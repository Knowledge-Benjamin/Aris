import cron from "node-cron";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  AnyMessageContent,
  WASocket,
  fetchLatestWaWebVersion,
  fetchLatestBaileysVersion,
  proto,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import { usePostgreSQLAuthState } from "postgres-baileys";
import qrcode from "qrcode-terminal";
import { Pool } from "pg";
import { EventEmitter } from "events";
import { normalizeConnectionString } from "./db";
import {
  saveWhatsappMessage,
  getPendingWhatsappMessagesByRemoteJid,
  saveWhatsappGroup,
  getPendingOutboxMessages,
  markOutboxSent,
  markOutboxFailed,
} from "./dbAdapter";
import { info, error } from "./logger";
import axios from "axios";
import { google } from "googleapis";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AUTH_TABLE_NAME =
  process.env.WHATSAPP_AUTH_TABLE || "aris_whatsapp_auth_state";

const DAY_START_HOUR = 8;
const DAY_END_HOUR = 20;
const BASE_INTERVAL_MINUTES = 55;
const JITTER_MINUTES = 32;

/**
 * Absolute hard-cap on how long a session may live.
 * These are *safety nets*, not the primary completion mechanism.
 * The session ends as soon as all in-flight work drains; these caps
 * exist only to guard against WhatsApp never sending a completion signal.
 */
const HARD_CAP_FRESH_MS = 35 * 60 * 1000;    // 35 min  – first-ever QR pair
const HARD_CAP_RECONNECT_MS = 10 * 60 * 1000; // 10 min  – subsequent sessions

const QUIET_WINDOW_MS = 180_000; // wait this long after last activity before closing a session
const DEBUG_WHATSAPP_RAW_PAYLOAD =
  process.env.WHATSAPP_DEBUG_RAW_PAYLOAD === "true";

// ---------------------------------------------------------------------------
// WorkTracker
// ---------------------------------------------------------------------------

/**
 * Tracks the number of concurrent in-flight async operations.
 * Emits "drain" when the counter reaches zero (and was previously > 0).
 * This replaces all guessed setTimeout-based draining.
 */
class WorkTracker extends EventEmitter {
  private count = 0;

  begin(): void {
    this.count += 1;
  }

  end(): void {
    if (this.count <= 0) {
      return;
    }
    this.count -= 1;
    if (this.count === 0) {
      this.emit("drain");
    }
  }

  get size(): number {
    return this.count;
  }

  /** Returns a Promise that resolves when the tracker drains (or immediately if already 0). */
  waitDrain(): Promise<void> {
    if (this.count === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.once("drain", resolve));
  }

  /**
   * Wraps an async operation: increments before, decrements after (success or failure).
   * Returns the original promise so callers can still await results.
   */
  track<T>(op: Promise<T>): Promise<T> {
    this.begin();
    op.finally(() => this.end());
    return op;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required for WhatsApp polling.");
  }
  return url;
}

/**
 * Downloads a GCS object using the service-account credentials in env and
 * returns the raw buffer. Used to retrieve audio before sending as a voice note.
 */
