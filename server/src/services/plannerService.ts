import { getPendingWhatsappMessages } from "../db/whatsappStore";
import { googleService } from "./googleService";
import { GoogleAccountRecord } from "../db/googleAccountStore";
import { goalsStore } from "../db/goalsStore";
import { whatsappOutboxStore } from "../db/whatsappOutboxStore";
import { getSelfJid } from "../db/whatsappAuthStore";
import { gcsService } from "./gcsService";
import { VoiceService } from "./voiceService";
import { GemmaService } from "./gemmaService";
import { WeatherService } from "./weatherService";
import { NewsService } from "./newsService";
import { SearchClient } from "./searchClient";
import { ExtractClient } from "./extractClient";
import { PdfService } from "./pdfService";
import { getDatabasePool } from "../db/db";
import { info, error } from "../utils/logger";

const voiceService = new VoiceService();
const weatherService = new WeatherService();
const newsService = new NewsService();
let searchClient: SearchClient | undefined;
let extractClient: ExtractClient | undefined;
try {
  searchClient = new SearchClient();
  extractClient = new ExtractClient();
} catch (e) {
  // gracefully handle missing SEARCH_SERVICE_URL during init
}

/**
 * A meeting action item with spatial and temporal anchors.
 * - temporalAnchor: when the action should be done, expressed as a natural-language string from the meeting
 *   (e.g. "by end of Friday", "next Monday morning", "within 48 hours", "ASAP").
 *   This is used to resolve a concrete ISO datetime for the calendar event.
 * - spatialAnchor: where the action takes place (e.g. "at the Kampala office", "on Zoom", "online", or null if unspecified).
 * - assignee: who is responsible ("Me" if it is the meeting host, or the name/role of the assigned person).
 */
export interface ActionItem {
  task: string;
  assignee: string;
  temporalAnchor: string | null;   // e.g. "by Friday 5pm", "next Monday", "in 2 days", "ASAP"
  spatialAnchor: string | null;    // e.g. "at the office", "online", "Zoom call", null
  resolvedDateTime?: string | null; // ISO 8601 — resolved by Gemma from temporalAnchor
}

interface MeetingSession {
  url: string;
  botService: any;
  audioBuffer: Buffer[];
  lastChunkProcessedAt: number;
  runningNotes: string;
  actionItems: ActionItem[];
}

export class PlannerService {
  private activeMeeting: MeetingSession | null = null;

  constructor(private gemmaService: GemmaService) {}

  private meetingUserId: number | null = null;

  startMeeting(url: string, botService: any, userId?: number) {
    if (this.activeMeeting) throw new Error("A meeting is already active.");
    this.meetingUserId = userId ?? null;
    this.activeMeeting = {
      url, botService, audioBuffer: [], lastChunkProcessedAt: Date.now(), runningNotes: "", actionItems: []
    };
    botService.on('audioChunk', (chunk: Buffer) => {
      if (!this.activeMeeting) return;
      this.activeMeeting.audioBuffer.push(chunk);
      if (Date.now() - this.activeMeeting.lastChunkProcessedAt > 30000) this.processMeetingAudioBuffer();
    });
    botService.on('left', () => this.finishMeeting());
  }

