import { Pool } from "pg";

export interface NewsResearchArticle {
  title: string;
  url: string;
  source?: string;
  publishedAt?: string;
  snippet?: string;
  content?: string;
}

export interface NewsResearchRecord {
  id: number;
  query: string;
  articles: NewsResearchArticle[];
  createdAt: Date;
}

export class NewsResearchStore {
  constructor(private readonly pool: Pool) {}

  async save(
    userId: number | undefined,
    sessionId: string | undefined,
    query: string,
    articles: NewsResearchArticle[]
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO news_research_records (user_id, session_id, query, articles)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [userId ?? null, sessionId ?? null, query, JSON.stringify(articles)]
    );
  }

  async findRelevant(
    userId: number | undefined,
    sessionId: string | undefined,
    query: string
  ): Promise<NewsResearchRecord[]> {
    const stopWords = new Set([
      "about", "after", "also", "are", "day", "for", "from", "how", "latest",
      "news", "now", "right", "search", "tell", "that", "the", "this", "today",
      "was", "what", "when", "where", "which", "who", "why", "with",
    ]);
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) || [])]
      .filter((term) => !stopWords.has(term))
      .slice(0, 8);
    if (!terms.length) return [];

    const values: unknown[] = [userId ?? null, sessionId ?? null];
    const matches = terms.map((term) => {
      values.push(`%${term}%`);
      const parameter = values.length;
      return `query ILIKE $${parameter}`;
    });
    values.push(5);

    const result = await this.pool.query(
      `SELECT id, query, articles, created_at AS "createdAt"
       FROM news_research_records
       WHERE user_id IS NOT DISTINCT FROM $1
         AND (session_id IS NULL OR session_id IS NOT DISTINCT FROM $2)
         AND (${matches.join(" OR ")})
       ORDER BY created_at DESC
       LIMIT $${values.length}`,
      values
    );

    return result.rows.map((row) => ({
      id: row.id,
      query: row.query,
      articles: Array.isArray(row.articles) ? row.articles : [],
      createdAt: row.createdAt,
    }));
  }
}
