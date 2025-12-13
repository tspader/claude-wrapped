#!/usr/bin/env bun
/**
 * WASM-based terminal ray marcher using OpenTUI for rendering.
 */

import {
  createCliRenderer,
  FrameBufferRenderable,
  BoxRenderable,
  TextRenderable,
  RGBA,
} from "@opentui/core";
import { Camera, type Vec3 } from "./camera";
import type { OptimizedBuffer } from "@opentui/core";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { makeSceneData, compileScene, config, sceneGroupDefs, type FlatScene } from "./scene";

// =============================================================================
// WASM Module Interface
// =============================================================================

interface WasmExports {
  memory: WebAssembly.Memory;
  // Ray buffer pointers
  get_bg_ptr: () => number;
  get_ray_ox_ptr: () => number;
  get_ray_oy_ptr: () => number;
  get_ray_oz_ptr: () => number;
  get_ray_dx_ptr: () => number;
  get_ray_dy_ptr: () => number;
  get_ray_dz_ptr: () => number;
  get_out_r_ptr: () => number;
  get_out_g_ptr: () => number;
  get_out_b_ptr: () => number;
  // Scene buffer pointers
  get_shape_types_ptr: () => number;
  get_shape_params_ptr: () => number;
  get_shape_positions_ptr: () => number;
  get_shape_colors_ptr: () => number;
  get_shape_groups_ptr: () => number;
  get_group_blend_modes_ptr: () => number;
  // Performance metrics pointer
  get_perf_metrics_ptr: () => number;
  reset_perf_metrics: () => void;
  // Functions
  get_max_rays: () => number;
  get_max_shapes: () => number;
  get_max_groups: () => number;
  set_ray_count: (count: number) => void;
  set_scene: (count: number, smoothK: number) => void;
  set_groups: (count: number) => void;
  compute_background: (time: number) => void;
  march_rays: () => void;
}

// WASM perf metric indices (must match renderer.c)
const PERF = {
  TOTAL_STEPS: 0,
  TOTAL_SDF_CALLS: 1,
  NORMAL_SDF_CALLS: 2,
  COLOR_LOOKUPS: 3,
  EARLY_HITS: 4,
  MISSES: 5,
  AVG_STEPS: 6,
  HIT_RATE: 7,
  AABB_SKIPPED: 8,
} as const;

interface WasmRenderer {
  exports: WasmExports;
  maxRays: number;
  maxShapes: number;
  maxGroups: number;
  // Ray buffer views
  rayOx: Float32Array;
  rayOy: Float32Array;
  rayOz: Float32Array;
  rayDx: Float32Array;
  rayDy: Float32Array;
  rayDz: Float32Array;
  outR: Float32Array;
  outG: Float32Array;
  outB: Float32Array;
  bgColor: Float32Array;
  // Scene buffer views
  shapeTypes: Uint8Array;
  shapeParams: Float32Array;
  shapePositions: Float32Array;
  shapeColors: Float32Array;
  shapeGroups: Uint8Array;
  groupBlendModes: Uint8Array;
  // Performance metrics
  perfMetrics: Float32Array;
}

// Granular timing for TS-side operations
interface FrameTimings {
  sceneDataMs: number;
  compileSceneMs: number;
  loadSceneMs: number;
  rayGenMs: number;
  rayCopyMs: number;
  marchRaysMs: number;
  renderToBufferMs: number;
  totalMs: number;
  // WASM metrics
  wasmTotalSteps: number;
  wasmTotalSdfCalls: number;
  wasmNormalSdfCalls: number;
  wasmColorLookups: number;
  wasmHits: number;
  wasmMisses: number;
  wasmAvgSteps: number;
  wasmHitRate: number;
  wasmAabbSkipped: number;
}

