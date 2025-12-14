import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { spawn } from "child_process";

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

export function readStatsCache(): any {
  const path = getStatsPath();
  if (!existsSync(path)) {
    throw new Error(`Stats file not found at ${path}`);
  }
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content);
}
