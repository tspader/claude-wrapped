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
  dailyModelTokens: Array<{
    date: string;
    tokensByModel: Record<string, number>;
  }>;
  modelUsage: Record<string, {
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

// time_persona: 0=morning, 1=afternoon, 2=evening, 3=night
interface Entry {
  total_messages: number;
  total_tokens: number;
  total_cost: number;
  morning_count: number;
  afternoon_count: number;
  evening_count: number;
  night_count: number;
  time_persona: number;
  most_active_day: number;
  most_active_day_tokens: number;
  most_active_day_messages: number;
}

interface GlobalStats {
  total_entries: number;
  highest_total_messages: number;
  highest_total_tokens: number;
  highest_total_cost: number;
  highest_most_active_day_tokens: number;
  highest_most_active_day_messages: number;
  avg_total_messages: number;
  avg_total_tokens: number;
  avg_total_cost: number;
  avg_most_active_day_tokens: number;
  avg_most_active_day_messages: number;
  morning_person_count: number;
  afternoon_person_count: number;
  evening_person_count: number;
  night_person_count: number;
}

async function recomputeGlobalStats(db: D1Database): Promise<void> {
  await db.prepare(`
    UPDATE global_stats SET
      total_entries = (SELECT COUNT(*) FROM entries),
      highest_total_messages = (SELECT COALESCE(MAX(total_messages), 0) FROM entries),
      highest_total_tokens = (SELECT COALESCE(MAX(total_tokens), 0) FROM entries),
      highest_total_cost = (SELECT COALESCE(MAX(total_cost), 0) FROM entries),
      highest_most_active_day_tokens = (SELECT COALESCE(MAX(most_active_day_tokens), 0) FROM entries),
      highest_most_active_day_messages = (SELECT COALESCE(MAX(most_active_day_messages), 0) FROM entries),
      sum_total_messages = (SELECT COALESCE(SUM(total_messages), 0) FROM entries),
      sum_total_tokens = (SELECT COALESCE(SUM(total_tokens), 0) FROM entries),
      sum_total_cost = (SELECT COALESCE(SUM(total_cost), 0) FROM entries),
      sum_most_active_day_tokens = (SELECT COALESCE(SUM(most_active_day_tokens), 0) FROM entries),
      sum_most_active_day_messages = (SELECT COALESCE(SUM(most_active_day_messages), 0) FROM entries),
      morning_person_count = (SELECT COUNT(*) FROM entries WHERE time_persona = 0),
      afternoon_person_count = (SELECT COUNT(*) FROM entries WHERE time_persona = 1),
      evening_person_count = (SELECT COUNT(*) FROM entries WHERE time_persona = 2),
      night_person_count = (SELECT COUNT(*) FROM entries WHERE time_persona = 3)
    WHERE id = 1
  `).run();
}

async function getGlobalStats(db: D1Database): Promise<GlobalStats> {
  const row = await db.prepare(`
    SELECT 
      total_entries,
      highest_total_messages,
      highest_total_tokens,
      highest_total_cost,
      highest_most_active_day_tokens,
      highest_most_active_day_messages,
      sum_total_messages,
      sum_total_tokens,
      sum_total_cost,
      sum_most_active_day_tokens,
      sum_most_active_day_messages,
      morning_person_count,
      afternoon_person_count,
      evening_person_count,
      night_person_count
    FROM global_stats WHERE id = 1
  `).first<{
    total_entries: number;
    highest_total_messages: number;
    highest_total_tokens: number;
    highest_total_cost: number;
    highest_most_active_day_tokens: number;
    highest_most_active_day_messages: number;
    sum_total_messages: number;
    sum_total_tokens: number;
    sum_total_cost: number;
    sum_most_active_day_tokens: number;
    sum_most_active_day_messages: number;
    morning_person_count: number;
    afternoon_person_count: number;
    evening_person_count: number;
    night_person_count: number;
  }>();

  if (!row) {
    throw new Error("global_stats row missing");
  }

  const n = row.total_entries || 1;
  return {
    total_entries: row.total_entries,
    highest_total_messages: row.highest_total_messages,
    highest_total_tokens: row.highest_total_tokens,
    highest_total_cost: row.highest_total_cost,
    highest_most_active_day_tokens: row.highest_most_active_day_tokens,
    highest_most_active_day_messages: row.highest_most_active_day_messages,
    avg_total_messages: row.sum_total_messages / n,
    avg_total_tokens: row.sum_total_tokens / n,
    avg_total_cost: row.sum_total_cost / n,
    avg_most_active_day_tokens: row.sum_most_active_day_tokens / n,
    avg_most_active_day_messages: row.sum_most_active_day_messages / n,
    morning_person_count: row.morning_person_count,
    afternoon_person_count: row.afternoon_person_count,
    evening_person_count: row.evening_person_count,
    night_person_count: row.night_person_count,
  };
}

function computeEntry(stats: StatsCache): Entry {
  // Total tokens and cost from all models
  let total_tokens = 0;
  let total_cost = 0;
  for (const model of Object.values(stats.modelUsage ?? {})) {
    total_tokens += (model.inputTokens ?? 0) + (model.outputTokens ?? 0);
    total_cost += model.costUSD ?? 0;
  }

  // Time of day counts (morning: 5-11, afternoon: 12-16, evening: 17-20, night: 21-4)
  let morning_count = 0, afternoon_count = 0, evening_count = 0, night_count = 0;
  for (const [hour, count] of Object.entries(stats.hourCounts ?? {})) {
    const h = parseInt(hour);
    if (h >= 5 && h <= 11) morning_count += count;
    else if (h >= 12 && h <= 16) afternoon_count += count;
    else if (h >= 17 && h <= 20) evening_count += count;
    else night_count += count; // 21-23, 0-4
  }

  // Build date->tokens lookup from dailyModelTokens
  const tokensByDate = new Map<string, number>();
  for (const day of stats.dailyModelTokens ?? []) {
    const dayTotal = Object.values(day.tokensByModel ?? {}).reduce((a, b) => a + b, 0);
    tokensByDate.set(day.date, dayTotal);
  }

  // Most active day
  let most_active_day = 0;
  let most_active_day_messages = 0;
  let most_active_day_tokens = 0;
  for (const day of stats.dailyActivity ?? []) {
    if (day.messageCount > most_active_day_messages) {
      most_active_day = new Date(day.date).getTime();
      most_active_day_messages = day.messageCount;
      most_active_day_tokens = tokensByDate.get(day.date) ?? 0;
    }
  }

  // Determine time persona (0=morning, 1=afternoon, 2=evening, 3=night)
  const counts = [morning_count, afternoon_count, evening_count, night_count];
  const time_persona = counts.indexOf(Math.max(...counts));

  return {
    total_messages: stats.totalMessages ?? 0,
    total_tokens,
    total_cost,
    morning_count,
    afternoon_count,
    evening_count,
    night_count,
    time_persona,
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
          morning_count, afternoon_count, evening_count, night_count, time_persona,
          most_active_day, most_active_day_tokens, most_active_day_messages)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        user.id,
        entry.total_messages,
        entry.total_tokens,
        entry.total_cost,
        entry.morning_count,
        entry.afternoon_count,
        entry.evening_count,
        entry.night_count,
        entry.time_persona,
        entry.most_active_day,
        entry.most_active_day_tokens,
        entry.most_active_day_messages
      ).run();

      return Response.json({ ok: true, entry });
    }

    // GET /stats/:external_id - get user entry + global stats
    if (request.method === "GET" && url.pathname.startsWith("/stats/")) {
      const external_id = url.pathname.slice("/stats/".length);

      const entry = await env.wrapped.prepare(`
        SELECT e.* FROM entries e
        JOIN users u ON u.id = e.user_id
        WHERE u.external_id = ?
      `).bind(external_id).first<Entry>();

      if (!entry) {
        return Response.json({ error: "not found" }, { status: 404 });
      }

      const global = await getGlobalStats(env.wrapped);

      return Response.json({ entry, global });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await recomputeGlobalStats(env.wrapped);
  }
};