async function loadWasm(): Promise<WasmRenderer> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const wasmPath = join(__dirname, "wasm", "renderer.wasm");
  const wasmBuffer = readFileSync(wasmPath);

  const { instance } = await WebAssembly.instantiate(wasmBuffer, {});
  const exports = instance.exports as unknown as WasmExports;
  const memory = exports.memory;
  const maxRays = exports.get_max_rays();
  const maxShapes = exports.get_max_shapes();
  const maxGroups = exports.get_max_groups();

  return {
    exports,
    maxRays,
    maxShapes,
    maxGroups,
    // Ray buffers
    rayOx: new Float32Array(memory.buffer, exports.get_ray_ox_ptr(), maxRays),
    rayOy: new Float32Array(memory.buffer, exports.get_ray_oy_ptr(), maxRays),
    rayOz: new Float32Array(memory.buffer, exports.get_ray_oz_ptr(), maxRays),
    rayDx: new Float32Array(memory.buffer, exports.get_ray_dx_ptr(), maxRays),
    rayDy: new Float32Array(memory.buffer, exports.get_ray_dy_ptr(), maxRays),
    rayDz: new Float32Array(memory.buffer, exports.get_ray_dz_ptr(), maxRays),
    outR: new Float32Array(memory.buffer, exports.get_out_r_ptr(), maxRays),
    outG: new Float32Array(memory.buffer, exports.get_out_g_ptr(), maxRays),
    outB: new Float32Array(memory.buffer, exports.get_out_b_ptr(), maxRays),
    bgColor: new Float32Array(memory.buffer, exports.get_bg_ptr(), 3),
    // Scene buffers
    shapeTypes: new Uint8Array(memory.buffer, exports.get_shape_types_ptr(), maxShapes),
    shapeParams: new Float32Array(memory.buffer, exports.get_shape_params_ptr(), maxShapes * 4),
    shapePositions: new Float32Array(memory.buffer, exports.get_shape_positions_ptr(), maxShapes * 3),
    shapeColors: new Float32Array(memory.buffer, exports.get_shape_colors_ptr(), maxShapes * 3),
    shapeGroups: new Uint8Array(memory.buffer, exports.get_shape_groups_ptr(), maxShapes),
    groupBlendModes: new Uint8Array(memory.buffer, exports.get_group_blend_modes_ptr(), maxGroups),
    // Performance metrics (16 floats)
    perfMetrics: new Float32Array(memory.buffer, exports.get_perf_metrics_ptr(), 16),
  };
}

// =============================================================================
// Scene Loading from compiled FlatScene
// =============================================================================

function loadScene(wasm: WasmRenderer, scene: FlatScene): void {
  if (scene.count > wasm.maxShapes) {
    console.error(`Too many shapes: ${scene.count} > ${wasm.maxShapes}`);
    return;
  }
  if (scene.groupCount > wasm.maxGroups) {
    console.error(`Too many groups: ${scene.groupCount} > ${wasm.maxGroups}`);
    return;
  }

  // Copy typed arrays directly to WASM buffers
  wasm.shapeTypes.set(scene.types);
  wasm.shapeParams.set(scene.params);
  wasm.shapePositions.set(scene.positions);
  wasm.shapeColors.set(scene.colors);
  wasm.shapeGroups.set(scene.groups);
  wasm.groupBlendModes.set(scene.groupBlendModes);

  wasm.exports.set_scene(scene.count, scene.smoothK);
  wasm.exports.set_groups(scene.groupCount);
}

// =============================================================================
// Render Frame using WASM
// =============================================================================