async function downloadFromGcs(gcsUri: string): Promise<Buffer> {
  const bucket = process.env.GCS_BUCKET_NAME;
  if (!bucket) throw new Error("GCS_BUCKET_NAME env var not set.");
  const objectPath = gcsUri.replace(`gs://${bucket}/`, "");

  const keyJson = process.env.GCS_KEY_JSON
    ? JSON.parse(Buffer.from(process.env.GCS_KEY_JSON, "base64").toString("utf8"))
    : undefined;
  const auth = new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
  });
  const token = await auth.getAccessToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media`;
  const resp = await axios.get<Buffer>(url, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: "arraybuffer",
  });
  return Buffer.from(resp.data);
}

/**
 * Flushes pending WhatsApp outbox messages via the live socket.
 * Text messages are sent as plain text; audio messages are sent as voice notes.
 */
async function flushOutbox(sock: WASocket): Promise<void> {
  const pending = await getPendingOutboxMessages(10);
  if (pending.length === 0) return;
  info(`[outbox] Flushing ${pending.length} pending message(s).`);

  for (const msg of pending) {
    try {
      if (msg.messageType === "text" && msg.body) {
        await sock.sendMessage(msg.toJid, { text: msg.body });
        info(`[outbox] Sent text message id=${msg.id} to=${msg.toJid}`);
      } else if (msg.messageType === "audio" && msg.mediaGcsUri) {
        const audioBuffer = await downloadFromGcs(msg.mediaGcsUri);
        await sock.sendMessage(msg.toJid, {
          audio: audioBuffer,
          mimetype: (msg.mediaMimeType || "audio/ogg") as any,
          ptt: true, // send as voice note (push-to-talk)
        });
        info(`[outbox] Sent voice note id=${msg.id} to=${msg.toJid} (${audioBuffer.length} bytes)`);
      }
      await markOutboxSent(msg.id);
    } catch (err) {
      error(`[outbox] Failed to send message id=${msg.id}`, err);
      await markOutboxFailed(msg.id).catch(() => undefined);
    }
  }
}

function getRandomPollDelayMs(): number {
  const jitter = (Math.random() * 2 - 1) * JITTER_MINUTES;
  const minutes = Math.max(1, BASE_INTERVAL_MINUTES + jitter);
  return Math.round(minutes * 60 * 1000);
}

function isDaytime(date: Date): boolean {
  const hour = date.getHours();
  return hour >= DAY_START_HOUR && hour < DAY_END_HOUR;
}

function extractTextMessage(
  message: AnyMessageContent | undefined
): string | undefined {
  if (!message) return undefined;
  const m = message as any;
  if (typeof m.conversation === "string") return m.conversation;
  if (typeof m.extendedTextMessage?.text === "string")
    return m.extendedTextMessage.text;
  if (typeof m.imageMessage?.caption === "string")
    return m.imageMessage.caption;
  if (typeof m.videoMessage?.caption === "string")
    return m.videoMessage.caption;
  if (typeof m.documentMessage?.fileName === "string")
    return m.documentMessage.fileName;
  return undefined;
}

function isPreKeyError(err: unknown): boolean {
  const msg = (err as any)?.message;
  const name = (err as any)?.name;
  return (
    (typeof msg === "string" &&
      /prekey/i.test(msg) &&
      /invalid|missing|not found/i.test(msg)) ||
    (typeof name === "string" && name.toLowerCase() === "prekeyerror")
  );
}

function getChatId(chat: any): string | undefined {
  return chat?.id || chat?.jid || chat?.key?.remoteJid;
}

function shouldProcessUnreadChat(chat: any): boolean {
  return typeof chat?.unreadCount === "number" && chat.unreadCount > 0;
}

// ---------------------------------------------------------------------------
// DB: whatsapp_history_sync table (keyed by stable account_id / JID)
// ---------------------------------------------------------------------------

async function ensureWhatsappHistorySyncTable(pool: Pool): Promise<void> {
  // Create the table if it doesn't exist, using account_id as the stable key.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_history_sync (
      id                SERIAL PRIMARY KEY,
      account_id        TEXT UNIQUE NOT NULL,
      sync_completed    BOOLEAN NOT NULL DEFAULT FALSE,
      synced_at         TIMESTAMP WITH TIME ZONE,
      created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  // Migration: if the old auth_state_hash column still exists, rename it.
  // This is idempotent — it silently fails if the column is already gone.
  await pool
    .query(
      `ALTER TABLE whatsapp_history_sync RENAME COLUMN auth_state_hash TO account_id;`
    )
    .catch(() => {
      /* column already renamed or never existed – safe to ignore */
    });
}

async function hasCompletedHistorySync(
  pool: Pool,
  accountId: string
): Promise<boolean> {
  const result = await pool.query(
    `SELECT sync_completed FROM whatsapp_history_sync WHERE account_id = $1`,
    [accountId]
  );
  return (
    (result.rowCount ?? 0) > 0 && result.rows[0].sync_completed === true
  );
}

async function markHistorySyncComplete(
  pool: Pool,
  accountId: string
): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_history_sync (account_id, sync_completed, synced_at, updated_at)
     VALUES ($1, TRUE, NOW(), NOW())
     ON CONFLICT (account_id)
     DO UPDATE SET sync_completed = TRUE, synced_at = NOW(), updated_at = NOW()`,
    [accountId]
  );
}

// ---------------------------------------------------------------------------
// Message saving helpers
// ---------------------------------------------------------------------------

