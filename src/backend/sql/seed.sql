INSERT INTO users (external_id) VALUES
    ('user_abc123'),
    ('user_def456'),
    ('user_ghi789');

INSERT INTO entries (user_id, total_messages, total_tokens, total_cost, morning_count, afternoon_count, evening_count, night_count, time_persona) VALUES
    (1, 1542, 2450000, 45.50, 320, 580, 420, 222, 1),
    (2, 876, 1200000, 22.30, 150, 400, 200, 126, 1),
    (3, 3201, 5100000, 98.75, 800, 1200, 750, 451, 1);
