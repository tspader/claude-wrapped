interface Env {
  wrapped: D1Database;
}

interface StatsCache {
  dailyActivity: Array<{
    date: string;
    messageCount: number;
    sessionCount: number;
    toolCallCount: number;
  }>;
  tokensByModel: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
  }>;
  totalSessions: number;
  totalMessages: number;
  hourCounts: Record<string, number>;
}

interface Entry {
  total_messages: number;
  total_tokens: number;
  total_cost: number;
  morning_count: number;
  afternoon_count: number;
  evening_count: number;
  night_count: number;
  most_active_day: number;
  most_active_day_tokens: number;
  most_active_day_messages: number;
}

function computeEntry(stats: StatsCache): Entry {
  // Total tokens and cost from all models
  let total_tokens = 0;
  let total_cost = 0;
  for (const model of Object.values(stats.tokensByModel)) {
    total_tokens += model.inputTokens + model.outputTokens + 
                    model.cacheReadInputTokens + model.cacheCreationInputTokens;
    total_cost += model.costUSD;
  }

  // Time of day counts (morning: 5-11, afternoon: 12-16, evening: 17-20, night: 21-4)
  let morning_count = 0, afternoon_count = 0, evening_count = 0, night_count = 0;
  for (const [hour, count] of Object.entries(stats.hourCounts)) {
    const h = parseInt(hour);
    if (h >= 5 && h <= 11) morning_count += count;
    else if (h >= 12 && h <= 16) afternoon_count += count;
    else if (h >= 17 && h <= 20) evening_count += count;
    else night_count += count; // 21-23, 0-4
  }

  // Most active day
  let most_active_day = 0;
  let most_active_day_messages = 0;
  let most_active_day_tokens = 0;
  for (const day of stats.dailyActivity) {
    if (day.messageCount > most_active_day_messages) {
      most_active_day = new Date(day.date).getTime();
      most_active_day_messages = day.messageCount;
      // Approximate tokens for this day based on ratio
      most_active_day_tokens = Math.round(
        (day.messageCount / stats.totalMessages) * total_tokens
      );
    }
  }

  return {
    total_messages: stats.totalMessages,
    total_tokens,
    total_cost,
    morning_count,
    afternoon_count,
    evening_count,
    night_count,
    most_active_day,
    most_active_day_tokens,
    most_active_day_messages,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // POST /stats - submit stats and get/create user entry
    if (request.method === "POST" && url.pathname === "/stats") {
      const { external_id, stats } = await request.json() as {
        external_id: string;
        stats: StatsCache;
      };

      if (!external_id || !stats) {
        return Response.json({ error: "missing external_id or stats" }, { status: 400 });
      }

      // Upsert user
      await env.wrapped.prepare(
        "INSERT OR IGNORE INTO users (external_id) VALUES (?)"
      ).bind(external_id).run();

      const user = await env.wrapped.prepare(
        "SELECT id FROM users WHERE external_id = ?"
      ).bind(external_id).first<{ id: number }>();

      if (!user) {
        return Response.json({ error: "failed to create user" }, { status: 500 });
      }

      // Check if entry already exists
      const existing = await env.wrapped.prepare(
        "SELECT * FROM entries WHERE user_id = ?"
      ).bind(user.id).first<Entry>();

      if (existing) {
        return Response.json({ ok: true, entry: existing });
      }

      const entry = computeEntry(stats);

      await env.wrapped.prepare(`
        INSERT INTO entries (user_id, total_messages, total_tokens, total_cost, 
          morning_count, afternoon_count, evening_count, night_count,
          most_active_day, most_active_day_tokens, most_active_day_messages)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        user.id,
        entry.total_messages,
        entry.total_tokens,
        entry.total_cost,
        entry.morning_count,
        entry.afternoon_count,
        entry.evening_count,
        entry.night_count,
        entry.most_active_day,
        entry.most_active_day_tokens,
        entry.most_active_day_messages
      ).run();

      return Response.json({ ok: true, entry });
    }

    // GET /stats/:external_id - get user entry
    if (request.method === "GET" && url.pathname.startsWith("/stats/")) {
      const external_id = url.pathname.slice("/stats/".length);

      const row = await env.wrapped.prepare(`
        SELECT e.* FROM entries e
        JOIN users u ON u.id = e.user_id
        WHERE u.external_id = ?
      `).bind(external_id).first<Entry>();

      if (!row) {
        return Response.json({ error: "not found" }, { status: 404 });
      }

      return Response.json(row);
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }
};
