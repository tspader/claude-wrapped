CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT NOT NULL UNIQUE
);

-- time_persona: 0=morning, 1=afternoon, 2=evening, 3=night
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
    time_persona INTEGER NOT NULL,
    most_active_day INTEGER NOT NULL,
    most_active_day_tokens INTEGER NOT NULL,
    most_active_day_messages INTEGER NOT NULL
);

CREATE INDEX idx_entries_user_id ON entries(user_id);

-- singleton table (id=1 always)
CREATE TABLE global_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_entries INTEGER NOT NULL DEFAULT 0,
    highest_total_messages INTEGER NOT NULL DEFAULT 0,
    highest_total_tokens INTEGER NOT NULL DEFAULT 0,
    highest_total_cost REAL NOT NULL DEFAULT 0,
    highest_most_active_day_tokens INTEGER NOT NULL DEFAULT 0,
    highest_most_active_day_messages INTEGER NOT NULL DEFAULT 0,
    sum_total_messages INTEGER NOT NULL DEFAULT 0,
    sum_total_tokens INTEGER NOT NULL DEFAULT 0,
    sum_total_cost REAL NOT NULL DEFAULT 0,
    sum_most_active_day_tokens INTEGER NOT NULL DEFAULT 0,
    sum_most_active_day_messages INTEGER NOT NULL DEFAULT 0,
    morning_person_count INTEGER NOT NULL DEFAULT 0,
    afternoon_person_count INTEGER NOT NULL DEFAULT 0,
    evening_person_count INTEGER NOT NULL DEFAULT 0,
    night_person_count INTEGER NOT NULL DEFAULT 0
);

INSERT INTO global_stats (id) VALUES (1);
