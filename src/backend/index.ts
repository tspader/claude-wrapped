import type { StatsCache, Entry, GlobalStats, EntryPercentiles } from "./types";

interface Env {
  wrapped: D1Database;
}

// Validation helpers
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function safeNumber(v: unknown, min: number, max: number, fallback = 0): number {
  return isFiniteNumber(v) ? clamp(v, min, max) : fallback;
}

function isValidExternalId(id: unknown): id is string {
  return typeof id === 'string'
    && id.length >= 1
    && id.length <= 128
    && /^[a-zA-Z0-9_-]+$/.test(id);
}

async function recomputeGlobalStats(db: D1Database): Promise<void> {
  const count = await db.prepare("SELECT COUNT(*) as n FROM entries").first<{n: number}>();
  const n = count?.n || 0;

  // Compute percentile thresholds for each metric
  const getPercentile = async (column: string, pct: number): Promise<number> => {
    if (n === 0) return 0;
    const offset = Math.max(0, Math.floor(n * pct) - 1);
    const row = await db.prepare(
      `SELECT ${column} as v FROM entries ORDER BY ${column} LIMIT 1 OFFSET ?`
    ).bind(offset).first<{v: number}>();
    return row?.v || 0;
  };

  const percentiles = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  
  const [
    messagesP, tokensP, costP,
    sums, personas
  ] = await Promise.all([
    Promise.all(percentiles.map(p => getPercentile('total_messages', p))),
    Promise.all(percentiles.map(p => getPercentile('total_tokens', p))),
    Promise.all(percentiles.map(p => getPercentile('total_cost', p))),
    db.prepare(`
      SELECT 
        COALESCE(SUM(total_messages), 0) as sum_messages,
        COALESCE(SUM(total_tokens), 0) as sum_tokens,
        COALESCE(SUM(total_cost), 0) as sum_cost
      FROM entries
    `).first<{sum_messages: number, sum_tokens: number, sum_cost: number}>(),
    db.prepare(`
      SELECT
        SUM(CASE WHEN time_persona = 0 THEN 1 ELSE 0 END) as morning,
        SUM(CASE WHEN time_persona = 1 THEN 1 ELSE 0 END) as afternoon,
        SUM(CASE WHEN time_persona = 2 THEN 1 ELSE 0 END) as evening,
        SUM(CASE WHEN time_persona = 3 THEN 1 ELSE 0 END) as night,
        SUM(CASE WHEN time_persona = 4 THEN 1 ELSE 0 END) as unknown
      FROM entries
    `).first<{morning: number, afternoon: number, evening: number, night: number, unknown: number}>()
  ]);

  await db.prepare(`
    UPDATE global_stats SET
      total_entries = ?,
      sum_total_messages = ?,
      sum_total_tokens = ?,
      sum_total_cost = ?,
      morning_person_count = ?,
      afternoon_person_count = ?,
      evening_person_count = ?,
      night_person_count = ?,
      unknown_person_count = ?,
      messages_p10 = ?, messages_p20 = ?, messages_p30 = ?, messages_p40 = ?, messages_p50 = ?,
      messages_p60 = ?, messages_p70 = ?, messages_p80 = ?, messages_p90 = ?, messages_p100 = ?,
      tokens_p10 = ?, tokens_p20 = ?, tokens_p30 = ?, tokens_p40 = ?, tokens_p50 = ?,
      tokens_p60 = ?, tokens_p70 = ?, tokens_p80 = ?, tokens_p90 = ?, tokens_p100 = ?,
      cost_p10 = ?, cost_p20 = ?, cost_p30 = ?, cost_p40 = ?, cost_p50 = ?,
      cost_p60 = ?, cost_p70 = ?, cost_p80 = ?, cost_p90 = ?, cost_p100 = ?
    WHERE id = 1
  `).bind(
    n,
    sums?.sum_messages || 0,
    sums?.sum_tokens || 0,
    sums?.sum_cost || 0,
    personas?.morning || 0,
    personas?.afternoon || 0,
    personas?.evening || 0,
    personas?.night || 0,
    personas?.unknown || 0,
    ...messagesP,
    ...tokensP,
    ...costP
  ).run();
}

