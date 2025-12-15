// Shared types between frontend and backend

export interface StatsCache {
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

// time_persona: 0=morning, 1=afternoon, 2=evening, 3=night, 4=unknown
export interface Entry {
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

export interface GlobalStats {
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
  unknown_person_count: number;
}

// API request/response types
export interface PostStatsRequest {
  external_id: string;
  stats: StatsCache;
}

export interface PostStatsResponse {
  ok: boolean;
  entry: Entry;
  global: GlobalStats;
}

export interface GetStatsResponse {
  entry: Entry;
  global: GlobalStats;
}
