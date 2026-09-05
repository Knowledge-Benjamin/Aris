import { PlannerService } from "./services/plannerService";
import { GemmaService } from "./services/gemmaService";
import { getDatabasePool } from "./db/db";
import { GoogleAccountStore } from "./db/googleAccountStore";
import { info } from "./utils/logger";

import { ArisService } from "./services/arisService";
import { MemoryStore } from "./db/memoryStore";
import { ContextStore } from "./db/contextStore";
import { getPendingWhatsappChat, markWhatsappChatProcessed } from "./db/whatsappStore";
import { googleService } from "./services/googleService";

const pool = getDatabasePool();
const gemmaService = new GemmaService();
const plannerService = new PlannerService(gemmaService);
const googleAccountStore = new GoogleAccountStore(pool);

const memoryStore = new MemoryStore(pool);
const contextStore = new ContextStore(pool);
const arisService = new ArisService(memoryStore, contextStore, gemmaService);

export const plannerServiceInstance = plannerService;

// Set of meeting URLs we have already alerted the user about (keyed by eventId)
const alertedMeetings = new Set<string>();

export function startBackgroundJobs() {
  info("[BackgroundJobs] Starting async random-interval ingestion loop to prevent WhatsApp bot ban.");
  scheduleNextIngestion();
  startWhatsappChatPoller();
  startMeetingAlertPoller();
}

function startWhatsappChatPoller() {
  setInterval(async () => {
    try {
      const pending = await getPendingWhatsappChat(5);
      for (const chat of pending) {
        try {
          info(`[BackgroundJobs] Processing incoming WhatsApp chat from user ${chat.userId}`);
          const res = await arisService.handleChat({
            message: chat.messageText || "[Attached Media]",
            sessionId: "whatsapp-direct",
            userId: chat.userId,
            mediaData: chat.mediaData
          });
          
          if (res.arisReply) {
            // Push the reply to the WhatsApp Outbox
            await pool.query(
              `INSERT INTO whatsapp_outbox (user_id, to_jid, message_type, body) VALUES ($1, $2, 'text', $3)`,
              [chat.userId, chat.senderJid, res.arisReply]
            );
          }
          await markWhatsappChatProcessed(chat.id, 'processed');
        } catch (err) {
          console.error(`[BackgroundJobs] Error processing whatsapp chat ${chat.id}`, err);
          await markWhatsappChatProcessed(chat.id, 'failed');
        }
      }
    } catch (err) {
      // suppress logging to avoid spam
    }
  }, 3000);
}

function startMeetingAlertPoller() {
  // Check every 60 seconds whether there is a meeting starting in the next 5 minutes
  setInterval(async () => {
    try {
      const usersResult = await pool.query(`SELECT id FROM users`);
      for (const row of usersResult.rows) {
        const userId = row.id;
        const googleAccount = await googleAccountStore.getGoogleAccount(userId);
        if (!googleAccount) continue;

        const now = new Date();
        const in6Min = new Date(now.getTime() + 6 * 60 * 1000);

        const events = await googleService.getCalendarEvents(
          googleAccount,
          5,
          now.toISOString(),
          in6Min.toISOString()
        ).catch(() => []);

        for (const event of events) {
          const eventId = event.id;
          if (!eventId || alertedMeetings.has(eventId)) continue;

          // Check if the event has a Meet or Zoom link
          const desc = (event.description || "") + (event.location || "");
          const meetMatch = desc.match(/https:\/\/meet\.google\.com\/[a-z0-9-]+/i);
          const zoomMatch = desc.match(/https:\/\/[a-z0-9.]*zoom\.us\/j\/[0-9]+[^\s"]*/i);
          const meetingUrl = meetMatch?.[0] || zoomMatch?.[0];

          if (!meetingUrl) continue;

          // Mark as alerted immediately to prevent duplicate pings
          alertedMeetings.add(eventId);

          const title = event.summary || "Unnamed Meeting";
          const startTime = event.start?.dateTime
            ? new Date(event.start.dateTime).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
            : "soon";

          // Push WhatsApp alert to user's self JID via outbox
          const alertText = `📅 *${title}* starts at *${startTime}* — in about 5 minutes.\n\nShould I join and take notes? Reply "join meeting" to confirm, or send me the link directly.`;

          await pool.query(
            `INSERT INTO whatsapp_outbox (user_id, to_jid, message_type, body)
             SELECT $1, sender_jid, 'text', $2
             FROM whatsapp_chat_inbox
             WHERE user_id = $1 AND status = 'processed'
             ORDER BY created_at DESC LIMIT 1`,
            [userId, alertText]
          ).catch(() => {
            // If no prior chat session exists, fall back to inserting a generic self-JID row
            pool.query(
              `INSERT INTO whatsapp_outbox (user_id, to_jid, message_type, body) VALUES ($1, 'self', 'text', $2)`,
              [userId, alertText]
            ).catch(() => {});
          });

          info(`[MeetingAlertPoller] Notified user ${userId} about upcoming meeting: ${title}`);
        }
      }
    } catch (err) {
      // suppress to avoid log spam
    }
  }, 60_000);
}

function scheduleNextIngestion() {
  // Random interval between 0 and 2 hours (0 to 7200000 ms)
  const nextRunMs = Math.floor(Math.random() * 7200000);
  info(`[BackgroundJobs] Next ingestion scheduled in ${Math.round(nextRunMs / 60000)} minutes.`);
  
  setTimeout(async () => {
    await runIngestionCycle();
    scheduleNextIngestion(); // Reschedule recursively
  }, nextRunMs);
}

async function runIngestionCycle() {
  try {
    info("[BackgroundJobs] Running ingestion cycle for all users.");
    const res = await pool.query(`SELECT id FROM users`);
    
    for (const row of res.rows) {
      const userId = row.id;
      const googleAccount = await googleAccountStore.getGoogleAccount(userId);
      await plannerService.ingestRecentContext(userId, googleAccount);
      
      // We will also occasionally trigger the daily plan here (e.g. if time is between 6 AM and 8 AM)
      const hour = new Date().getHours();
      if (hour >= 6 && hour <= 8) {
        // We could add a check if it already ran today, for now just trigger it
        await plannerService.generateDailyPlan(userId, googleAccount);
      }
    }
  } catch (err) {
    console.error("[BackgroundJobs] Error in ingestion cycle", err);
  }
}
