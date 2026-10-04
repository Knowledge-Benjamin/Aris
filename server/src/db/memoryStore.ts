import { Pool } from "pg";
import { EmbeddingClient } from "../services/embeddingClient";

export interface ConversationMessage {
  userId?: number;
  sessionId?: string;
  role: "user" | "aris" | "system";
  content: string;
}

export interface SemanticMemoryResult {
  id: number;
  content: string;
  createdAt: string;
  similarity?: number;
}

export interface UserProfileEntry {
  profileKey: string;
  profileValue: string;
}

export class MemoryStore {
  private embeddingClient = new EmbeddingClient();
  private readonly minimumMemorySimilarity = 0.55;

  constructor(private pool: Pool) {}

  async saveConversationMessage(message: ConversationMessage) {
    const query = `
      INSERT INTO conversations (user_id, session_id, role, content, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `;
    await this.pool.query(query, [message.userId ?? null, message.sessionId ?? null, message.role, message.content]);
  }

  async getRelevantMemories(
    userId: number | undefined,
    sessionId: string | undefined,
    queryText: string | undefined,
    limit: number
  ) {
    if (!queryText) {
      return this.getRecentMemories(userId, sessionId, limit);
    }

    try {
      const results = await this.getSemanticMemories(userId, sessionId, queryText, limit);
      return results
        .filter((row) => (row.similarity ?? 0) >= this.minimumMemorySimilarity)
        .map((row) => row.content);
    } catch (error) {
      console.warn("[MemoryStore] vector memory search failed; no query-irrelevant memories will be substituted", error);
    }

    return [];
  }

  async getSemanticMemories(
    userId: number | undefined,
    sessionId: string | undefined,
    queryText: string,
    limit: number
  ): Promise<SemanticMemoryResult[]> {
    const [queryEmbedding] = await this.embeddingClient.embedTexts([queryText]);
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;

    if (userId) {
      const query = `
        SELECT id, content, created_at, 1 - (embedding <=> $2::vector) AS similarity
        FROM memories
        WHERE user_id = $1 AND embedding IS NOT NULL
        ORDER BY embedding <=> $2::vector
        LIMIT $3
      `;
      const result = await this.pool.query(query, [userId, vectorLiteral, limit]);
      return result.rows.map((row) => ({
        id: row.id,
        content: row.content,
        createdAt: row.created_at,
        similarity: Number(row.similarity),
      }));
    }

    if (sessionId) {
      const query = `
        SELECT id, content, created_at, 1 - (embedding <=> $2::vector) AS similarity
        FROM memories
        WHERE session_id = $1 AND embedding IS NOT NULL
        ORDER BY embedding <=> $2::vector
        LIMIT $3
      `;
      const result = await this.pool.query(query, [sessionId, vectorLiteral, limit]);
      return result.rows.map((row) => ({
        id: row.id,
        content: row.content,
        createdAt: row.created_at,
        similarity: Number(row.similarity),
      }));
    }

    throw new Error("Semantic search requires userId or sessionId.");
  }

  async getUserProfile(userId: number): Promise<UserProfileEntry[]> {
    const query = `
      SELECT profile_key, profile_value
      FROM user_profiles
      WHERE user_id = $1
      ORDER BY updated_at DESC
    `;
    const result = await this.pool.query(query, [userId]);
    return result.rows.map((row) => ({
      profileKey: row.profile_key,
      profileValue: row.profile_value,
    }));
  }

  async storeProfileEntry(userId: number, profileKey: string, profileValue: string) {
    const query = `
      INSERT INTO user_profiles (user_id, profile_key, profile_value, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (user_id, profile_key, profile_value) DO UPDATE SET updated_at = NOW()
    `;
    await this.pool.query(query, [userId, profileKey, profileValue]);
  }

  private async getRecentMemories(userId: number | undefined, sessionId: string | undefined, limit: number) {
    if (userId && sessionId) {
      const query = `
        SELECT content
        FROM memories
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT $2
      `;
      const result = await this.pool.query(query, [userId, limit]);
      return result.rows.map((row) => row.content);
    }

    if (userId) {
      const query = `
        SELECT content
        FROM memories
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT $2
      `;
      const result = await this.pool.query(query, [userId, limit]);
      return result.rows.map((row) => row.content);
    }

    if (sessionId) {
      const query = `
        SELECT content
        FROM memories
        WHERE session_id = $1
        ORDER BY updated_at DESC
        LIMIT $2
      `;
      const result = await this.pool.query(query, [sessionId, limit]);
      return result.rows.map((row) => row.content);
    }

    return [];
  }

  async getRecentConversationHistory(userId: number | undefined, sessionId: string | undefined, limit: number) {
    if (userId && sessionId) {
      const query = `
        SELECT role, content
        FROM conversations
        WHERE user_id = $1 AND session_id = $2
        ORDER BY created_at DESC
        LIMIT $3
      `;
      const result = await this.pool.query(query, [userId, sessionId, limit]);
      return result.rows.reverse().map((row) => `${row.role === "user" ? "User" : "Aris"}: ${row.content}`);
    }

    if (userId) {
      const query = `
        SELECT role, content
        FROM conversations
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `;
      const result = await this.pool.query(query, [userId, limit]);
      return result.rows.reverse().map((row) => `${row.role === 'user' ? 'User' : 'Aris'}: ${row.content}`);
    }

    if (sessionId) {
      const query = `
        SELECT role, content
        FROM conversations
        WHERE session_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `;
      const result = await this.pool.query(query, [sessionId, limit]);
      return result.rows.reverse().map((row) => `${row.role === 'user' ? 'User' : 'Aris'}: ${row.content}`);
    }

    return [];
  }

  async storeMemoryEntry(userId: number | undefined, sessionId: string | undefined, content: string) {
    const embeddings = await this.embeddingClient.embedTexts([content]);
    const embeddingVector = embeddings[0] || [];
    const vectorLiteral = `[${embeddingVector.join(",")}]`;

    const query = `
      INSERT INTO memories (user_id, session_id, content, created_at, updated_at, embedding)
      VALUES ($1, $2, $3, NOW(), NOW(), $4::vector)
    `;
    await this.pool.query(query, [userId ?? null, sessionId ?? null, content, vectorLiteral]);
  }
}
