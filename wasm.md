# WASM Raymarcher Plan

## Goal
Move SDF evaluation and raymarching to WASM for ~5-10x speedup via SIMD.

## Architecture

```
JS (scene definition)     C/WASM (hot path)
─────────────────────    ─────────────────────
SceneDefinition          Flat typed arrays
  ↓ compile(t)             ↓
FlatSDF arrays    ───→   march_batch()
  - types[]                - SIMD vec ops
  - params[]               - Inline SDF eval
  - transforms[]           - Batch normals
  - colors[]               ↓
       ←───────────────  color buffer out
```

## Data Layout (SoA)

```c
// Scene representation (passed from JS)
typedef struct {
    uint8_t* types;        // SDF_SPHERE, SDF_BOX, etc.
    float* params;         // shape params (radius, dimensions)
    float* transforms;     // 4x4 matrices, row-major
    float* colors;         // RGB per shape
    uint32_t count;        // number of shapes
} Scene;

// Ray batch (passed from JS)
typedef struct {
    float* ox, *oy, *oz;   // origins (SoA)
    float* dx, *dy, *dz;   // directions (SoA)
    uint32_t count;        // number of rays
} RayBatch;

// Output (written by WASM)
typedef struct {
    float* r, *g, *b;      // final colors (SoA)
} ColorBuffer;
```

## SDF Types

```c
enum SDFType {
    SDF_SPHERE = 0,  // params: [radius]
    SDF_BOX    = 1,  // params: [w, h, d]
    SDF_TORUS  = 2,  // params: [major, minor]
    SDF_PLANE  = 3,  // params: [nx, ny, nz, d]
};
```

## API

```c
// Initialize (allocate internal buffers)
void init(uint32_t max_rays, uint32_t max_shapes);

// Set scene data (call once per frame if scene changes)
void set_scene(uint8_t* types, float* params, float* transforms, 
               float* colors, uint32_t count, float smooth_k);

// Set rays (call once per frame)
void set_rays(float* ox, float* oy, float* oz,
              float* dx, float* dy, float* dz, uint32_t count);

// March all rays, write colors to output buffer
void march(float* out_r, float* out_g, float* out_b,
           uint32_t max_steps, float max_dist, float hit_threshold);

// Get timing info (optional)
float get_march_time_ms();
```

## JS Integration

```ts
// Load WASM
const wasm = await WebAssembly.instantiate(wasmBuffer, {});
const { init, set_scene, set_rays, march } = wasm.instance.exports;

// Compile scene definition to flat arrays
function compileScene(def: SceneDefinition, t: number): FlatArrays {
    const types = new Uint8Array(def.objects.length);
    const params = new Float32Array(def.objects.length * 4);
    const transforms = new Float32Array(def.objects.length * 16);
    const colors = new Float32Array(def.objects.length * 3);
    
    for (let i = 0; i < def.objects.length; i++) {
        const obj = def.objects[i];
        types[i] = SHAPE_TYPE_MAP[obj.shape];
        // Apply animation at time t, pack params/transforms
        packObject(obj, t, params, transforms, colors, i);
    }
    return { types, params, transforms, colors };
}

// Render frame
function render(scene: SceneDefinition, t: number) {
    const flat = compileScene(scene, t);
    set_scene(flat.types, flat.params, flat.transforms, flat.colors, flat.count);
    set_rays(rayOrigins, rayDirections, rayCount);
    march(colorBuffer, MAX_STEPS, MAX_DIST, HIT_THRESHOLD);
    // colorBuffer now contains RGB values
}
```

## Build

```bash
# Compile C to WASM with SIMD
clang --target=wasm32 -O3 -msimd128 -nostdlib \
    -Wl,--no-entry -Wl,--export-all \
    -o renderer.wasm renderer.c
```

## Phases

1. **Hello world** - Pass time, return background color
2. **Basic march** - Single sphere, no lighting
3. **Full scene** - Multiple primitives, smooth union
4. **Lighting** - Normals, diffuse, ambient
5. **SIMD** - Vectorize inner loops (4 rays at a time)

## Performance Targets

| Metric | Current (JS) | Target (WASM) |
|--------|--------------|---------------|
| Frame time (200x50) | ~50ms | ~5-10ms |
| SDF evals/sec | ~2M | ~20M |
| Memory allocs/frame | ~100k | 0 |

## Files

```
src/
  wasm/
    renderer.c      # Core WASM implementation
    build.sh        # Build script
  renderer.wasm     # Compiled output (gitignored)
  wasm-loader.ts    # JS bindings
```
