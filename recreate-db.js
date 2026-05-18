const { Pool } = require('pg');

const pool = new Pool({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: '3556654',
    database: 'crm_autoservice'
});

(async () => {
    try {
        await pool.query('DROP TABLE IF EXISTS calls');
        await pool.query('DROP TABLE IF EXISTS ats_users');
        console.log('Old tables dropped');

        // Создаём ats_users с достаточной длиной user_id
        await pool.query(`
            CREATE TABLE IF NOT EXISTS ats_users (
                user_id VARCHAR(200) PRIMARY KEY
            )
        `);

        // Создаём calls
        await pool.query(`
            CREATE TABLE calls (
                id             SERIAL PRIMARY KEY,
                call_id        VARCHAR(100) NOT NULL,
                type           VARCHAR(20) NOT NULL CHECK (type IN ('in', 'out')),
                status         VARCHAR(30) CHECK (status IN ('Success', 'Missed', 'Cancel', 'Busy', 'NotAvailable', 'NotAllowed', 'NotFound')),
                client_phone   VARCHAR(20) NOT NULL,
                user_id        VARCHAR(200),
                ext            VARCHAR(10),
                group_name     VARCHAR(100),
                telnum         VARCHAR(20),
                diversion      VARCHAR(20),
                start_time     TIMESTAMP NOT NULL,
                wait_time      INTEGER,
                duration       INTEGER,
                recording_link TEXT,
                client_name    VARCHAR(200),
                car_number     VARCHAR(20),
                notes          TEXT,
                created_at     TIMESTAMP DEFAULT NOW()
            )
        `);

        // Индексы
        await pool.query('CREATE INDEX idx_calls_call_id ON calls(call_id)');
        await pool.query('CREATE INDEX idx_calls_client_phone ON calls(client_phone)');
        await pool.query('CREATE INDEX idx_calls_start_time ON calls(start_time)');
        await pool.query('CREATE UNIQUE INDEX idx_calls_unique_call ON calls(start_time, type, client_phone, user_id)');

        // FK
        await pool.query(`
            ALTER TABLE calls
            ADD CONSTRAINT fk_calls_user_id FOREIGN KEY (user_id) REFERENCES ats_users(user_id) ON DELETE SET NULL ON UPDATE CASCADE
        `);

        console.log('Schema recreated successfully');
    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await pool.end();
    }
})();
