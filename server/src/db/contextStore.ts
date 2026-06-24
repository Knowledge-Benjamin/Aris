import { Pool } from "pg";

export interface GmailMessageSummary {
  id: string;
  subject: string;
  from: string;
  date?: string;
}

export interface ToolInvocationRecord {
  tool: string;
  payload: any;
}

export interface SessionContext {
  recentGmailMessages: GmailMessageSummary[];
  lastToolInvocation: ToolInvocationRecord | undefined;
}

/**
 * Hybrid (in-memory + DB) store for per-session context that survives server
 * restarts and works across multiple server instances.
 *
 * Reads use the in-memory Map as a fast-path cache. On a cache miss the value
 * is loaded from PostgreSQL. Writes go to both the cache and the DB so the
 * data is immediately durable.
 */
export class ContextStore {
  private cache = new Map<string, SessionContext>();

  constructor(private pool: Pool) {}

  /**
   * Load context for a key into the in-memory cache if it is not already
   * present. Should be called at the start of each handleChat invocation.
   */
  async warmCache(key: string): Promise<void> {
    if (this.cache.has(key)) return;

    try {
      const result = await this.pool.query(
        `SELECT recent_gmail_messages, last_tool_invocation
         FROM session_context
         WHERE context_key = $1`,
        [key]
      );

      if (result.rows[0]) {
        this.cache.set(key, {
          recentGmailMessages: result.rows[0].recent_gmail_messages ?? [],
          lastToolInvocation: result.rows[0].last_tool_invocation ?? undefined,
        });
      } else {
        this.cache.set(key, { recentGmailMessages: [], lastToolInvocation: undefined });
      }
    } catch {
      // On DB error, initialise to empty so the caller still works.
      this.cache.set(key, { recentGmailMessages: [], lastToolInvocation: undefined });
    }
  }

  getRecentGmailMessages(key: string): GmailMessageSummary[] {
    return this.cache.get(key)?.recentGmailMessages ?? [];
  }

  getLastToolInvocation(key: string): ToolInvocationRecord | undefined {
    return this.cache.get(key)?.lastToolInvocation;
  }

  async setRecentGmailMessages(key: string, messages: GmailMessageSummary[]): Promise<void> {
    const existing = this.cache.get(key) ?? { recentGmailMessages: [], lastToolInvocation: undefined };
    this.cache.set(key, { ...existing, recentGmailMessages: messages });

    try {
      await this.pool.query(
        `INSERT INTO session_context (context_key, recent_gmail_messages, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (context_key)
         DO UPDATE SET recent_gmail_messages = $2::jsonb, updated_at = NOW()`,
        [key, JSON.stringify(messages)]
      );
    } catch {
      // DB write failure is non-fatal; the in-memory value is still correct
      // for this server process lifetime.
    }
  }

  async setLastToolInvocation(key: string, invocation: ToolInvocationRecord): Promise<void> {
    const existing = this.cache.get(key) ?? { recentGmailMessages: [], lastToolInvocation: undefined };
    this.cache.set(key, { ...existing, lastToolInvocation: invocation });

    try {
      await this.pool.query(
        `INSERT INTO session_context (context_key, last_tool_invocation, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (context_key)
         DO UPDATE SET last_tool_invocation = $2::jsonb, updated_at = NOW()`,
        [key, JSON.stringify(invocation)]
      );
    } catch {
      // DB write failure is non-fatal.
    }
  }
}
