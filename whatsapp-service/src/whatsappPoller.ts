import crypto from "crypto";
import cron from "node-cron";
import makeWASocket, { Browsers, DisconnectReason, AnyMessageContent, WASocket, fetchLatestWaWebVersion, fetchLatestBaileysVersion, proto } from "@whiskeysockets/baileys";
import { usePostgreSQLAuthState } from "postgres-baileys";
import qrcode from "qrcode-terminal";
import { Pool } from "pg";
import { normalizeConnectionString } from "./db";
import { saveWhatsappMessage } from "./dbAdapter";
import { info, error } from "./logger";

const AUTH_TABLE_NAME = process.env.WHATSAPP_AUTH_TABLE || "aris_whatsapp_auth_state";
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 20;
const BASE_INTERVAL_MINUTES = 55;
const JITTER_MINUTES = 32;
const QUIET_WINDOW_MS = 20000;
const MAX_SESSION_MS = 2 * 60 * 1000;

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
    sock.ws?.close();
  } catch {
    // ignore
  }
}

export async function pollWhatsappInboxOnce() {
  const databaseUrl = getDatabaseUrl();
  const url = new URL(databaseUrl);
  info(`WhatsApp service using database host: ${url.hostname}`);

  const normalizedDatabaseUrl = normalizeConnectionString(databaseUrl);
  const pool = new Pool({ connectionString: normalizedDatabaseUrl });
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
  let quietTimer: NodeJS.Timeout | undefined;
  let sessionTimer: NodeJS.Timeout | undefined;

  const endSession = async () => {
    if (resolved) {
      return;
    }
    resolved = true;
    if (quietTimer) {
      clearTimeout(quietTimer);
    }
    if (sessionTimer) {
      clearTimeout(sessionTimer);
    }
    if (currentSock) {
      await disconnectSocket(currentSock);
    }
  };

  const scheduleClose = () => {
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
      markOnlineOnConnect: false,
      syncFullHistory: historySyncPending,
      shouldSyncHistoryMessage: ({ syncType }) => syncType !== 1,
      getMessage: async () => ({ conversation: "" }),
    });

    currentSock = sock;
    info("WhatsApp polling socket created and auth state loaded.");

    sock.ev.on("creds.update", async () => {
      try {
        await saveCreds();
        await refreshHistorySyncState();
        info("WhatsApp credentials updated and persisted to Postgres.");
      } catch (err) {
        error("Failed to persist WhatsApp credentials", err);
      }
    });

    sock.ev.on("messaging-history.status", async (status: any) => {
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
          scheduleClose();
        } catch (err) {
          error("Failed to record WhatsApp history sync completion", err);
        }
      }
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

        resolved = true;
      }

      if (update.connection === "open" || update.isNewLogin || update.registered) {
        info("WhatsApp connection is ready or paired.");

        if (!historySyncPending || historySyncCompleted) {
          scheduleClose();
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
          scheduleClose();
          return;
        }

        info("Waiting for WhatsApp history sync completion before closing session.");
      }
    });

    sock.ev.on("messages.upsert", async (upsert: any) => {
      if (upsert.type !== "notify" || !Array.isArray(upsert.messages)) {
        return;
      }

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
            },
          });
          info(`Saved WhatsApp message from ${senderId}.`);
        } catch (err) {
          error("Failed to save WhatsApp message to Postgres", err);
        }
      }

      if (!historySyncPending || historySyncCompleted) {
        scheduleClose();
      } else {
        info("Received WhatsApp messages while waiting for history sync completion.");
      }
    });

    return sock;
  };

  await createSocket();
  sessionTimer = setTimeout(endSession, MAX_SESSION_MS);

  await new Promise<void>((resolve) => {
    const checkClosed = () => {
      if (resolved) {
        resolve();
        return;
      }
      setTimeout(checkClosed, 500);
    };
    checkClosed();
  });

  await pool.end();
  info("WhatsApp polling session completed.");
}

export async function clearWhatsappAuthState() {
  const databaseUrl = getDatabaseUrl();
  const normalizedDatabaseUrl = normalizeConnectionString(databaseUrl);
  const pool = new Pool({ connectionString: normalizedDatabaseUrl });
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
