const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

// Beeline отправляет данные в формате application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: true }));

// Настройка шаблонизатора EJS
app.set('view engine', 'ejs');
app.set('views', './views');

// Подключение к PostgreSQL
const pool = new Pool({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: '3556654',
    database: 'crm_autoservice'
});

const CRM_TOKEN = '36cb3c75-1591-4a7b-bbd4-f767fd43a6b1';
// Домен API Beeline (замените на ваш, например: cloudpbx.beeline.kg, ats.beeline.kg и т.д.)
const BEELINE_API_HOST = 'cloudpbx.beeline.ru';

// Форматирование даты для Beeline API: YYYYMMDDTHHMMSSZ
function formatBeelineDate(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    const h = String(date.getUTCHours()).padStart(2, '0');
    const min = String(date.getUTCMinutes()).padStart(2, '0');
    const s = String(date.getUTCSeconds()).padStart(2, '0');
    return `${y}${m}${d}T${h}${min}${s}Z`;
}

// Парсинг одной строки CSV с учётом кавычек (без сторонних библиотек)
function parseCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result.map(v => v.replace(/^"|"$/g, ''));
}

// Маппинг статусов Beeline API v2 в наши статусы
function mapBeelineStatus(status) {
    switch (status) {
        case 'RECIEVED': return 'Success';
        case 'MISSED': return 'Missed';
        case 'PLACED': return 'Success';
        case 'REDIRECTED': return 'Success';
        default: return status;
    }
}

