# overview
This is how we define scenes by composited SDFs.

# init
Runs once, on startup.

- Seed PRNG from config
- Generate base positions for blob spheres (two columns)
- Generate random noise offsets, phase offsets, freq multipliers per sphere
- Initialize simplex noise generator

# update
Runs every frame.

- `makeSceneData(t)` computes current positions/sizes using animation functions
- `compileScene()` flattens ObjectDef[] to parallel typed arrays
- `loadScene()` copies typed arrays to WASM buffers via `.set()`

# animation

| What | How |
|------|-----|
| Blob drift | `pnoise1(offset + t * speed)` - simplex noise |
| Blob size | `sin(t * freq + phase) * amount` |
| Claude slingshot | `getClaudePosition(t)` - windup then parabolic flight |
| Claude sway | Same noise as blobs, smaller scale |


# groups
Shapes have a group ID. Each group has a blend mode (hard or smooth). Shapes within a group blend with that mode. Groups smooth-union together at the end.

# references
- `src/scene.ts` - scene state, animation, compilation
- `sceneState` - init-once RNG seeds and offsets
- `makeSceneData(t)` - per-frame position/size computation
- `compileScene()` - flatten to typed arrays
- `sceneGroupDefs` - group blend mode definitions