  private async finishMeeting() {
    if (!this.activeMeeting) return;
    const session = this.activeMeeting;
    this.activeMeeting = null; // clear first to prevent re-entry

    await this.processMeetingAudioBuffer();
    info(`[MeetingProcessor] Meeting ended. Compiling final notes and delivering...`);

    const title = `Meeting Notes — ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`;
    const dateStr = new Date().toLocaleString();
    const fullNotes = `# ${title}\n\n${session.runningNotes}\n\n## Action Items\n${session.actionItems.map(a => `- ${a}`).join("\n")}`;

    // 1. Generate PDF
    const pdfService = new PdfService();
    let pdfBuffer: Buffer | null = null;
    try {
      pdfBuffer = await pdfService.generateNotesPdf(title, dateStr, fullNotes);
      info(`[MeetingProcessor] PDF generated (${pdfBuffer.length} bytes)`);
    } catch (e) {
      error("[MeetingProcessor] Failed to generate PDF", e);
    }

    if (this.meetingUserId) {
      const pool = getDatabasePool();
      const accountResult = await pool.query(`SELECT * FROM google_accounts WHERE user_id = $1 LIMIT 1`, [this.meetingUserId]).catch(() => null);
      const account = accountResult?.rows?.[0];

      // Helper: format a single ActionItem as a human-readable string
      const formatAction = (item: ActionItem) => {
        let line = `• [${item.assignee}] ${item.task}`;
        if (item.temporalAnchor) line += ` — ⏰ ${item.temporalAnchor}`;
        if (item.spatialAnchor)  line += ` 📍 ${item.spatialAnchor}`;
        return line;
      };

      const actionLines = session.actionItems.map(formatAction).join("\n");

      // 2. Email the PDF
      if (account?.google_email && pdfBuffer) {
        const summaryText = [
          `Hi Benjamin,`,
          ``,
          `Your meeting has ended. Here are the AI-generated notes:`,
          ``,
          session.runningNotes,
          ``,
          `── Action Items ──`,
          actionLines,
          ``,
          `— Aris`
        ].join("\n");

        await googleService.sendEmail(
          account,
          account.google_email,
          title,
          summaryText,
          { filename: "meeting-notes.pdf", mimeType: "application/pdf", contentBase64: pdfBuffer.toString("base64") }
        ).catch(e => error("[MeetingProcessor] Email send failed", e));
        info("[MeetingProcessor] Email with PDF sent.");
      }

      // 3. Push text summary + PDF to WhatsApp via outbox
      const waText = [
        `📝 *Meeting Finished!*`,
        ``,
        `*Summary:*`,
        session.runningNotes.slice(0, 500),
        session.runningNotes.length > 500 ? `_...continued in PDF_` : ``,
        ``,
        `*Action Items:*`,
        ...session.actionItems.map(item => {
          let line = `• *[${item.assignee}]* ${item.task}`;
          if (item.temporalAnchor) line += `\n  ⏰ ${item.temporalAnchor}`;
          if (item.spatialAnchor)  line += `\n  📍 ${item.spatialAnchor}`;
          return line;
        })
      ].join("\n");

      await pool.query(
        `INSERT INTO whatsapp_outbox (user_id, to_jid, message_type, body)
         SELECT $1, sender_jid, 'text', $2 FROM whatsapp_chat_inbox
         WHERE user_id = $1 AND status = 'processed' ORDER BY created_at DESC LIMIT 1`,
        [this.meetingUserId, waText]
      ).catch(() => {});

      // Then upload PDF to GCS and enqueue as document
      if (pdfBuffer && gcsService) {
        try {
          const gcsUri = await gcsService.upload(pdfBuffer, `meeting-notes-${Date.now()}.pdf`, "application/pdf");
          await pool.query(
            `INSERT INTO whatsapp_outbox (user_id, to_jid, message_type, body, media_gcs_uri, media_mime_type)
             SELECT $1, sender_jid, 'document', $2, $3, 'application/pdf' FROM whatsapp_chat_inbox
             WHERE user_id = $1 AND status = 'processed' ORDER BY created_at DESC LIMIT 1`,
            [this.meetingUserId, "meeting-notes.pdf", gcsUri]
          ).catch(() => {});
          info("[MeetingProcessor] PDF queued for WhatsApp delivery.");
        } catch (e) {
          error("[MeetingProcessor] GCS upload failed", e);
        }
      }

      // 4. Add action items to Google Calendar — anchored to resolvedDateTime + location
      if (account && session.actionItems.length > 0) {
        const nextBusinessDay = new Date(Date.now() + 24 * 60 * 60 * 1000);
        nextBusinessDay.setHours(9, 0, 0, 0);

        for (const item of session.actionItems) {
          const startDt = item.resolvedDateTime
            ? new Date(item.resolvedDateTime)
            : nextBusinessDay;
          const endDt   = new Date(startDt.getTime() + 30 * 60 * 1000); // 30-min block

          const eventDescription = [
            `Task: ${item.task}`,
            `Assignee: ${item.assignee}`,
            item.temporalAnchor ? `Deadline: ${item.temporalAnchor}` : null,
            item.spatialAnchor  ? `Location context: ${item.spatialAnchor}` : null,
            ``,
            `From meeting on ${dateStr}`,
          ].filter(Boolean).join("\n");

          await googleService.createCalendarEvent(account, {
            summary:     `[Action] ${item.task}`,
            description: eventDescription,
            location:    item.spatialAnchor ?? undefined,
            start:       { dateTime: startDt.toISOString() },
            end:         { dateTime: endDt.toISOString() },
          }).catch(() => {});
        }
        info(`[MeetingProcessor] Added ${session.actionItems.length} anchored action items to Google Calendar.`);
      }
    }

    info("[MeetingProcessor] All deliveries complete.");
  }

