require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  try {
    // Check group messages - how is the sender stored?
    const res1 = await pool.query(`
      SELECT id, sender_id, message_text, metadata
      FROM whatsapp_messages
      WHERE sender_id LIKE '%@g.us'
      LIMIT 5
    `);
    console.log('GROUP MESSAGES (sender_id = group JID):');
    console.log(JSON.stringify(res1.rows, null, 2));

    // Check individual (DM) messages
    const res2 = await pool.query(`
      SELECT id, sender_id, message_text, metadata
      FROM whatsapp_messages
      WHERE sender_id LIKE '%@s.whatsapp.net'
      LIMIT 5
    `);
    console.log('\nDIRECT MESSAGES (sender_id = phone JID):');
    console.log(JSON.stringify(res2.rows, null, 2));

    // Count by type
    const res3 = await pool.query(`
      SELECT 
        CASE 
          WHEN sender_id LIKE '%@g.us' THEN 'group'
          WHEN sender_id LIKE '%@s.whatsapp.net' THEN 'individual'
          WHEN sender_id LIKE '%@lid' THEN 'lid'
          WHEN sender_id LIKE '%-@g.us' THEN 'legacy_group'
          ELSE 'other'
        END as type,
        COUNT(*) as count
      FROM whatsapp_messages
      GROUP BY 1
    `);
    console.log('\nMESSAGE TYPES:');
    console.log(JSON.stringify(res3.rows, null, 2));

    // Check if any group messages have participant in metadata
    const res4 = await pool.query(`
      SELECT id, sender_id, metadata
      FROM whatsapp_messages
      WHERE sender_id LIKE '%@g.us'
        AND metadata->>'participant' IS NOT NULL
        AND metadata->>'participant' != ''
      LIMIT 5
    `);
    console.log('\nGROUP MESSAGES WITH PARTICIPANT IN METADATA:');
    console.log(JSON.stringify(res4.rows, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}
run();