async function saveUnreadHistoryMessages(history: any): Promise<number> {
  if (!history?.chats?.length || !history?.messages?.length) {
    info(
      "WhatsApp history payload contained no chats or messages; skipping."
    );
    return 0;
  }

  const unreadChatIds = history.chats
    .filter(shouldProcessUnreadChat)
    .map(getChatId)
    .filter((jid: string | undefined): jid is string => Boolean(jid));

  if (!unreadChatIds.length) {
    info("WhatsApp history payload contained no chats with unread messages.");
    return 0;
  }

  const unreadSet = new Set<string>(unreadChatIds);
  const toSave = history.messages.filter(
    (msg: any) =>
      msg?.key?.remoteJid &&
      !msg?.key?.fromMe &&
      unreadSet.has(msg.key.remoteJid)
  );

  if (!toSave.length) {
    info("No unread messages in this history payload.");
    return 0;
  }

  let saved = 0;
  const validRecords = [];

  for (const msg of toSave) {
    const messageText = extractTextMessage(msg.message);
    if (!messageText) continue;

    const isGroup = msg.key.remoteJid?.endsWith("@g.us");
    const participantJid =
      msg.key.participant || (isGroup ? (msg as any).participant : null) || null;
    const senderId = participantJid || msg.key.remoteJid;
    if (!senderId) continue;

    validRecords.push({ msg, senderId, messageText, isGroup });
  }

  // Process in batches to avoid tying up a single connection sequentially for
  // minutes, which causes Neon to terminate idle proxy connections.
  // We use 25 since the pool max is 50, leaving room for other concurrent ops.
  const BATCH_SIZE = 25;
  for (let i = 0; i < validRecords.length; i += BATCH_SIZE) {
    const batch = validRecords.slice(i, i + BATCH_SIZE);
    
    await Promise.all(
      batch.map(async (record) => {
        try {
          await saveWhatsappMessage({
            senderId: record.senderId,
            messageId: record.msg.key.id || `${record.senderId}:${record.msg.messageTimestamp}`,
            messageText: record.messageText,
            whatsappTimestamp: Number(record.msg.messageTimestamp) || Date.now(),
            metadata: {
              remoteJid: record.msg.key.remoteJid,
              groupJid: record.isGroup ? record.msg.key.remoteJid : undefined,
              participant: record.msg.key.participant,
              pushName: (record.msg as any).pushName || undefined,
              messageStubType: record.msg.messageStubType,
              unreadCount: history.chats.find(
                (chat: any) => getChatId(chat) === record.msg.key.remoteJid
              )?.unreadCount,
            },
          });
          saved += 1;
        } catch (err) {
          error("Failed to save historical WhatsApp message", err);
        }
      })
    );
  }

  if (saved) {
    info(`Saved ${saved} historical unread WhatsApp message(s) from initial sync.`);
  }
  return saved;
}

async function saveLocalUnreadMessagesByRemoteJid(
  remoteJid: string
): Promise<number> {
  const pending = await getPendingWhatsappMessagesByRemoteJid(remoteJid, 100);
  if (!pending.length) {
    info(`No pending local unread messages for ${remoteJid}.`);
    return 0;
  }
  info(`Loaded ${pending.length} pending local unread message(s) for ${remoteJid}.`);
  return pending.length;
}

async function handleUnreadChatMetadata(chat: any): Promise<number> {
  if (!shouldProcessUnreadChat(chat)) return 0;
  const remoteJid = getChatId(chat);
  if (!remoteJid) return 0;
  info(
    `Unread chat metadata for ${remoteJid} (unreadCount=${chat.unreadCount}).`
  );
  return saveLocalUnreadMessagesByRemoteJid(remoteJid);
}

// ---------------------------------------------------------------------------
// Socket close helper
// ---------------------------------------------------------------------------

function waitForSocketClose(sock: WASocket): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      sock.ws?.off("close", done);
      sock.ev.off("connection.update", onUpdate);
      resolve();
    };

    const onUpdate = (upd: any) => {
      if (upd?.connection === "close") done();
    };

    // Already closed?
    const ws = sock.ws as any;
    if (!ws || ws.readyState === 3 /* CLOSED */) {
      resolve();
      return;
    }

    sock.ws?.once("close", done);
    sock.ev.on("connection.update", onUpdate);
  });
}

