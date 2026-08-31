import { getPendingWhatsappMessages } from "../db/whatsappStore";
import { googleService } from "./googleService";
import { GoogleAccountRecord } from "../db/googleAccountStore";
import { goalsStore } from "../db/goalsStore";
import { whatsappOutboxStore } from "../db/whatsappOutboxStore";
import { getSelfJid } from "../db/whatsappAuthStore";
import { gcsService } from "./gcsService";
import { VoiceService } from "./voiceService";
import { GemmaService } from "./gemmaService";
import { info, error } from "../utils/logger";

const voiceService = new VoiceService();

export class PlannerService {
  constructor(private gemmaService: GemmaService) {}

  // ─── 1. Context Ingestion ──────────────────────────────────────────────────
  /**
   * Reads unread WA messages + emails, then does a strategic LLM reasoning pass
   * to extract: (a) state-delta facts, (b) any urgent actions, (c) persona shift.
   */
  async ingestRecentContext(userId: number, googleAccount?: GoogleAccountRecord) {
    info(`[PlannerService] Ingesting recent context for user ${userId}`);
    let contextText = "";

    try {
      // 1a. WhatsApp messages
      const pendingWa = await getPendingWhatsappMessages(50);
      if (pendingWa.length > 0) {
        contextText += "Recent WhatsApp Messages:\n";
        pendingWa.forEach(m => {
          contextText += `- [${m.receivedAt}] From ${m.senderId}: ${m.messageText}\n`;
        });
      }

      // 1b. Gmail messages
      if (googleAccount) {
        const emails = await googleService.getGmailMessages(googleAccount, 10);
        if (emails.length > 0) {
          contextText += "\nRecent Emails:\n";
          emails.forEach(e => {
            contextText += `- Subject: ${e?.subject} | From: ${e?.from}\n`;
          });
        }
      }

      if (!contextText) {
        info(`[PlannerService] No new context for user ${userId}`);
        return;
      }

      const state = await goalsStore.getUserState(userId);
      const goals = await goalsStore.getActiveGoals(userId);

      // 1c. Deep strategic reasoning pass
      const prompt = `You are Aris's autonomous background reasoning engine.
Analyze the following recent messages/emails for a user whose active goals are: ${JSON.stringify(goals.map((g: any) => g.title))}.
Current state profile: ${JSON.stringify(state.state)}

MESSAGES / EMAILS:
${contextText}

Perform the following reasoning steps and return a SINGLE JSON object:
1. "state_updates": any new facts to merge into the profile (e.g. {"mood": "stressed", "client_x_status": "unhappy"})
2. "urgent_actions": array of strings describing any immediate actions Aris should take (e.g. "Reschedule pitch deck block to today 10am", "Reply to client X urgently")
3. "persona_shift": optional new coach persona if user is clearly slipping or under pressure (e.g. "tough-love", "crisis-mode", "military-drill-sergeant"). Leave null if no change needed.

Respond ONLY in valid JSON. Example:
{"state_updates": {"mood": "stressed"}, "urgent_actions": ["Move pitch prep to 9am"], "persona_shift": "tough-love"}`;

      const response = await this.gemmaService.requestArisAdvice(prompt);
      const cleaned = response.reply.replace(/```json/g, "").replace(/```/g, "").trim();
      let reasoning: any = {};
      try { reasoning = JSON.parse(cleaned); } catch { /* ignore */ }

      // Apply state updates
      if (reasoning.state_updates && Object.keys(reasoning.state_updates).length > 0) {
        await goalsStore.updateUserState(userId, reasoning.state_updates);
        info(`[PlannerService] State updated: ` + JSON.stringify(reasoning.state_updates));
      }

      // Apply persona shift
      if (reasoning.persona_shift && typeof reasoning.persona_shift === "string") {
        await goalsStore.updateCoachPersona(userId, reasoning.persona_shift);
        info(`[PlannerService] Persona shifted to: ${reasoning.persona_shift}`);
      }

      // Queue urgent actions as WhatsApp self-messages (text notification to user)
      if (Array.isArray(reasoning.urgent_actions) && reasoning.urgent_actions.length > 0) {
        const selfJid = await getSelfJid();
        if (selfJid) {
          const body = `⚡ *Aris Alert* ⚡\n\nBased on your latest messages, here's what needs your attention now:\n\n` +
            reasoning.urgent_actions.map((a: string, i: number) => `${i + 1}. ${a}`).join("\n");
          await whatsappOutboxStore.enqueue(selfJid, "text", body, undefined, undefined, userId);
          info(`[PlannerService] Queued ${reasoning.urgent_actions.length} urgent action(s) to WhatsApp outbox`);
        }
      }

    } catch (err) {
      error(`[PlannerService] Ingestion failed for user ${userId}`, err);
    }
  }