  private async processMeetingAudioBuffer() {
    if (!this.activeMeeting || this.activeMeeting.audioBuffer.length === 0) return;
    
    const combinedBuffer = Buffer.concat(this.activeMeeting.audioBuffer);
    this.activeMeeting.audioBuffer = []; // reset
    this.activeMeeting.lastChunkProcessedAt = Date.now();
    
    const mediaParts: Array<{ inlineData: { mimeType: string; data: string } }> = [{
      inlineData: {
        mimeType: "video/webm",
        data: combinedBuffer.toString("base64")
      }
    }];

    const nowIso = new Date().toISOString();

    const prompt = `You are Aris, an expert AI meeting notetaker. The current date/time is ${nowIso}.
Here is the next 30 seconds of audio from the meeting.

Current running notes:
${this.activeMeeting.runningNotes}

Your job:
1. Update the running notes with new information from this audio chunk.
2. Identify any NEW action items spoken in this audio (e.g. "John will send the report by Friday", "we need to book a venue for next Monday").
3. For EACH new action item, extract:
   - task: what needs to be done (concise imperative sentence)
   - assignee: who is responsible ("Me" if the meeting host/organizer, otherwise the person's name or role)
   - temporalAnchor: EXACT time expression spoken (e.g. "by end of Friday", "next Monday at 10am", "within 48 hours", "ASAP", null if none mentioned)
   - spatialAnchor: location or medium if mentioned (e.g. "at the Kampala office", "via Zoom", "on-site", "online", null if not mentioned)
   - resolvedDateTime: convert temporalAnchor to an ISO 8601 datetime string relative to ${nowIso}. If temporalAnchor is null or "ASAP", set this to the next business day at 09:00 local time. Use UTC+3 (East Africa Time).

Output ONLY valid JSON in this exact shape:
{
  "updated_notes": "...",
  "new_action_items": [
    {
      "task": "Send the Q3 financial report to the board",
      "assignee": "Me",
      "temporalAnchor": "by end of Friday",
      "spatialAnchor": "via email",
      "resolvedDateTime": "2026-09-05T17:00:00+03:00"
    }
  ]
}
If there are no new action items, output an empty array for new_action_items.
Do NOT include any text outside the JSON object.`;

    try {
      const response = await this.gemmaService.requestArisAdvice(prompt, mediaParts);
      const cleaned = response.reply.replace(/```json/g, "").replace(/```/g, "").trim();
      const data = JSON.parse(cleaned);
      if (data.updated_notes) this.activeMeeting.runningNotes = data.updated_notes;
      if (Array.isArray(data.new_action_items) && data.new_action_items.length > 0) {
        this.activeMeeting.actionItems.push(...data.new_action_items as ActionItem[]);
        info(`[MeetingProcessor] Extracted ${data.new_action_items.length} new action item(s).`);
      }
      info(`[MeetingProcessor] Processed 30s chunk. Notes: ${this.activeMeeting.runningNotes.length} chars, total actions: ${this.activeMeeting.actionItems.length}`);
    } catch (err) {
      error(`[MeetingProcessor] Error processing audio chunk`, err);
    }
  }

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
      const mediaParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
      if (pendingWa.length > 0) {
        contextText += "Recent WhatsApp Messages:\n";
        pendingWa.forEach(m => {
          contextText += `- [${m.receivedAt}] From ${m.senderId}: ${m.messageText}\n`;
          if (m.metadata?.mediaData) {
            const media = m.metadata.mediaData as any;
            if (media.mimeType && media.dataBase64) {
              mediaParts.push({ inlineData: { mimeType: media.mimeType, data: media.dataBase64 } });
            }
          }
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

      const state = await goalsStore.getUserState(userId);
      const goals = await goalsStore.getActiveGoals(userId);
      const pendingTasks = await goalsStore.getPendingTasks(userId);

      // 1c. Short-term weather context (next 4 hours)
      const lat = state.state?.lat || 40.7128;
      const lon = state.state?.lon || -74.0060;
      let weatherAlertContext = "";
      try {
        const forecast = await weatherService.getForecast(lat, lon, undefined, ["temperature_2m", "precipitation_probability"]);
        if (forecast.hourly?.precipitation_probability) {
          const next4Hours = forecast.hourly.precipitation_probability.slice(0, 4);
          const maxPrecip = Math.max(...next4Hours);
          if (maxPrecip > 30) {
            weatherAlertContext = `\nWARNING: High chance of precipitation (${maxPrecip}%) in the next 4 hours.`;
            contextText += weatherAlertContext;
          }
        }
      } catch { /* ignore */ }

      // 1d. Proactive News & Internet Monitoring (with full article scraping)
      const topics = state.state?.monitored_topics;
      if (Array.isArray(topics) && topics.length > 0) {
        info(`[PlannerService] Monitoring ${topics.length} topics with full article scraping`);
        for (const topic of topics.slice(0, 3)) { // limit to 3 topics per cycle
          try {
            const urlsToScrape: string[] = [];

            // Step 1: Get top 3 news headlines + their URLs
            const news = await newsService.getTopNews(topic, 3);
            if (news.length > 0) {
              contextText += `\nLatest News for "${topic}":\n`;
              news.forEach(n => {
                contextText += `- ${n.title} (${n.source}) [${n.link}]\n`;
                if (n.link) urlsToScrape.push(n.link);
              });
            }

            // Step 2: Get top 3 web search results + their URLs
            if (searchClient) {
              const searchRes = await searchClient.search({ query: topic, limit: 3 });
              if (searchRes.results?.length > 0) {
                contextText += `\nWeb Search for "${topic}":\n`;
                searchRes.results.slice(0, 3).forEach((r: any) => {
                  contextText += `- ${r.title}: ${r.snippet} [${r.url}]\n`;
                  if (r.url) urlsToScrape.push(r.url);
                });
              }
            }

            // Step 3: Scrape the full article content from all collected URLs
            if (extractClient && urlsToScrape.length > 0) {
              info(`[PlannerService] Scraping ${urlsToScrape.length} URLs for topic "${topic}"`);
              try {
                const extracted = await extractClient.extract({ urls: urlsToScrape, limit: 1500 });
                const readable = extracted.results.filter(r => !r.error && r.content && r.content.length > 200);
                if (readable.length > 0) {
                  contextText += `\nFull Article Content for "${topic}":\n`;
                  readable.forEach(r => {
                    // Truncate per article to keep context manageable
                    const preview = r.content.slice(0, 800);
                    contextText += `\n[${r.title}]\n${preview}${r.content.length > 800 ? "...(truncated)" : ""}\n`;
                  });
                }
              } catch (scrapeErr) {
                error(`[PlannerService] Article scraping failed for topic ${topic}`, scrapeErr);
              }
            }

          } catch (e) {
            error(`[PlannerService] Failed to monitor topic ${topic}`, e);
          }
        }
      }

      if (!contextText) {
        info(`[PlannerService] No new context for user ${userId}`);
        return;
      }

      // 1d. Deep strategic reasoning pass
      const prompt = `You are Aris's autonomous background reasoning engine.
Analyze the following recent events for a user whose active goals are: ${JSON.stringify(goals.map((g: any) => g.title))}.
Current state profile: ${JSON.stringify(state.state)}
Today's Pending Tasks: ${JSON.stringify(pendingTasks.map((t: any) => t.title))}

RECENT EVENTS (Messages / Emails / Weather / News / Web Searches):
${contextText}

Perform the following reasoning steps and return a SINGLE JSON object:
1. "state_updates": any new facts to merge into the profile (e.g. {"mood": "stressed", "monitored_topics": ["stock market"]})
2. "urgent_actions": array of strings describing immediate actions Aris should take. Use this to alert the user of breaking news, severe weather, or unread urgent emails. (e.g. "Alert user that their competitor just launched a new product according to the news.", "Warn user it will rain soon.")
3. "persona_shift": optional new coach persona if user is clearly slipping or under pressure (e.g. "tough-love", "crisis-mode", "military-drill-sergeant"). Leave null if no change needed.

Respond ONLY in valid JSON. Example:
{"state_updates": {"mood": "stressed"}, "urgent_actions": ["Move pitch prep to 9am"], "persona_shift": "tough-love"}`;

      const response = await this.gemmaService.requestArisAdvice(prompt, mediaParts);
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
      const yesterdayTasks = await goalsStore.getYesterdayTasks(userId);

      // Calculate Goal Metrics
      const goalMetrics = activeGoals.map(g => {
        const start = new Date(g.createdAt).getTime();
        const target = g.targetDate ? new Date(g.targetDate).getTime() : start + (365 * 24 * 60 * 60 * 1000); // default 1 yr
        const now = Date.now();
        const totalDays = Math.max(1, Math.round((target - start) / (1000 * 60 * 60 * 24)));
        const elapsedDays = Math.max(0, Math.round((now - start) / (1000 * 60 * 60 * 24)));
        const percentTime = Math.min(100, Math.round((elapsedDays / totalDays) * 100));
        
        // Calculate task progress for this goal
        const goalTasks = yesterdayTasks.filter(t => t.goalId === g.id);
        const completed = goalTasks.filter(t => t.status === 'completed').length;
        const total = goalTasks.length;
        const dailyProgress = total > 0 ? Math.round((completed / total) * 100) : 0;

        return {
          title: g.title,
          totalDays,
          elapsedDays,
          percentTimeElapsed: percentTime,
          yesterdayCompletionRate: `${completed}/${total} (${dailyProgress}%)`
        };
      });

      // Get Weather (Defaulting to New York if no location in state)
      const lat = state.state?.lat || 40.7128;
      const lon = state.state?.lon || -74.0060;
      let weatherInfo = "Weather data unavailable.";
      try {
        const forecast = await weatherService.getForecast(lat, lon, ["temperature_2m", "precipitation"]);
        weatherInfo = `Today: ${forecast.current?.temperature_2m || 20}°C, Precip: ${forecast.current?.precipitation || 0}mm`;
      } catch { /* ignore */ }

      const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

      // 2a. LLM generates both: (i) structured task list, (ii) spoken morning brief script
      const prompt = `You are Aris, an aggressive and strategic life coach. Today is ${today}.
User's Current State: ${JSON.stringify(state.state)}
Coach Persona: ${state.coachPersona}

--- GOAL METRICS ---
${JSON.stringify(goalMetrics, null, 2)}

--- YESTERDAY'S PERFORMANCE ---
Tasks: ${JSON.stringify(yesterdayTasks.map(t => ({ title: t.title, status: t.status })))}

--- TODAY'S CONTEXT ---
Weather: ${weatherInfo}
Pending Carryover Tasks: ${JSON.stringify(pendingTasks.map((t: any) => t.title))}

Generate a JSON object with two keys:
1. "tasks": array of 2-3 objects with "title", "description", "durationHours" — concrete actions for TODAY.
2. "morning_brief": a spoken script (under 90 seconds when read aloud, around 200 words) for a WhatsApp voice note. 
   Be direct, strategic, and match the coach persona.
   CRITICAL: Verbally call out their goal timeline (e.g. "You are ${goalMetrics[0]?.elapsedDays || 0} days into your ${goalMetrics[0]?.totalDays || 0} day plan. That's ${goalMetrics[0]?.percentTimeElapsed || 0}% of your time gone.")
   Call out yesterday's performance (what they did/didn't do). Mention the weather if relevant to tasks. Give today's battle plan. End with a rallying call.

Example:
{
  "tasks": [{"title": "Finalize pitch deck", "description": "Complete slides 8-12", "durationHours": 2}],
  "morning_brief": "Good morning. You are 45 days into your 365 day billionaire goal. 12% of your time is gone. Yesterday you only completed 1 of 3 tasks. That's unacceptable. It's raining today, so no excuses to leave the desk. Let's fix this..."
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
