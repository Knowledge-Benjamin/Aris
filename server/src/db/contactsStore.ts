import { getDatabasePool } from "./db";

export interface ContactRecord {
  id: number;
  userId: number;
  googleResourceName?: string;
  displayName?: string;
  givenName?: string;
  familyName?: string;
  phoneNumbers: string[];
  emailAddresses: string[];
  profileSummary?: string;
  syncedAt: Date;
}

const pool = getDatabasePool();

/**
 * Normalize a phone number to digits only for fuzzy matching.
 * e.g. "+1 (206) 555-0100" → "12065550100"
 *      "206123456@c.us"    → "206123456"
 */
export function normalizePhone(raw: string): string {
  return raw.replace(/@.*$/, "").replace(/[^0-9]/g, "");
}

/**
 * Returns true if the JID is a WhatsApp group (ends with @g.us)
 */
export function isGroupJid(jid: string): boolean {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

/**
 * Extracts a human-readable label from a JID for fallback display.
 * Individual: "254712345678@s.whatsapp.net" → "+254712345678"
 * Group:      "120363043635066182@g.us"    → "Group Chat"
 */
export function jidToDisplayFallback(jid: string): string {
  if (isGroupJid(jid)) return "Group Chat";
  const digits = jid.replace(/@.*$/, "").replace(/[^0-9]/g, "");
  if (!digits) return jid;
  return "+" + digits;
}

/**
 * Produce every plausible digit-only lookup key for a raw phone / WhatsApp ID.
 * Handles formats like:
 *   "254712345678@c.us"  → ["254712345678", "712345678", "0712345678"]
 *   "+254 712 345 678"  → ["254712345678", "712345678", "0712345678"]
 *   "0712345678"        → ["0712345678", "712345678"]
 */
export function phoneLookupKeys(raw: string): string[] {
  // Group JIDs cannot be phone-matched — skip them
  if (isGroupJid(raw)) return [];
  const full = normalizePhone(raw);
  if (!full) return [];
  const keys = new Set<string>();
  keys.add(full);
  // Last 9 digits (core local number)
  if (full.length > 9) keys.add(full.slice(-9));
  // Last 10 digits
  if (full.length > 10) keys.add(full.slice(-10));
  // Strip leading country code: if starts with 1, 7, 254, 44 etc. add 0-prefixed
  if (full.length === 12 && full.startsWith("254")) {
    keys.add("0" + full.slice(3)); // → "0712345678"
    keys.add(full.slice(3));       // → "712345678"
  } else if (full.length === 11 && full.startsWith("0")) {
    keys.add(full.slice(1));       // → "712345678"
  } else if (full.length === 10 && !full.startsWith("0")) {
    keys.add("0" + full);          // → "0712345678"
  }
  return Array.from(keys);
}

function keysOverlap(keysA: string[], keysB: string[]): boolean {
  return keysA.some(a => keysB.includes(a));
}

/**
 * Resolve an array of raw WhatsApp sender IDs (phone numbers) to contact display names.
 * Returns a map of raw → resolved name. Uses multi-key fuzzy matching to guarantee
 * matches across country-code variations and WhatsApp ID formats.
 */
export async function resolvePhoneNumbers(
  userId: number,
  rawNumbers: string[]
): Promise<Record<string, string>> {
  if (!rawNumbers.length) return {};

  const result: Record<string, string> = {};

  // --- Pass 1: Resolve group JIDs from whatsapp_groups table ---
  const groupJids = rawNumbers.filter(isGroupJid);
  if (groupJids.length) {
    const groupRes = await pool.query(
      `SELECT jid, subject FROM whatsapp_groups WHERE jid = ANY($1)`,
      [groupJids]
    ).catch(() => ({ rows: [] as any[] }));
    for (const row of groupRes.rows) {
      result[row.jid] = row.subject;
    }
  }

  // --- Pass 2: Resolve individual phone-number JIDs from contacts table ---
  const phoneJids = rawNumbers.filter(r => !isGroupJid(r));
  if (!phoneJids.length) return result;

  // Build lookup-key sets for every incoming number
  const incomingKeyMap: Array<{ raw: string; keys: string[] }> = phoneJids.map(raw => ({
    raw,
    keys: phoneLookupKeys(raw),
  }));

  const contactRes = await pool.query(
    `SELECT display_name, phone_numbers FROM contacts WHERE user_id = $1`,
    [userId]
  );

  for (const row of contactRes.rows) {
    const name: string = row.display_name;
    if (!name) continue;
    const dbPhones: string[] = row.phone_numbers || [];
    const dbKeys = dbPhones.flatMap(p => phoneLookupKeys(p));
    if (!dbKeys.length) continue;

    for (const inc of incomingKeyMap) {
      if (result[inc.raw]) continue;
      if (keysOverlap(inc.keys, dbKeys)) {
        result[inc.raw] = name;
      }
    }
  }

  return result;
}

/**
 * Given a display name (or partial name like "Grace"), return all normalized
 * phone lookup keys for that contact. Used to find WhatsApp messages from a named contact.
 */
export async function resolveNameToPhones(
  userId: number,
  nameQuery: string
): Promise<{ contactId: number; displayName: string; phoneKeys: string[]; whatsappIds: string[]; profileSummary: string } | null> {
  const q = `%${nameQuery.toLowerCase()}%`;
  const res = await pool.query(
    `SELECT id, display_name, given_name, family_name, phone_numbers, whatsapp_ids, profile_summary
     FROM contacts
     WHERE user_id = $1
       AND (
         LOWER(display_name) LIKE $2
         OR LOWER(given_name) LIKE $2
         OR LOWER(family_name) LIKE $2
       )
     ORDER BY
       CASE
         WHEN LOWER(display_name) = $3 OR LOWER(given_name) = $3 THEN 0
         ELSE 1
       END
     LIMIT 1`,
    [userId, q, nameQuery.toLowerCase()]
  );

  if (!res.rows.length) return null;

  const row = res.rows[0];
  const phones: string[] = row.phone_numbers || [];
  const whatsappIds: string[] = row.whatsapp_ids || [];
  const phoneKeys = [...new Set(phones.flatMap(p => phoneLookupKeys(p)))];

  return {
    contactId: row.id,
    displayName: row.display_name || [row.given_name, row.family_name].filter(Boolean).join(" ") || nameQuery,
    phoneKeys,
    whatsappIds,
    profileSummary: row.profile_summary || "",
  };
}

export async function linkWhatsappIdsToContact(userId: number, contactId: number, whatsappIds: string[]) {
  if (!whatsappIds.length) return;
  await pool.query(`
    UPDATE contacts 
    SET whatsapp_ids = ARRAY(
      SELECT DISTINCT UNNEST(array_cat(COALESCE(whatsapp_ids, '{}'), $1::text[]))
    )
    WHERE id = $2 AND user_id = $3
  `, [whatsappIds, contactId, userId]);
}

export async function updateContactProfileSummary(userId: number, contactId: number, summary: string) {
  await pool.query(`
    UPDATE contacts 
    SET profile_summary = $1
    WHERE id = $2 AND user_id = $3
  `, [summary, contactId, userId]);
}

export async function upsertContacts(userId: number, contacts: Array<{
  resourceName?: string;
  displayName?: string;
  givenName?: string;
  familyName?: string;
  phoneNumbers?: string[];
  emailAddresses?: string[];
}>): Promise<number> {
  if (!contacts.length) return 0;
  let upserted = 0;

  for (const c of contacts) {
    const phones = (c.phoneNumbers || []).map(p => p.trim()).filter(Boolean);
    const emails = (c.emailAddresses || []).map(e => e.trim().toLowerCase()).filter(Boolean);
    const resourceName = c.resourceName || null;
    const displayName = c.displayName || [c.givenName, c.familyName].filter(Boolean).join(" ") || null;

    await pool.query(
      `INSERT INTO contacts (user_id, google_resource_name, display_name, given_name, family_name, phone_numbers, email_addresses, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id, google_resource_name)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         given_name = EXCLUDED.given_name,
         family_name = EXCLUDED.family_name,
         phone_numbers = EXCLUDED.phone_numbers,
         email_addresses = EXCLUDED.email_addresses,
         synced_at = NOW()`,
      [userId, resourceName, displayName, c.givenName || null, c.familyName || null, phones, emails]
    );
    upserted++;
  }
  return upserted;
}

export async function getContactCount(userId: number): Promise<number> {
  const res = await pool.query(`SELECT COUNT(*) FROM contacts WHERE user_id = $1`, [userId]);
  return parseInt(res.rows[0].count, 10);
}



/**
 * Search contacts by name, email, or phone number. Returns matches.
 */
export async function searchContacts(userId: number, query: string): Promise<ContactRecord[]> {
  const q = `%${query.toLowerCase()}%`;
  const res = await pool.query(
    `SELECT id, user_id, google_resource_name, display_name, given_name, family_name, phone_numbers, email_addresses, profile_summary, synced_at
     FROM contacts
     WHERE user_id = $1
       AND (
         LOWER(display_name) LIKE $2
         OR LOWER(given_name) LIKE $2
         OR LOWER(family_name) LIKE $2
         OR EXISTS (SELECT 1 FROM unnest(email_addresses) e WHERE LOWER(e) LIKE $2)
         OR EXISTS (SELECT 1 FROM unnest(phone_numbers) p WHERE p LIKE $2)
       )
     LIMIT 20`,
    [userId, q]
  );

  return res.rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    googleResourceName: r.google_resource_name,
    displayName: r.display_name,
    givenName: r.given_name,
    familyName: r.family_name,
    phoneNumbers: r.phone_numbers || [],
    emailAddresses: r.email_addresses || [],
    profileSummary: r.profile_summary || "",
    syncedAt: r.synced_at,
  }));
}

export async function getAllContacts(userId: number): Promise<ContactRecord[]> {
  const res = await pool.query(
    `SELECT id, user_id, google_resource_name, display_name, given_name, family_name, phone_numbers, email_addresses, synced_at
     FROM contacts WHERE user_id = $1 ORDER BY display_name`,
    [userId]
  );
  return res.rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    googleResourceName: r.google_resource_name,
    displayName: r.display_name,
    givenName: r.given_name,
    familyName: r.family_name,
    phoneNumbers: r.phone_numbers || [],
    emailAddresses: r.email_addresses || [],
    syncedAt: r.synced_at,
  }));
}
