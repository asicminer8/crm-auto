const { Pool } = require('pg');
const pool = new Pool({ 
  host: 'localhost', 
  port: 5432, 
  user: 'postgres', 
  password: '3556654', 
  database: 'crm_autoservice' 
});

async function checkAllCalls() {
  try {
    const res = await pool.query('SELECT id, client_phone, recording_link FROM calls LIMIT 5');
    console.log('Recent calls:');
    res.rows.forEach(r => console.log(`ID: ${r.id}, Phone: ${r.client_phone}, Recording: ${r.recording_link || 'NULL'}`));
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

checkAllCalls();