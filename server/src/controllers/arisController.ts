import { Request, Response } from "express";
import { ArisService } from "../services/arisService";
import { getDatabasePool } from "../db/db";
import { GemmaService } from "../services/gemmaService";
import { MemoryStore } from "../db/memoryStore";
import { VoiceService } from "../services/voiceService";
import { info, error } from "../utils/logger";
import { AuthenticatedRequest } from "../middleware/authMiddleware";

import { ContextStore } from "../db/contextStore";
import { CompanionService } from "../services/companionService";
import { sharedLocationService } from "../services/locationService";

const pool = getDatabasePool();
const memoryStore = new MemoryStore(pool);
const contextStore = new ContextStore(pool);
const gemmaService = new GemmaService();
const arisService = new ArisService(memoryStore, contextStore, gemmaService);
const voiceService = new VoiceService();
const companionService = new CompanionService(gemmaService);
const CHAT_FAILURE_MESSAGE = "I couldn't complete that just now. Please try again in a moment.";

export async function updateCompanionLocation(req: Request, res: Response) {
  const userId = (req as AuthenticatedRequest).authUserId;
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized user." });
  }

  try {
    const { lat, lon, accuracyMeters, capturedAtEpochMs, timezone } = req.body || {};
    if (typeof lat !== "number" || typeof lon !== "number" || typeof capturedAtEpochMs !== "number" ||
        (accuracyMeters !== undefined && typeof accuracyMeters !== "number") ||
        (timezone !== undefined && typeof timezone !== "string")) {
      return res.status(400).json({ error: "lat, lon, capturedAtEpochMs, and optional accuracyMeters/timezone have invalid types." });
    }

    sharedLocationService.setDeviceLocation(userId, {
      lat,
      lon,
      accuracyMeters,
      capturedAtEpochMs,
      timezone,
    });
    return res.status(204).end();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid location data.";
    return res.status(400).json({ error: message });
  }
}

export async function arisChat(req: Request, res: Response) {
  try {
    const { message, sessionId, approvedAction, mediaData, replyContext } = req.body;
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }
    
    if (message.length > 8000) {
      return res.status(400).json({ error: "message is too long (max 8000 chars)" });
    }

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized user." });
    }

    const response = await arisService.handleChat({ message, sessionId, userId, approvedAction, mediaData, replyContext });
    res.json(response);
  } catch (error) {
    console.error("arisChat error", error);
    res.status(500).json({ error: CHAT_FAILURE_MESSAGE });
  }
}

export async function arisChatStream(req: Request, res: Response) {
  try {
    const { message, sessionId, approvedAction, mediaData, replyContext } = req.body;
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }
    
    if (message.length > 8000) {
      return res.status(400).json({ error: "message is too long (max 8000 chars)" });
    }

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized user." });
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Disable socket timeout for long-running tool chains
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true);

    // Send a keepalive heartbeat every 15s to prevent the connection being dropped
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`${JSON.stringify({ type: 'heartbeat' })}\n`);
      }
    }, 15000);

    const onProgress = (msg: string) => {
      res.write(`${JSON.stringify({ type: 'progress', message: msg })}\n`);
    };

    try {
      const response = await arisService.handleChat(
        { message, sessionId, userId, approvedAction, mediaData, replyContext },
        onProgress
      );
      clearInterval(heartbeat);
      res.write(`${JSON.stringify({ type: 'complete', data: response })}\n`);
      res.end();
    } catch (innerError) {
      clearInterval(heartbeat);
      throw innerError;
    }

  } catch (error) {
    console.error("arisChatStream error", error);
    if (!res.headersSent) {
      res.status(500).json({ error: CHAT_FAILURE_MESSAGE });
    } else {
      res.write(`${JSON.stringify({ type: "error", error: CHAT_FAILURE_MESSAGE })}\n`);
      res.end();
    }
  }
}