function closeSocket(sock: WASocket): void {
  try {
    if (typeof sock.end === "function") {
      sock.end(new Error("Intentional polling cutoff"));
    } else {
      sock.ws?.close();
    }
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Main polling function
// ---------------------------------------------------------------------------

export async function pollWhatsappInboxOnce(): Promise<void> {
  const databaseUrl = getDatabaseUrl();
  const url = new URL(databaseUrl);
  info(`WhatsApp service using database host: ${url.hostname}`);

  const pool = new Pool({
    connectionString: normalizeConnectionString(databaseUrl),
    max: Number(process.env.WHATSAPP_PG_POOL_MAX) || 50,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis:
      Number(process.env.WHATSAPP_PG_CONNECTION_TIMEOUT_MS) || 300_000,
  });

  await ensureWhatsappHistorySyncTable(pool);

  const { state, saveCreds } = await usePostgreSQLAuthState(
    pool,
    AUTH_TABLE_NAME
  );

  // -------------------------------------------------------------------------
  // Stable account identity — never changes after first QR scan.
  // Falls back to a placeholder while the account is being registered so that
  // we don't mark sync complete for the wrong session.
  // -------------------------------------------------------------------------
  const getAccountId = (): string | null =>
    state.creds?.me?.id ?? null;

  const initialAccountId = getAccountId();
  const alreadySynced = initialAccountId
    ? await hasCompletedHistorySync(pool, initialAccountId)
    : false;

  // historySyncPending is TRUE if we still need to receive history from WA.
  let historySyncPending = !alreadySynced;
  let historySyncCompleted = alreadySynced;

  // A "fresh session" is one where history sync is required — this drives
  // the hard-cap timeout choice and whether we wait for the sync before closing.
  const isFreshSession =
    historySyncPending ||
    !state.creds?.me ||
    process.env.FIRST_RUN === "true";

  const shouldExitAfterDone =
    process.argv.includes("once") ||
    process.env.WHATSAPP_ABORT_ON_CLOSE === "true";

  const hardCapMs = isFreshSession ? HARD_CAP_FRESH_MS : HARD_CAP_RECONNECT_MS;

  info(
    `WhatsApp auth loaded. accountId=${initialAccountId ?? "none"} ` +
      `historySyncPending=${historySyncPending} ` +
      `isFreshSession=${isFreshSession} ` +
      `hardCapMs=${hardCapMs}`
  );

  // -------------------------------------------------------------------------
  // Fetch WA Web version
  // -------------------------------------------------------------------------
  const waVersionResponse = await fetchLatestWaWebVersion();
  let version = waVersionResponse.version;
  let versionLabel = `WhatsApp Web version ${version.join(".")}`;

  if (!waVersionResponse.isLatest) {
    error("Failed to fetch latest WhatsApp Web version", waVersionResponse.error);
    const fallback = await fetchLatestBaileysVersion();
    version = fallback.version;
    versionLabel = `fallback Baileys version ${version.join(".")}`;
  }
  info(`Using ${versionLabel}`);

  // -------------------------------------------------------------------------
  // Session lifecycle state
  // -------------------------------------------------------------------------
  let currentSock: WASocket | undefined;
  let shutdownRequested = false;
  let poolClosed = false;
  let reconnecting = false;
  let unreadProcessed = 0;
  // How many messaging-history.set batches we have received so far.
  // Used to guard receivedPendingNotifications: that event only means
  // "WA server flushed offline notifications" — it fires BEFORE the
  // phone-driven history sync starts, so we must not treat it as
  // "history complete" unless actual history data has already arrived.
  let seenHistorySetCount = 0;

  // Tracks every async DB/creds write so we can wait for them before exiting.
  const dbWork = new WorkTracker();
  // Tracks active messaging-history.set processing (separate for clarity).
  const historyWork = new WorkTracker();

  // The single promise the outer caller awaits.
  let sessionResolve!: () => void;
  const sessionDone = new Promise<void>((res) => {
    sessionResolve = res;
  });

  // Quiet-window timer for reconnect sessions (closed when any work arrives,
  // restarted after each operation completes).
  let quietTimer: ReturnType<typeof setTimeout> | undefined;

  // Absolute hard-cap timer — safety net only.
  let hardCapTimer: ReturnType<typeof setTimeout> | undefined;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const resetQuietTimer = () => {
    // Fresh sessions get a massive 15-minute idle window to allow the phone
    // all the time it needs to generate, encrypt, and upload massive INITIAL,
    // RECENT, and FULL history chunks. Reconnects use the standard 3-minute window.
    const ms = isFreshSession ? 15 * 60_000 : QUIET_WINDOW_MS;

    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      info(
        `Quiet window (${ms}ms) expired with no activity — closing session.`
      );
      void endSession("quiet-window");
    }, ms);
  };

  const cancelQuietTimer = () => {
    if (quietTimer) {
      clearTimeout(quietTimer);
      quietTimer = undefined;
    }
  };

  /**
   * Primary shutdown path. Waits for all in-flight work to drain (no timers),
   * then closes the socket and pool in order.
   *
   * `reason` is just for logging.
   */
  const endSession = async (reason: string): Promise<void> => {
    if (shutdownRequested) return;
    shutdownRequested = true;

    info(`WhatsApp session ending (reason=${reason}).`);
    cancelQuietTimer();

    if (hardCapTimer) {
      clearTimeout(hardCapTimer);
      hardCapTimer = undefined;
    }

    // 1. Wait for any in-flight history processing to complete.
    if (historyWork.size > 0) {
      info(`Waiting for ${historyWork.size} in-flight history batch(es) to drain…`);
      await historyWork.waitDrain();
      info("History work drained.");
    }

    // 2. Wait for all DB writes to settle.
    if (dbWork.size > 0) {
      info(`Waiting for ${dbWork.size} in-flight DB write(s) to settle…`);
      await dbWork.waitDrain();
      info("DB work drained.");
    }

    // 3. Close the socket and wait for the close event — no setTimeout.
    if (currentSock) {
      const sockClosePromise = waitForSocketClose(currentSock);
      closeSocket(currentSock);
      info("Waiting for socket close event…");
      await sockClosePromise;
      info("Socket closed.");
    }

    // 4. Final drain check after socket close (creds.update may still fire).
    if (dbWork.size > 0) {
      await dbWork.waitDrain();
    }

    // 5. Drain and end the Postgres pool.
    if (!poolClosed) {
      poolClosed = true;
      try {
        await pool.end();
        info("Postgres pool ended cleanly.");
      } catch (err) {
        error("Failed to end Postgres pool", err);
      }
    }

    if (shouldExitAfterDone) {
      info("Exiting process after graceful shutdown.");
      process.exit(0);
    }

    sessionResolve();
  };

  /**
   * Called whenever we're confident history sync is now complete.
   * Idempotent — safe to call multiple times.
   *
   * The DB write is tracked through dbWork so it cannot race with pool.end()
   * even if endSession() is triggered concurrently (e.g. hard-cap fires at
   * the same moment as messaging-history.status arrives).
   */
  const onHistorySyncComplete = (trigger: string): void => {
    if (historySyncCompleted) return;
    historySyncCompleted = true;
    historySyncPending = false;

    const accountId = getAccountId();
    info(
      `History sync marked complete (trigger=${trigger}, accountId=${accountId ?? "unknown"}).`
    );

    if (accountId && !poolClosed) {
      const persistOp = (async () => {
        try {
          await markHistorySyncComplete(pool, accountId);
        } catch (err) {
          error("Failed to persist history sync completion", err);
        }
      })();
      dbWork.track(persistOp);
    }

    // ALWAYS start a quiet window when sync completes.
    // We give it a LONG window (60s) because Baileys might be downloading
    // huge history chunks in the background right now.
    resetQuietTimer();
  };

  // -------------------------------------------------------------------------
  // Socket factory (called once, and again on restartRequired)
  // -------------------------------------------------------------------------

  const createSocket = async (): Promise<WASocket> => {
    const sock = makeWASocket({
      auth: state,
      version,
      browser: Browsers.macOS("Chrome"),
      shouldIgnoreJid: (jid) =>
        typeof jid === "string" && jid.includes("broadcast"),
      markOnlineOnConnect: false,
      // Only request full history when we actually need it.
      syncFullHistory: historySyncPending,
      // Allow all sync types through — filtering happens at the processing layer.
      shouldSyncHistoryMessage: () => true,
      getMessage: async () => ({ conversation: "" }),
    });

    currentSock = sock;
    info("WhatsApp socket created.");

    // ------------------------------------------------------------------
    // creds.update — save credentials to Postgres
    // Intentionally has NO shutdownRequested guard: Baileys fires creds.update
    // as part of the graceful close handshake (key rotation, etc). Dropping
    // those writes would corrupt the auth state for the next session.
    // endSession() calls dbWork.waitDrain() *after* closing the socket, so
    // these late writes are always awaited before pool.end().
    // ------------------------------------------------------------------
    sock.ev.on("creds.update", () => {
      if (poolClosed) return; // pool is already gone — nothing we can do
      const op = (async () => {
        try {
          await saveCreds();
          info("WhatsApp credentials persisted.");
        } catch (err) {
          error("Failed to persist WhatsApp credentials", err);
        }
      })();
      dbWork.track(op);
    });

    // ------------------------------------------------------------------
    // connection.update — the authoritative connection lifecycle event
    // ------------------------------------------------------------------
    sock.ev.on("connection.update", async (update: any) => {
      const code = update.lastDisconnect?.error?.output?.statusCode;
      info("connection.update:", JSON.stringify(update));

      // QR code for fresh pairing
      if (update.qr) {
        info(
          "WhatsApp QR code generated. Scan with your WhatsApp mobile app:"
        );
        qrcode.generate(update.qr, { small: true });
      }

      // ----------------------------------------------------------------
      // Socket closed by WhatsApp
      // ----------------------------------------------------------------
      if (update.connection === "close") {
        info(
          `Connection closed: ${update.lastDisconnect?.error?.message ?? "unknown"} (code=${code})`
        );

        if (code === DisconnectReason.restartRequired) {
          // WhatsApp asks us to reconnect to complete pairing/login.
          info("restartRequired — reconnecting to finalise login.");
          cancelQuietTimer();
          if (!shutdownRequested && !reconnecting) {
            reconnecting = true;
            // Use a promise-based delay rather than a fire-and-forget timeout.
            await new Promise<void>((res) => setTimeout(res, 1500));
            reconnecting = false;
            try {
              await createSocket();
            } catch (err) {
              error("Failed to reconnect after restartRequired", err);
              void endSession("reconnect-failed");
            }
          }
          return;
        }

        if (code === DisconnectReason.loggedOut) {
          info("Logged out — clearing pending sync flag.");
        }

        if (!shutdownRequested) {
          void endSession(`connection-close-code-${code ?? "unknown"}`);
        }
        return;
      }

      // ----------------------------------------------------------------
      // Connection open / paired
      // ----------------------------------------------------------------
      if (update.connection === "open" || update.isNewLogin || update.registered) {
        info("WhatsApp connection is open.");

        // Flush any pending outbox messages (morning brief voice notes, alerts, etc.)
        flushOutbox(sock).catch(err => error("[outbox] flush failed", err));

        // If we already know sync is done (e.g. second reconnect in same session),
        // let the quiet window handle shutdown.
        if (!historySyncPending || historySyncCompleted) {
          resetQuietTimer();
          return;
        }

        // We need history — do NOT short-circuit on accountSyncCounter.
        // Just log and wait for messaging-history.* events.
        info("Waiting for WhatsApp history sync events…");
      }

      // ----------------------------------------------------------------
      // receivedPendingNotifications — WA server flushed offline messages
      // ----------------------------------------------------------------
      // IMPORTANT: this event means the WA *server* has delivered all
      // queued offline *server-side* notifications. It fires BEFORE the
      // phone-driven history sync (AwaitingInitialSync) begins. It is
      // therefore NOT a reliable signal that history sync is complete
      // unless we have already received actual messaging-history.set data.
      //
      // We use it as a completion trigger only when:
      //   seenHistorySetCount > 0  — history batches have arrived and
      //                              been processed, so there is real
      //                              data behind this event.
      // If no history batches have arrived yet, we log and keep waiting
      // for messaging-history.set / messaging-history.status or the hard cap.
      if (update.receivedPendingNotifications === true && historySyncPending) {
        info(
          `receivedPendingNotifications=true — WA server notifications flushed. ` +
          `seenHistorySetCount=${seenHistorySetCount}.`
        );

        if (seenHistorySetCount === 0) {
          info(
            "No messaging-history.set batches received yet — phone-driven history " +
            "sync has not started. Waiting for messaging-history.set / " +
            "messaging-history.status or hard-cap timeout."
          );
          // Do NOT mark complete here. The hard-cap timer is the safety net.
          return;
        }

        // We have seen real history data. Wait for any in-flight batches
        // to finish before marking complete.
        if (historyWork.size > 0) {
          info(`Still processing ${historyWork.size} history batch(es); waiting…`);
          await historyWork.waitDrain();
        }
        if (!historySyncCompleted) {
          info("All history batches processed before receivedPendingNotifications; marking sync complete.");
          onHistorySyncComplete("receivedPendingNotifications");
        }
      }
    });

    // ------------------------------------------------------------------
    // messaging-history.status — explicit sync completion signal from WA
    // ------------------------------------------------------------------
    sock.ev.on("messaging-history.status", async (status: any) => {
      if (shutdownRequested) return;
      info("messaging-history.status:", JSON.stringify(status));

      if (!historySyncPending || historySyncCompleted) return;

      const relevantTypes = [
        proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
        proto.HistorySync.HistorySyncType.RECENT,
        proto.HistorySync.HistorySyncType.FULL,
      ];
      if (!relevantTypes.includes(status.syncType)) return;

      if (status.status === "complete" || status.status === "paused") {
        // Wait for any in-flight batches that arrived before this status event.
        if (historyWork.size > 0) {
          info(
            `messaging-history.status=${status.status}: waiting for ${historyWork.size} batch(es) to drain first…`
          );
          await historyWork.waitDrain();
        }
        onHistorySyncComplete(`messaging-history.status:${status.status}`);
      }
    });

    // ------------------------------------------------------------------
    // messaging-history.set — actual history data batches from the phone
    // ------------------------------------------------------------------
    sock.ev.on("messaging-history.set", (history: any) => {
      if (shutdownRequested) return;

      seenHistorySetCount += 1;

      // Cancel quiet timer while processing — we have active work.
      cancelQuietTimer();

      const op = (async () => {
        const stage =
          historySyncPending && !historySyncCompleted
            ? "initial sync"
            : "periodic sync";
        info(`messaging-history.set #${seenHistorySetCount} received during ${stage}.`);
        if (DEBUG_WHATSAPP_RAW_PAYLOAD) {
          info(
            "Raw messaging-history.set payload:",
            JSON.stringify(history, null, 2)
          );
        }
        try {
          const saved = await saveUnreadHistoryMessages(history);
          unreadProcessed += saved;
        } catch (err) {
          error("Failed to process history batch", err);
        }
      })();

      // Track both work trackers: DB writes inside the op use dbWork directly,
      // the outer batch processing uses historyWork.
      historyWork.track(op);
      dbWork.track(op);

      // When the chunk is done processing, restart the quiet timer so we wait for the next chunk
      op.finally(() => {
        if (!shutdownRequested) {
          resetQuietTimer();
        }
      });
    });

    // ------------------------------------------------------------------
    // messages.upsert — real-time incoming messages
    // ------------------------------------------------------------------
    sock.ev.on("messages.upsert", (upsert: any) => {
      if (shutdownRequested || !Array.isArray(upsert.messages)) return;

      cancelQuietTimer();

      const op = (async () => {
        if (DEBUG_WHATSAPP_RAW_PAYLOAD) {
          info("Raw messages.upsert:", JSON.stringify(upsert, null, 2));
        }
        if (upsert.type !== "notify") {
          info(`messages.upsert type=${upsert.type} — processing history-style messages.`);
        }

        try {
          for (const msg of upsert.messages) {
            if (msg.key.fromMe || !msg.key.remoteJid) continue;

            const isGroup = msg.key.remoteJid?.endsWith("@g.us");
            const participantJid =
              msg.key.participant ||
              (isGroup ? (msg as any).participant : null) ||
              null;
            const senderId = participantJid || msg.key.remoteJid;
            const messageText = extractTextMessage(msg.message) || "[Media Message]";
            
            let mediaData: { mimeType: string; dataBase64: string } | undefined;
            const msgType = Object.keys(msg.message || {})[0];
            if (msgType === "imageMessage" || msgType === "audioMessage" || msgType === "videoMessage" || msgType === "documentMessage") {
              try {
                const buffer = await downloadMediaMessage(msg, "buffer", {}, { logger: Object.assign(info, { child: () => info }) as any });
                if (buffer) {
                  const m = msg.message as any;
                  const mType = m[msgType];
                  mediaData = {
                    mimeType: mType?.mimetype || "application/octet-stream",
                    dataBase64: buffer.toString("base64")
                  };
                  info(`[whatsappPoller] Downloaded media from ${senderId} - type: ${mediaData.mimeType}, size: ${buffer.length}`);
                }
              } catch (e) {
                error(`[whatsappPoller] Failed to download media message from ${senderId}`, e);
              }
            }

            if (!messageText && !mediaData) continue;

            try {
              await saveWhatsappMessage({
                senderId,
                messageId: msg.key.id || `${senderId}:${msg.messageTimestamp}`,
                messageText: messageText === "[Media Message]" ? (mediaData ? "[Attached Media]" : "") : messageText,
                whatsappTimestamp: Number(msg.messageTimestamp) || Date.now(),
                metadata: {
                  remoteJid: msg.key.remoteJid,
                  groupJid: isGroup ? msg.key.remoteJid : undefined,
                  participant: participantJid,
                  pushName: (msg as any).pushName || undefined,
                  messageStubType: msg.messageStubType,
                  upsertType: upsert.type,
                  mediaData,
                },
              });
              info(`Saved message from ${senderId} (${upsert.type}).`);
            } catch (err) {
              error("Failed to save WhatsApp message", err);
            }
          }
        } catch (err) {
          if (isPreKeyError(err)) {
            info("Skipped undecryptable group message (missing PreKey).");
            return;
          }
          throw err;
        }

        // After processing live messages, nudge the quiet timer.
        if (!historySyncPending || historySyncCompleted) {
          resetQuietTimer();
        }
      })();

      dbWork.track(op);
    });

    // ------------------------------------------------------------------
    // chats.upsert / chats.update
    // ------------------------------------------------------------------
    const handleChats = (chats: any[]) => {
      if (!Array.isArray(chats) || shutdownRequested) return;
      cancelQuietTimer();
      const op = (async () => {
        for (const chat of chats) {
          const saved = await handleUnreadChatMetadata(chat);
          unreadProcessed += saved;
        }
        resetQuietTimer();
      })();
      dbWork.track(op);
    };

    sock.ev.on("chats.upsert", handleChats);
    sock.ev.on("chats.update", handleChats);

    // ------------------------------------------------------------------
    // groups.upsert / groups.update
    // ------------------------------------------------------------------
    const handleGroups = (groups: any[]) => {
      if (!Array.isArray(groups) || shutdownRequested) return;
      const op = (async () => {
        for (const group of groups) {
          const jid: string = group?.id || group?.jid;
          const subject: string = group?.subject;
          if (jid && subject) {
            try {
              await saveWhatsappGroup(jid, subject);
              info(`Saved group "${subject}" for ${jid}.`);
            } catch (err) {
              error("Failed to save WhatsApp group", err);
            }
          }
        }
      })();
      dbWork.track(op);
    };

    sock.ev.on("groups.upsert", handleGroups);
    sock.ev.on("groups.update", handleGroups);

    return sock;
  };

  // -------------------------------------------------------------------------
  // Install absolute hard-cap timer — pure safety net, not primary mechanism.
  // -------------------------------------------------------------------------
  hardCapTimer = setTimeout(() => {
    info(
      `Hard-cap timeout (${hardCapMs}ms) reached — forcing session end. ` +
        "This means WA never sent a completion signal; check connectivity."
    );
    void endSession("hard-cap-timeout");
  }, hardCapMs);

  // -------------------------------------------------------------------------
  // Start the socket, then await the session-done promise.
  // Everything from here on is event-driven.
  // -------------------------------------------------------------------------
  await createSocket();

  // NOTE: For reconnect sessions the quiet timer is started inside the
  // connection.update handler once the socket is confirmed open (line ~687).
  // Do NOT start it here — the socket hasn't opened yet and the timer would
  // race against the connection attempt, potentially killing the session
  // before WA has even finished the TLS handshake.

  await sessionDone;

  if (unreadProcessed === 0) {
    info("Session completed — no unread messages found.");
  } else {
    info(`Session completed — ${unreadProcessed} unread message(s) processed.`);
  }
}

