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

  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

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
    CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops);
  `);

  console.log("Creating session_context table...");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_context (
      context_key VARCHAR(255) PRIMARY KEY,
      recent_gmail_messages JSONB DEFAULT '[]',
      last_tool_invocation JSONB,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
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

  // Stores group metadata (subject/name) so we can resolve @g.us JIDs to readable names.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_groups (
      jid TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `).catch(() => undefined);

  // Tracks which WhatsApp accounts have completed their initial history sync.
  // Keyed by account_id (the stable WhatsApp JID, e.g. "61412345678@s.whatsapp.net").
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_history_sync (
      id             SERIAL PRIMARY KEY,
      account_id     TEXT UNIQUE NOT NULL,
      sync_completed BOOLEAN NOT NULL DEFAULT FALSE,
      synced_at      TIMESTAMP WITH TIME ZONE,
      created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `).catch(() => undefined);

  // Migration: rename the old auth_state_hash column to account_id if it still exists.
  await pool.query(
    `ALTER TABLE whatsapp_history_sync RENAME COLUMN auth_state_hash TO account_id;`
  ).catch(() => undefined);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      google_resource_name TEXT,
      display_name TEXT,
      given_name TEXT,
      family_name TEXT,
      phone_numbers TEXT[],
      email_addresses TEXT[],
      whatsapp_ids TEXT[],
      profile_summary TEXT,
      synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      UNIQUE (user_id, google_resource_name)
    );
  `).catch(() => undefined);

  await pool.query(`
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_ids TEXT[];
  `).catch(() => undefined);

  await pool.query(`
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS profile_summary TEXT;
  `).catch(() => undefined);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS contacts_user_id_idx ON contacts(user_id);
  `).catch(() => undefined);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS contacts_phone_numbers_idx ON contacts USING GIN(phone_numbers);
  `).catch(() => undefined);

  console.log("Database setup complete.");
  await pool.end();
}

setup().catch((error) => {
  console.error("Database setup failed:", error);
  process.exit(1);
});
