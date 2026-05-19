const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({ 
  host: 'localhost', 
  port: 5432, 
  user: 'postgres', 
  password: '3556654', 
  database: 'crm_autoservice' 
});

// Добавляем маршрут для очистки дубликатов
app.post('/api/calls/clean-duplicates', async (req, res) => {
    console.log('Received request to clean duplicates');
    
    try {
        // Находим группы звонков с одинаковым номером, датой и временем (с точностью до минуты)
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
        `;
        
        console.log('Executing query to find duplicate groups...');
        const duplicateGroups = await pool.query(duplicatesQuery);
        console.log(`Found ${duplicateGroups.rows.length} groups with exact time duplicates`);

        let totalDeleted = 0;
        
        // Обрабатываем каждую группу
        for (const group of duplicateGroups.rows) {
            console.log(`Processing group: ${group.client_phone} at ${group.call_minute}`);
            
            // Если есть принятые звонки, удаляем все пропущенные с тем же временем
            if (group.success_count > 0) {
                // Удаляем все пропущенные звонки для этой группы
                const deleteQuery = `
                    DELETE FROM calls
                    WHERE client_phone = $1 
                        AND DATE_TRUNC('minute', start_time) = $2
                        AND status = 'Missed'
                `;
                
                console.log(`Executing delete for ${group.client_phone}...`);
                const deleteResult = await pool.query(deleteQuery, [
                    group.client_phone, 
                    group.call_minute
                ]);
                
                const deletedCount = deleteResult.rowCount;
                totalDeleted += deletedCount;
                
                console.log(`Deleted ${deletedCount} missed calls for ${group.client_phone} at ${group.call_minute}`);
            }
        }
        
        console.log(`Total deleted: ${totalDeleted} missed calls`);
        res.status(200).json({ deleted: totalDeleted, groups: duplicateGroups.rows.length });
        
    } catch (err) {
        console.error('Error cleaning duplicate calls:', err);
        res.status(500).json({ error: 'Failed to clean duplicates' });
    }
});

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`Test server running on port ${PORT}`);
});