function renderFrame(
  wasm: WasmRenderer,
  t: number,
  nativeWidth: number,
  nativeHeight: number,
  termWidth: number,
  termHeight: number,
  scale: number,
  frameBuffer: OptimizedBuffer,
  camera: Camera
): FrameTimings {
  const timings: FrameTimings = {
    sceneDataMs: 0,
    compileSceneMs: 0,
    loadSceneMs: 0,
    rayGenMs: 0,
    rayCopyMs: 0,
    marchRaysMs: 0,
    renderToBufferMs: 0,
    totalMs: 0,
    wasmTotalSteps: 0,
    wasmTotalSdfCalls: 0,
    wasmNormalSdfCalls: 0,
    wasmColorLookups: 0,
    wasmHits: 0,
    wasmMisses: 0,
    wasmAvgSteps: 0,
    wasmHitRate: 0,
    wasmAabbSkipped: 0,
  };

  const totalStart = performance.now();
  const nRays = nativeWidth * nativeHeight;

  if (nRays > wasm.maxRays) {
    console.error(`Too many rays: ${nRays} > ${wasm.maxRays}`);
    return timings;
  }

  // Reset WASM perf metrics
  wasm.exports.reset_perf_metrics();

  // Compile scene at time t and load to WASM
  let t0 = performance.now();
  const objects = makeSceneData(t);
  timings.sceneDataMs = performance.now() - t0;

  t0 = performance.now();
  const flatScene = compileScene(objects, sceneGroupDefs, config.scene.smoothK);
  timings.compileSceneMs = performance.now() - t0;

  t0 = performance.now();
  loadScene(wasm, flatScene);
  timings.loadSceneMs = performance.now() - t0;

  // Generate rays using JS Camera at native resolution
  t0 = performance.now();
  const { origins, directions } = camera.generateRays(nativeWidth, nativeHeight);
  timings.rayGenMs = performance.now() - t0;

  // Copy rays to WASM buffers
  t0 = performance.now();
  for (let i = 0; i < nRays; i++) {
    const o = origins[i]!;
    const d = directions[i]!;
    wasm.rayOx[i] = o[0];
    wasm.rayOy[i] = o[1];
    wasm.rayOz[i] = o[2];
    wasm.rayDx[i] = d[0];
    wasm.rayDy[i] = d[1];
    wasm.rayDz[i] = d[2];
  }
  timings.rayCopyMs = performance.now() - t0;

  // Set ray count and compute background
  wasm.exports.set_ray_count(nRays);
  wasm.exports.compute_background(t);

  // Do the raymarching in WASM
  t0 = performance.now();
  wasm.exports.march_rays();
  timings.marchRaysMs = performance.now() - t0;

  // Read WASM perf metrics
  timings.wasmTotalSteps = wasm.perfMetrics[PERF.TOTAL_STEPS]!;
  timings.wasmTotalSdfCalls = wasm.perfMetrics[PERF.TOTAL_SDF_CALLS]!;
  timings.wasmNormalSdfCalls = wasm.perfMetrics[PERF.NORMAL_SDF_CALLS]!;
  timings.wasmColorLookups = wasm.perfMetrics[PERF.COLOR_LOOKUPS]!;
  timings.wasmHits = wasm.perfMetrics[PERF.EARLY_HITS]!;
  timings.wasmMisses = wasm.perfMetrics[PERF.MISSES]!;
  timings.wasmAvgSteps = wasm.perfMetrics[PERF.AVG_STEPS]!;
  timings.wasmHitRate = wasm.perfMetrics[PERF.HIT_RATE]!;
  timings.wasmAabbSkipped = wasm.perfMetrics[PERF.AABB_SKIPPED]!;

  // Read results and render to buffer with upscaling
  t0 = performance.now();
  const bg: Vec3 = [wasm.bgColor[0]!, wasm.bgColor[1]!, wasm.bgColor[2]!];
  renderToBufferUpscaled(wasm, nativeWidth, nativeHeight, termWidth, termHeight, scale, frameBuffer, bg);
  timings.renderToBufferMs = performance.now() - t0;

  timings.totalMs = performance.now() - totalStart;
  return timings;
}

// =============================================================================
// Output Rendering (ASCII mode)
// =============================================================================

function dither(brightness: number, row: number, col: number): number {
  const bayer2x2 = [
    [0.0, 0.5],
    [0.75, 0.25],
  ];
  const threshold = bayer2x2[row % 2]![col % 2]!;
  return brightness + (threshold - 0.5) * 0.15;
}