// Загрузка истории звонков из Beeline API v2 (Portal API)
async function fetchHistoryFromBeeline(optDateFrom, optDateTo) {
    const now = new Date();

    let dateFrom, dateTo;
    if (optDateFrom && optDateTo) {
        dateFrom = new Date(optDateFrom + 'T00:00:00Z');
        const [y, m, d] = optDateTo.split('-').map(Number);
        dateTo = new Date(Date.UTC(y, m - 1, d + 1));
    } else {
        dateFrom = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0));
        dateTo = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0));
    }

    const dateFromStr = dateFrom.toISOString();
    const dateToStr = dateTo.toISOString();

    const pageSize = 100;
    let page = 0;
    let totalInserted = 0;
    let hasMore = true;

    while (hasMore) {
        const queryParams = new URLSearchParams({
            dateFrom: dateFromStr,
            dateTo: dateToStr,
            page: String(page),
            pageSize: String(pageSize)
        }).toString();

        const path = `/apis/portal/v2/statistics?${queryParams}`;

        const records = await new Promise((resolvePage, rejectPage) => {
            const options = {
                hostname: BEELINE_API_HOST,
                port: 443,
                path: path,
                method: 'GET',
                headers: {
                    'X-MPBX-API-AUTH-TOKEN': CRM_TOKEN,
                    'Accept': 'application/json'
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        console.error(`Beeline API returned status ${res.statusCode}: ${data}`);
                        return resolvePage([]);
                    }
                    try {
                        const parsed = JSON.parse(data);
                        resolvePage(Array.isArray(parsed) ? parsed : []);
                    } catch (e) {
                        resolvePage([]);
                    }
                });
            });

            req.on('error', (err) => rejectPage(err));
            req.end();
        });

        if (!records || records.length === 0) {
            hasMore = false;
            break;
        }

        let inserted = 0;
        const dbClient = await pool.connect();
        try {
            const userIds = new Set();
            for (const record of records) {
                if (record.abonent && record.abonent.userId) {
                    userIds.add(record.abonent.userId);
                }
            }
            if (userIds.size > 0) {
                const userArray = Array.from(userIds);
                const placeholders = userArray.map((_, i) => `($${i + 1})`).join(',');
                await dbClient.query(`
                    INSERT INTO ats_users (user_id) VALUES ${placeholders}
                    ON CONFLICT (user_id) DO NOTHING
                `, userArray);
            }

            for (const record of records) {
                const direction = record.direction === 'INBOUND' ? 'in' : (record.direction === 'OUTBOUND' ? 'out' : null);
                const clientPhone = direction === 'in' ? (record.phone_from || record.phone) : (record.phone_to || record.phone);
                const diversion = direction === 'in' ? (record.phone_to || null) : null;

                const callId = record.externalTrackingId
                    ? `bl-${record.externalTrackingId}`
                    : `bl-${record.startDate}-${direction}-${clientPhone || 'unknown'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

                const values = [
                    callId, direction, mapBeelineStatus(record.status), clientPhone,
                    record.abonent ? record.abonent.userId : null,
                    record.abonent ? record.abonent.extension : null,
                    record.department || null, null, diversion,
                    record.startDate ? new Date(record.startDate) : null,
                    null, record.duration ? Math.round(record.duration / 1000) : null, null
                ];

                const query = `
                    INSERT INTO calls (call_id, type, status, client_phone, user_id, ext, group_name, telnum, diversion, start_time, wait_time, duration, recording_link)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                    ON CONFLICT (start_time, type, client_phone, user_id) DO NOTHING
                `;
                await dbClient.query(query, values);
                inserted++;
            }
        } finally {
            dbClient.release();
        }

        console.log(`Loaded ${inserted} records from Beeline statistics (page ${page})`);
        totalInserted += inserted;

        if (page === 0) {
            try {
                await fetchRecordingsForDateRange(dateFromStr, dateToStr);
            } catch (recErr) {
                console.error('Failed to fetch recordings:', recErr.message);
            }
        }

        if (records.length < pageSize) hasMore = false;
        page++;
    }

    return totalInserted;
}

// После синхронизации статистики подтягивает ссылки на записи разговоров
async function fetchRecordingsForDateRange(dateFromStr, dateToStr) {
    // 1. Получаем список записей из /apis/portal/records
    const records = await new Promise((resolve, reject) => {
        const qs = new URLSearchParams({
            dateFrom: formatBeelineDate(new Date(dateFromStr)),
            dateTo: formatBeelineDate(new Date(dateToStr))
        }).toString();
        const req = https.request({
            hostname: BEELINE_API_HOST, port: 443,
            path: `/apis/portal/records?${qs}`,
            method: 'GET',
            headers: { 'X-MPBX-API-AUTH-TOKEN': CRM_TOKEN, 'Accept': 'application/json' }
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', c => data += c);
            res.on('end', () => {
                if (res.statusCode !== 200) return resolve([]);
                try { const p = JSON.parse(data); resolve(Array.isArray(p) ? p : []); }
                catch (e) { resolve([]); }
            });
        });
        req.on('error', e => reject(e));
        req.end();
    });

    if (!records || records.length === 0) {
        console.log('No recordings found for period');
        return;
    }

    // 2. Для каждой записи получаем reference-ссылку и обновляем БД
    let updated = 0;
    for (const rec of records) {
        // Ищем звонок в БД по номеру телефона (последние 7+ цифр) и дате
        const recPhoneClean = rec.phone ? rec.phone.replace(/[^0-9]/g, '') : '';
        if (!recPhoneClean) continue;

        const recDate = rec.date ? new Date(rec.date) : null;
        if (!recDate) continue;

        // Поиск звонка с таким же номером (последние 7+ цифр) и временем (+/- 5 мин)
        const phoneSuffix = recPhoneClean.slice(-7);
        const dateStart = new Date(recDate.getTime() - 300000).toISOString();
        const dateEnd = new Date(recDate.getTime() + 300000).toISOString();

        try {
            const result = await pool.query(`
                SELECT id, client_phone, start_time FROM calls
                WHERE recording_link IS NULL
                  AND start_time >= $1::timestamp
                  AND start_time <= $2::timestamp
                  AND RIGHT(regexp_replace(client_phone, '[^0-9]', '', 'g'), 7) = $3
                LIMIT 1
            `, [dateStart, dateEnd, phoneSuffix]);

            if (result.rows.length === 0) continue;

            const call = result.rows[0];

            // Получаем reference-ссылку
            const ref = await new Promise((resolve, reject) => {
                const req = https.request({
                    hostname: BEELINE_API_HOST, port: 443,
                    path: `/apis/portal/records/${encodeURIComponent(rec.id)}/reference`,
                    method: 'GET',
                    headers: { 'X-MPBX-API-AUTH-TOKEN': CRM_TOKEN, 'Accept': 'application/json' }
                }, (res) => {
                    let data = '';
                    res.setEncoding('utf8');
                    res.on('data', c => data += c);
                    res.on('end', () => {
                        if (res.statusCode !== 200) return resolve(null);
                        try { const p = JSON.parse(data); resolve(p && p.url ? p.url : null); }
                        catch (e) { resolve(null); }
                    });
                });
                req.on('error', e => reject(e));
                req.end();
            });

            if (ref) {
                await pool.query('UPDATE calls SET recording_link = $1 WHERE id = $2', [ref, call.id]);
                updated++;
            }
        } catch (err) {
            console.error('Error processing recording:', err.message);
        }
    }

    console.log(`Updated ${updated} recordings for period`);
}

// Функция для очистки дубликатов пропущенных звонков
async function cleanDuplicateMissedCalls(clientPhone, callDate) {
    try {
        // Проверяем, есть ли принятые звонки для этого номера в течение дня
        const checkQuery = `
            SELECT MIN(start_time) as first_success_time
            FROM calls
            WHERE client_phone = $1 
              AND DATE(start_time) = $2
              AND status = 'Success'
        `;
        
        const checkResult = await pool.query(checkQuery, [clientPhone, callDate]);
        
        if (checkResult.rows.length > 0 && checkResult.rows[0].first_success_time) {
            const firstSuccessTime = checkResult.rows[0].first_success_time;
            
            // Удаляем все пропущенные звонки до первого успешного
            const deleteQuery = `
                DELETE FROM calls
                WHERE client_phone = $1 
                  AND DATE(start_time) = $2
                  AND status = 'Missed'
                  AND start_time < $3
            `;
            
            const deleteResult = await pool.query(deleteQuery, [clientPhone, callDate, firstSuccessTime]);
            
            if (deleteResult.rowCount > 0) {
                console.log(`Cleaned ${deleteResult.rowCount} missed calls for ${clientPhone} on ${callDate} (before first success at ${firstSuccessTime})`);
                return deleteResult.rowCount;
            }
        }
        
        return 0;
    } catch (error) {
        console.error('Error cleaning duplicate missed calls:', error);
        return 0;
    }
}

// POST /api/beeline/history — приём данных о звонках от Beeline
app.post('/api/beeline/history', async (req, res) => {
    console.log('Beeline history body:', req.body);

    const { crm_token, callid, phone, type } = req.body;

    if (!crm_token || !callid || !phone || !type) {
        return res.status(400).json({ error: 'Missing required fields: crm_token, callid, phone, type' });
    }

    if (crm_token !== CRM_TOKEN) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    const query = `
        INSERT INTO calls (call_id, type, status, client_phone, user_id, ext, group_name, telnum, diversion, start_time, wait_time, duration, recording_link)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (call_id) DO UPDATE SET
            type = EXCLUDED.type,
            status = EXCLUDED.status,
            client_phone = EXCLUDED.client_phone,
            user_id = EXCLUDED.user_id,
            ext = EXCLUDED.ext,
            group_name = EXCLUDED.group_name,
            telnum = EXCLUDED.telnum,
            diversion = EXCLUDED.diversion,
            start_time = EXCLUDED.start_time,
            wait_time = EXCLUDED.wait_time,
            duration = EXCLUDED.duration,
            recording_link = EXCLUDED.recording_link
    `;

    const values = [
        callid,
        type,
        req.body.status || null,
        phone,
        req.body.user || null,
        req.body.ext || null,
        req.body.groupRealName || req.body.group || null,
        req.body.telnum || null,
        req.body.diversion || null,
        req.body.start ? new Date(req.body.start) : null,
        null,
        req.body.duration ? parseInt(req.body.duration, 10) : null,
        req.body.link || null
    ];

    try {
        await pool.query(query, values);
        
        // Если это успешный звонок, очищаем дубликаты пропущенных
        if (req.body.status === 'Success' && req.body.start) {
            const callDate = new Date(req.body.start);
            await cleanDuplicateMissedCalls(phone, callDate);
        }
        
        return res.status(200).send();
    } catch (err) {
        console.error('Database error in /api/beeline/history:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/beeline/event — приём событий звонка
app.post('/api/beeline/event', (req, res) => {
    console.log('Beeline event body:', req.body);
    console.log('Event type:', req.body.type);
    console.log('Direction:', req.body.direction);
    console.log('CallID:', req.body.callid);
    console.log('Phone:', req.body.phone);
    console.log('User:', req.body.user);
    return res.status(200).send();
});

// POST /api/beeline/contact — запрос данных о клиенте по номеру телефона
app.post('/api/beeline/contact', async (req, res) => {
    const { crm_token, phone, callid } = req.body;

    if (!crm_token || !phone || !callid) {
        return res.status(400).json({ error: 'Missing required fields: crm_token, phone, callid' });
    }

    if (crm_token !== CRM_TOKEN) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    try {
        const result = await pool.query(
            'SELECT name AS contact_name, responsible FROM clients WHERE phone = $1 LIMIT 1',
            [phone]
        );

        if (result.rows.length > 0) {
            return res.status(200).json(result.rows[0]);
        }
        return res.status(200).json({});
    } catch (err) {
        // Если таблица clients ещё не создана — просто возвращаем пустой объект
        console.error('Database error in /api/beeline/contact:', err.message);
        return res.status(200).json({});
    }
});

// POST /api/calls/sync — синхронизация звонков за сегодня с Beeline
app.post('/api/calls/sync', async (req, res) => {
    try {
        const count = await fetchHistoryFromBeeline();
        res.status(200).json({ loaded: count });
    } catch (err) {
        console.error('Sync error:', err);
        res.status(500).json({ error: 'Sync failed' });
    }
});

// POST /api/calls/clean-duplicates — очистка дубликатов пропущенных звонков
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
            console.log(`Processing group: ${group.client_phone} at ${group.call_minute}, Total: ${group.call_count}, Success: ${group.success_count}`);
            
            // Если есть принятые звонки, удаляем все пропущенные с тем же временем
            if (group.success_count > 0) {
                console.log(`Deleting missed calls for ${group.client_phone}...`);
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
                
                console.log(`Deleted ${deletedCount} missed calls for ${group.client_phone} at ${group.call_minute}`);
            }
        }
        
        console.log(`Total deleted: ${totalDeleted} missed calls`);
        const result = { deleted: totalDeleted, groups: duplicateGroups.rows.length };
        console.log(`Returning response:`, result);
        res.status(200).json(result);
        
    } catch (err) {
        console.error('Error cleaning duplicate calls:', err);
        res.status(500).json({ error: 'Failed to clean duplicates' });
    }
});

// GET / — редирект на журнал звонков
app.get('/', (req, res) => {
    res.redirect('/calls');
});

// GET /calls — страница со списком звонков с фильтрацией по дате и пагинацией
app.get('/calls', async (req, res) => {
    // Запрещаем кэширование для получения актуальных данных
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '-1');
    
    try {
        const { dateFrom, dateTo, preset, firstTime } = req.query;
        let page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 50;
        if (page < 1) page = 1;
        const offset = (page - 1) * limit;

        let effectiveDateFrom = dateFrom || '';
        let effectiveDateTo = dateTo || '';

        const now = new Date();
        const todayStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

        if (preset === 'today') {
            effectiveDateFrom = todayStart.toISOString().split('T')[0];
            effectiveDateTo = todayStart.toISOString().split('T')[0];
        } else if (preset === 'yesterday') {
            const yesterday = new Date(todayStart);
            yesterday.setDate(yesterday.getDate() - 1);
            effectiveDateFrom = yesterday.toISOString().split('T')[0];
            effectiveDateTo = yesterday.toISOString().split('T')[0];
        } else if (preset === 'week') {
            const weekAgo = new Date(todayStart);
            weekAgo.setDate(weekAgo.getDate() - 7);
            effectiveDateFrom = weekAgo.toISOString().split('T')[0];
            effectiveDateTo = todayStart.toISOString().split('T')[0];
        } else if (preset === 'month') {
            const monthAgo = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
            effectiveDateFrom = monthAgo.toISOString().split('T')[0];
            effectiveDateTo = todayStart.toISOString().split('T')[0];
        } else if (!preset && !dateFrom && !dateTo) {
            // По умолчанию показываем последние 2 дня
            const twoDaysAgo = new Date(todayStart);
            twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
            effectiveDateFrom = twoDaysAgo.toISOString().split('T')[0];
            effectiveDateTo = todayStart.toISOString().split('T')[0];
        }

        // Синхронизируем звонки из Beeline за выбранный период
        if (effectiveDateFrom && effectiveDateTo) {
            try {
                const synced = await fetchHistoryFromBeeline(effectiveDateFrom, effectiveDateTo);
                console.log(`Synced ${synced} records from Beeline for ${effectiveDateFrom} - ${effectiveDateTo}`);
            } catch (syncErr) {
                console.error('Sync error in /calls:', syncErr.message);
            }
        }

        let queryText = 'SELECT * FROM calls';
        let countQuery = 'SELECT COUNT(*) FROM calls';
        const params = [];
        const conditions = [];

        if (effectiveDateFrom) {
            params.push(effectiveDateFrom + ' 00:00:00');
            conditions.push(`start_time >= $${params.length}::timestamp`);
        }
if (effectiveDateTo) {
    const [y, m, d] = effectiveDateTo.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    const nextDayStr = next.toISOString().split('T')[0];
    params.push(nextDayStr + ' 00:00:00');
    conditions.push(`start_time < $${params.length}::timestamp`);
}

        if (conditions.length > 0) {
            const whereClause = ' WHERE ' + conditions.join(' AND ');
            queryText += whereClause;
            countQuery += whereClause;
        }

        queryText += ' ORDER BY start_time DESC';

        const countResult = await pool.query(countQuery, params);
        const totalCount = parseInt(countResult.rows[0].count, 10);
        const totalPages = Math.ceil(totalCount / limit);

        queryText += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);

        const result = await pool.query(queryText, params);
        
        // Фильтруем дубликаты: если есть принятый звонок, убираем все пропущенные с тем же номером и временем (с точностью до минуты)
        let filteredCalls = [];
        const callGroups = {};
        
        // Группируем звонки по номеру телефона и времени (с точностью до минуты)
        result.rows.forEach(call => {
            if (call.client_phone && call.start_time) {
                const date = new Date(call.start_time);
                const key = `${call.client_phone}-${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
                
                if (!callGroups[key]) {
                    callGroups[key] = [];
                }
                callGroups[key].push(call);
            } else {
                // Если нет необходимой информации для группировки, добавляем как есть
                filteredCalls.push(call);
            }
        });
        
        // Обрабатываем каждую группу
        Object.values(callGroups).forEach(group => {
            const hasSuccess = group.some(call => call.status === 'Success');
            const missedCalls = group.filter(call => call.status === 'Missed');
            
            if (hasSuccess) {
                // Если есть принятый звонок, добавляем только принятые
                group.filter(call => call.status === 'Success').forEach(call => filteredCalls.push(call));
            } else if (missedCalls.length > 1) {
                // Если несколько пропущенных без принятых, добавляем только один (самый ранний)
                const earliestMissed = missedCalls.reduce((prev, current) => 
                    new Date(prev.start_time) < new Date(current.start_time) ? prev : current
                );
                filteredCalls.push(earliestMissed);
            } else {
                // Если нет принятых и не более одного пропущенного, добавляем все звонки
                group.forEach(call => filteredCalls.push(call));
            }
        });
        
        // Если включен фильтр "Звонили в первый раз", отфильтруем только тех, кто звонит впервые
        if (firstTime === 'on' && (effectiveDateFrom || (preset && preset !== ''))) {
            // Определяем начальную дату для проверки истории
            const historyCheckDate = new Date(effectiveDateFrom || '1970-01-01');
            
            // Находим все уникальные номера телефонов из отфильтрованных звонков
            const phoneNumbers = [...new Set(filteredCalls.map(call => call.client_phone).filter(Boolean))];
            
            // Для каждого номера проверяем, были ли звонки до开始 периода
            const firstTimeCallers = new Set();
            
            for (const phone of phoneNumbers) {
                // Проверяем, были ли звонки с этого номера до выбранного периода
                const historyQuery = `
                    SELECT COUNT(*) as count
                    FROM calls
                    WHERE client_phone = $1
                      AND start_time < $2
                `;
                
                const historyResult = await pool.query(historyQuery, [phone, historyCheckDate]);
                const hasHistory = parseInt(historyResult.rows[0].count, 10) > 0;
                
                if (!hasHistory) {
                    firstTimeCallers.add(phone);
                }
            }
            
            // Оставляем только звонки от тех, кто звонит впервые
            filteredCalls = filteredCalls.filter(call => 
                call.client_phone && firstTimeCallers.has(call.client_phone)
            );
        }

        res.render('calls', {
            calls: filteredCalls,
            dateFrom: effectiveDateFrom,
            dateTo: effectiveDateTo,
            preset: preset || '',
            page: page,
            totalPages: totalPages,
            totalCount: totalCount,
            limit: limit,
            firstTime: firstTime === 'on' ? 'on' : ''
        });
    } catch (err) {
        console.error('Error in /calls:', err);
        res.status(500).send(`<h1>Internal Server Error</h1><pre>${err.stack}</pre>`);
    }
});

