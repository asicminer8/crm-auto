const { Pool } = require('pg');

const pool = new Pool({ 
  host: 'localhost', 
  port: 5432, 
  user: 'postgres', 
  password: '3556654', 
  database: 'crm_autoservice' 
});

async function checkDuplicateCase() {
  try {
    // Проверяем конкретный случай с номером +79169991781 за 19.05.2026
    const testQuery = `
      SELECT id, status, client_phone, start_time
      FROM calls
      WHERE client_phone = '+79169991781'
        AND DATE(start_time) = '2026-05-19'
      ORDER BY start_time
    `;
    
    const result = await pool.query(testQuery);
    console.log(`Found ${result.rows.length} calls for +79169991781 on 2026-05-19:`);
    result.rows.forEach(row => {
      console.log(`  ID: ${row.id}, Status: ${row.status}, Time: ${row.start_time}`);
    });
    
    // Проверяем нашу логику
    if (result.rows.length > 1) {
      const firstSuccess = result.rows.find(r => r.status === 'Success');
      if (firstSuccess) {
        console.log(`First success at: ${firstSuccess.start_time}`);
        
        const missedBeforeSuccess = result.rows.filter(r => 
          r.status === 'Missed' && 
          new Date(r.start_time) < new Date(firstSuccess.start_time)
        );
        
        console.log(`Missed calls before success: ${missedBeforeSuccess.length}`);
        missedBeforeSuccess.forEach(m => {
          console.log(`  Should delete: ID ${m.id}, Status ${m.status}, Time ${m.start_time}`);
        });
      }
    }
    
  } catch (error) {
    console.error('Error checking duplicate case:', error);
  } finally {
    await pool.end();
  }
}

checkDuplicateCase();