  // ─── 2. Daily Plan Generation + TTS Morning Brief ─────────────────────────
  /**
   * Generates today's plan, blocks it on Google Calendar, synthesizes a TTS
   * voice note via Google Wavenet, uploads to GCS, and queues it to the
   * WhatsApp outbox so the user receives it as a voice message on wake-up.
   */
  async generateDailyPlan(userId: number, googleAccount?: GoogleAccountRecord) {
    info(`[PlannerService] Generating daily plan for user ${userId}`);
    try {
      const state = await goalsStore.getUserState(userId);
      const activeGoals = await goalsStore.getActiveGoals(userId);
      const pendingTasks = await goalsStore.getPendingTasks(userId);

      const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

      // 2a. LLM generates both: (i) structured task list, (ii) spoken morning brief script
      const prompt = `You are Aris, an aggressive and strategic life coach. Today is ${today}.
User's Current State: ${JSON.stringify(state.state)}
Active Goals: ${JSON.stringify(activeGoals.map((g: any) => g.title))}
Coach Persona: ${state.coachPersona}
Unfinished Tasks from yesterday: ${JSON.stringify(pendingTasks.map((t: any) => t.title))}

Generate a JSON object with two keys:
1. "tasks": array of 2-3 objects with "title", "description", "durationHours" — concrete actions for TODAY.
2. "morning_brief": a spoken script (under 90 seconds when read aloud, around 200 words) for a WhatsApp voice note. 
   Be direct, strategic, and match the coach persona. Reference the user's goals. 
   Mention any unfinished items. Give today's battle plan. End with a rallying call.

Example:
{
  "tasks": [{"title": "Finalize pitch deck", "description": "Complete slides 8-12", "durationHours": 2}],
  "morning_brief": "Good morning. Yesterday you left the pitch deck half-done. That's not acceptable. Today we fix it..."
}

Respond ONLY in valid JSON.`;

      const response = await this.gemmaService.requestArisAdvice(prompt);
      const cleaned = response.reply.replace(/```json/g, "").replace(/```/g, "").trim();
      let plan: any = {};
      try { plan = JSON.parse(cleaned); } catch {
        error("[PlannerService] Failed to parse daily plan", cleaned);
        return;
      }

      const tasks: any[] = Array.isArray(plan.tasks) ? plan.tasks : [];
      const briefScript: string = plan.morning_brief || "";

      // 2b. Schedule tasks on Google Calendar
      if (tasks.length > 0) {
        const now = new Date();
        let currentHour = Math.max(now.getHours() + 1, 8); // Start at 8am minimum
        for (const task of tasks) {
          const startTime = new Date(now);
          startTime.setHours(currentHour, 0, 0, 0);
          const endTime = new Date(startTime.getTime() + (task.durationHours || 1) * 60 * 60 * 1000);

          let eventId: string | undefined;
          if (googleAccount) {
            const event = await googleService.createCalendarEvent(googleAccount, {
              summary: `[Aris Goal] ${task.title}`,
              description: task.description || "",
              start: { dateTime: startTime.toISOString() },
              end: { dateTime: endTime.toISOString() },
            });
            eventId = event.id || undefined;
          }

          await goalsStore.addDailyTask(
            userId, task.title, task.description,
            activeGoals[0]?.id, startTime, endTime, eventId
          );
          currentHour += (task.durationHours || 1) + 1;
        }
        info(`[PlannerService] Scheduled ${tasks.length} tasks for user ${userId}`);
      }

      // 2c. Synthesize TTS voice note and deliver via WhatsApp outbox
      const selfJid = await getSelfJid();
      if (selfJid && briefScript) {
        try {
          const taskList = tasks.map((t: any, i: number) => `${i + 1}. ${t.title}`).join("\n");

          // First send a text summary card
          const textBody = `🌅 *Good Morning — Aris Daily Brief*\n\n` +
            `*Today's Mission:*\n${taskList}\n\n` +
            `*Persona Mode:* ${state.coachPersona.toUpperCase()}\n\n` +
            `_Voice note incoming ↓_`;
          await whatsappOutboxStore.enqueue(selfJid, "text", textBody, undefined, undefined, userId);

          // Then synthesize the brief as a Wavenet voice note
          const { audioBase64, mimeType } = await voiceService.synthesizeSpeech(briefScript, "OGG_OPUS");
          const audioBuffer = Buffer.from(audioBase64, "base64");

          // Upload to GCS
          const destPath = `aris-briefs/${userId}/${Date.now()}.ogg`;
          const gcsUri = await gcsService.upload(audioBuffer, destPath, "audio/ogg");

          // Queue voice note in outbox
          await whatsappOutboxStore.enqueue(selfJid, "audio", undefined, gcsUri, "audio/ogg", userId);
          info(`[PlannerService] Morning brief voice note queued → ${gcsUri}`);

        } catch (ttsErr) {
          error("[PlannerService] TTS/GCS delivery failed, falling back to text", ttsErr);
          // Fallback: send as plain text
          if (selfJid) {
            await whatsappOutboxStore.enqueue(selfJid, "text", `🎙️ *Morning Brief*\n\n${briefScript}`, undefined, undefined, userId);
          }
        }
      }

    } catch (err) {
      error(`[PlannerService] Daily plan generation failed for user ${userId}`, err);
    }
  }
}
