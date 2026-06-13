import crypto from "crypto";
import cron from "node-cron";
import makeWASocket, { Browsers, DisconnectReason, AnyMessageContent, WASocket, fetchLatestWaWebVersion, fetchLatestBaileysVersion, proto } from "@whiskeysockets/baileys";
import { usePostgreSQLAuthState } from "postgres-baileys";
import qrcode from "qrcode-terminal";
import { Pool } from "pg";
import { normalizeConnectionString } from "./db";
import { saveWhatsappMessage, getPendingWhatsappMessagesByRemoteJid } from "./dbAdapter";
import { info, error } from "./logger";

const AUTH_TABLE_NAME = process.env.WHATSAPP_AUTH_TABLE || "aris_whatsapp_auth_state";
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 20;
const BASE_INTERVAL_MINUTES = 55;
const JITTER_MINUTES = 32;
const QUIET_WINDOW_MS = 20000;
const MAX_SESSION_MS = 2 * 60 * 1000;
const FIRST_RUN_STAY_ALIVE_MS = 10 * 60 * 1000;
const DEBUG_WHATSAPP_RAW_PAYLOAD = process.env.WHATSAPP_DEBUG_RAW_PAYLOAD === "true";

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for WhatsApp polling.");
  }
  return databaseUrl;
}

function getRandomPollDelayMs() {
  const jitter = (Math.random() * 2 - 1) * JITTER_MINUTES;
  const minutes = Math.max(1, BASE_INTERVAL_MINUTES + jitter);
  return Math.round(minutes * 60 * 1000);
}

function isDaytime(date: Date) {
  const hour = date.getHours();
  return hour >= DAY_START_HOUR && hour < DAY_END_HOUR;
}

function extractTextMessage(message: AnyMessageContent | undefined): string | undefined {
  if (!message) return undefined;

  const anyMessage = message as any;
  if ("conversation" in anyMessage && typeof anyMessage.conversation === "string") {
    return anyMessage.conversation;
  }

  if ("extendedTextMessage" in anyMessage && typeof anyMessage.extendedTextMessage?.text === "string") {
    return anyMessage.extendedTextMessage.text;
  }

  if ("imageMessage" in anyMessage && typeof anyMessage.imageMessage?.caption === "string") {
    return anyMessage.imageMessage.caption;
  }

  if ("videoMessage" in anyMessage && typeof anyMessage.videoMessage?.caption === "string") {
    return anyMessage.videoMessage.caption;
  }

  if ("documentMessage" in anyMessage && typeof anyMessage.documentMessage?.fileName === "string") {
    return anyMessage.documentMessage.fileName;
  }

  return undefined;
}

async function ensureWhatsappHistorySyncTable(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_history_sync (
      id SERIAL PRIMARY KEY,
      auth_state_hash TEXT UNIQUE NOT NULL,
      sync_completed BOOLEAN NOT NULL DEFAULT FALSE,
      synced_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);
}

function getChatId(chat: any): string | undefined {
  return chat?.id || chat?.jid || chat?.key?.remoteJid;
}

function shouldProcessUnreadChat(chat: any): boolean {
  return typeof chat?.unreadCount === "number" && chat.unreadCount > 0;
}