function renderToBufferUpscaled(
  wasm: WasmRenderer,
  nativeWidth: number,
  nativeHeight: number,
  termWidth: number,
  termHeight: number,
  scale: number,
  frameBuffer: OptimizedBuffer,
  background: Vec3
): void {
  const chars = " .:-=+*#%@";
  const bgColor = RGBA.fromValues(background[0], background[1], background[2], 1);

  // Iterate over terminal pixels and sample from native resolution
  for (let termRow = 0; termRow < termHeight; termRow++) {
    // Map terminal row to native row
    const nativeRow = Math.min(Math.floor(termRow / scale), nativeHeight - 1);

    for (let termCol = 0; termCol < termWidth; termCol++) {
      // Map terminal col to native col
      const nativeCol = Math.min(Math.floor(termCol / scale), nativeWidth - 1);

      const idx = nativeRow * nativeWidth + nativeCol;
      const r = wasm.outR[idx]!;
      const g = wasm.outG[idx]!;
      const b = wasm.outB[idx]!;

      let brightness = (r + g + b) / 3;
      brightness = dither(brightness, termRow, termCol);
      let charIdx = Math.floor(brightness * (chars.length - 1));
      charIdx = Math.max(0, Math.min(chars.length - 1, charIdx));

      // Check if pixel has color (not background)
      if (r > 0.04 || g > 0.04 || b > 0.04) {
        const fg = RGBA.fromValues(r, g, b, 1);
        frameBuffer.setCell(termCol, termRow, chars[charIdx]!, fg, bgColor, 0);
      } else {
        // Dark background character
        const darkFg = RGBA.fromValues(0.03, 0.05, 0.04, 1);
        frameBuffer.setCell(termCol, termRow, "@", darkFg, bgColor, 0);
      }
    }
  }
}

// =============================================================================
// CLI
// =============================================================================

function parseArgs(): {
  time: number;
  animate: boolean;
  fps: number;
  scale: number;
  bench: boolean;
  width: number | null;
  height: number | null;
} {
  const args = process.argv.slice(2);
  const result = {
    time: 0,
    animate: false,
    fps: 30,
    scale: 1,
    bench: false,
    width: null as number | null,
    height: null as number | null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "-t":
      case "--time":
        result.time = parseFloat(args[++i] || "0");
        break;
      case "-a":
      case "--animate":
        result.animate = true;
        break;
      case "--fps":
        result.fps = parseInt(args[++i] || "30", 10);
        break;
      case "-s":
      case "--scale":
        result.scale = parseInt(args[++i] || "1", 10);
        break;
      case "-b":
      case "--bench":
        result.bench = true;
        break;
      case "-w":
      case "--width":
        result.width = parseInt(args[++i] || "256", 10);
        break;
      case "-h":
      case "--height":
        result.height = parseInt(args[++i] || "64", 10);
        break;
      case "--help":
        console.log(`Usage: bun src/main.ts [options]

Options:
  -t, --time <float>    Time value for scene (default: 0)
  -a, --animate         Run animation loop
  --fps <int>           Frames per second (default: 30)
  -s, --scale <int>     Upscale factor (default: 1, render at 1/scale resolution)
  -b, --bench           Benchmark mode (no display, prints stats)
  -w, --width <int>     Native render width (default: terminal width)
  -h, --height <int>    Native render height (default: terminal height)
  --help                Show this help`);
        process.exit(0);
    }
  }

  return result;
}

// =============================================================================
// Benchmark Mode
// =============================================================================

