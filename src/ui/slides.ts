import type { StatsBox } from "./StatsBox";
import { invokeClaudeStats, readStatsCache, checkStatsExistence } from "../utils/stats";
import { hostname } from "os";
import { t, green, cyan, yellow, red, bold, dim, type StyledText } from "@opentui/core";

export type SlideType = "prompt" | "action" | "info";

export interface Slide {
  id: string;
  type: SlideType;
  getText: (data: any) => StyledText;
  onEnter?: (box: StatsBox) => Promise<void> | void;
  options?: { label: string, value: string, style: (s: string) => any }[];
  noTyping?: boolean;
}

export const SLIDES: Slide[] = [
  // 0. Intro
  {
    id: "intro",
    type: "prompt",
    noTyping: true,
    getText: () => t`Welcome to Claude Wrapped.

Would you like to analyze your
local Claude stats?

This will run: ${cyan("claude --print \"/stats\"")}
And read:    ${cyan("~/.claude/stats-cache.json")}`,
    options: [
      { label: "YES", value: "yes", style: green },
      { label: "NO", value: "no", style: red },
    ]
  },
  // 1. Loading / Fetching
  {
    id: "fetching",
    type: "action",
    getText: () => t`Crunching the numbers...`,
    onEnter: async (box: StatsBox) => {
      await new Promise(r => setTimeout(r, 500));
      try {
        await invokeClaudeStats();
        if (!checkStatsExistence()) throw new Error("Stats file not generated.");
        box.setStatsData(readStatsCache());
        box.nextSlide();
      } catch (e: any) {
        box.setError(e.message);
      }
    }
  },
  // 2. Total Messages
  {
    id: "total_messages",
    type: "info",
    getText: (d) => {
       const count = d.totalMessages || 0;
       return t`This year, you sent

      ${bold(green(count.toLocaleString()))}

messages to Claude.`;
    }
  },
  // 3. Total Sessions
  {
    id: "total_sessions",
    type: "info",
    getText: (d) => {
       const count = d.totalSessions || 0;
       return t`Across ${cyan(count.toLocaleString())} different sessions.

Some were short.
Some were deeply complex.`;
    }
  },
  // 4. Models
  {
    id: "models",
    type: "info",
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
  // 5. Time of Day
  {
    id: "time_of_day",
    type: "info",
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
  // 6. Upload Prompt
  {
    id: "upload_prompt",
    type: "prompt",
    getText: () => t`Would you like to publish your
stats to the global leaderboard?`,
    options: [
        { label: "PUBLISH", value: "yes", style: green },
        { label: "SKIP", value: "no", style: dim },
    ]
  },
  // 7. Upload Action
  {
    id: "uploading",
    type: "action",
    getText: () => t`Uploading...`,
    onEnter: async (box: StatsBox) => {
         try {
           const user = process.env.USER || "unknown";
           const host = hostname();
           const rawId = `${user}@${host}`;
           const machineId = btoa(rawId).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_").slice(0, 128);
           
           const stats = box.getStatsData();
           const response = await fetch("http://localhost:8787/stats", {
             method: "POST",
             headers: { "Content-Type": "application/json" },
             body: JSON.stringify({
               external_id: machineId,
               stats: stats
             })
           });
    
           if (!response.ok) throw new Error(response.statusText);
           
           stats.uploadSuccess = true;
           box.setStatsData(stats);
         } catch (e: any) {
           const stats = box.getStatsData();
           stats.uploadError = e.message;
           box.setStatsData(stats);
         }
         box.nextSlide();
    }
  },
  // 8. Done
  {
    id: "done",
    type: "info",
    getText: (d) => {
        if (d.uploadSuccess) {
            return t`${green("SUCCESS!")}

Your stats are live.
Thanks for using Claude.`;
        } else if (d.uploadError) {
            return t`${red("UPLOAD FAILED")}

${d.uploadError}`;
        } else {
            return t`Thanks for checking your stats!

Keep building amazing things.`;
        }
    }
  }
];