async function saveUnreadHistoryMessages(history: any): Promise<number> {
  if (!history?.chats?.length || !history?.messages?.length) {
    info("WhatsApp history payload contained no chats or messages; no unread messages found.");
    return 0;
  }

  const unreadChatIds = history.chats
    .filter(shouldProcessUnreadChat)
    .map(getChatId)
    .filter((jid: string | undefined): jid is string => Boolean(jid));

  if (!unreadChatIds.length) {
    info("WhatsApp history payload contained no chats with unread messages; no unread messages found.");
    return 0;
  }

  const unreadChatSet = new Set(unreadChatIds);
  const messagesToSave = history.messages.filter((msg: any) => {
    const remoteJid = msg?.key?.remoteJid;
    return remoteJid && !msg?.key?.fromMe && unreadChatSet.has(remoteJid);
  });

  if (!messagesToSave.length) {
    info("WhatsApp history payload contained no unread messages to save.");
    return 0;
  }

  let savedCount = 0;
  for (const msg of messagesToSave) {
    const messageText = extractTextMessage(msg.message);
    if (!messageText) {
      continue;
    }

    const senderId = msg.key.participant || msg.key.remoteJid;
    if (!senderId) {
      continue;
    }

    try {
      await saveWhatsappMessage({
        senderId,
        messageId: msg.key.id || `${senderId}:${msg.messageTimestamp}`,
        messageText,
        whatsappTimestamp: Number(msg.messageTimestamp) || Date.now(),
        metadata: {
          remoteJid: msg.key.remoteJid,
          participant: msg.key.participant,
          messageStubType: msg.messageStubType,
          unreadCount: history.chats.find((chat: any) => getChatId(chat) === msg.key.remoteJid)?.unreadCount,
        },
      });
      savedCount += 1;
    } catch (err) {
      error("Failed to save historical unread WhatsApp message", err);
    }
  }

  if (savedCount) {
    info(`Saved ${savedCount} historical unread WhatsApp message(s) from initial sync.`);
  }

  return savedCount;
}

async function saveLocalUnreadMessagesByRemoteJid(remoteJid: string): Promise<number> {
  const pendingMessages = await getPendingWhatsappMessagesByRemoteJid(remoteJid, 100);
  if (!pendingMessages.length) {
    info(`No pending local unread WhatsApp messages found for ${remoteJid}.`);
    return 0;
  }

  info(`Loaded ${pendingMessages.length} pending local unread WhatsApp message(s) for ${remoteJid} from local history.`);
  return pendingMessages.length;
}

function isPreKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const message = (err as any)?.message;
  const name = (err as any)?.name;
  return (
    typeof message === "string" && /prekey/i.test(message) && /invalid|missing|not found/i.test(message)
  ) || typeof name === "string" && name.toLowerCase() === "prekeyerror";
}

async function handleUnreadChatMetadata(chat: any): Promise<number> {
  if (!shouldProcessUnreadChat(chat)) {
    info("WhatsApp chat metadata update contained no unread messages.");
    return 0;
  }

  const remoteJid = getChatId(chat);
  if (!remoteJid) {
    info("WhatsApp chat metadata update had no remote JID; ignoring.");
    return 0;
  }

  info(`Detected unread WhatsApp chat metadata for ${remoteJid} with unreadCount=${chat.unreadCount}.`);
  return await saveLocalUnreadMessagesByRemoteJid(remoteJid);
}

function normalizeAuthState(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }
  if (Array.isArray(value)) {
    return value.map(normalizeAuthState);
  }
  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return Object.keys(objectValue).sort().reduce((acc, key) => {
      acc[key] = normalizeAuthState(objectValue[key]);
      return acc;
    }, {} as Record<string, unknown>);
  }
  return value;
}

function computeAuthStateHash(state: any) {
  const normalized = normalizeAuthState(state.creds || state);
  const payload = JSON.stringify(normalized);
  return crypto.createHash("sha256").update(payload).digest("hex");
}

async function hasCompletedWhatsappHistorySync(pool: Pool, authStateHash: string) {
  const result = await pool.query(
    `SELECT sync_completed FROM whatsapp_history_sync WHERE auth_state_hash = $1`,
    [authStateHash]
  );
  return (result.rowCount ?? 0) > 0 && result.rows[0].sync_completed === true;
}

async function markWhatsappHistorySyncComplete(pool: Pool, authStateHash: string) {
  await pool.query(
    `INSERT INTO whatsapp_history_sync (auth_state_hash, sync_completed, synced_at, updated_at)
     VALUES ($1, TRUE, NOW(), NOW())
     ON CONFLICT (auth_state_hash) DO UPDATE SET sync_completed = TRUE, synced_at = NOW(), updated_at = NOW()`,
    [authStateHash]
  );
}

async function disconnectSocket(sock: WASocket) {
  try {
    info("Closing WhatsApp socket after quiet period.");
    if (typeof sock.end === "function") {
      sock.end(new Error("Intentional polling cutoff"));
    } else {
      sock.ws?.close();
    }
  } catch {
    // ignore
  }
}

