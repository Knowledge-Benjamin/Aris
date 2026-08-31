import { getDatabasePool } from "./db";

const pool = getDatabasePool();
const AUTH_TABLE = process.env.WHATSAPP_AUTH_TABLE || "aris_whatsapp_auth_state";

/**
 * Returns the authenticated WhatsApp account's own JID by reading the
 * Baileys credential row stored in Postgres after QR-code pairing.
 * Returns null if no account has been paired yet.
 *
 * Example return value: "256700000000@s.whatsapp.net"
 */
export async function getSelfJid(): Promise<string | null> {
  try {
    const res = await pool.query(
      `SELECT value FROM ${AUTH_TABLE} WHERE key = 'creds' LIMIT 1`
    );
    if (!res.rows.length) return null;
    const creds =
      typeof res.rows[0].value === "string"
        ? JSON.parse(res.rows[0].value)
        : res.rows[0].value;
    return creds?.me?.id ?? null;
  } catch {
    return null;
  }
}
