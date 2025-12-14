# summary
Claude Wrapped. A TUI using OpenTUI which reads local stats in $HOME/.claude/stats-cache.json and renders them alongside a raymarched scene. Uses `bun`, not `npm`. Cloudflare D1 database in the backend + worker.

# references
- `src`: TUI
- `src/renderer`: WASM raymarching + SDF implementation
- `backend`: Cloudflare worker

# rules
- Always be concise.
- When writing documents, always be minimal but complete. Provide enough information for a brand new LLM to understand the problem, but no more than that. Prose should be short, concise.
