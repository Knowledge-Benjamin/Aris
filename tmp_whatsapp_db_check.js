const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: '.env' });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  try {
    const t = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='whatsapp_messages'");
    console.log('whatsapp_messages table exists:', t.rows.length > 0);
    if (t.rows.length > 0) {
      const c = await pool.query('SELECT count(*) AS cnt FROM whatsapp_messages');
      console.log('row count:', c.rows[0].cnt);
      const e = await pool.query('SELECT id, sender_id, message_text, whatsapp_timestamp, received_at, is_analyzed FROM whatsapp_messages ORDER BY received_at DESC LIMIT 5');
      console.log('last rows:', JSON.stringify(e.rows, null, 2));
    }
  } catch (err) { console.error('error querying db', err); } finally { await pool.end(); }
})();
