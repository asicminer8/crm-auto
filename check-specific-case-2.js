const { Pool } = require('pg');

const pool = new Pool({ 
  host: 'localhost', 
  port: 5432, 
  user: 'postgres', 
  password: '3556654', 
  database: 'crm_autoservice' 
});

async function checkSpecificCase() {
  try {
    // Проверяем конкретный случай с номером +79250200003 за 19.05.2026
    const testQuery = `
      SELECT id, status, client_phone, start_time
      FROM calls
      WHERE client_phone = '+79250200003'
        AND DATE(start_time) = '2026-05-19'
      ORDER BY start_time
    `;
    
    const result = await pool.query(testQuery);
    console.log(`Found ${result.rows.length} calls for +79250200003 on 2026-05-19:`);
    result.rows.forEach(row => {
      console.log(`  ID: ${row.id}, Status: ${row.status}, Time: ${row.start_time}, Minute: ${new Date(row.start_time).getMinutes()}`);
    });
    
    // Проверяем, входит ли этот случай в нашу группировку по минутам
    if (result.rows.length > 0) {
      console.log('\nGrouping by minute:');
      const groups = {};
      result.rows.forEach(row => {
        const minute = new Date(row.start_time).getMinutes();
        if (!groups[minute]) {
          groups[minute] = [];
        }
        groups[minute].push(row);
      });
      
      Object.keys(groups).forEach(minute => {
        console.log(` Minute ${minute}:`);
        groups[minute].forEach(row => {
          console.log(`  ID: ${row.id}, Status: ${row.status}, Time: ${row.start_time}`);
        });
      });
    }
    
  } catch (error) {
    console.error('Error checking specific case:', error);
  } finally {
    await pool.end();
  }
}

checkSpecificCase();