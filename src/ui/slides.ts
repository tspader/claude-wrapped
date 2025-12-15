import type { StatsBox } from "./StatsBox";
import { invokeClaudeStats, readStatsCache, checkStatsExistence, postStatsToApi } from "../utils/stats";
import { t, green, cyan, yellow, bold, type StyledText } from "@opentui/core";

// Abortable delay helper
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export type SlideType = "prompt" | "action" | "info";

export interface SlideOption {
  label: string;
  targetSlide: string;
  style: (s: string) => any;
}

export interface Slide {
  type: SlideType;
  next: string;
  getText: (data: any) => StyledText;
  onEnter?: (box: StatsBox) => Promise<void> | void;
  options?: SlideOption[];
  noTyping?: boolean;
}

export const SLIDES: Record<string, Slide> = {
  logo: {
    type: "info",
    next: "intro",
    noTyping: true,
    getText: () => t``,
  },

  intro: {
    type: "prompt",
    next: "fetching",
    getText: () => t`Welcome to Claude Wrapped.

Would you like to analyze your
local Claude stats?

This will run: ${cyan("claude --print \"/stats\"")}
And read:    ${cyan("~/.claude/stats-cache.json")}`,
    options: [
      { label: "YES", targetSlide: "fetching", style: green },
    ]
  },

  fetching: {
    type: "action",
    next: "messages",
    getText: () => t`Crunching the numbers...`,
    onEnter: async (box: StatsBox) => {
      const signal = box.abortSignal;
      try {
        await delay(500, signal);
        await invokeClaudeStats();
        if (!checkStatsExistence()) throw new Error("Stats file not generated.");
        const stats = readStatsCache();

        // Retry with exponential backoff: 1s, 4s, 16s, 64s
        const delays = [1, 4, 16, 64];
        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= delays.length; attempt++) {
          if (signal.aborted) return;
          try {
            const response = await postStatsToApi(stats);
            box.setStatsData({ ...stats, ...response });
            box.nextSlide();
            return;
          } catch (e: any) {
            lastError = e;
            if (attempt < delays.length) {
              const delaySeconds = delays[attempt]!;
              for (let remaining = delaySeconds; remaining >= 0; remaining--) {
                if (signal.aborted) return;
                try { box.setStatus(t`Failed to post stats. Retry ${yellow(`${attempt + 1}/${delays.length}`)} in ${yellow(String(remaining))}s...`); } catch {}
                await delay(1000, signal);
              }
            }
          }
        }

        throw lastError || new Error("Failed to post stats after retries");
      } catch (e: any) {
        if (e.name === "AbortError") return; // Silently exit on abort
        try { box.setError(e.message); } catch {}
      }
    }
  },

  messages: {
    type: "info",
    next: "sessions",
    getText: (d) => {
      const count = d.totalMessages || 0;
      const totalUsers = d.global?.total_entries || 0;
      return t`This year, you sent

      ${bold(green(count.toLocaleString()))}

messages to Claude.

${cyan(`(${totalUsers} users have shared stats)`)}`;
    }
  },

  sessions: {
    type: "info",
    next: "models",
    getText: (d) => {
      const count = d.totalSessions || 0;
      return t`Across ${cyan(count.toLocaleString())} different sessions.

Some were short.
Some were deeply complex.`;
    }
  },

  models: {
    type: "info",
    next: "time",
    getText: (d) => {
      const usage = d.modelUsage || {};
      const models = Object.keys(usage);
      const fav = models.sort((a, b) => (usage[b].inputTokens || 0) - (usage[a].inputTokens || 0))[0] || "None";
      const shortFav = fav.split('-').slice(0, 3).join('-');

      if (models.length > 5) {
        return t`You explored ${yellow(models.length)} different models.

Your favorite was:
${green(shortFav)}

You really like experimenting!`;
      }

      return t`You explored ${yellow(models.length)} different models.

Your favorite was:
${green(shortFav)}`;
    }
  },

  time: {
    type: "info",
    next: "done",
    getText: (d) => {
      const hours = d.hourCounts || {};
      let night = 0;
      let morning = 0;
      let afternoon = 0;
      let evening = 0;

      for (let h = 0; h < 24; h++) {
        const c = hours[h] || 0;
        if (h >= 5 && h < 12) morning += c;
        else if (h >= 12 && h < 18) afternoon += c;
        else if (h >= 18 && h < 22) evening += c;
        else night += c;
      }

      let type = "balanced user";
      let max = Math.max(night, morning, afternoon, evening);
      if (max === night) type = "Night Owl";
      else if (max === morning) type = "Early Bird";
      else if (max === afternoon) type = "Daytime Hustler";
      else if (max === evening) type = "Evening Thinker";

      return t`You are a ${cyan(type)}.

Most of your ideas happen when
the world is ${max === night ? "asleep" : "awake"}.`;
    }
  },

  done: {
    type: "info",
    next: "done", // terminal - loops to self
    getText: () => t`Thanks for using Claude.

Keep building amazing things.`
  }
};

// Starting slide ID
export const START_SLIDE = "logo";
