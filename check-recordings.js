const { Pool } = require('pg');
const pool = new Pool({ 
  host: 'localhost', 
  port: 5432, 
  user: 'postgres', 
  password: '3556654', 
  database: 'crm_autoservice' 
});

async function checkRecordings() {
  try {
    const res = await pool.query('SELECT id, recording_link FROM calls WHERE recording_link IS NOT NULL LIMIT 5');
    console.log('Calls with recordings:');
    res.rows.forEach(r => console.log(`ID: ${r.id}, Link: ${r.recording_link}`));
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

checkRecordings();