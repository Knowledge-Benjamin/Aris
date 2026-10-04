import { getDatabasePool } from "./db";

const pool = getDatabasePool();

export interface AudioContextRecord {
  id?: number;
  userId: number;
  storageUri: string;
  mimeType: string;
  sourceType: string;
  sourceText: string;
  chunkIndex: number;
  chunkCount: number;
  sessionId?: string;
  createdAt?: Date;
}

export const audioContextStore = {
  async getRecentForUser(userId: number, limit = 20): Promise<AudioContextRecord[]> {
    const result = await pool.query(
      `SELECT id, user_id, storage_uri, mime_type, source_type, source_text,
              chunk_index, chunk_count, session_id, created_at
       FROM audio_context
       WHERE user_id = $1
       ORDER BY created_at DESC, chunk_index ASC
       LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map(mapRow);
  },

  async upsert(record: AudioContextRecord): Promise<void> {
    await pool.query(
      `INSERT INTO audio_context
       (user_id, storage_uri, mime_type, source_type, source_text, chunk_index, chunk_count, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (storage_uri) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         mime_type = EXCLUDED.mime_type,
         source_type = EXCLUDED.source_type,
         source_text = EXCLUDED.source_text,
         chunk_index = EXCLUDED.chunk_index,
         chunk_count = EXCLUDED.chunk_count,
         session_id = EXCLUDED.session_id,
         updated_at = NOW()`,
      [record.userId, record.storageUri, record.mimeType, record.sourceType, record.sourceText, record.chunkIndex, record.chunkCount, record.sessionId ?? null]
    );
  },
};

function mapRow(row: any): AudioContextRecord {
  return {
    id: row.id,
    userId: row.user_id,
    storageUri: row.storage_uri,
    mimeType: row.mime_type,
    sourceType: row.source_type,
    sourceText: row.source_text,
    chunkIndex: row.chunk_index,
    chunkCount: row.chunk_count,
    sessionId: row.session_id ?? undefined,
    createdAt: row.created_at ?? undefined,
  };
}