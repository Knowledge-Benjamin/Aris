import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required in environment variables.");
}

function normalizeConnectionString(connectionString: string) {
  try {
    const url = new URL(connectionString);
    if (!url.searchParams.has("sslmode")) {
      url.searchParams.set("sslmode", "verify-full");
    }
    return url.toString();
  } catch {
    return connectionString;
  }
}

const pool = new Pool({ connectionString: normalizeConnectionString(connectionString) });

async function setup() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      expires_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() + INTERVAL '30 days'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      session_id TEXT,
      user_id INTEGER REFERENCES users(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS vector;
  `);

  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS vector;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id SERIAL PRIMARY KEY,
      session_id TEXT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      embedding VECTOR(768)
    );
  `);

  await pool.query(`
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding VECTOR(768);
  `).catch(() => undefined);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
  `).catch(() => undefined);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_key TEXT NOT NULL,
      profile_value TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      UNIQUE (user_id, profile_key, profile_value)
    );
  `).catch(() => undefined);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS user_profiles_user_id_idx ON user_profiles(user_id);
  `).catch(() => undefined);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS google_accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      google_user_id TEXT NOT NULL,
      google_email TEXT,
      access_token TEXT,
      refresh_token TEXT,
      token_expiry TIMESTAMP WITH TIME ZONE,
      scopes TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      UNIQUE (user_id)
    );
  `).catch(() => undefined);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS google_accounts_user_id_idx ON google_accounts(user_id);
  `).catch(() => undefined);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id SERIAL PRIMARY KEY,
      sender_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      message_text TEXT NOT NULL,
      whatsapp_timestamp BIGINT,
      received_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      is_analyzed BOOLEAN NOT NULL DEFAULT FALSE,
      metadata JSONB,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `).catch(() => undefined);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS whatsapp_messages_is_analyzed_idx ON whatsapp_messages(is_analyzed);
  `).catch(() => undefined);

  await pool.query(`
    ALTER TABLE conversations ALTER COLUMN session_id DROP NOT NULL;
  `).catch(() => undefined);

  await pool.query(`
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  `).catch(() => undefined);

  await pool.query(`
    ALTER TABLE memories ALTER COLUMN session_id DROP NOT NULL;
  `).catch(() => undefined);

  await pool.query(`
    ALTER TABLE memories ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  `).catch(() => undefined);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE;
  `).catch(() => undefined);

  console.log("Database setup complete.");
  await pool.end();
}

setup().catch((error) => {
  console.error("Database setup failed:", error);
  process.exit(1);
});