// ---------------------------------------------------------------------------
// Clear auth state
// ---------------------------------------------------------------------------

export async function clearWhatsappAuthState(): Promise<void> {
  const databaseUrl = getDatabaseUrl();
  const pool = new Pool({
    connectionString: normalizeConnectionString(databaseUrl),
    max: 5,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis:
      Number(process.env.WHATSAPP_PG_CONNECTION_TIMEOUT_MS) || 15_000,
  });
  const { deleteSession } = await usePostgreSQLAuthState(pool, AUTH_TABLE_NAME);
  await deleteSession();
  await pool.end();
  info("Cleared WhatsApp auth state from database.");
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export function startWhatsappScheduler(): void {
  info("Starting WhatsApp polling scheduler.");

  cron.schedule("0 8 * * *", () => {
    info("WhatsApp polling window has opened for the day.");
  });

  cron.schedule("0 20 * * *", () => {
    info("WhatsApp polling window has closed for the day.");
  });

  const scheduleNext = async (): Promise<void> => {
    const delayMs = getRandomPollDelayMs();
    const nextRun = new Date(Date.now() + delayMs);
    info(`Next WhatsApp polling check scheduled at ${nextRun.toISOString()}`);

    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

    if (isDaytime(new Date())) {
      try {
        await pollWhatsappInboxOnce();
      } catch (err) {
        error("WhatsApp polling run failed", err);
      }
    } else {
      info("Skipping poll — outside daytime window.");
    }

    scheduleNext();
  };

  scheduleNext();
}