// GET /stats — страница статистики звонков
app.get('/stats', async (req, res) => {
    try {
        const newClientsQuery = `
            WITH first_calls AS (
                SELECT 
                    client_phone,
                    DATE_TRUNC('month', MIN(start_time)) as first_month
                FROM calls
                WHERE client_phone IS NOT NULL
                GROUP BY client_phone
            )
            SELECT 
                TO_CHAR(first_month, 'YYYY-MM') as month,
                COUNT(*) as new_clients
            FROM first_calls
            GROUP BY month
            ORDER BY month DESC
        `;
        const newClientsResult = await pool.query(newClientsQuery);

        const monthlyStatsQuery = `
            WITH call_groups AS (
                SELECT 
                    client_phone,
                    DATE_TRUNC('minute', start_time) as call_minute,
                    BOOL_OR(status = 'Success') as has_success,
                    COUNT(*) FILTER (WHERE status = 'Missed') as missed_count
                FROM calls
                GROUP BY client_phone, DATE_TRUNC('minute', start_time)
            ),
            deduped AS (
                SELECT 
                    call_minute,
                    CASE WHEN has_success THEN 1 ELSE 0 END as success_count,
                    CASE WHEN NOT has_success AND missed_count > 0 THEN 1 ELSE 0 END as missed_count
                FROM call_groups
            )
            SELECT 
                TO_CHAR(call_minute, 'YYYY-MM') as month,
                SUM(success_count + missed_count) as total_calls,
                SUM(success_count) as success_calls,
                SUM(missed_count) as missed_calls
            FROM deduped
            GROUP BY month
            ORDER BY month DESC
        `;
        const monthlyStatsResult = await pool.query(monthlyStatsQuery);

        res.render('stats', {
            newClients: newClientsResult.rows,
            monthlyStats: monthlyStatsResult.rows
        });
    } catch (err) {
        console.error('Error in /stats:', err);
        res.status(500).send('Ошибка при загрузке статистики');
    }
});