interface GlobalStatsRow {
  total_entries: number;
  sum_total_messages: number;
  sum_total_tokens: number;
  sum_total_cost: number;
  morning_person_count: number;
  afternoon_person_count: number;
  evening_person_count: number;
  night_person_count: number;
  unknown_person_count: number;
  messages_p10: number; messages_p20: number; messages_p30: number; messages_p40: number; messages_p50: number;
  messages_p60: number; messages_p70: number; messages_p80: number; messages_p90: number; messages_p100: number;
  tokens_p10: number; tokens_p20: number; tokens_p30: number; tokens_p40: number; tokens_p50: number;
  tokens_p60: number; tokens_p70: number; tokens_p80: number; tokens_p90: number; tokens_p100: number;
  cost_p10: number; cost_p20: number; cost_p30: number; cost_p40: number; cost_p50: number;
  cost_p60: number; cost_p70: number; cost_p80: number; cost_p90: number; cost_p100: number;
  recompute_on_write: number;
}

async function getGlobalStatsRow(db: D1Database): Promise<GlobalStatsRow> {
  const row = await db.prepare(`SELECT * FROM global_stats WHERE id = 1`).first<GlobalStatsRow>();
  if (!row) throw new Error("global_stats row missing");
  return row;
}

function rowToGlobalStats(row: GlobalStatsRow): GlobalStats {
  const n = row.total_entries || 1;
  return {
    total_entries: row.total_entries,
    avg_total_messages: row.sum_total_messages / n,
    avg_total_tokens: row.sum_total_tokens / n,
    avg_total_cost: row.sum_total_cost / n,
    morning_person_count: row.morning_person_count,
    afternoon_person_count: row.afternoon_person_count,
    evening_person_count: row.evening_person_count,
    night_person_count: row.night_person_count,
    unknown_person_count: row.unknown_person_count,
    messages_percentiles: [
      row.messages_p10, row.messages_p20, row.messages_p30, row.messages_p40, row.messages_p50,
      row.messages_p60, row.messages_p70, row.messages_p80, row.messages_p90, row.messages_p100
    ],
    tokens_percentiles: [
      row.tokens_p10, row.tokens_p20, row.tokens_p30, row.tokens_p40, row.tokens_p50,
      row.tokens_p60, row.tokens_p70, row.tokens_p80, row.tokens_p90, row.tokens_p100
    ],
    cost_percentiles: [
      row.cost_p10, row.cost_p20, row.cost_p30, row.cost_p40, row.cost_p50,
      row.cost_p60, row.cost_p70, row.cost_p80, row.cost_p90, row.cost_p100
    ],
  };
}

function computePercentile(value: number, thresholds: number[]): number {
  // thresholds = [p10, p20, ..., p100]
  // Returns 0-100
  if (thresholds.length === 0 || thresholds[9] === 0) return 50; // no data
  for (let i = 0; i < 10; i++) {
    if (value <= thresholds[i]!) {
      // Interpolate within bucket
      const lower = i === 0 ? 0 : thresholds[i - 1]!;
      const upper = thresholds[i]!;
      const bucketStart = i * 10;
      if (upper === lower) return bucketStart + 10;
      const fraction = (value - lower) / (upper - lower);
      return bucketStart + fraction * 10;
    }
  }
  return 100;
}

function computeEntryPercentiles(entry: Entry, global: GlobalStats): EntryPercentiles {
  return {
    messages: computePercentile(entry.total_messages, global.messages_percentiles),
    tokens: computePercentile(entry.total_tokens, global.tokens_percentiles),
    cost: computePercentile(entry.total_cost, global.cost_percentiles),
  };
}

// Reasonable upper bounds for sanity checks
const MAX_MESSAGES = 10_000_000;
const MAX_TOKENS = 100_000_000_000;
const MAX_COST = 1_000_000;
const MAX_COUNT = 10_000_000;

