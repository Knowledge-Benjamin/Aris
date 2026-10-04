import { Pool } from "pg";
import { EmbeddingClient } from "../services/embeddingClient";

export interface MediaLibraryRecord {
  id: number;
  userId: number;
  driveFileId: string;
  driveUrl: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  sourceType: string;
  summary: string;
  sourceText: string;
  sessionId?: string;
  createdAt: Date;
  similarity?: number;
}

export interface MediaLibraryInput {
  userId: number;
  driveFileId: string;
  driveUrl: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  sourceType: string;
  summary: string;
  sourceText?: string;
  sourceReference?: string;
  sessionId?: string;
}

export class MediaLibraryStore {
  private readonly embeddingClient = new EmbeddingClient();

  constructor(private readonly pool: Pool) {}

  async upsert(input: MediaLibraryInput): Promise<MediaLibraryRecord> {
    const sourceText = input.sourceText?.trim() || input.summary.trim();
    const embeddingText = [
      `File: ${input.fileName}`,
      `Type: ${input.mimeType}`,
      `Summary: ${input.summary}`,
      `Content: ${sourceText}`,
    ].join("\n");
    const [embedding] = await this.embeddingClient.embedTexts([embeddingText]);
    if (!embedding?.length) {
      throw new Error("The embedding service returned no vector for the media library record.");
    }
    const vector = `[${embedding.join(",")}]`;
    const result = await this.pool.query(
      `INSERT INTO media_library
       (user_id, drive_file_id, drive_url, file_name, mime_type, byte_size,
        source_type, summary, source_text, source_reference, session_id, embedding, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector, NOW(), NOW())
       ON CONFLICT (user_id, drive_file_id) DO UPDATE SET
         drive_url = EXCLUDED.drive_url,
         file_name = EXCLUDED.file_name,
         mime_type = EXCLUDED.mime_type,
         byte_size = EXCLUDED.byte_size,
         source_type = EXCLUDED.source_type,
         summary = EXCLUDED.summary,
         source_text = EXCLUDED.source_text,
         source_reference = EXCLUDED.source_reference,
         session_id = EXCLUDED.session_id,
         embedding = EXCLUDED.embedding,
         updated_at = NOW()
       RETURNING id, user_id, drive_file_id, drive_url, file_name, mime_type,
         byte_size, source_type, summary, source_text, session_id, created_at`,
      [
        input.userId,
        input.driveFileId,
        input.driveUrl,
        input.fileName,
        input.mimeType,
        input.byteSize,
        input.sourceType,
        input.summary,
        sourceText,
        input.sourceReference ?? null,
        input.sessionId ?? null,
        vector,
      ]
    );
    return mapRow(result.rows[0]);
  }

  async findById(userId: number, id: number): Promise<MediaLibraryRecord | undefined> {
    const result = await this.pool.query(
      `SELECT id, user_id, drive_file_id, drive_url, file_name, mime_type,
         byte_size, source_type, summary, source_text, session_id, created_at
       FROM media_library
       WHERE user_id = $1 AND id = $2
       LIMIT 1`,
      [userId, id]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async findByDriveFileId(userId: number, driveFileId: string): Promise<MediaLibraryRecord | undefined> {
    const result = await this.pool.query(
      `SELECT id, user_id, drive_file_id, drive_url, file_name, mime_type,
         byte_size, source_type, summary, source_text, session_id, created_at
       FROM media_library
       WHERE user_id = $1 AND drive_file_id = $2
       LIMIT 1`,
      [userId, driveFileId]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async findBySourceReference(userId: number, sourceType: string, sourceReference: string): Promise<MediaLibraryRecord | undefined> {
    const result = await this.pool.query(
      `SELECT id, user_id, drive_file_id, drive_url, file_name, mime_type,
         byte_size, source_type, summary, source_text, session_id, created_at
       FROM media_library
       WHERE user_id = $1 AND source_type = $2 AND source_reference = $3
       LIMIT 1`,
      [userId, sourceType, sourceReference]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async search(userId: number, query: string, limit = 8): Promise<MediaLibraryRecord[]> {
    const [embedding] = await this.embeddingClient.embedTexts([query]);
    if (!embedding?.length) {
      throw new Error("The embedding service returned no vector for the media library search.");
    }
    const vector = `[${embedding.join(",")}]`;
    const result = await this.pool.query(
      `SELECT id, user_id, drive_file_id, drive_url, file_name, mime_type,
         byte_size, source_type, summary, source_text, session_id, created_at,
         1 - (embedding <=> $2::vector) AS similarity
       FROM media_library
       WHERE user_id = $1 AND embedding IS NOT NULL
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [userId, vector, Math.max(1, Math.min(limit, 20))]
    );
    return result.rows
      .map(mapRow)
      .filter((record) => (record.similarity ?? 0) >= 0.35);
  }

  async listRecent(userId: number, limit = 20): Promise<MediaLibraryRecord[]> {
    const result = await this.pool.query(
      `SELECT id, user_id, drive_file_id, drive_url, file_name, mime_type,
         byte_size, source_type, summary, source_text, session_id, created_at
       FROM media_library
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, Math.max(1, Math.min(limit, 50))]
    );
    return result.rows.map(mapRow);
  }
}

function mapRow(row: any): MediaLibraryRecord {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    driveFileId: row.drive_file_id,
    driveUrl: row.drive_url,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    sourceType: row.source_type,
    summary: row.summary,
    sourceText: row.source_text,
    sessionId: row.session_id ?? undefined,
    createdAt: row.created_at,
    similarity: row.similarity === undefined ? undefined : Number(row.similarity),
  };
}
