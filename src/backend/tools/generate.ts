// Generate random stats and post to API
import { API_URL } from "../../constants";
import type { StatsCache } from "../types";

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateStats(): StatsCache {
  const totalMessages = rand(100, 20000);
  const inputTokens = rand(100000, 10000000);
  const outputTokens = rand(50000, 5000000);
  const costUSD = (inputTokens * 0.000003 + outputTokens * 0.000015) * (0.5 + Math.random());

  // Random hour distribution
  const hourCounts: Record<string, number> = {};
  const peakHour = rand(0, 23);
  for (let h = 0; h < 24; h++) {
    const dist = Math.abs(h - peakHour);
    hourCounts[h] = rand(0, Math.max(1, 50 - dist * 5));
  }

  return {
    totalMessages,
    totalSessions: rand(10, 500),
    hourCounts,
    modelUsage: {
      "claude-sonnet-4-20250514": { inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD }
    },
    dailyActivity: [],
    dailyModelTokens: [],
  };
}

const externalId = `gen_${Date.now()}_${rand(1000, 9999)}`;
const stats = generateStats();

const res = await fetch(`${API_URL}/stats`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ external_id: externalId, stats }),
});

const data = await res.json() as any;
const e = data.entry;
const p = data.percentiles;
console.log(`msgs=${e.total_messages} (p${p.messages.toFixed(0)}) | tokens=${e.total_tokens} (p${p.tokens.toFixed(0)}) | cost=$${e.total_cost.toFixed(2)} (p${p.cost.toFixed(0)}) | n=${data.global.total_entries}`);
