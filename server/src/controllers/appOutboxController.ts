import { Request, Response } from "express";
import { appOutboxStore } from "../db/appOutboxStore";

/**
 * GET /api/aris/outbox
 *
 * Returns pending app-bound outbox messages. The client acknowledges each one
 * only after its media has been downloaded and the message persisted locally.
 *
 * The Android app calls this endpoint on connect and after each chat session
 * to receive proactive messages, morning briefs, alerts, and podcast episodes
 * that Aris queued in the background (planner cron, meeting processor, etc).
 *
 * Response body:
 * {
 *   messages: Array<{
 *     id: number;
 *     messageType: "text" | "audio";
 *     body?: string;          // for text messages
 *     mediaDriveRef?: string; // for audio: "drive:<fileId>"
 *     mediaMimeType?: string;
 *     createdAt: string;      // ISO timestamp
 *   }>
 * }
 */
export async function pollAppOutbox(req: Request, res: Response) {
  try {
    const userId: number | undefined = (req as any).authUserId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated." });
    }

    const appPending = await appOutboxStore.getPendingForApp(userId);

    console.log(`[appOutbox] user=${userId} pending=${appPending.length}`);

    const messages = appPending.map((m) => ({
      id: m.id,
      messageType: m.messageType,
      body: m.body,
      content: m.body,
      quotedMessage: m.quotedMessage,
      mediaDriveRef: m.mediaGcsUri,
      mediaMimeType: m.mediaMimeType,
      createdAt: m.createdAt.toISOString(),
    }));

    return res.json({ messages });
  } catch (err: any) {
    console.error("[appOutbox] poll failed", err);
    return res.status(500).json({ error: "Failed to fetch app outbox." });
  }
}

export async function acknowledgeAppOutboxMessage(req: Request, res: Response) {
  try {
    const userId: number | undefined = (req as any).authUserId;
    const messageId = Number(req.params.messageId);
    if (!userId) return res.status(401).json({ error: "Not authenticated." });
    if (!Number.isSafeInteger(messageId) || messageId < 1) {
      return res.status(400).json({ error: "A valid outbox message ID is required." });
    }
    const acknowledged = await appOutboxStore.markAppSent(userId, messageId);
    if (!acknowledged) {
      return res.status(404).json({ error: "Pending app outbox message was not found." });
    }
    return res.status(204).end();
  } catch (err) {
    console.error("[appOutbox] acknowledge failed", err);
    return res.status(500).json({ error: "Failed to acknowledge app outbox message." });
  }
}
