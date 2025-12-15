const BASE = "http://127.0.0.1:8787";

async function postAndGet() {
  const stats = await Bun.file(`${process.env.HOME}/.claude/stats-cache.json`).json();

  const postRes = await fetch(`${BASE}/stats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      external_id: "test-user-1",
      stats,
    }),
  });
  const postText = await postRes.text();
  console.log("POST /stats:", postText);

  const getRes = await fetch(`${BASE}/stats/test-user-1`);
  const getText = await getRes.text();
  console.log("GET /stats:", getText);
}

async function triggerGlobal() {
  // Trigger scheduled event via wrangler dev's __scheduled endpoint
  const res = await fetch(`${BASE}/__scheduled?cron=*+*+*+*+*`, {
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