// Полная синхронизация за 2025–2026 годы
app.get('/api/sync-all', async (req, res) => {
    try {
        let totalSynced = 0;
        const years = [2025, 2026];
        const currentYear = new Date().getFullYear();
        const currentMonth = new Date().getMonth() + 1;

        for (const year of years) {
            if (year > currentYear) continue;

            const startDate = `${year}-01-01`;
            let endDate;

            if (year < currentYear) {
                endDate = `${year}-12-31`;
            } else {
                // текущий год — до сегодняшнего дня
                endDate = new Date().toISOString().split('T')[0];
            }

            console.log(`Syncing year ${year}: ${startDate} → ${endDate}`);
            const count = await fetchHistoryFromBeeline(startDate, endDate);
            totalSynced += count;
            console.log(`Year ${year} synced: ${count} records`);
        }

        res.json({
            success: true,
            totalSynced,
            years: years.filter(y => y <= currentYear),
            message: 'Полная синхронизация завершена'
        });
    } catch (err) {
        console.error('Full sync error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Глобальный обработчик ошибок (только для разработки)
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send(`<h1>Unexpected Error</h1><pre>${err.stack}</pre>`);
});

// Попытаться получить прямую ссылку на запись разговора через Portal API и сохранить в БД
async function getRecordingUrlForCall(call) {
    if (!call) return null;
    if (call.recording_link) return call.recording_link;

    // Попробуем найти запись по номеру и времени разговора
    try {
        const date = call.start_time ? new Date(call.start_time) : null;

        const qs = new URLSearchParams({
            dateFrom: formatBeelineDate(date ? new Date(date.getTime() - 300000) : new Date(Date.now() - 86400000)),
            dateTo: formatBeelineDate(date ? new Date(date.getTime() + 300000) : new Date())
        }).toString();

        console.log(`[getRecordingUrlForCall] Searching records: /apis/portal/records?${qs}`);

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
                res.setEncoding('utf8');
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) return resolve([]);
                    try {
                        const parsed = JSON.parse(data);
                        resolve(Array.isArray(parsed) ? parsed : []);
                    } catch (e) { resolve([]); }
                });
            });
            req.on('error', (e) => reject(e));
            req.end();
        });

        if (!records || records.length === 0) return null;

        // Попробуем найти наиболее подходящую запись по длительности/времени/номеру
        let matched = null;
        for (const r of records) {
            if (call.client_phone && r.phone && r.phone.replace(/[^0-9]/g, '').endsWith(call.client_phone.replace(/[^0-9]/g, '').slice(-7))) {
                matched = r; break;
            }
            // fallback: совпадение по дате (с небольшим допуском)
            if (r.date && call.start_time) {
                const rd = new Date(r.date).getTime();
                const cd = new Date(call.start_time).getTime();
                if (Math.abs(rd - cd) < 1000 * 60 * 5) { matched = r; break; }
            }
        }

        if (!matched) matched = records[0];

        if (!matched || !matched.id) return null;

