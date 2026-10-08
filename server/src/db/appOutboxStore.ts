import { getDatabasePool } from "./db";

const pool = getDatabasePool();

export type AppOutboxMessageType = "text" | "audio" | "document";

export interface AppOutboxMessage {
  id: number;
  userId?: number;
  messageType: AppOutboxMessageType;
  body?: string;
  mediaGcsUri?: string;
  mediaMimeType?: string;
  quotedMessage?: unknown;
  status: "pending" | "sent" | "failed";
  createdAt: Date;
  sentAt?: Date;
}

export interface AppOutboxPackageItem {
  messageType: AppOutboxMessageType;
  body?: string;
  mediaGcsUri?: string;
  mediaMimeType?: string;
}

export const appOutboxStore = {
  async enqueueAppMessage(
    userId: number,
    messageType: AppOutboxMessageType,
    body?: string,
    mediaGcsUri?: string,
    mediaMimeType?: string,
    quotedMessage?: unknown
  ): Promise<AppOutboxMessage> {
    const result = await pool.query(
      `INSERT INTO whatsapp_outbox (user_id, to_jid, message_type, body, media_gcs_uri, media_mime_type, quoted_message, status)
       VALUES ($1, 'app', $2, $3, $4, $5, $6, 'pending') RETURNING *`,
      [userId, messageType, body ?? null, mediaGcsUri ?? null, mediaMimeType ?? null,
        quotedMessage === undefined ? null : JSON.stringify(quotedMessage)]
    );
    return mapRow(result.rows[0]);
  },

  async enqueueAppPackage(
    userId: number,
    items: AppOutboxPackageItem[],
    quotedMessage?: unknown
  ): Promise<AppOutboxMessage[]> {
    if (!items.length) throw new Error("An app delivery package must contain at least one item.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const rows: AppOutboxMessage[] = [];
      for (const item of items) {
        const result = await client.query(
          `INSERT INTO whatsapp_outbox (user_id, to_jid, message_type, body, media_gcs_uri, media_mime_type, quoted_message, status)
           VALUES ($1, 'app', $2, $3, $4, $5, $6, 'pending') RETURNING *`,
          [
            userId,
            item.messageType,
            item.body ?? null,
            item.mediaGcsUri ?? null,
            item.mediaMimeType ?? null,
            quotedMessage === undefined ? null : JSON.stringify(quotedMessage),
          ]
        );
        rows.push(mapRow(result.rows[0]));
      }
      await client.query("COMMIT");
      return rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async getAllForUser(userId: number): Promise<AppOutboxMessage[]> {
    const result = await pool.query(
      `SELECT * FROM whatsapp_outbox WHERE user_id = $1 AND to_jid = 'app' ORDER BY created_at DESC`,
      [userId]
    );
    return result.rows.map(mapRow);
  },

  async getPendingForApp(userId: number, limit = 50): Promise<AppOutboxMessage[]> {
    const result = await pool.query(
      `SELECT * FROM whatsapp_outbox
       WHERE user_id = $1 AND to_jid = 'app' AND status = 'pending'
       ORDER BY created_at ASC, id ASC
       LIMIT $2`,
      [userId, Math.max(1, Math.min(limit, 100))]
    );
    return result.rows.map(mapRow);
  },

  async markAppSent(userId: number, id: number): Promise<boolean> {
    const result = await pool.query(
      `UPDATE whatsapp_outbox
       SET status = 'sent', sent_at = NOW()
       WHERE id = $1 AND user_id = $2 AND to_jid = 'app' AND status = 'pending'`,
      [id, userId]
    );
    return (result.rowCount ?? 0) > 0;
  },

  async clearPending(userId: number): Promise<number> {
    const result = await pool.query(
      `DELETE FROM whatsapp_outbox WHERE user_id = $1 AND to_jid = 'app' AND status = 'pending'`,
      [userId]
    );
    return result.rowCount ?? 0;
  },
};

function mapRow(row: any): AppOutboxMessage {
  return {
    id: row.id,
    userId: row.user_id ?? undefined,
    messageType: row.message_type as AppOutboxMessageType,
    body: row.body ?? undefined,
    mediaGcsUri: row.media_gcs_uri ?? undefined,
    mediaMimeType: row.media_mime_type ?? undefined,
    quotedMessage: row.quoted_message ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? undefined,
  };
}
