import { Request, Response } from "express";
import { ArisService } from "../services/arisService";
import { getDatabasePool } from "../db/db";
import { GemmaService } from "../services/gemmaService";
import { MemoryStore } from "../db/memoryStore";
import { VoiceService } from "../services/voiceService";
import { info, error } from "../utils/logger";
import { AuthenticatedRequest } from "../middleware/authMiddleware";

const pool = getDatabasePool();
const memoryStore = new MemoryStore(pool);
const gemmaService = new GemmaService();
const arisService = new ArisService(memoryStore, gemmaService);
const voiceService = new VoiceService();

export async function arisChat(req: Request, res: Response) {
  try {
    const { message, sessionId } = req.body;
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized user." });
    }

    const response = await arisService.handleChat({ message, sessionId, userId });
    res.json(response);
  } catch (error) {
    console.error("arisChat error", error);
    res.status(500).json({ error: "Aris internal error" });
  }
}

export async function arisVoice(req: Request, res: Response) {
  try {
    const { audioBase64, mimeType, sessionId } = req.body;
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;

    if (!audioBase64 || typeof audioBase64 !== "string") {
      return res.status(400).json({ error: "audioBase64 is required" });
    }

    if (!mimeType || typeof mimeType !== "string") {
      return res.status(400).json({ error: "mimeType is required" });
    }

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized user." });
    }

    info(`[aris] arisVoice request userId=${userId} sessionId=${sessionId} mimeType=${mimeType} audioBase64Length=${audioBase64.length}`);
    const transcript = await voiceService.transcribeAudio(audioBase64, mimeType);
    if (!transcript) {
      return res.status(400).json({ error: "Unable to transcribe audio." });
    }

    const response = await arisService.handleChat({ message: transcript, sessionId, userId });
    const voice = await voiceService.synthesizeSpeech(response.arisReply);

    res.json({
      transcript,
      arisReply: response.arisReply,
      memoryUpdates: response.memoryUpdates,
      voiceBase64: voice.audioBase64,
      voiceMimeType: voice.mimeType,
    });
  } catch (err: any) {
    error("arisVoice error", {
      message: err.message,
      stack: err.stack,
      userId: (req as AuthenticatedRequest).authUserId,
      sessionId: req.body?.sessionId,
    });
    console.error("arisVoice error", err);
    res.status(500).json({ error: "Aris voice processing failed." });
  }
}

export async function arisWelcome(req: Request, res: Response) {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;
    const sessionId = req.body?.sessionId as string | undefined;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized user." });
    }

    const welcomeText = await arisService.generateWelcomeMessage(userId, sessionId);
    const voice = await voiceService.synthesizeSpeech(welcomeText, "LINEAR16");

    res.json({
      text: welcomeText,
      voiceBase64: voice.audioBase64,
      voiceMimeType: voice.mimeType,
    });
  } catch (error) {
    console.error("arisWelcome error", error);
    res.status(500).json({ error: "Aris welcome speech failed." });
  }
}