async function runBenchmark(
  wasm: WasmRenderer,
  nativeWidth: number,
  nativeHeight: number,
  camera: Camera
): Promise<void> {
  const WARMUP_FRAMES = 10;
  const MEASURE_FRAMES = 10;

  console.log(`\n=== BENCHMARK MODE ===`);
  console.log(`Native resolution: ${nativeWidth}x${nativeHeight}`);
  console.log(`Rays: ${nativeWidth * nativeHeight}`);
  console.log(`Warmup frames: ${WARMUP_FRAMES}`);
  console.log(`Measurement frames: ${MEASURE_FRAMES}`);
  console.log();

  // We need a dummy framebuffer for renderToBuffer - create minimal typed array
  const dummyBuffer = {
    setCell: () => {},
  } as unknown as import("@opentui/core").OptimizedBuffer;

  // Warmup
  console.log("Warming up...");
  for (let i = 0; i < WARMUP_FRAMES; i++) {
    const t = i * 0.1;
    renderFrameBenchmark(wasm, t, nativeWidth, nativeHeight, camera);
  }

  // Measure
  console.log("Measuring...\n");
  const allTimings: FrameTimings[] = [];

  for (let i = 0; i < MEASURE_FRAMES; i++) {
    const t = (WARMUP_FRAMES + i) * 0.1;
    const timings = renderFrameBenchmark(wasm, t, nativeWidth, nativeHeight, camera);
    allTimings.push(timings);
  }

  // Compute stats
  const totals = allTimings.map((t) => t.totalMs).sort((a, b) => a - b);
  const marchTimes = allTimings.map((t) => t.marchRaysMs).sort((a, b) => a - b);
  const medianTotal = totals[Math.floor(totals.length / 2)]!;
  const worstTotal = totals[totals.length - 1]!;
  const medianMarch = marchTimes[Math.floor(marchTimes.length / 2)]!;
  const worstMarch = marchTimes[marchTimes.length - 1]!;

  const last = allTimings[allTimings.length - 1]!;

  console.log(`=== RESULTS ===`);
  console.log(`Resolution: ${nativeWidth}x${nativeHeight} (${nativeWidth * nativeHeight} rays)`);
  console.log();
  console.log(`-- Frame Timing --`);
  console.log(`  Median total:  ${medianTotal.toFixed(2)}ms`);
  console.log(`  Worst total:   ${worstTotal.toFixed(2)}ms`);
  console.log(`  Median march:  ${medianMarch.toFixed(2)}ms`);
  console.log(`  Worst march:   ${worstMarch.toFixed(2)}ms`);
  console.log();
  console.log(`-- Last Frame Breakdown --`);
  console.log(`  sceneData:     ${last.sceneDataMs.toFixed(3)}ms`);
  console.log(`  compileScene:  ${last.compileSceneMs.toFixed(3)}ms`);
  console.log(`  loadScene:     ${last.loadSceneMs.toFixed(3)}ms`);
  console.log(`  rayGen:        ${last.rayGenMs.toFixed(3)}ms`);
  console.log(`  rayCopy:       ${last.rayCopyMs.toFixed(3)}ms`);
  console.log(`  marchRays:     ${last.marchRaysMs.toFixed(3)}ms`);
  console.log(`  renderBuffer:  ${last.renderToBufferMs.toFixed(3)}ms`);
  console.log(`  TOTAL:         ${last.totalMs.toFixed(3)}ms`);
  console.log();
  console.log(`-- WASM Metrics --`);
  console.log(`  totalSteps:    ${last.wasmTotalSteps.toFixed(0)}`);
  console.log(`  avgSteps:      ${last.wasmAvgSteps.toFixed(1)}/batch`);
  console.log(`  sdfCalls:      ${last.wasmTotalSdfCalls.toFixed(0)} (march loop)`);
  console.log(`  normalSdf:     ${last.wasmNormalSdfCalls.toFixed(0)}`);
  console.log(`  colorLookups:  ${last.wasmColorLookups.toFixed(0)}`);
  console.log(`  hits/misses:   ${last.wasmHits.toFixed(0)}/${last.wasmMisses.toFixed(0)}`);
  console.log(`  hitRate:       ${last.wasmHitRate.toFixed(1)}%`);
  console.log(`  aabbSkipped:   ${last.wasmAabbSkipped.toFixed(0)}`);
  console.log();
}

/**
 * Benchmark version of renderFrame - skips the terminal output phase
 */