export async function arisVoice(req: Request, res: Response) {
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    const { audioBase64, mimeType, sessionId, replyContext } = req.body;
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUserId;

    if (!audioBase64 || typeof audioBase64 !== "string") {
      return res.status(400).json({ error: "audioBase64 is required" });
    }

    if (!mimeType || typeof mimeType !== "string") {
      return res.status(400).json({ error: "mimeType is required" });
    }

    if (!mimeType.toLowerCase().startsWith("audio/")) {
      return res.status(400).json({ error: "An audio attachment is required." });
    }

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized user." });
    }

    info(`[aris] arisVoice multimodal request userId=${userId} sessionId=${sessionId} mimeType=${mimeType} audioBase64Length=${audioBase64.length}`);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true);
    res.flushHeaders();

    const writeEvent = (event: Record<string, unknown>) => {
      if (!res.destroyed && !res.writableEnded) {
        res.write(`${JSON.stringify(event)}\n`);
      }
    };
    writeEvent({ type: "progress", message: "Aris is listening to your voice note." });
    heartbeat = setInterval(() => writeEvent({ type: "heartbeat" }), 15000);

    const response = await arisService.handleChat({
      message: "Listen to the attached voice note and respond directly to the spoken request. Treat the speech as the user's message; do not return a transcript unless asked.",
      sessionId,
      userId,
      mediaData: { mimeType, dataBase64: audioBase64, fileName: `voice-note-${Date.now()}` },
      replyContext: typeof replyContext === "string" ? replyContext : undefined,
    });
    let voice: Awaited<ReturnType<typeof voiceService.synthesizeSpeech>> | undefined;
    let voiceError: string | undefined;
    try {
      voice = await voiceService.synthesizeSpeech(response.arisReply);
      const extension = voice.mimeType === "audio/wav" ? "wav" : voice.mimeType === "audio/ogg" ? "ogg" : "mp3";
      void arisService.archiveGeneratedMedia(
        userId,
        sessionId,
        `aris-voice-reply-${Date.now()}.${extension}`,
        voice.mimeType,
        Buffer.from(voice.audioBase64, "base64"),
        "aris_voice_reply",
        response.arisReply,
      ).then((archivedVoice) => {
        info(`[aris] archived voice reply sessionId=${sessionId} mediaId=${archivedVoice.id}`);
      }).catch((archiveError) => {
        error("arisVoice reply archive failed; returning generated audio inline", archiveError);
      });
    } catch (synthesisError) {
      error("arisVoice synthesis failed; returning the text response", synthesisError);
      voiceError = "I couldn’t create the audio reply this time, so I’m replying in text.";
    }

    info(`[aris] voice response ready sessionId=${sessionId} textLength=${response.arisReply.length} audio=${Boolean(voice)}`);
    writeEvent({
      type: "complete",
      data: {
        arisReply: response.arisReply,
        memoryUpdates: response.memoryUpdates,
        voiceBase64: voice?.audioBase64,
        voiceMimeType: voice?.mimeType,
        voiceError,
      },
    });
    res.end();
  } catch (err: any) {
    error("arisVoice error", {
      message: err.message,
      stack: err.stack,
      userId: (req as AuthenticatedRequest).authUserId,
      sessionId: req.body?.sessionId,
    });
    console.error("arisVoice error", err);
    if (!res.headersSent) {
      res.status(500).json({ error: CHAT_FAILURE_MESSAGE });
    } else if (!res.destroyed && !res.writableEnded) {
      res.write(`${JSON.stringify({ type: "error", error: CHAT_FAILURE_MESSAGE })}\n`);
      res.end();
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

export async function downloadArisMedia(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) return res.status(401).json({ error: "Unauthorized user." });
    const mediaId = Number(req.params.mediaId);
    if (!Number.isInteger(mediaId) || mediaId < 1) {
      return res.status(400).json({ error: "A valid media library ID is required." });
    }
    const media = await arisService.downloadLibraryMedia(userId, mediaId);
    if (!media) return res.status(404).json({ error: "Media file not found in this user's library." });
    res.setHeader("Content-Type", media.record.mimeType);
    res.setHeader("Content-Length", String(media.content.length));
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(media.record.fileName)}`);
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(media.content);
  } catch (err) {
    error("downloadArisMedia error", err);
    return res.status(500).json({ error: "Unable to download this media file from Google Drive." });
  }
}

export async function downloadArisMediaByDriveId(req: Request, res: Response) {
  try {
    const userId = (req as AuthenticatedRequest).authUserId;
    if (!userId) return res.status(401).json({ error: "Unauthorized user." });
    const driveFileId = String(req.params.driveFileId || "").trim();
    if (!driveFileId || driveFileId.includes("/")) {
      return res.status(400).json({ error: "A valid Google Drive file ID is required." });
    }
    const media = await arisService.downloadLibraryMediaByDriveId(userId, driveFileId);
    if (!media) return res.status(404).json({ error: "Media file not found in this user's library." });
    res.setHeader("Content-Type", media.record.mimeType);
    res.setHeader("Content-Length", String(media.content.length));
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(media.record.fileName)}`);
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(media.content);
  } catch (err) {
    error("downloadArisMediaByDriveId error", err);
    return res.status(500).json({ error: "Unable to download this media file from Google Drive." });
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

export async function companionAudio(req: Request, res: Response) {
  try {
    const { userId, audioBase64 } = req.body;
    if (!userId || !audioBase64) {
      return res.status(400).json({ error: "Missing userId or audioBase64" });
    }

    info(`[companionAudio] Passing audio to CompanionService for user ${userId}, length: ${audioBase64.length}`);

    const result = await companionService.processAmbientAudio(userId, audioBase64);

    res.json(result);
  } catch (err) {
    error("companionAudio error", err);
    res.status(500).json({ error: "Failed to process ambient audio" });
  }
}