export async function pollWhatsappInboxOnce() {
  const databaseUrl = getDatabaseUrl();
  const url = new URL(databaseUrl);
  info(`WhatsApp service using database host: ${url.hostname}`);

  const normalizedDatabaseUrl = normalizeConnectionString(databaseUrl);
  const pool = new Pool({
    connectionString: normalizedDatabaseUrl,
    max: Number(process.env.WHATSAPP_PG_POOL_MAX) || 20,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: Number(process.env.WHATSAPP_PG_CONNECTION_TIMEOUT_MS) || 15000,
  });
  await ensureWhatsappHistorySyncTable(pool);

  const { state, saveCreds } = await usePostgreSQLAuthState(pool, AUTH_TABLE_NAME);
  const getAuthStateHash = () => computeAuthStateHash(state);
  let authStateHash = getAuthStateHash();
  let historySyncPending = !(await hasCompletedWhatsappHistorySync(pool, authStateHash));
  let historySyncCompleted = !historySyncPending;

  const refreshHistorySyncState = async () => {
    authStateHash = getAuthStateHash();
    historySyncPending = !(await hasCompletedWhatsappHistorySync(pool, authStateHash));
    historySyncCompleted = !historySyncPending;
  };

  const isFreshSession = !state.creds?.me || process.env.FIRST_RUN === "true";
  const shouldExitAfterPoolEnd = process.argv.includes("once") || process.env.WHATSAPP_ABORT_ON_CLOSE === "true";
  const sessionTimeoutMs = isFreshSession ? Math.max(MAX_SESSION_MS, FIRST_RUN_STAY_ALIVE_MS + 60 * 1000) : MAX_SESSION_MS;

  const hasAuth = Boolean(state.creds?.me);
  info(`WhatsApp saved auth state exists: ${hasAuth}`);
  if (!hasAuth) {
    info("No saved WhatsApp auth was found. A QR code will be shown for pairing.");
  }

  const waVersionResponse = await fetchLatestWaWebVersion();
  let version = waVersionResponse.version;
  let versionLabel = `WhatsApp Web version ${version.join('.')}`;

  if (!waVersionResponse.isLatest) {
    error("Failed to fetch latest WhatsApp Web version", waVersionResponse.error);
    const baileysFallback = await fetchLatestBaileysVersion();
    version = baileysFallback.version;
    versionLabel = `fallback Baileys version ${version.join('.')}`;
  }

  info(`Using ${versionLabel}`);

  let currentSock: WASocket | undefined;
  let reconnecting = false;
  let resolved = false;
  let shutdownRequested = false;
  let poolShutdownScheduled = false;
  let quietTimer: NodeJS.Timeout | undefined;
  let activeHistorySets = 0;
  let sessionTimer: NodeJS.Timeout | undefined;
  let unreadMessagesProcessed = 0;
  let sessionResolve: (() => void) | undefined;
  const sessionPromise = new Promise<void>((resolve) => {
    sessionResolve = resolve;
  });
  const pendingOperations = new Set<Promise<unknown>>();

  const trackPendingOperation = <T>(promise: Promise<T>) => {
    pendingOperations.add(promise as Promise<unknown>);
    promise.finally(() => pendingOperations.delete(promise as Promise<unknown>));
    return promise;
  };

  const waitForPendingOperations = async () => {
    if (pendingOperations.size === 0) {
      info("No pending auth writes to drain before pool shutdown.");
      return;
    }
    info(`Waiting for ${pendingOperations.size} pending auth write(s) to settle before pool shutdown.`);
    await Promise.allSettled(Array.from(pendingOperations));
    info("Pending auth writes have settled.");
  };

  const canShutdown = () => {
    return historySyncCompleted && activeHistorySets === 0 && pendingOperations.size === 0 && !reconnecting;
  };

  const attemptShutdown = async () => {
    if (!isFreshSession) {
      return;
    }
    if (!canShutdown()) {
      return;
    }
    info("First-run sync is complete and all pending work is settled. Triggering shutdown.");
    await endSession();
  };

  const drainPostgresPool = async () => {
    if (poolShutdownScheduled) {
      return;
    }
    poolShutdownScheduled = true;

    info("[whatsapp-service] Socket completely closed. Now draining DB pool...");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await waitForPendingOperations();
    try {
      await pool.end();
      info("[whatsapp-service] Postgres pool ended cleanly.");
    } catch (err) {
      error("Failed to end Postgres pool cleanly", err);
    }
    if (shouldExitAfterPoolEnd) {
      info("[whatsapp-service] Exiting process after graceful shutdown.");
      process.exit(0);
    }
  };

  const waitForSocketClose = async (sock: WASocket) => {
    return new Promise<void>((resolve) => {
      let settled = false;

      const cleanup = () => {
        if (settled) {
          return;
        }
        settled = true;
        sock.ws?.off("close", onClose);
        sock.ev.off("connection.update", onConnectionUpdate);
        resolve();
      };

      const onClose = () => {
        info("WhatsApp WebSocket close event received.");
        cleanup();
      };

      const onConnectionUpdate = (update: any) => {
        if (update?.connection === "close") {
          info("WhatsApp connection update reported close.");
          cleanup();
        }
      };

      sock.ws?.once("close", onClose);
      sock.ev.on("connection.update", onConnectionUpdate);
    });
  };

  const endSession = async () => {
    if (shutdownRequested) {
      return;
    }
    shutdownRequested = true;
    if (quietTimer) {
      clearTimeout(quietTimer);
    }
    if (sessionTimer) {
      clearTimeout(sessionTimer);
    }
    if (currentSock) {
      const closePromise = waitForSocketClose(currentSock);
      await disconnectSocket(currentSock);
      info("Waiting for socket close event before final completion.");
      await closePromise;
      info("Socket close event received. Waiting for pending auth writes to settle.");
    }

    await waitForPendingOperations();
    resolved = true;
    sessionResolve?.();
  };

  const scheduleClose = () => {
    if (isFreshSession) {
      info("First-run session active; skipping quiet-period timeout.");
      return;
    }

    if (quietTimer) {
      clearTimeout(quietTimer);
    }
    quietTimer = setTimeout(endSession, QUIET_WINDOW_MS);
  };

  const createSocket = async () => {
    const sock = makeWASocket({
      auth: state,
      version,
      browser: Browsers.macOS("Chrome"),
      shouldIgnoreJid: (jid) => typeof jid === "string" && jid.includes("broadcast"),
      markOnlineOnConnect: false,
      syncFullHistory: historySyncPending,
      shouldSyncHistoryMessage: ({ syncType }) => syncType !== 1,
      getMessage: async () => ({ conversation: "" }),
    });

    currentSock = sock;
    info("WhatsApp polling socket created and auth state loaded.");

    sock.ev.on("creds.update", async () => {
      if (resolved) {
        return;
      }

      const op = (async () => {
        try {
          await saveCreds();
          await refreshHistorySyncState();
          info("WhatsApp credentials updated and persisted to Postgres.");
        } catch (err) {
          error("Failed to persist WhatsApp credentials", err);
        }
      })();

      trackPendingOperation(op);
      await op;
    });

    sock.ev.on("messaging-history.status", async (status: any) => {
      if (resolved) {
        return;
      }

      const op = (async () => {
        info("WhatsApp messaging-history.status:", JSON.stringify(status));
        if (!historySyncPending || historySyncCompleted) {
          return;
        }

        const relevantSyncTypes = [
          proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
          proto.HistorySync.HistorySyncType.RECENT,
          proto.HistorySync.HistorySyncType.FULL,
        ];

        if (!relevantSyncTypes.includes(status.syncType)) {
          return;
        }

        if (status.status === "complete" || status.status === "paused") {
          try {
            await markWhatsappHistorySyncComplete(pool, getAuthStateHash());
            historySyncPending = false;
            historySyncCompleted = true;
            info("Marked one-time WhatsApp full history sync as completed.");
            if (isFreshSession) {
              await attemptShutdown();
            } else {
              scheduleClose();
            }
          } catch (err) {
            error("Failed to record WhatsApp history sync completion", err);
          }
        }
      })();

      trackPendingOperation(op);
    });

    sock.ev.on("messaging-history.set", async (history: any) => {
      if (resolved) return;

      activeHistorySets += 1;
      const op = (async () => {
        const syncStage = historySyncPending && !historySyncCompleted ? "initial sync" : "periodic sync";
        info(`WhatsApp messaging-history.set received during ${syncStage}.`);
        if (DEBUG_WHATSAPP_RAW_PAYLOAD) {
          info("WhatsApp raw messaging-history.set payload:", JSON.stringify(history, null, 2));
        }
        try {
          const savedCount = await saveUnreadHistoryMessages(history);
          unreadMessagesProcessed += savedCount;
        } catch (err) {
          error("Failed to save unread chat history from WhatsApp history payload", err);
        } finally {
          activeHistorySets -= 1;
          if (isFreshSession) {
            await attemptShutdown();
          }
        }
      })();

      trackPendingOperation(op);
    });

    sock.ev.on("connection.update", async (update: any) => {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      info("WhatsApp connection.update:", JSON.stringify(update));

      if (update.qr) {
        info("WhatsApp QR code generated. Scan the code below with your WhatsApp mobile app:");
        info(`QR payload length: ${update.qr.length} startsWith https://wa.me/settings/linked_devices#: ${update.qr.startsWith("https://wa.me/settings/linked_devices#")}`);
        qrcode.generate(update.qr, { small: true });
        info("If the QR does not appear, copy the base64 QR string and use an external QR scanner.");
      }

      if (update.connection === "close") {
        info(`WhatsApp connection closed: ${update.lastDisconnect?.error?.message ?? "unknown"} (code=${code})`);

        if (code === DisconnectReason.restartRequired) {
          info("WhatsApp restartRequired close received; reconnecting to finalize pairing/login.");
          if (quietTimer) {
            clearTimeout(quietTimer);
            quietTimer = undefined;
          }
          if (!resolved && !reconnecting) {
            reconnecting = true;
            setTimeout(async () => {
              reconnecting = false;
              try {
                await createSocket();
              } catch (err) {
                error("Failed to reconnect WhatsApp socket after restartRequired", err);
              }
            }, 1500);
          }
          return;
        }

        if (code === DisconnectReason.loggedOut) {
          info("WhatsApp auth state was logged out. Ending polling session.");
        }

        if (!shutdownRequested) {
          await endSession();
        }

        await drainPostgresPool();
      }

      if (update.connection === "open" || update.isNewLogin || update.registered) {
        info("WhatsApp connection is ready or paired.");

        if (!historySyncPending || historySyncCompleted) {
          if (isFreshSession) {
            await attemptShutdown();
          } else {
            scheduleClose();
          }
          return;
        }

        if (state.creds?.accountSyncCounter > 0) {
          info("Existing WhatsApp sync state detected; treating history sync as complete on open.");
          try {
            await markWhatsappHistorySyncComplete(pool, getAuthStateHash());
            historySyncPending = false;
            historySyncCompleted = true;
            info("Marked one-time WhatsApp full history sync as completed on reconnection.");
          } catch (err) {
            error("Failed to record WhatsApp history sync completion", err);
          }
          if (isFreshSession) {
            await attemptShutdown();
          } else {
            scheduleClose();
          }
          return;
        }

        info("Waiting for WhatsApp history sync completion before closing session.");
      }
    });

    sock.ev.on("messages.upsert", async (upsert: any) => {
      if (resolved || !Array.isArray(upsert.messages)) {
        return;
      }

      const op = (async () => {
        if (DEBUG_WHATSAPP_RAW_PAYLOAD) {
          info("WhatsApp raw messages.upsert payload:", JSON.stringify(upsert, null, 2));
        }

        if (upsert.type !== "notify") {
          info(`WhatsApp messages.upsert received with type=${upsert.type}; processing history-style or pending messages.`);
        }

        try {
          for (const msg of upsert.messages) {
            if (msg.key.fromMe || !msg.key.remoteJid) {
              continue;
            }

            const senderId = msg.key.participant || msg.key.remoteJid;
            const messageText = extractTextMessage(msg.message);
            if (!messageText) {
              continue;
            }

            try {
              await saveWhatsappMessage({
                senderId,
                messageId: msg.key.id || `${senderId}:${msg.messageTimestamp}`,
                messageText,
                whatsappTimestamp: Number(msg.messageTimestamp) || Date.now(),
                metadata: {
                  remoteJid: msg.key.remoteJid,
                  participant: msg.key.participant,
                  messageStubType: msg.messageStubType,
                  upsertType: upsert.type,
                },
              });
              info(`Saved WhatsApp message from ${senderId} (${upsert.type}).`);
            } catch (err) {
              error("Failed to save WhatsApp message to Postgres", err);
            }
          }
        } catch (err) {
          if (isPreKeyError(err)) {
            info("Skipped undecryptable group message due to missing PreKey.");
            return;
          }
          throw err;
        }

        if (!historySyncPending || historySyncCompleted) {
          if (isFreshSession) {
            await attemptShutdown();
          } else {
            scheduleClose();
          }
        } else {
          info("Received WhatsApp messages while waiting for history sync completion.");
        }
      })();

      trackPendingOperation(op);
    });

    sock.ev.on("chats.upsert", async (chats: any[]) => {
      if (!Array.isArray(chats)) {
        return;
      }

      const op = (async () => {
        for (const chat of chats) {
          const savedCount = await handleUnreadChatMetadata(chat);
          unreadMessagesProcessed += savedCount;
        }
      })();

      trackPendingOperation(op);
    });

    sock.ev.on("chats.update", async (chats: any[]) => {
      if (!Array.isArray(chats)) {
        return;
      }

      const op = (async () => {
        for (const chat of chats) {
          const savedCount = await handleUnreadChatMetadata(chat);
          unreadMessagesProcessed += savedCount;
        }
      })();

      trackPendingOperation(op);
    });

    return sock;
  };

  await createSocket();
  sessionTimer = setTimeout(endSession, sessionTimeoutMs);

  await sessionPromise;

  if (unreadMessagesProcessed === 0) {
    info("WhatsApp polling session completed with zero unread messages processed.");
  } else {
    info(`WhatsApp polling session completed with ${unreadMessagesProcessed} unread message(s) processed.`);
  }
  info("All pending writes drained. Postgres pool termination will occur after socket close.");
}

