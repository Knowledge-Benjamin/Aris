import { Pool } from "pg";

export interface GoogleAccountRecord {
  userId: number;
  googleUserId: string;
  googleEmail?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiry?: string;
  scopes?: string;
}

export class GoogleAccountStore {
  constructor(private pool: Pool) {}

  async saveGoogleAccount(
    userId: number,
    googleUserId: string,
    googleEmail: string | undefined,
    accessToken: string | undefined,
    refreshToken: string | undefined,
    tokenExpiryMs: number | undefined,
    scopes: string | undefined
  ): Promise<GoogleAccountRecord> {
    const tokenExpiry = tokenExpiryMs ? new Date(tokenExpiryMs).toISOString() : null;
    const result = await this.pool.query(
      `
      INSERT INTO google_accounts (
        user_id,
        google_user_id,
        google_email,
        access_token,
        refresh_token,
        token_expiry,
        scopes,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        google_user_id = EXCLUDED.google_user_id,
        google_email = EXCLUDED.google_email,
        access_token = EXCLUDED.access_token,
        refresh_token = COALESCE(EXCLUDED.refresh_token, google_accounts.refresh_token),
        token_expiry = EXCLUDED.token_expiry,
        scopes = EXCLUDED.scopes,
        updated_at = NOW()
      RETURNING user_id AS "userId", google_user_id AS "googleUserId", google_email AS "googleEmail", access_token AS "accessToken", refresh_token AS "refreshToken", token_expiry AS "tokenExpiry", scopes
      `,
      [userId, googleUserId, googleEmail, accessToken, refreshToken, tokenExpiry, scopes]
    );

    return result.rows[0];
  }

  async getGoogleAccount(userId: number): Promise<GoogleAccountRecord | undefined> {
    const result = await this.pool.query(
      `
      SELECT user_id AS "userId", google_user_id AS "googleUserId", google_email AS "googleEmail", access_token AS "accessToken", refresh_token AS "refreshToken", token_expiry AS "tokenExpiry", scopes
      FROM google_accounts
      WHERE user_id = $1
      LIMIT 1
      `,
      [userId]
    );
    return result.rows[0];
  }

  async updateGoogleTokens(
    userId: number,
    accessToken: string | undefined,
    refreshToken: string | undefined,
    tokenExpiryMs: number | undefined,
    scopes: string | undefined
  ): Promise<void> {
    const tokenExpiry = tokenExpiryMs ? new Date(tokenExpiryMs).toISOString() : null;
    await this.pool.query(
      `
      UPDATE google_accounts
      SET
        access_token = COALESCE($2, access_token),
        refresh_token = COALESCE($3, refresh_token),
        token_expiry = COALESCE($4, token_expiry),
        scopes = COALESCE($5, scopes),
        updated_at = NOW()
      WHERE user_id = $1
      `,
      [userId, accessToken, refreshToken, tokenExpiry, scopes]
    );
  }

  async deleteGoogleAccount(userId: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM google_accounts WHERE user_id = $1`,
      [userId]
    );
  }
}
