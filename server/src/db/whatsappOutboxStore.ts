import { getDatabasePool } from "./db";

const pool = getDatabasePool();

export type OutboxMessageType = "text" | "audio";

export interface OutboxMessage {
  id: number;
  userId?: number;
  toJid: string;
  messageType: OutboxMessageType;
  body?: string;
  mediaGcsUri?: string;
  mediaMimeType?: string;
  quotedMessage?: unknown;
  status: "pending" | "sent" | "failed";
  createdAt: Date;
  sentAt?: Date;
}

export interface AppOutboxPackageItem {
  messageType: OutboxMessageType;
  body?: string;
  mediaGcsUri?: string;
  mediaMimeType?: string;
}

export const whatsappOutboxStore = {
  async enqueue(
    toJid: string,
    messageType: OutboxMessageType,
    body?: string,
    mediaGcsUri?: string,
    mediaMimeType?: string,
    userId?: number,
    quotedMessage?: unknown
  ): Promise<OutboxMessage> {
    const res = await pool.query(
      `INSERT INTO whatsapp_outbox (user_id, to_jid, message_type, body, media_gcs_uri, media_mime_type, quoted_message, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending') RETURNING *`,
      [userId ?? null, toJid, messageType, body ?? null, mediaGcsUri ?? null, mediaMimeType ?? null,
        quotedMessage === undefined ? null : JSON.stringify(quotedMessage)]
    );
    return mapRow(res.rows[0]);
  },

  async enqueueAppPackage(
    userId: number,
    items: AppOutboxPackageItem[],
    quotedMessage?: unknown
  ): Promise<OutboxMessage[]> {
    if (!items.length) throw new Error("An app delivery package must contain at least one item.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const rows: OutboxMessage[] = [];
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

  async getAllForUser(userId: number): Promise<OutboxMessage[]> {
    const res = await pool.query(
      `SELECT * FROM whatsapp_outbox WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return res.rows.map(mapRow);
  },

  async getPendingForApp(userId: number, limit = 50): Promise<OutboxMessage[]> {
    const res = await pool.query(
      `SELECT * FROM whatsapp_outbox
       WHERE user_id = $1 AND to_jid = 'app' AND status = 'pending'
       ORDER BY created_at ASC, id ASC
       LIMIT $2`,
      [userId, Math.max(1, Math.min(limit, 100))]
    );
    return res.rows.map(mapRow);
  },

  async markAppSent(userId: number, id: number): Promise<boolean> {
    const res = await pool.query(
      `UPDATE whatsapp_outbox
       SET status = 'sent', sent_at = NOW()
       WHERE id = $1 AND user_id = $2 AND to_jid = 'app' AND status = 'pending'`,
      [id, userId]
    );
    return (res.rowCount ?? 0) > 0;
  },

  async clearPending(userId: number): Promise<number> {
    const res = await pool.query(
      `DELETE FROM whatsapp_outbox WHERE user_id = $1 AND status = 'pending'`,
      [userId]
    );
    return res.rowCount ?? 0;
  },

  async getPending(limit = 20): Promise<OutboxMessage[]> {
    const res = await pool.query(
      `SELECT * FROM whatsapp_outbox WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT $1`,
      [limit]
    );
    return res.rows.map(mapRow);
  },

  async markSent(id: number): Promise<void> {
    await pool.query(
      `UPDATE whatsapp_outbox SET status = 'sent', sent_at = NOW() WHERE id = $1`,
      [id]
    );
  },

  async markFailed(id: number): Promise<void> {
    await pool.query(
      `UPDATE whatsapp_outbox SET status = 'failed' WHERE id = $1`,
      [id]
    );
  },
};

function mapRow(row: any): OutboxMessage {
  return {
    id: row.id,
    userId: row.user_id ?? undefined,
    toJid: row.to_jid,
    messageType: row.message_type as OutboxMessageType,
    body: row.body ?? undefined,
    mediaGcsUri: row.media_gcs_uri ?? undefined,
    mediaMimeType: row.media_mime_type ?? undefined,
    quotedMessage: row.quoted_message ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? undefined,
  };
}