// Получаем прямую ссылку на запись
          const refOptions = {
              hostname: BEELINE_API_HOST,
              port: 443,
              path: `/apis/portal/records/${encodeURIComponent(matched.id)}/reference`,
              method: 'GET',
              headers: { 'X-MPBX-API-AUTH-TOKEN': CRM_TOKEN, 'Accept': 'application/json' }
          };

        const direct = await new Promise((resolve, reject) => {
            const req = https.request(refOptions, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', c => data += c);
                res.on('end', () => {
                    if (res.statusCode !== 200) return resolve(null);
                    try { const p = JSON.parse(data); resolve(p && p.url ? p.url : null); } catch (e) { resolve(null); }
                });
            });
            req.on('error', e => reject(e));
            req.end();
        });

        if (direct) {
            // Сохраняем в БД
            try {
                await pool.query('UPDATE calls SET recording_link = $1 WHERE id = $2', [direct, call.id]);
            } catch (e) { console.error('Failed to save recording_link:', e.message); }
            return direct;
        }
    } catch (err) {
        console.error('Error getRecordingUrlForCall:', err.message || err);
    }
    return null;
}

// Прокси/стриминг записи разговора по id (id — поле `calls.id`)
app.get('/api/calls/recording/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const result = await pool.query('SELECT * FROM calls WHERE id = $1 LIMIT 1', [id]);
        if (result.rows.length === 0) return res.status(404).send('Call not found');
        const call = result.rows[0];

        console.log(`[Recording Request] Call ID: ${id}, Phone: ${call.client_phone}, Time: ${call.start_time}`);

        let url = await getRecordingUrlForCall(call);
        if (!url) {
            console.log(`[Recording Request] No recording found for call ${id}`);
            
            // Пробуем найти запись напрямую через API
            const recordingUrl = await findRecordingDirectly(call);
            if (!recordingUrl) {
                return res.status(404).send('Recording not found');
            }
            url = recordingUrl;
        }

        console.log(`[Recording Request] Found recording URL: ${url}`);

        // Если прямой доступ возможен, проксируем файл
        const parsed = new URL(url);
        const proto = parsed.protocol === 'http:' ? http : https;
        const proxyReq = proto.get(url, (proxyRes) => {
            res.statusCode = proxyRes.statusCode || 200;
            res.setHeader('Content-Type', 'audio/mpeg');
            Object.entries(proxyRes.headers).forEach(([k,v]) => {
                const key = k.toLowerCase();
                if (key === 'content-disposition' || key === 'content-type') return;
                res.setHeader(k, v);
            });
            proxyRes.pipe(res);
        });
        proxyReq.on('error', (e) => {
            console.error('Proxy error:', e.message);
            res.status(502).send('Error fetching recording');
        });
    } catch (err) {
        console.error('Error in /api/calls/recording/:id', err);
        res.status(500).send('Server error');
    }
});