function renderFrameBenchmark(
  wasm: WasmRenderer,
  t: number,
  nativeWidth: number,
  nativeHeight: number,
  camera: Camera
): FrameTimings {
  const timings: FrameTimings = {
    sceneDataMs: 0,
    compileSceneMs: 0,
    loadSceneMs: 0,
    rayGenMs: 0,
    rayCopyMs: 0,
    marchRaysMs: 0,
    renderToBufferMs: 0,
    totalMs: 0,
    wasmTotalSteps: 0,
    wasmTotalSdfCalls: 0,
    wasmNormalSdfCalls: 0,
    wasmColorLookups: 0,
    wasmHits: 0,
    wasmMisses: 0,
    wasmAvgSteps: 0,
    wasmHitRate: 0,
    wasmAabbSkipped: 0,
  };

  const totalStart = performance.now();
  const nRays = nativeWidth * nativeHeight;

  if (nRays > wasm.maxRays) {
    console.error(`Too many rays: ${nRays} > ${wasm.maxRays}`);
    return timings;
  }

  // Reset WASM perf metrics
  wasm.exports.reset_perf_metrics();

  // Compile scene at time t and load to WASM
  let t0 = performance.now();
  const objects = makeSceneData(t);
  timings.sceneDataMs = performance.now() - t0;

  t0 = performance.now();
  const flatScene = compileScene(objects, sceneGroupDefs, config.scene.smoothK);
  timings.compileSceneMs = performance.now() - t0;

  t0 = performance.now();
  loadScene(wasm, flatScene);
  timings.loadSceneMs = performance.now() - t0;

  // Generate rays using JS Camera at native resolution
  t0 = performance.now();
  const { origins, directions } = camera.generateRays(nativeWidth, nativeHeight);
  timings.rayGenMs = performance.now() - t0;

  // Copy rays to WASM buffers
  t0 = performance.now();
  for (let i = 0; i < nRays; i++) {
    const o = origins[i]!;
    const d = directions[i]!;
    wasm.rayOx[i] = o[0];
    wasm.rayOy[i] = o[1];
    wasm.rayOz[i] = o[2];
    wasm.rayDx[i] = d[0];
    wasm.rayDy[i] = d[1];
    wasm.rayDz[i] = d[2];
  }
  timings.rayCopyMs = performance.now() - t0;

  // Set ray count and compute background
  wasm.exports.set_ray_count(nRays);
  wasm.exports.compute_background(t);

  // Do the raymarching in WASM
  t0 = performance.now();
  wasm.exports.march_rays();
  timings.marchRaysMs = performance.now() - t0;

  // Read WASM perf metrics
  timings.wasmTotalSteps = wasm.perfMetrics[PERF.TOTAL_STEPS]!;
  timings.wasmTotalSdfCalls = wasm.perfMetrics[PERF.TOTAL_SDF_CALLS]!;
  timings.wasmNormalSdfCalls = wasm.perfMetrics[PERF.NORMAL_SDF_CALLS]!;
  timings.wasmColorLookups = wasm.perfMetrics[PERF.COLOR_LOOKUPS]!;
  timings.wasmHits = wasm.perfMetrics[PERF.EARLY_HITS]!;
  timings.wasmMisses = wasm.perfMetrics[PERF.MISSES]!;
  timings.wasmAvgSteps = wasm.perfMetrics[PERF.AVG_STEPS]!;
  timings.wasmHitRate = wasm.perfMetrics[PERF.HIT_RATE]!;
  timings.wasmAabbSkipped = wasm.perfMetrics[PERF.AABB_SKIPPED]!;

  // Skip renderToBuffer in benchmark mode - that's terminal I/O
  timings.renderToBufferMs = 0;

  timings.totalMs = performance.now() - totalStart;
  return timings;
}

