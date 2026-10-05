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

export interface ReusableAnswerMemory {
  id: number;
  question: string;
  answer: string;
  intent: string;
  categories: string[];
  recordedAt: string;
  similarity: number;
  sources: Array<{ tool: string; recordedAt: string; summary: string }>;
}

export interface UserProfileEntry {
  profileKey: string;
  profileValue: string;
}

export class MemoryStore {
  private embeddingClient = new EmbeddingClient();
  private readonly minimumMemorySimilarity = 0.55;
  private readonly minimumAnswerSimilarity = 0.72;

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
    limit: number,
    suppliedEmbedding?: number[],
  ): Promise<SemanticMemoryResult[]> {
    const queryEmbedding = suppliedEmbedding || (await this.embeddingClient.embedTexts([queryText]))[0];
    if (!queryEmbedding?.length) {
      throw new Error("The embedding service returned no vector for semantic memory retrieval.");
    }
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

  async getReusableAnswers(
    userId: number | undefined,
    queryText: string,
    limit = 5,
    suppliedEmbedding?: number[],
  ): Promise<ReusableAnswerMemory[]> {
    if (!userId || !queryText.trim()) return [];
    const queryEmbedding = suppliedEmbedding || (await this.embeddingClient.embedTexts([queryText]))[0];
    if (!queryEmbedding?.length) {
      throw new Error("The embedding service returned no vector for reusable-answer retrieval.");
    }
    const vectorLiteral = `[${queryEmbedding.join(",")}]`;
    const result = await this.pool.query(
      `SELECT id, question, answer, intent, categories, sources, captured_at,
         1 - (embedding <=> $2::vector) AS similarity
       FROM aris_answer_memories
       WHERE user_id = $1 AND embedding IS NOT NULL
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [userId, vectorLiteral, Math.max(1, Math.min(limit, 10))]
    );
    return result.rows
      .map((row): ReusableAnswerMemory => ({
        id: Number(row.id),
        question: row.question,
        answer: row.answer,
        intent: row.intent,
        categories: Array.isArray(row.categories) ? row.categories : [],
        recordedAt: new Date(row.captured_at).toISOString(),
        similarity: Number(row.similarity),
        sources: Array.isArray(row.sources) ? row.sources : [],
      }))
      .filter((answer) => answer.similarity >= this.minimumAnswerSimilarity);
  }

  async getRequestMemory(
    userId: number | undefined,
    sessionId: string | undefined,
    queryText: string,
    memoryLimit = 12,
    answerLimit = 5,
  ): Promise<{ memories: string[]; answers: ReusableAnswerMemory[]; queryEmbedding: number[] }> {
    const [queryEmbedding] = await this.embeddingClient.embedTexts([queryText]);
    if (!queryEmbedding?.length) {
      throw new Error("The embedding service returned no vector for request memory retrieval.");
    }
    const [memoryResult, answerResult] = await Promise.allSettled([
      this.getSemanticMemories(userId, sessionId, queryText, memoryLimit, queryEmbedding),
      this.getReusableAnswers(userId, queryText, answerLimit, queryEmbedding),
    ]);
    if (memoryResult.status === "rejected") {
      console.warn("[MemoryStore] semantic fact retrieval failed", memoryResult.reason);
    }
    if (answerResult.status === "rejected") {
      console.warn("[MemoryStore] reusable answer retrieval failed; run npm run db:setup if the answer-memory table is missing", answerResult.reason);
    }
    const memoryResults = memoryResult.status === "fulfilled" ? memoryResult.value : [];
    const answers = answerResult.status === "fulfilled" ? answerResult.value : [];
    return {
      memories: memoryResults
        .filter((row) => (row.similarity ?? 0) >= this.minimumMemorySimilarity)
        .map((row) => row.content),
      answers,
      queryEmbedding,
    };
  }

  async storeReusableAnswer(input: {
    userId: number;
    question: string;
    answer: string;
    intent: string;
    categories: string[];
    sources: Array<{ tool: string; recordedAt: string; summary: string }>;
    embedding?: number[];
  }): Promise<void> {
    const question = input.question.trim();
    const answer = input.answer.trim();
    if (!question || !answer) return;

    const boundedQuestion = question.slice(0, 2000);
    const embedding = input.embedding && question.length <= 2000
      ? input.embedding
      : (await this.embeddingClient.embedTexts([boundedQuestion]))[0];
    if (!embedding?.length) {
      throw new Error("The embedding service returned no vector for the reusable answer.");
    }
    const questionKey = boundedQuestion.toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/g, "").trim();
    await this.pool.query(
      `INSERT INTO aris_answer_memories
       (user_id, question_key, question, answer, intent, categories, sources, embedding, captured_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::vector, NOW(), NOW())
       ON CONFLICT (user_id, question_key) DO UPDATE SET
         question = EXCLUDED.question,
         answer = EXCLUDED.answer,
         intent = EXCLUDED.intent,
         categories = EXCLUDED.categories,
         sources = EXCLUDED.sources,
         embedding = EXCLUDED.embedding,
         captured_at = NOW(),
         updated_at = NOW()`,
      [
        input.userId,
        questionKey,
        boundedQuestion,
        answer.slice(0, 24000),
        input.intent,
        JSON.stringify(input.categories),
        JSON.stringify(input.sources),
        `[${embedding.join(",")}]`,
      ]
    );
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
