# overview
A raymarcher written in WASM.

# data flow
```
Each Frame:
makeSceneData(t)     → ObjectDef[]        (TS: animate positions)
    ↓
compileScene()       → FlatScene          (TS: flatten to typed arrays)
    ↓
loadScene()          → WASM buffers       (TS: copy via typedArray.set())
    ↓
Camera.generateRays()→ ray origins/dirs   (TS: perspective projection)
    ↓
march_rays()         → color buffer       (WASM+SIMD: raymarch SDF)
    ↓
renderToBuffer()     → terminal           (TS: ASCII + truecolor)
```

# scene (ts -> wasm)
```c
// Per-shape arrays (SoA layout for cache efficiency)
uint8_t types[MAX_SHAPES];        // SPHERE=0, BOX=1
float params[MAX_SHAPES * 4];     // [radius] or [w,h,d,_]
float positions[MAX_SHAPES * 3];  // x,y,z center
float colors[MAX_SHAPES * 3];     // r,g,b
uint8_t groups[MAX_SHAPES];       // group ID

// Per-group
uint8_t blend_mode[MAX_GROUPS];   // 0=hard(min), 1=smooth
```

# hierarchical sdf groups
Groups blend internally, then combine:

```
Group 0 (blobs):  spheres  →  smooth_union  →  d0
Group 1 (claude): boxes    →  min (hard)    →  d1
                                   ↓
                          smooth_union(d0, d1) → final
```

This gives Claude distinct limbs while still melting into blob columns.

# simd
- Process 4 rays per iteration via `wasm_simd128.h`
- `scene_sdf_simd()` evaluates 4 points simultaneously
- Ray buffers use SoA layout: `ray_ox[N], ray_oy[N], ray_oz[N]` (not AoS)

# references

| File | Purpose |
|------|---------|
| `src/wasm/renderer.c` | SIMD raymarcher, SDF primitives, hierarchical eval |
| `src/scene.ts` | Scene types, `makeSceneData()`, `compileScene()`, group defs |
| `src/main-wasm.ts` | WASM loader, render loop, terminal output |


```bash
clang --target=wasm32 -O3 -msimd128 -nostdlib -Wl,--no-entry -Wl,--export-all -o renderer.wasm renderer.c
```
