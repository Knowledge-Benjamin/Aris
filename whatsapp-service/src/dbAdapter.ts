import { getDatabasePool } from "./db";

const pool = getDatabasePool();

export interface WhatsappMessageRecord {
  id: number;
  senderId: string;
  messageId: string;
  messageText: string;
  whatsappTimestamp: number;
  receivedAt: string;
  isAnalyzed: boolean;
  metadata?: Record<string, unknown>;
}

export async function saveWhatsappMessage(params: {
  senderId: string;
  messageId: string;
  messageText: string;
  whatsappTimestamp: number;
  metadata?: Record<string, unknown>;
}) {
  const query = `
    INSERT INTO whatsapp_messages (sender_id, message_id, message_text, whatsapp_timestamp, received_at, is_analyzed, metadata, created_at, updated_at)
    VALUES ($1, $2, $3, $4, NOW(), FALSE, $5, NOW(), NOW())
    ON CONFLICT (message_id) DO UPDATE SET
      message_text = EXCLUDED.message_text,
      metadata = EXCLUDED.metadata,
      updated_at = NOW();
  `;

  await pool.query(query, [
    params.senderId,
    params.messageId,
    params.messageText,
    params.whatsappTimestamp,
    params.metadata || null,
  ]);
}

export async function getPendingWhatsappMessages(limit = 100) {
  const query = `
    SELECT id, sender_id, message_id, message_text, whatsapp_timestamp, received_at, is_analyzed, metadata
    FROM whatsapp_messages
    WHERE is_analyzed = FALSE
    ORDER BY received_at ASC
    LIMIT $1
  `;

  const result = await pool.query(query, [limit]);
  return result.rows.map((row) => ({
    id: row.id,
    senderId: row.sender_id,
    messageId: row.message_id,
    messageText: row.message_text,
    whatsappTimestamp: Number(row.whatsapp_timestamp),
    receivedAt: row.received_at,
    isAnalyzed: row.is_analyzed,
    metadata: row.metadata || undefined,
  }));
}

export async function getPendingWhatsappMessagesByRemoteJid(remoteJid: string, limit = 100) {
  const query = `
    SELECT id, sender_id, message_id, message_text, whatsapp_timestamp, received_at, is_analyzed, metadata
    FROM whatsapp_messages
    WHERE is_analyzed = FALSE
      AND metadata->>'remoteJid' = $1
    ORDER BY received_at ASC
    LIMIT $2
  `;

  const result = await pool.query(query, [remoteJid, limit]);
  return result.rows.map((row) => ({
    id: row.id,
    senderId: row.sender_id,
    messageId: row.message_id,
    messageText: row.message_text,
    whatsappTimestamp: Number(row.whatsapp_timestamp),
    receivedAt: row.received_at,
    isAnalyzed: row.is_analyzed,
    metadata: row.metadata || undefined,
  }));
}

export async function markWhatsappMessagesAnalyzed(ids: number[]) {
  if (!ids.length) {
    return;
  }

  const query = `
    UPDATE whatsapp_messages
    SET is_analyzed = TRUE,
        updated_at = NOW()
    WHERE id = ANY($1)
  `;

  await pool.query(query, [ids]);
}

export async function saveWhatsappGroup(jid: string, subject: string) {
  await pool.query(`
    INSERT INTO whatsapp_groups (jid, subject, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (jid) DO UPDATE SET subject = EXCLUDED.subject, updated_at = NOW()
  `, [jid, subject]);
}

// ─── Outbox: messages queued by Aris to be sent out ─────────────────────────

export interface OutboxRecord {
  id: number;
  toJid: string;
  messageType: "text" | "audio";
  body?: string;
  mediaGcsUri?: string;
  mediaMimeType?: string;
}

export async function getPendingOutboxMessages(limit = 10): Promise<OutboxRecord[]> {
  const result = await pool.query(
    `SELECT id, to_jid, message_type, body, media_gcs_uri, media_mime_type
     FROM whatsapp_outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1`,
    [limit]
  );
  return result.rows.map((row) => ({
    id: row.id,
    toJid: row.to_jid,
    messageType: row.message_type as "text" | "audio",
    body: row.body ?? undefined,
    mediaGcsUri: row.media_gcs_uri ?? undefined,
    mediaMimeType: row.media_mime_type ?? undefined,
  }));
}

export async function markOutboxSent(id: number): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_outbox SET status = 'sent', sent_at = NOW() WHERE id = $1`,
    [id]
  );
}

export async function markOutboxFailed(id: number): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_outbox SET status = 'failed' WHERE id = $1`,
    [id]
  );
}
