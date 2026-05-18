const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

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
    return new Promise((resolve, reject) => {
        const now = new Date();

        let dateFrom, dateTo;
        if (optDateFrom && optDateTo) {
            dateFrom = new Date(optDateFrom);
            dateTo = new Date(optDateTo);
            dateTo.setDate(dateTo.getDate() + 1); // включительно
        } else {
            dateFrom = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0));
            dateTo = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0));
        }

        // ISO-8601 формат с Z (UTC) — требование API
        const dateFromStr = dateFrom.toISOString();
        const dateToStr = dateTo.toISOString();

        const queryParams = new URLSearchParams({
            dateFrom: dateFromStr,
            dateTo: dateToStr,
            page: '0',
            pageSize: '100'
        }).toString();

        const path = `/apis/portal/v2/statistics?${queryParams}`;

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
            res.on('end', async () => {
                try {
                    if (res.statusCode !== 200) {
                        console.error(`Beeline API returned status ${res.statusCode}: ${data}`);
                        resolve(0);
                        return;
                    }

                    const records = JSON.parse(data);
                    if (!Array.isArray(records) || records.length === 0) {
                        console.log('No data returned from Beeline statistics');
                        resolve(0);
                        return;
                    }

                    let inserted = 0;
                    const dbClient = await pool.connect();
                    try {
                        // Собираем уникальных абонентов и добавляем в ats_users (чтобы FK не нарушался)
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
                            // Для входящих: phone_from — клиент, phone_to — наш номер
                            // Для исходящих: phone_from — наш номер, phone_to — клиент
                            const clientPhone = direction === 'in' ? (record.phone_from || record.phone) : (record.phone_to || record.phone);
                            const diversion = direction === 'in' ? (record.phone_to || null) : null;

// Используем externalTrackingId из API, если есть, иначе генерируем с суффиксом
                             const callId = record.externalTrackingId
                                 ? `bl-${record.externalTrackingId}`
                                 : `bl-${record.startDate}-${direction}-${clientPhone || 'unknown'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

                            const values = [
                                callId,
                                direction,
                                mapBeelineStatus(record.status),
                                clientPhone,
                                record.abonent ? record.abonent.userId : null,
                                record.abonent ? record.abonent.extension : null,
                                record.department || null,
                                null, // telnum нет в v2
                                diversion,
                                record.startDate ? new Date(record.startDate) : null,
                                null, // wait_time нет в v2
                                record.duration ? Math.round(record.duration / 1000) : null,
                                null  // recording_link - нужно получать через v3 API
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

                    console.log(`Loaded ${inserted} records from Beeline statistics`);

                    // После синхронизации статистики подтягиваем записи разговоров
                    try {
                        await fetchRecordingsForDateRange(dateFromStr, dateToStr);
                    } catch (recErr) {
                        console.error('Failed to fetch recordings:', recErr.message);
                    }

                    resolve(inserted);
                } catch (err) {
                    reject(err);
                }
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.end();
    });
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

// GET / — редирект на журнал звонков
app.get('/', (req, res) => {
    res.redirect('/calls');
});

// GET /calls — страница со списком звонков с фильтрацией по дате и пагинацией
app.get('/calls', async (req, res) => {
    try {
        const { dateFrom, dateTo, preset } = req.query;
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
        } else if (preset === 'month' || (!preset && !dateFrom && !dateTo)) {
            const monthAgo = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
            effectiveDateFrom = monthAgo.toISOString().split('T')[0];
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
            const nextDay = new Date(effectiveDateTo);
            nextDay.setDate(nextDay.getDate() + 1);
            const nextDayStr = nextDay.toISOString().split('T')[0];
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

        res.render('calls', {
            calls: result.rows,
            dateFrom: effectiveDateFrom,
            dateTo: effectiveDateTo,
            preset: preset || '',
            page: page,
            totalPages: totalPages,
            totalCount: totalCount,
            limit: limit
        });
    } catch (err) {
        console.error('Error in /calls:', err);
        res.status(500).send(`<h1>Internal Server Error</h1><pre>${err.stack}</pre>`);
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

        let url = await getRecordingUrlForCall(call);
        if (!url) return res.status(404).send('Recording not found');

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

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
