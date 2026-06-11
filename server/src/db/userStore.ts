import { Pool } from "pg";
import crypto from "crypto";

const HASH_ALGORITHM = "sha512";
const HASH_ITERATIONS = 120000;
const HASH_KEYLEN = 64;

export interface UserRecord {
  id: number;
  email: string;
  created_at: string;
  onboarding_complete?: boolean;
}

function hashPassword(password: string, salt: string) {
  return crypto.pbkdf2Sync(password, salt, HASH_ITERATIONS, HASH_KEYLEN, HASH_ALGORITHM).toString("hex");
}

function generateSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

export class UserStore {
  constructor(private pool: Pool) {}

  async createUser(email: string, password: string): Promise<UserRecord> {
    const normalizedEmail = email.trim().toLowerCase();
    const salt = generateSalt();
    const passwordHash = hashPassword(password, salt);

    const result = await this.pool.query(
      `INSERT INTO users (email, password_hash, salt, onboarding_complete, created_at)
       VALUES ($1, $2, $3, FALSE, NOW())
       RETURNING id, email, onboarding_complete, created_at`,
      [normalizedEmail, passwordHash, salt]
    );

    return result.rows[0];
  }

  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    const normalizedEmail = email.trim().toLowerCase();
    const result = await this.pool.query(
      `SELECT id, email, created_at FROM users WHERE email = $1 LIMIT 1`,
      [normalizedEmail]
    );
    return result.rows[0];
  }

  async verifyPassword(email: string, password: string): Promise<UserRecord | undefined> {
    const normalizedEmail = email.trim().toLowerCase();
    const result = await this.pool.query(
      `SELECT id, email, created_at, password_hash, salt, onboarding_complete FROM users WHERE email = $1 LIMIT 1`,
      [normalizedEmail]
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }

    const candidateHash = hashPassword(password, row.salt);
    if (crypto.timingSafeEqual(Buffer.from(candidateHash, "hex"), Buffer.from(row.password_hash, "hex"))) {
      return { id: row.id, email: row.email, created_at: row.created_at, onboarding_complete: row.onboarding_complete };
    }

    return undefined;
  }

  async createSession(userId: number): Promise<string> {
    const token = generateToken();
    await this.pool.query(
      `INSERT INTO sessions (user_id, token, created_at, expires_at)
       VALUES ($1, $2, NOW(), NOW() + INTERVAL '30 days')`,
      [userId, token]
    );
    return token;
  }

  async findUserByToken(token: string): Promise<UserRecord | undefined> {
    const result = await this.pool.query(
      `SELECT u.id, u.email, u.created_at, u.onboarding_complete
       FROM users u
       JOIN sessions s ON s.user_id = u.id
       WHERE s.token = $1 AND s.expires_at > NOW()
       LIMIT 1`,
      [token]
    );
    return result.rows[0];
  }

  async markOnboardingComplete(userId: number): Promise<void> {
    await this.pool.query(
      `UPDATE users SET onboarding_complete = TRUE WHERE id = $1`,
      [userId]
    );
  }
}
