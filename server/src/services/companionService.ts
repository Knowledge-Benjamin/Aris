import { GemmaService } from "./gemmaService";
import { getDatabasePool } from "../db/db";
import { info, error } from "../utils/logger";
import OpenAI from "openai";
import fsPromises from "fs/promises";
import fs from "fs";
import path from "path";
import os from "os";

export class CompanionService {
  private gemmaService: GemmaService;
  private pool = getDatabasePool();
  
  // Rolling memory buffer: Map of userId -> Array of { timestamp, text }
  private rollingBuffer: Map<number, Array<{ timestamp: number; text: string }>> = new Map();
  
  // We use OpenAI SDK to call any OpenAI-compatible whisper endpoint (e.g., Groq, local inference)
  private openai = new OpenAI({
    apiKey: process.env.WHISPER_API_KEY || "YOUR_WHISPER_API_KEY", 
    baseURL: process.env.WHISPER_API_URL || "https://api.groq.com/openai/v1"
  });

  // Keywords that indicate Aris should pay attention to the ambient stream
  private readonly TRIGGER_KEYWORDS = [
    "aris", "will", "need to", "tomorrow", "finished", "submitted", 
    "let's meet", "schedule", "remind me", "did you", "done"
  ];

  constructor(gemmaService: GemmaService) {
    this.gemmaService = gemmaService;
  }

  public async processAmbientAudio(userId: number, audioBase64: string): Promise<{ success: boolean; actionTaken: string }> {
    try {
      // 1. Tier 1: Fast STT
      const transcript = await this.transcribeAudio(audioBase64);
      if (!transcript || transcript.trim().length === 0) {
        return { success: true, actionTaken: "none_silent" };
      }

      info(`[Companion] Transcript for user ${userId}: "${transcript}"`);

      // 2. Append to rolling buffer
      this.appendToBuffer(userId, transcript);

      // 3. Tier 2: Relevance Filter
      if (!this.containsActionableKeywords(transcript)) {
        return { success: true, actionTaken: "none_irrelevant" };
      }

      info(`[Companion] Actionable keywords detected. Aggregating context...`);

      // 4. Tier 3: Context Aggregation
      const fullContext = this.getAggregatedContext(userId);
      
      // 5. Tier 4: Heavy LLM Inference
      const inferredAction = await this.inferActionFromContext(userId, fullContext);

      if (inferredAction && inferredAction !== "No action") {
        info(`[Companion] Aris inferred action: ${inferredAction}`);
        
        // Tier 5: Silent DB Update & Optional Notification
        await this.executeSilentAction(userId, inferredAction);
        
        // Clear buffer after successful action to prevent duplicate processing
        this.clearBuffer(userId);
        
        return { success: true, actionTaken: inferredAction };
      }

      return { success: true, actionTaken: "none_no_action_inferred" };

    } catch (err) {
      error("[Companion] Error processing ambient audio", err);
      throw err;
    }
  }

  private async transcribeAudio(base64Audio: string): Promise<string> {
    const tempFilePath = path.join(os.tmpdir(), `companion_${Date.now()}_${Math.random().toString(36).substring(7)}.ogg`);
    try {
      await fsPromises.writeFile(tempFilePath, Buffer.from(base64Audio, "base64"));
      
      // Use whisper-large-v3 on Groq (faster and lighter on our server than local whisper-tiny)
      const transcription = await this.openai.audio.transcriptions.create({
        file: fs.createReadStream(tempFilePath) as any,
        model: "whisper-large-v3",
      });
      
      return transcription.text;
    } catch (err) {
      error("[Companion] Transcription failed", err);
      return "";
    } finally {
      await fsPromises.unlink(tempFilePath).catch(() => {});
    }
  }

  private appendToBuffer(userId: number, text: string) {
    if (!this.rollingBuffer.has(userId)) {
      this.rollingBuffer.set(userId, []);
    }
    const buffer = this.rollingBuffer.get(userId)!;
    buffer.push({ timestamp: Date.now(), text });

    // Keep only last 5 minutes of context
    const fiveMinsAgo = Date.now() - 5 * 60 * 1000;
    this.rollingBuffer.set(userId, buffer.filter(item => item.timestamp > fiveMinsAgo));
  }

  private getAggregatedContext(userId: number): string {
    const buffer = this.rollingBuffer.get(userId) || [];
    return buffer.map(b => b.text).join(" ");
  }

  private clearBuffer(userId: number) {
    this.rollingBuffer.set(userId, []);
  }

  private containsActionableKeywords(text: string): boolean {
    const lowerText = text.toLowerCase();
    return this.TRIGGER_KEYWORDS.some(kw => lowerText.includes(kw));
  }

  private async inferActionFromContext(userId: number, contextText: string): Promise<string> {
    const prompt = `
      You are Aris, an ambient digital assistant.
      The following is a rolling transcript of the user's ambient environment over the last few minutes.
      
      TRANSCRIPT:
      "${contextText}"

      YOUR TASK:
      Analyze the transcript. Did the user implicitly complete a task, state a new commitment, or ask you a direct question?
      - If they completed a task, output: "COMPLETED: [Task Description]"
      - If they scheduled something, output: "SCHEDULED: [Event Description]"
      - If they asked a question to Aris, output: "REPLY: [Your brief answer]"
      - If none of these apply, output exactly: "No action"
    `;

    const response = await this.gemmaService.inferAmbientAction(prompt); // We will add this to GemmaService
    return response.trim();
  }

  private async executeSilentAction(userId: number, actionStr: string) {
    if (actionStr.startsWith("REPLY:")) {
      // For direct replies, we MUST message the user on WhatsApp
      const replyBody = actionStr.replace("REPLY:", "").trim();
      await this.pool.query(
        `INSERT INTO whatsapp_outbox (user_id, to_jid, message_type, body) VALUES ($1, 'self', 'text', $2)`,
        [userId, replyBody]
      );
    } else {
      // For COMPLETED or SCHEDULED, we silently log it to the context store
      // (The plannerService cron job will ingest this later)
      await this.pool.query(
        `INSERT INTO ambient_logs (user_id, inferred_action, created_at) VALUES ($1, $2, NOW())`,
        [userId, actionStr]
      ).catch(() => {
        // Fallback if table doesn't exist yet, just log it
        info(`[Companion] Silent action logged: ${actionStr}`);
      });
    }
  }
}
