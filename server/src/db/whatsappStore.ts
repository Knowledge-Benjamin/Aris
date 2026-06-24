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

export interface WhatsappMessageStats {
  totalMessages: number;
  pendingMessages: number;
  latestReceivedAt: string | null;
  uniqueSenders: number;
}

const pool = getDatabasePool();

function mapRow(row: any): WhatsappMessageRecord {
  return {
    id: row.id,
    senderId: row.sender_id,
    messageId: row.message_id,
    messageText: row.message_text,
    whatsappTimestamp: Number(row.whatsapp_timestamp),
    receivedAt: row.received_at,
    isAnalyzed: row.is_analyzed,
    metadata: row.metadata || undefined,
  };
}

/**
 * Fetch only pending (not yet analyzed) messages. Used for the "any new messages?" flow.
 */
export async function getPendingWhatsappMessages(limit = 50): Promise<WhatsappMessageRecord[]> {
  const result = await pool.query(
    `SELECT id, sender_id, message_id, message_text, whatsapp_timestamp, received_at, is_analyzed, metadata
     FROM whatsapp_messages
     WHERE is_analyzed = FALSE
     ORDER BY received_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(mapRow);
}

/**
 * Fetch recent messages from ALL senders (both analyzed and pending), newest first.
 * Used for general WhatsApp history reads.
 */
export async function getRecentWhatsappMessages(limit = 100): Promise<WhatsappMessageRecord[]> {
  const result = await pool.query(
    `SELECT id, sender_id, message_id, message_text, whatsapp_timestamp, received_at, is_analyzed, metadata
     FROM whatsapp_messages
     ORDER BY received_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows.map(mapRow).reverse(); // chronological order
}

/**
 * Fetch all messages from a specific set of sender phone numbers (normalized digits only).
 * Matches any suffix of the stored sender_id against the provided normalized keys.
 * Used for "what did Grace say?" flows.
 */
export async function getWhatsappConversationBySenders(
  normalizedPhones: string[],
  exactWhatsappIds: string[],
  limit = 200
): Promise<WhatsappMessageRecord[]> {
  if (!normalizedPhones.length && !exactWhatsappIds.length) return [];

  // Build LIKE patterns: '%254712345678' — matches suffix of sender_id stripped of @c.us etc.
  const patterns = normalizedPhones.map(p => `%${p}`);

  // We use regexp_replace to strip non-digit chars from sender_id for comparison
  const result = await pool.query(
    `SELECT id, sender_id, message_id, message_text, whatsapp_timestamp, received_at, is_analyzed, metadata
     FROM whatsapp_messages
     WHERE sender_id = ANY($1::text[])
        OR regexp_replace(split_part(sender_id, '@', 1), '[^0-9]', '', 'g') = ANY($2::text[])
        OR regexp_replace(split_part(sender_id, '@', 1), '[^0-9]', '', 'g') LIKE ANY($3::text[])
        OR regexp_replace(split_part(metadata->>'participant', '@', 1), '[^0-9]', '', 'g') = ANY($2::text[])
        OR regexp_replace(split_part(metadata->>'participant', '@', 1), '[^0-9]', '', 'g') LIKE ANY($3::text[])
     ORDER BY received_at ASC
     LIMIT $4`,
    [exactWhatsappIds, normalizedPhones, patterns, limit]
  );
  return result.rows.map(mapRow);
}

/**
 * Get stats about the WhatsApp message store.
 * Used by Aris to decide whether to run the service or read from history.
 */
export async function getWhatsappMessageStats(): Promise<WhatsappMessageStats> {
  const result = await pool.query(
    `SELECT
       COUNT(*) AS total_messages,
       COUNT(*) FILTER (WHERE is_analyzed = FALSE) AS pending_messages,
       MAX(received_at) AS latest_received_at,
       COUNT(DISTINCT split_part(sender_id, '@', 1)) AS unique_senders
     FROM whatsapp_messages`
  );
  const row = result.rows[0];
  return {
    totalMessages: parseInt(row.total_messages, 10),
    pendingMessages: parseInt(row.pending_messages, 10),
    latestReceivedAt: row.latest_received_at || null,
    uniqueSenders: parseInt(row.unique_senders, 10),
  };
}

export async function markWhatsappMessagesAnalyzed(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await pool.query(
    `UPDATE whatsapp_messages SET is_analyzed = TRUE, updated_at = NOW() WHERE id = ANY($1)`,
    [ids]
  );
}
