import { Request, Response } from "express";
import { whatsappOutboxStore } from "../db/whatsappOutboxStore";

/**
 * GET /api/aris/outbox
 *
 * Returns all pending app-bound outbox messages for the authenticated user
 * (i.e. rows where to_jid = 'app'), then marks them as sent so they are not
 * returned on the next poll.
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

    // Fetch all pending app-bound messages for this user
    const all = await whatsappOutboxStore.getAllForUser(userId);
    const appPending = all.filter(
      (m) => m.toJid === "app" && m.status === "pending"
    );

    console.log(`[appOutbox] user=${userId} pending=${appPending.length}`);

    // Mark each as sent immediately so repeated polls don't re-deliver
    for (const msg of appPending) {
      await whatsappOutboxStore.markSent(msg.id);
    }

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