async function main(): Promise<void> {
  const args = parseArgs();

  // Load WASM module
  const wasm = await loadWasm();

  // Benchmark mode - no renderer needed
  if (args.bench) {
    const nativeWidth = args.width ?? 256;
    const nativeHeight = args.height ?? 64;

    const camera = new Camera({
      eye: config.camera.eye,
      at: config.camera.at,
      up: config.camera.up,
      fov: config.camera.fov,
    });

    await runBenchmark(wasm, nativeWidth, nativeHeight, camera);
    return;
  }

  // Create OpenTUI renderer
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: args.fps,
  });

  // Terminal dimensions (output size)
  const termWidth = renderer.width;
  const termHeight = renderer.height;

  // Native render resolution (scaled down)
  // Use ceil to ensure we cover the full terminal when upscaling
  const scale = Math.max(1, args.scale);
  const nativeWidth = Math.ceil(termWidth / scale);
  const nativeHeight = Math.ceil(termHeight / scale);

  // Check if we exceed max rays
  const nRays = nativeWidth * nativeHeight;
  if (nRays > wasm.maxRays) {
    process.stderr.write(`Render resolution too large: ${nativeWidth}x${nativeHeight} = ${nRays} rays, max is ${wasm.maxRays}\n`);
    process.stderr.write(`Use -s/--scale to reduce resolution\n`);
    process.exit(1);
  }

  // Camera config from scene.ts
  const camera = new Camera({
    eye: config.camera.eye,
    at: config.camera.at,
    up: config.camera.up,
    fov: config.camera.fov,
  });

  // Create FrameBufferRenderable at terminal resolution
  const canvas = new FrameBufferRenderable(renderer, {
    id: "raymarcher",
    width: termWidth,
    height: termHeight,
    position: "absolute",
    left: 0,
    top: 0,
  });

  renderer.root.add(canvas);

  // Create centered stats box
  const boxMargin = 2;
  const boxWidth = Math.floor(termWidth / 2);
  const boxHeight = termHeight - boxMargin * 2;
  const boxLeft = Math.floor((termWidth - boxWidth) / 2);
  const boxTop = boxMargin;

  const statsBox = new BoxRenderable(renderer, {
    id: "stats-box",
    width: boxWidth,
    height: boxHeight,
    position: "absolute",
    left: boxLeft,
    top: boxTop,
    border: true,
    borderStyle: "single",
    borderColor: "#FFFFFF",
    backgroundColor: RGBA.fromValues(0, 0, 0, 0.5),
    padding: 1,
  });

  const titleText = new TextRenderable(renderer, {
    id: "title-text",
    content: "CLAUDE WRAPPED",
    fg: "#FFFFFF",
  });

  const statsText = new TextRenderable(renderer, {
    id: "stats-text",
    content: "",
    fg: "#AAAAAA",
  });

  statsBox.flexDirection = "column";
  statsBox.add(titleText);
  statsBox.add(statsText);
  renderer.root.add(statsBox);

  // Frame timing tracking
  const frameTimes: number[] = [];
  let worstFrameTime = 0;
  let medianFrameTime = 0;
  let frameCount = 0;
  let lastTimings: FrameTimings | null = null;

  function updateStats(timings: FrameTimings): void {
    frameTimes.push(timings.totalMs);
    frameCount++;
    lastTimings = timings;

    // Update stats every FPS frames
    if (frameCount % args.fps === 0) {
      worstFrameTime = Math.max(...frameTimes);
      const sorted = [...frameTimes].sort((a, b) => a - b);
      medianFrameTime = sorted[Math.floor(sorted.length / 2)] ?? 0;
      frameTimes.length = 0; // Clear for next batch
    }

    statsText.content = [
      "",
      `Resolution: ${nativeWidth}x${nativeHeight} (${scale}x)`,
      `Rays: ${nativeWidth * nativeHeight}`,
      "",
      "-- TS Timings --",
      `  sceneData:    ${timings.sceneDataMs.toFixed(2)}ms`,
      `  compileScene: ${timings.compileSceneMs.toFixed(2)}ms`,
      `  loadScene:    ${timings.loadSceneMs.toFixed(2)}ms`,
      `  rayGen:       ${timings.rayGenMs.toFixed(2)}ms`,
      `  rayCopy:      ${timings.rayCopyMs.toFixed(2)}ms`,
      `  marchRays:    ${timings.marchRaysMs.toFixed(2)}ms`,
      `  renderBuffer: ${timings.renderToBufferMs.toFixed(2)}ms`,
      `  TOTAL:        ${timings.totalMs.toFixed(2)}ms`,
      "",
      "-- WASM Metrics --",
      `  totalSteps:   ${timings.wasmTotalSteps.toFixed(0)}`,
      `  avgSteps:     ${timings.wasmAvgSteps.toFixed(1)}/batch`,
      `  sdfCalls:     ${timings.wasmTotalSdfCalls.toFixed(0)} (march)`,
      `  normalSdf:    ${timings.wasmNormalSdfCalls.toFixed(0)}`,
      `  colorLookups: ${timings.wasmColorLookups.toFixed(0)}`,
      `  hits/misses:  ${timings.wasmHits.toFixed(0)}/${timings.wasmMisses.toFixed(0)}`,
      `  hitRate:      ${timings.wasmHitRate.toFixed(1)}%`,
      "",
      `Worst: ${worstFrameTime.toFixed(1)}ms | Median: ${medianFrameTime.toFixed(1)}ms`,
    ].join("\n");
  }

  // Get initial background for clear
  wasm.exports.compute_background(args.time);
  const bg: Vec3 = [wasm.bgColor[0]!, wasm.bgColor[1]!, wasm.bgColor[2]!];
  const bgColor = RGBA.fromValues(bg[0], bg[1], bg[2], 1);
  renderer.setBackgroundColor(bgColor);

  if (args.animate) {
    let t = 0;

    renderer.setFrameCallback(async (deltaTime) => {
      wasm.exports.compute_background(t);
      const bg: Vec3 = [wasm.bgColor[0]!, wasm.bgColor[1]!, wasm.bgColor[2]!];
      const bgRgba = RGBA.fromValues(bg[0], bg[1], bg[2], 1);
      renderer.setBackgroundColor(bgRgba);
      canvas.frameBuffer.clear(bgRgba);
      const timings = renderFrame(wasm, t, nativeWidth, nativeHeight, termWidth, termHeight, scale, canvas.frameBuffer, camera);
      t += deltaTime / 1000;

      updateStats(timings);
    });

    renderer.start();
  } else {
    // Single frame
    canvas.frameBuffer.clear(bgColor);
    const timings = renderFrame(wasm, args.time, nativeWidth, nativeHeight, termWidth, termHeight, scale, canvas.frameBuffer, camera);

    statsText.content = [
      "",
      `Resolution: ${nativeWidth}x${nativeHeight} (${scale}x)`,
      `Rays: ${nativeWidth * nativeHeight}`,
      "",
      "-- TS Timings --",
      `  sceneData:    ${timings.sceneDataMs.toFixed(2)}ms`,
      `  compileScene: ${timings.compileSceneMs.toFixed(2)}ms`,
      `  loadScene:    ${timings.loadSceneMs.toFixed(2)}ms`,
      `  rayGen:       ${timings.rayGenMs.toFixed(2)}ms`,
      `  rayCopy:      ${timings.rayCopyMs.toFixed(2)}ms`,
      `  marchRays:    ${timings.marchRaysMs.toFixed(2)}ms`,
      `  renderBuffer: ${timings.renderToBufferMs.toFixed(2)}ms`,
      `  TOTAL:        ${timings.totalMs.toFixed(2)}ms`,
      "",
      "-- WASM Metrics --",
      `  totalSteps:   ${timings.wasmTotalSteps.toFixed(0)}`,
      `  avgSteps:     ${timings.wasmAvgSteps.toFixed(1)}/batch`,
      `  sdfCalls:     ${timings.wasmTotalSdfCalls.toFixed(0)} (march)`,
      `  normalSdf:    ${timings.wasmNormalSdfCalls.toFixed(0)}`,
      `  colorLookups: ${timings.wasmColorLookups.toFixed(0)}`,
      `  hits/misses:  ${timings.wasmHits.toFixed(0)}/${timings.wasmMisses.toFixed(0)}`,
      `  hitRate:      ${timings.wasmHitRate.toFixed(1)}%`,
    ].join("\n");

    await renderer.idle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    renderer.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
