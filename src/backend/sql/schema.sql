CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT NOT NULL UNIQUE
);

-- time_persona: 0=morning, 1=afternoon, 2=evening, 3=night, 4=unknown
CREATE TABLE entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
    total_messages INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    total_cost REAL NOT NULL,
    morning_count INTEGER NOT NULL,
    afternoon_count INTEGER NOT NULL,
    evening_count INTEGER NOT NULL,
    night_count INTEGER NOT NULL,
    time_persona INTEGER NOT NULL
);

CREATE INDEX idx_entries_user_id ON entries(user_id);
CREATE INDEX idx_entries_total_messages ON entries(total_messages);
CREATE INDEX idx_entries_total_tokens ON entries(total_tokens);
CREATE INDEX idx_entries_total_cost ON entries(total_cost);

-- singleton table (id=1 always)
-- histogram buckets: p0-p9 represent 10 percentile thresholds (10th, 20th, ... 100th)
CREATE TABLE global_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_entries INTEGER NOT NULL DEFAULT 0,
    sum_total_messages INTEGER NOT NULL DEFAULT 0,
    sum_total_tokens INTEGER NOT NULL DEFAULT 0,
    sum_total_cost REAL NOT NULL DEFAULT 0,
    morning_person_count INTEGER NOT NULL DEFAULT 0,
    afternoon_person_count INTEGER NOT NULL DEFAULT 0,
    evening_person_count INTEGER NOT NULL DEFAULT 0,
    night_person_count INTEGER NOT NULL DEFAULT 0,
    unknown_person_count INTEGER NOT NULL DEFAULT 0,
    -- histogram thresholds for messages (value at each decile)
    messages_p10 INTEGER NOT NULL DEFAULT 0,
    messages_p20 INTEGER NOT NULL DEFAULT 0,
    messages_p30 INTEGER NOT NULL DEFAULT 0,
    messages_p40 INTEGER NOT NULL DEFAULT 0,
    messages_p50 INTEGER NOT NULL DEFAULT 0,
    messages_p60 INTEGER NOT NULL DEFAULT 0,
    messages_p70 INTEGER NOT NULL DEFAULT 0,
    messages_p80 INTEGER NOT NULL DEFAULT 0,
    messages_p90 INTEGER NOT NULL DEFAULT 0,
    messages_p100 INTEGER NOT NULL DEFAULT 0,
    -- histogram thresholds for tokens
    tokens_p10 INTEGER NOT NULL DEFAULT 0,
    tokens_p20 INTEGER NOT NULL DEFAULT 0,
    tokens_p30 INTEGER NOT NULL DEFAULT 0,
    tokens_p40 INTEGER NOT NULL DEFAULT 0,
    tokens_p50 INTEGER NOT NULL DEFAULT 0,
    tokens_p60 INTEGER NOT NULL DEFAULT 0,
    tokens_p70 INTEGER NOT NULL DEFAULT 0,
    tokens_p80 INTEGER NOT NULL DEFAULT 0,
    tokens_p90 INTEGER NOT NULL DEFAULT 0,
    tokens_p100 INTEGER NOT NULL DEFAULT 0,
    -- histogram thresholds for cost
    cost_p10 REAL NOT NULL DEFAULT 0,
    cost_p20 REAL NOT NULL DEFAULT 0,
    cost_p30 REAL NOT NULL DEFAULT 0,
    cost_p40 REAL NOT NULL DEFAULT 0,
    cost_p50 REAL NOT NULL DEFAULT 0,
    cost_p60 REAL NOT NULL DEFAULT 0,
    cost_p70 REAL NOT NULL DEFAULT 0,
    cost_p80 REAL NOT NULL DEFAULT 0,
    cost_p90 REAL NOT NULL DEFAULT 0,
    cost_p100 REAL NOT NULL DEFAULT 0,
    recompute_on_write INTEGER NOT NULL DEFAULT 1
);

INSERT INTO global_stats (id) VALUES (1);