// Вспомогательная функция прямого поиска записи
async function findRecordingDirectly(call) {
    try {
        const date = new Date(call.start_time);
        const qs = new URLSearchParams({
            dateFrom: formatBeelineDate(new Date(date.getTime() - 300000)),
            dateTo: formatBeelineDate(new Date(date.getTime() + 300000))
        }).toString();
        
        console.log(`[findRecordingDirectly] Searching with query: ${qs}`);

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
                console.log(`[findRecordingDirectly] Response status: ${res.statusCode}`);
                res.setEncoding('utf8');
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) return resolve([]);
                    try {
                        const parsed = JSON.parse(data);
                        resolve(Array.isArray(parsed) ? parsed : []);
                    } catch (e) { resolve([]); }
                });
            });
            req.on('error', (e) => reject(e));
            req.end();
        });

        if (!records || records.length === 0) return null;

        // Найти запись по номеру телефона
        const callPhoneDigits = call.client_phone.replace(/[^0-9]/g, '').slice(-7);
        let matched = null;
        
        for (const r of records) {
            const recordPhoneDigits = r.phone.replace(/[^0-9]/g, '').slice(-7);
            if (callPhoneDigits === recordPhoneDigits) {
                matched = r;
                break;
            }
        }

        if (!matched && records.length > 0) {
            matched = records[0];
        }

        if (!matched || !matched.id) return null;

        // Получаем прямую ссылку на запись
        const ref = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: BEELINE_API_HOST, port: 443,
                path: `/apis/portal/records/${encodeURIComponent(matched.id)}/reference`,
                method: 'GET',
                headers: { 'X-MPBX-API-AUTH-TOKEN': CRM_TOKEN, 'Accept': 'application/json' }
            }, (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', c => data += c);
                res.on('end', () => {
                    if (res.statusCode !== 200) return resolve(null);
                    try { const p = JSON.parse(data); resolve(p && p.url ? p.url : null); }
                    catch (e) { resolve(null); }
                });
            });
            req.on('error', e => reject(e));
            req.end();
        });

        if (ref) {
            // Сохраняем в БД
            await pool.query('UPDATE calls SET recording_link = $1 WHERE id = $2', [ref, call.id]);
            return ref;
        }

        return null;
    } catch (err) {
        console.error('Error in findRecordingDirectly:', err.message);
        return null;
    }
}

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
