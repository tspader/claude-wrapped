CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT NOT NULL UNIQUE
);

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
    most_active_day INTEGER NOT NULL,
    most_active_day_tokens INTEGER NOT NULL,
    most_active_day_messages INTEGER NOT NULL
);

CREATE INDEX idx_entries_user_id ON entries(user_id);
