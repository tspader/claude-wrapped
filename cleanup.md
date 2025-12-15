# StatsBox.ts Cleanup

## Tasks

- [ ] **1. Remove manual width calculation** (lines 100-103)
  - Remove `innerWidth`/`innerHeight` variables
  - Use `width: "100%"` or let flexbox handle child sizing

- [ ] **2. Remove explicit innerWidth on containers** (lines 123, 155)
  - `logoContainer` and `titleContainer` receive explicit `width: innerWidth`
  - Should auto-stretch in column flex parent

- [ ] **3. Use margin instead of newline strings** (lines 325, 333, 337)
  - Option spacing via `"\n\n"` and `"   "` strings
  - Replace with marginTop/marginBottom or gap

- [ ] **4. Remove redundant typingFinished state** (line 90)
  - `typingFinished` is always `displayIndex >= plainText.length`
  - Replace with getter or inline check

- [ ] **5. Refactor to state machine style**
  - handleInput has nested conditionals for slide types
  - Separate prompt vs info slide handling
  - Consider: slides handle own input, or cleaner switch/dispatch pattern
