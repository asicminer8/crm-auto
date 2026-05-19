const { Pool } = require('pg');

const pool = new Pool({ 
  host: 'localhost', 
  port: 5432, 
  user: 'postgres', 
  password: '3556654', 
  database: 'crm_autoservice' 
});

async function testApiEndpoint() {
  try {
    // Имитируем POST запрос к endpoint
    const duplicatesQuery = `
        SELECT 
            client_phone,
            DATE_TRUNC('minute', start_time) as call_minute,
            COUNT(*) as call_count,
            COUNT(CASE WHEN status = 'Success' THEN 1 END) as success_count,
            MIN(start_time) as min_time,
            MAX(start_time) as max_time
        FROM calls 
        WHERE client_phone IS NOT NULL 
            AND start_time >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY client_phone, DATE_TRUNC('minute', start_time)
        HAVING COUNT(*) > 1 AND COUNT(CASE WHEN status = 'Success' THEN 1 END) > 0
        ORDER BY client_phone, call_minute
        LIMIT 5
    `;
    
    const duplicateGroups = await pool.query(duplicatesQuery);
    console.log(`Found ${duplicateGroups.rows.length} groups with exact time duplicates (preview):`);

    let totalDeleted = 0;
    
    // Обрабатываем каждую группу
    for (const group of duplicateGroups.rows) {
        console.log(`\nGroup: ${group.client_phone} at ${group.call_minute}`);
        console.log(`  Total: ${group.call_count}, Success: ${group.success_count}`);
        
        // Получаем все звонки в этой группе
        const callsQuery = `
            SELECT id, status, client_phone, start_time
            FROM calls
            WHERE client_phone = $1 
                AND DATE_TRUNC('minute', start_time) = $2
            ORDER BY start_time
        `;
        
        const callsResult = await pool.query(callsQuery, [group.client_phone, group.call_minute]);
        const calls = callsResult.rows;
        
        console.log(`  Calls before deletion:`);
        calls.forEach(c => {
            console.log(`    ID: ${c.id}, Status: ${c.status}, Time: ${c.start_time}`);
        });
        
        // Если есть принятые звонки, удаляем все пропущенные с тем же временем
        if (group.success_count > 0) {
            // Удаляем все пропущенные звонки для этой группы
            const deleteQuery = `
                DELETE FROM calls
                WHERE client_phone = $1 
                    AND DATE_TRUNC('minute', start_time) = $2
                    AND status = 'Missed'
            `;
            
            const deleteResult = await pool.query(deleteQuery, [
                group.client_phone, 
                group.call_minute
            ]);
            
            const deletedCount = deleteResult.rowCount;
            totalDeleted += deletedCount;
            
            console.log(`  Deleted: ${deletedCount} missed calls`);
            
            // Проверяем после удаления
            const afterDeleteQuery = `
                SELECT id, status, client_phone, start_time
                FROM calls
                WHERE client_phone = $1 
                    AND DATE_TRUNC('minute', start_time) = $2
                ORDER BY start_time
            `;
            
            const afterDeleteResult = await pool.query(afterDeleteQuery, [group.client_phone, group.call_minute]);
            console.log(`  Calls after deletion:`);
            afterDeleteResult.rows.forEach(c => {
                console.log(`    ID: ${c.id}, Status: ${c.status}, Time: ${c.start_time}`);
            });
        }
    }
    
    console.log(`\nTotal deleted: ${totalDeleted} missed calls`);
    
  } catch (error) {
    console.error('Error testing API endpoint:', error);
  } finally {
    await pool.end();
  }
}

testApiEndpoint();