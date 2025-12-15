import { join } from "path";
import { homedir, hostname } from "os";
import { existsSync, readFileSync } from "fs";
import { spawn } from "child_process";
import { API_URL } from "../constants";
import type { StatsCache, PostStatsResponse } from "../backend/types";

export function getStatsPath(): string {
  return join(homedir(), ".claude", "stats-cache.json");
}

export function checkStatsExistence(): boolean {
  return existsSync(getStatsPath());
}

export async function invokeClaudeStats(): Promise<void> {
  return new Promise((resolve, reject) => {
    // We don't capture output, we just want the side effect (file creation/update)
    const proc = spawn("claude", ["--print", "/stats"], {
      stdio: "ignore", // We don't need the JSON output on stdout
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`claude process exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

export function readStatsCache(): StatsCache {
  const path = getStatsPath();
  if (!existsSync(path)) {
    throw new Error(`Stats file not found at ${path}`);
  }
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content);
}

function getMachineId(): string {
  const user = process.env.USER || "unknown";
  const host = hostname();
  const rawId = `${user}@${host}`;
  return btoa(rawId).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_").slice(0, 128);
}

export async function postStatsToApi(stats: StatsCache): Promise<PostStatsResponse> {
  const response = await fetch(`${API_URL}/stats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      external_id: getMachineId(),
      stats: stats
    })
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`);
  }

  return response.json() as Promise<PostStatsResponse>;
}