export async function clearWhatsappAuthState() {
  const databaseUrl = getDatabaseUrl();
  const normalizedDatabaseUrl = normalizeConnectionString(databaseUrl);
  const pool = new Pool({
    connectionString: normalizedDatabaseUrl,
    max: Number(process.env.WHATSAPP_PG_POOL_MAX) || 20,
    idleTimeoutMillis: 60000,
    connectionTimeoutMillis: Number(process.env.WHATSAPP_PG_CONNECTION_TIMEOUT_MS) || 15000,
  });
  const { deleteSession } = await usePostgreSQLAuthState(pool, AUTH_TABLE_NAME);
  await deleteSession();
  await pool.end();

  info("Cleared WhatsApp auth state from database.");
}

export function startWhatsappScheduler() {
  info("Starting WhatsApp polling scheduler.");

  cron.schedule("0 8 * * *", () => {
    info("WhatsApp polling window has opened for the day.");
  });

  cron.schedule("0 20 * * *", () => {
    info("WhatsApp polling window has closed for the day.");
  });

  const scheduleNext = async () => {
    const delayMs = getRandomPollDelayMs();
    const nextRun = new Date(Date.now() + delayMs);
    info(`Next WhatsApp polling check scheduled at ${nextRun.toISOString()}`);

    setTimeout(async () => {
      if (isDaytime(new Date())) {
        try {
          await pollWhatsappInboxOnce();
        } catch (err) {
          error("WhatsApp polling run failed", err);
        }
      } else {
        info("Skipping WhatsApp polling because now is outside the daytime window.");
      }
      scheduleNext();
    }, delayMs);
  };

  scheduleNext();
}
