import { readStatsCache, postStatsToApi } from "../../utils/stats";

async function postAndGet() {
  const stats = readStatsCache();
  console.log("Posting stats via postStatsToApi...");
  const result = await postStatsToApi(stats);
  console.log(JSON.stringify(result, null, 2));
}

async function triggerGlobal() {
  const API_URL = process.env.CLAUDE_WRAPPED_API_URL || "http://localhost:8787";
  const res = await fetch(`${API_URL}/__scheduled?cron=*+*+*+*+*`, {
    method: "GET",
  });
  console.log("Triggered scheduled:", res.status, await res.text());
}

const arg = process.argv[2];

if (arg === "--global") {
  await triggerGlobal();
} else {
  await postAndGet();
}
