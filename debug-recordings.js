const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({ 
  host: 'localhost', 
  port: 5432, 
  user: 'postgres', 
  password: '3556654', 
  database: 'crm_autoservice' 
});

const CRM_TOKEN = '36cb3c75-1591-4a7b-bbd4-f767fd43a6b1';
const BEELINE_API_HOST = 'cloudpbx.beeline.ru';

function formatBeelineDate(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    const h = String(date.getUTCHours()).padStart(2, '0');
    const min = String(date.getUTCMinutes()).padStart(2, '0');
    const s = String(date.getUTCSeconds()).padStart(2, '0');
    return `${y}${m}${d}T${h}${min}${s}Z`;
}

async function debugRecordings() {
  try {
    // Get a call ID from database
    const res = await pool.query('SELECT * FROM calls LIMIT 1');
    if (res.rows.length === 0) {
      console.log('No calls in database');
      return;
    }
    
    const call = res.rows[0];
    console.log('Testing with call:', call.id, call.client_phone, call.start_time);
    
    // Test API call to get recordings
    const date = new Date(call.start_time);
    const qs = new URLSearchParams({
      dateFrom: formatBeelineDate(new Date(date.getTime() - 300000)),
      dateTo: formatBeelineDate(new Date(date.getTime() + 300000))
    }).toString();
    
    console.log(`Query: /apis/portal/records?${qs}`);
    
    const options = {
      hostname: BEELINE_API_HOST,
      port: 443,
      path: `/apis/portal/records?${qs}`,
      method: 'GET',
      headers: {
        'X-MPBX-API-AUTH-TOKEN': CRM_TOKEN,
        'Accept': 'application/json'
      }
    };
    
    const records = await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        console.log(`Response status: ${res.statusCode}`);
        res.setEncoding('utf8');
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          console.log('Response data:', data.substring(0, 200));
          if (res.statusCode !== 200) return resolve([]);
          try {
            const parsed = JSON.parse(data);
            resolve(Array.isArray(parsed) ? parsed : []);
          } catch (e) { resolve([]); }
        });
      });
      req.on('error', (e) => {
        console.error('Request error:', e);
        reject(e);
      });
      req.end();
    });
    
    console.log('Found records:', records.length);
    records.forEach(r => console.log(`  ${r.id} - ${r.date} - ${r.phone}`));
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

debugRecordings();