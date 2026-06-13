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
