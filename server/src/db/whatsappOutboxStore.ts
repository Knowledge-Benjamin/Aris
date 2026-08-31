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
  status: "pending" | "sent" | "failed";
  createdAt: Date;
  sentAt?: Date;
}

export const whatsappOutboxStore = {
  async enqueue(
    toJid: string,
    messageType: OutboxMessageType,
    body?: string,
    mediaGcsUri?: string,
    mediaMimeType?: string,
    userId?: number
  ): Promise<OutboxMessage> {
    const res = await pool.query(
      `INSERT INTO whatsapp_outbox (user_id, to_jid, message_type, body, media_gcs_uri, media_mime_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING *`,
      [userId ?? null, toJid, messageType, body ?? null, mediaGcsUri ?? null, mediaMimeType ?? null]
    );
    return mapRow(res.rows[0]);
  },

  async getPending(limit = 20): Promise<OutboxMessage[]> {
    const res = await pool.query(
      `SELECT * FROM whatsapp_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1`,
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
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? undefined,
  };
}
