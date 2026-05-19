const { Pool } = require('pg');

const pool = new Pool({ 
  host: 'localhost', 
  port: 5432, 
  user: 'postgres', 
  password: '3556654', 
  database: 'crm_autoservice' 
});

async function cleanDuplicateCalls() {
  try {
    // Находим все группы звонков по номеру телефона за день
    const duplicatesQuery = `
      SELECT 
        client_phone,
        DATE(start_time) as call_date,
        MIN(start_time) as first_call_time,
        COUNT(*) as call_count,
        COUNT(CASE WHEN status = 'Success' THEN 1 END) as success_count
      FROM calls 
      WHERE client_phone IS NOT NULL 
        AND start_time >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY client_phone, DATE(start_time)
      HAVING COUNT(*) > 1 AND COUNT(CASE WHEN status = 'Success' THEN 1 END) > 0
    `;
    
    const duplicateGroups = await pool.query(duplicatesQuery);
    console.log(`Found ${duplicateGroups.rows.length} groups with duplicates`);

    let totalDeleted = 0;
    
    // Обрабатываем каждую группу
    for (const group of duplicateGroups.rows) {
      // Получаем все звонки в этой группе
      const callsQuery = `
        SELECT id, status, start_time
        FROM calls
        WHERE client_phone = $1 
          AND DATE(start_time) = $2
        ORDER BY start_time
      `;
      
      const callsResult = await pool.query(callsQuery, [group.client_phone, group.call_date]);
      const calls = callsResult.rows;
      
      // Если есть принятые звонки, удаляем пропущенные
      if (group.success_count > 0) {
        // Находим время первого принятого звонка
        const firstSuccessCall = calls.find(c => c.status === 'Success');
        const firstSuccessTime = firstSuccessCall.start_time;
        
        // Удаляем все пропущенные звонки до первого успешного
        const deleteQuery = `
          DELETE FROM calls
          WHERE client_phone = $1 
            AND DATE(start_time) = $2
            AND status = 'Missed'
            AND start_time < $3
        `;
        
        const deleteResult = await pool.query(deleteQuery, [
          group.client_phone, 
          group.call_date, 
          firstSuccessTime
        ]);
        
        const deletedCount = deleteResult.rowCount;
        totalDeleted += deletedCount;
        
        if (deletedCount > 0) {
          console.log(`Deleted ${deletedCount} missed calls for ${group.client_phone} on ${group.call_date} (before first success at ${firstSuccessTime})`);
        }
      }
    }
    
    console.log(`Total deleted: ${totalDeleted} missed calls`);
    return totalDeleted;
    
  } catch (error) {
    console.error('Error cleaning duplicate calls:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

cleanDuplicateCalls().then(count => {
  console.log(`Cleaned ${count} duplicate missed calls`);
}).catch(err => {
  console.error('Failed to clean duplicates:', err);
});