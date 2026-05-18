-- Таблица звонков для CRM автосервиса
-- Соответствует параметрам команды history из API Beeline

-- Заглушка для сотрудников АТС (будет заменена/расширена реальной таблицей сотрудников)
CREATE TABLE IF NOT EXISTS ats_users (
    user_id VARCHAR(50) PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS calls (
    id             SERIAL PRIMARY KEY,
    call_id        VARCHAR(100) NOT NULL,
    type           VARCHAR(20) NOT NULL CHECK (type IN ('in', 'out')),
    status         VARCHAR(30) CHECK (status IN ('Success', 'Missed', 'Cancel', 'Busy', 'NotAvailable', 'NotAllowed', 'NotFound')),
    client_phone   VARCHAR(20) NOT NULL,
    user_id        VARCHAR(50),
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
    created_at     TIMESTAMP DEFAULT NOW(),

    -- Индекс на call_id для быстрого поиска
    CONSTRAINT idx_calls_call_id UNIQUE (call_id),

    -- Внешний ключ на user_id (заглушка ats_users, пока без реальной привязки)
    CONSTRAINT fk_calls_user_id FOREIGN KEY (user_id) REFERENCES ats_users(user_id) ON DELETE SET NULL ON UPDATE CASCADE
);

-- Дополнительный индекс на client_phone для быстрого поиска по номеру
CREATE INDEX IF NOT EXISTS idx_calls_client_phone ON calls(client_phone);

-- Индекс на start_time для фильтрации по периоду
CREATE INDEX IF NOT EXISTS idx_calls_start_time ON calls(start_time);

-- Составной индекс для защиты от дублей при синхронизации (API v2 не возвращает call_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_unique_call ON calls(start_time, type, client_phone, user_id);

-- Тестовые данные для заглушки сотрудников АТС (чтобы FK не нарушался)
INSERT INTO ats_users (user_id) VALUES ('user_4821'), ('user_4822') ON CONFLICT DO NOTHING;

-- Тестовые записи, имитирующие реальные данные из API Beeline
INSERT INTO calls (call_id, type, status, client_phone, user_id, ext, group_name, telnum, diversion, start_time, wait_time, duration, recording_link, client_name, car_number, notes)
VALUES
(
    'beeline-abc123-20260518-001',
    'in',
    'Success',
    '+79161234567',
    'user_4821',
    '101',
    'Приём заявок',
    '+74951234567',
    '+78001234567',
    '2026-05-18 09:15:30',
    12,
    245,
    'https://cloud.beeline.ru/api/record/abc123',
    'Иванов Сергей Петрович',
    'А123БВ777',
    'Запись на ТО, замена масла и фильтров'
),
(
    'beeline-def456-20260518-002',
    'out',
    'Busy',
    '+79169876543',
    'user_4822',
    '102',
    'Приём заявок',
    '+74951234568',
    NULL,
    '2026-05-18 10:42:15',
    0,
    0,
    NULL,
    NULL,
    NULL,
    'Абонент занят, перезвонить через 30 минут'
),
(
    'beeline-ghi789-20260518-003',
    'in',
    'Missed',
    '+79165554433',
    NULL,
    NULL,
    NULL,
    NULL,
    '+78001234568',
    '2026-05-18 11:05:00',
    45,
    0,
    NULL,
    NULL,
    NULL,
    'Пропущенный звонок, номер неизвестен, возможно спам'
);

COMMIT;