function computeEntry(stats: StatsCache): Entry {
  // Total tokens and cost from all models
  let total_tokens = 0;
  let total_cost = 0;
  for (const model of Object.values(stats.modelUsage ?? {})) {
    const input = safeNumber(model.inputTokens, 0, MAX_TOKENS);
    const output = safeNumber(model.outputTokens, 0, MAX_TOKENS);
    total_tokens += input + output;
    total_cost += safeNumber(model.costUSD, 0, MAX_COST);
  }
  total_tokens = Math.min(total_tokens, MAX_TOKENS);
  total_cost = Math.min(total_cost, MAX_COST);

  // Time of day counts (morning: 5-11, afternoon: 12-16, evening: 17-20, night: 21-4)
  let morning_count = 0, afternoon_count = 0, evening_count = 0, night_count = 0;
  for (const [hour, count] of Object.entries(stats.hourCounts ?? {})) {
    const h = parseInt(hour);
    if (!Number.isFinite(h) || h < 0 || h > 23) continue;
    const safeCount = safeNumber(count, 0, MAX_COUNT);
    if (h >= 5 && h <= 11) morning_count += safeCount;
    else if (h >= 12 && h <= 16) afternoon_count += safeCount;
    else if (h >= 17 && h <= 20) evening_count += safeCount;
    else night_count += safeCount; // 21-23, 0-4
  }

  // Determine time persona (0=morning, 1=afternoon, 2=evening, 3=night, 4=unknown)
  const counts = [morning_count, afternoon_count, evening_count, night_count];
  const maxCount = Math.max(...counts);
  const time_persona = maxCount === 0 ? 4 : counts.indexOf(maxCount);

  return {
    total_messages: safeNumber(stats.totalMessages, 0, MAX_MESSAGES),
    total_tokens,
    total_cost,
    morning_count,
    afternoon_count,
    evening_count,
    night_count,
    time_persona,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // POST /stats - submit stats and get/create user entry
    if (request.method === "POST" && url.pathname === "/stats") {
      const { external_id, stats } = await request.json() as {
        external_id: unknown;
        stats: StatsCache;
      };

      if (!isValidExternalId(external_id)) {
        return Response.json({ error: "invalid external_id" }, { status: 400 });
      }

      if (!stats || typeof stats !== 'object') {
        return Response.json({ error: "missing or invalid stats" }, { status: 400 });
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
        const globalRow = await getGlobalStatsRow(env.wrapped);
        const global = rowToGlobalStats(globalRow);
        const percentiles = computeEntryPercentiles(existing, global);
        return Response.json({ ok: true, entry: existing, percentiles, global });
      }

      const entry = computeEntry(stats);

      await env.wrapped.prepare(`
        INSERT INTO entries (user_id, total_messages, total_tokens, total_cost,
          morning_count, afternoon_count, evening_count, night_count, time_persona)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        user.id,
        entry.total_messages,
        entry.total_tokens,
        entry.total_cost,
        entry.morning_count,
        entry.afternoon_count,
        entry.evening_count,
        entry.night_count,
        entry.time_persona
      ).run();

      // Read global stats row to check recompute flag
      let globalRow = await getGlobalStatsRow(env.wrapped);

      if (globalRow.recompute_on_write) {
        await recomputeGlobalStats(env.wrapped);
        globalRow = await getGlobalStatsRow(env.wrapped);

        // Disable recompute_on_write after 1000 entries
        if (globalRow.total_entries >= 1000) {
          await env.wrapped.prepare(
            "UPDATE global_stats SET recompute_on_write = 0 WHERE id = 1"
          ).run();
        }
      }

      const global = rowToGlobalStats(globalRow);
      const percentiles = computeEntryPercentiles(entry, global);
      return Response.json({ ok: true, entry, percentiles, global });
    }

    // GET /stats/:external_id - get user entry + global stats
    if (request.method === "GET" && url.pathname.startsWith("/stats/")) {
      const external_id = url.pathname.slice("/stats/".length);

      if (!isValidExternalId(external_id)) {
        return Response.json({ error: "invalid external_id" }, { status: 400 });
      }

      const entry = await env.wrapped.prepare(`
        SELECT e.* FROM entries e
        JOIN users u ON u.id = e.user_id
        WHERE u.external_id = ?
      `).bind(external_id).first<Entry>();

      if (!entry) {
        return Response.json({ error: "not found" }, { status: 404 });
      }

      const globalRow = await getGlobalStatsRow(env.wrapped);
      const global = rowToGlobalStats(globalRow);
      const percentiles = computeEntryPercentiles(entry, global);

      return Response.json({ entry, percentiles, global });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await recomputeGlobalStats(env.wrapped);
  }
};
