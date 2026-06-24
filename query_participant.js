require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  try {
    const res = await pool.query("SELECT metadata->>'participant' as participant, sender_id FROM whatsapp_messages WHERE metadata->>'participant' IS NOT NULL LIMIT 10");
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
run();
