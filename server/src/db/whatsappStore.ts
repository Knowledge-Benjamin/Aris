import { getDatabasePool } from "./db";

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

const pool = getDatabasePool();

export async function getPendingWhatsappMessages(limit = 50): Promise<WhatsappMessageRecord[]> {
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

export async function markWhatsappMessagesAnalyzed(ids: number[]): Promise<void> {
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
