- Never run the CLI in animated mode. It destroys your context window. Instead, render a single frame like this:
```bash
bun src/main.ts --time 0
```
-
