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
import { Camera, type Vec3, normalize, cross, sub } from "./camera";
import type { OptimizedBuffer } from "@opentui/core";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { StatsBox } from "./ui/StatsBox";
import {
  compileScene,
  setActiveScene,
  getActiveScene,
  type FlatScene,
  type LightingConfig,
} from "./scene";

// Register all scenes (side effect: adds to registry)
import "./scenes/slingshot";
import "./scenes/tpose";

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
  // Point light buffer pointers
  get_point_light_x_ptr: () => number;
  get_point_light_y_ptr: () => number;
  get_point_light_z_ptr: () => number;
  get_point_light_r_ptr: () => number;
  get_point_light_g_ptr: () => number;
  get_point_light_b_ptr: () => number;
  get_point_light_intensity_ptr: () => number;
  get_point_light_radius_ptr: () => number;
  get_max_point_lights: () => number;
  set_point_lights: (count: number) => void;
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
  set_camera: (
    ex: number, ey: number, ez: number,
    fx: number, fy: number, fz: number,
    rx: number, ry: number, rz: number,
    ux: number, uy: number, uz: number,
    halfW: number, halfH: number
  ) => void;
  generate_rays: (width: number, height: number) => void;
  compute_background: (time: number) => void;
  set_lighting: (ambient: number, dirX: number, dirY: number, dirZ: number, intensity: number) => void;
  march_rays: () => void;
  // Compositing (outputs to out_char/out_fg/out_bg for bulk copy to OpenTUI)
  get_out_char_ptr: () => number;
  get_out_fg_ptr: () => number;
  get_out_bg_ptr: () => number;
  composite: (width: number, height: number) => void;
  composite_blocks: (width: number, height: number) => void;
  // Upscaling (uses MAX_RAYS for output buffer size since terminal is the limit)
  get_upscaled_char_ptr: () => number;
  get_upscaled_fg_ptr: () => number;
  upscale: (nativeW: number, nativeH: number, outW: number, outH: number, scale: number) => void;
  // Snow particle system
  get_snow_x_ptr: () => number;
  get_snow_y_ptr: () => number;
  get_snow_speed_ptr: () => number;
  get_snow_drift_ptr: () => number;
  get_max_particles: () => number;
  set_snow: (count: number) => void;
  update_snow: (dt: number, width: number, height: number) => void;
  apply_snow: (width: number, height: number) => void;
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
  maxPointLights: number;
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
  // Point light buffer views
  pointLightX: Float32Array;
  pointLightY: Float32Array;
  pointLightZ: Float32Array;
  pointLightR: Float32Array;
  pointLightG: Float32Array;
  pointLightB: Float32Array;
  pointLightIntensity: Float32Array;
  pointLightRadius: Float32Array;
  // Performance metrics (16 floats)
  perfMetrics: Float32Array;
  // Composited output (bulk copy to OpenTUI)
  outChar: Uint32Array;
  outFg: Float32Array;
  outBg: Float32Array;
  // Upscaled output (for scale > 1)
  upscaledChar: Uint32Array;
  upscaledFg: Float32Array;
  // Snow particle buffers
  maxParticles: number;
  snowX: Float32Array;
  snowY: Float32Array;
  snowSpeed: Float32Array;
  snowDrift: Float32Array;
}

// Granular timing for TS-side operations
interface FrameTimings {
  sceneDataMs: number;
  compileSceneMs: number;
  loadSceneMs: number;
  rayGenMs: number;
  rayCopyMs: number;
  marchRaysMs: number;
  compositeMs: number;
  bufferCopyMs: number;
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

  // @ts-ignore
  const { instance } = await WebAssembly.instantiate(wasmBuffer, {});
  const exports = instance.exports as unknown as WasmExports;
  const memory = exports.memory;
  const maxRays = exports.get_max_rays();
  const maxShapes = exports.get_max_shapes();
  const maxGroups = exports.get_max_groups();
  const maxPointLights = exports.get_max_point_lights();

  return {
    exports,
    maxRays,
    maxShapes,
    maxGroups,
    maxPointLights,
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
    // Point light buffers
    pointLightX: new Float32Array(memory.buffer, exports.get_point_light_x_ptr(), maxPointLights),
    pointLightY: new Float32Array(memory.buffer, exports.get_point_light_y_ptr(), maxPointLights),
    pointLightZ: new Float32Array(memory.buffer, exports.get_point_light_z_ptr(), maxPointLights),
    pointLightR: new Float32Array(memory.buffer, exports.get_point_light_r_ptr(), maxPointLights),
    pointLightG: new Float32Array(memory.buffer, exports.get_point_light_g_ptr(), maxPointLights),
    pointLightB: new Float32Array(memory.buffer, exports.get_point_light_b_ptr(), maxPointLights),
    pointLightIntensity: new Float32Array(memory.buffer, exports.get_point_light_intensity_ptr(), maxPointLights),
    pointLightRadius: new Float32Array(memory.buffer, exports.get_point_light_radius_ptr(), maxPointLights),
    // Performance metrics (16 floats)
    perfMetrics: new Float32Array(memory.buffer, exports.get_perf_metrics_ptr(), 16),
    // Composited output (bulk copy to OpenTUI)
    outChar: new Uint32Array(memory.buffer, exports.get_out_char_ptr(), maxRays),
    outFg: new Float32Array(memory.buffer, exports.get_out_fg_ptr(), maxRays * 4),
    outBg: new Float32Array(memory.buffer, exports.get_out_bg_ptr(), maxRays * 4),
    // Upscaled output (same max size as native - terminal is the limiting factor)
    upscaledChar: new Uint32Array(memory.buffer, exports.get_upscaled_char_ptr(), maxRays),
    upscaledFg: new Float32Array(memory.buffer, exports.get_upscaled_fg_ptr(), maxRays * 4),
    // Snow particle buffers
    maxParticles: exports.get_max_particles(),
    snowX: new Float32Array(memory.buffer, exports.get_snow_x_ptr(), exports.get_max_particles()),
    snowY: new Float32Array(memory.buffer, exports.get_snow_y_ptr(), exports.get_max_particles()),
    snowSpeed: new Float32Array(memory.buffer, exports.get_snow_speed_ptr(), exports.get_max_particles()),
    snowDrift: new Float32Array(memory.buffer, exports.get_snow_drift_ptr(), exports.get_max_particles()),
  };
}

// =============================================================================
// Scene Loading from compiled FlatScene
// =============================================================================

/**
 * Set up camera in WASM - compute basis vectors and pass to WASM.
 */
function setupCamera(wasm: WasmRenderer, camera: Camera, width: number, height: number): void {
  const forward = normalize(sub(camera.at, camera.eye));
  const right = normalize(cross(forward, camera.up));
  const up = cross(right, forward);

  const aspect = width / height;
  const fovRad = (camera.fov * Math.PI) / 180;
  const halfHeight = Math.tan(fovRad / 2);
  const halfWidth = halfHeight * aspect;

  wasm.exports.set_camera(
    camera.eye[0], camera.eye[1], camera.eye[2],
    forward[0], forward[1], forward[2],
    right[0], right[1], right[2],
    up[0], up[1], up[2],
    halfWidth, halfHeight
  );
}

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
// Snow Particle System
// =============================================================================

import type { SnowConfig } from "./scene/types";

// Track current snow state for reinitialization detection
let currentSnowConfig: SnowConfig | null = null;
let snowInitializedForSize: { width: number; height: number } | null = null;

/**
 * Initialize snow particles when config changes or screen size changes.
 */
function initializeSnow(
  wasm: WasmRenderer,
  config: SnowConfig,
  width: number,
  height: number
): void {
  const count = Math.min(config.count, wasm.maxParticles);
  
  for (let i = 0; i < count; i++) {
    // Random position across screen
    wasm.snowX[i] = Math.random() * width;
    wasm.snowY[i] = Math.random() * height;
    
    // Speed with jitter (±20% of base speed)
    const jitter = (Math.random() - 0.5) * 0.4 * config.baseSpeed;
    wasm.snowSpeed[i] = config.baseSpeed + jitter;
    
    // Random drift in range [-driftStrength, driftStrength]
    wasm.snowDrift[i] = (Math.random() - 0.5) * 2 * config.driftStrength;
  }
  
  wasm.exports.set_snow(count);
  currentSnowConfig = config;
  snowInitializedForSize = { width, height };
}

// =============================================================================
// Render Frame using WASM
// =============================================================================

function renderFrame(
  wasm: WasmRenderer,
  t: number,
  nativeWidth: number,
  nativeHeight: number,
  outputWidth: number,
  outputHeight: number,
  scale: number,
  frameBuffer: OptimizedBuffer,
  camera: Camera,
  useBlocks: boolean = false,
  deltaTime: number = 0.016  // default ~60fps
): FrameTimings {
  const timings: FrameTimings = {
    sceneDataMs: 0,
    compileSceneMs: 0,
    loadSceneMs: 0,
    rayGenMs: 0,
    rayCopyMs: 0,
    marchRaysMs: 0,
    compositeMs: 0,
    bufferCopyMs: 0,
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

  const nOutput = outputWidth * outputHeight;
  if (scale > 1 && nOutput > wasm.maxRays) {
    console.error(`Output too large for upscaling: ${nOutput} > ${wasm.maxRays}`);
    return timings;
  }

  // Reset WASM perf metrics
  wasm.exports.reset_perf_metrics();

  // Compile scene at time t and load to WASM
  const scene = getActiveScene();
  let t0 = performance.now();
  const frame = scene.update(t);
  timings.sceneDataMs = performance.now() - t0;

  t0 = performance.now();
  const flatScene = compileScene(frame.objects, scene.groupDefs, scene.config.smoothK);
  timings.compileSceneMs = performance.now() - t0;

  t0 = performance.now();
  loadScene(wasm, flatScene);
  timings.loadSceneMs = performance.now() - t0;

  // Generate rays at native resolution (apply per-frame camera override if present)
  t0 = performance.now();
  const frameCamera = new Camera({
    eye: frame.camera?.eye ?? camera.eye,
    at: frame.camera?.at ?? camera.at,
    up: frame.camera?.up ?? camera.up,
    fov: frame.camera?.fov ?? camera.fov,
  });
  setupCamera(wasm, frameCamera, nativeWidth, nativeHeight);
  wasm.exports.generate_rays(nativeWidth, nativeHeight);
  timings.rayGenMs = performance.now() - t0;
  timings.rayCopyMs = 0;

  // Compute background
  wasm.exports.compute_background(t);

  // Set lighting (use per-frame override or scene default)
  const lighting = frame.lighting ?? scene.config.lighting;
  const [dx, dy, dz] = lighting.directional.direction;
  wasm.exports.set_lighting(lighting.ambient, dx, dy, dz, lighting.directional.intensity);

  // Set point lights
  const pointLights = lighting.pointLights ?? [];
  const numPointLights = Math.min(pointLights.length, wasm.maxPointLights);
  for (let i = 0; i < numPointLights; i++) {
    const pl = pointLights[i]!;
    wasm.pointLightX[i] = pl.position[0];
    wasm.pointLightY[i] = pl.position[1];
    wasm.pointLightZ[i] = pl.position[2];
    wasm.pointLightR[i] = pl.color[0];
    wasm.pointLightG[i] = pl.color[1];
    wasm.pointLightB[i] = pl.color[2];
    wasm.pointLightIntensity[i] = pl.intensity;
    wasm.pointLightRadius[i] = pl.radius;
  }
  wasm.exports.set_point_lights(numPointLights);

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

  // Composite in WASM (RGB floats -> ASCII/blocks + RGBA for OpenTUI)
  t0 = performance.now();
  if (useBlocks) {
    // Block mode: renders at 2x height internally, outputs at outputHeight
    wasm.exports.composite_blocks(nativeWidth, nativeHeight);
  } else {
    wasm.exports.composite(nativeWidth, nativeHeight);
  }
  
  // Apply snow effect if scene has snow config (only for non-block mode)
  if (frame.snow && !useBlocks) {
    // Check if we need to (re)initialize snow
    const needsInit = !currentSnowConfig ||
      currentSnowConfig.count !== frame.snow.count ||
      currentSnowConfig.baseSpeed !== frame.snow.baseSpeed ||
      currentSnowConfig.driftStrength !== frame.snow.driftStrength ||
      !snowInitializedForSize ||
      snowInitializedForSize.width !== nativeWidth ||
      snowInitializedForSize.height !== nativeHeight;
    
    if (needsInit) {
      initializeSnow(wasm, frame.snow, nativeWidth, nativeHeight);
    }
    
    // Update and apply snow
    wasm.exports.update_snow(deltaTime, nativeWidth, nativeHeight);
    wasm.exports.apply_snow(nativeWidth, nativeHeight);
  }
  timings.compositeMs = performance.now() - t0;

  // Upscale if needed, then bulk copy to framebuffer
  t0 = performance.now();
  const bg: Vec3 = [wasm.bgColor[0]!, wasm.bgColor[1]!, wasm.bgColor[2]!];
  if (useBlocks) {
    // Block mode output is half the native height
    const blockOutHeight = Math.floor(nativeHeight / 2);
    copyToFrameBufferBlocks(wasm, nativeWidth, blockOutHeight, frameBuffer);
  } else if (scale > 1) {
    wasm.exports.upscale(nativeWidth, nativeHeight, outputWidth, outputHeight, scale);
    copyToFrameBufferUpscaled(wasm, outputWidth, outputHeight, frameBuffer, bg);
  } else {
    copyToFrameBuffer(wasm, nativeWidth, nativeHeight, frameBuffer, bg);
  }
  timings.bufferCopyMs = performance.now() - t0;

  timings.renderToBufferMs = timings.compositeMs + timings.bufferCopyMs;
  timings.totalMs = performance.now() - totalStart;
  return timings;
}

// =============================================================================
// Output Rendering - Bulk copy from WASM to OpenTUI
// =============================================================================

function copyToFrameBuffer(
  wasm: WasmRenderer,
  width: number,
  height: number,
  frameBuffer: OptimizedBuffer,
  background: Vec3
): void {
  const buffers = (frameBuffer as any).buffers;
  if (!buffers) {
    throw new Error("OpenTUI buffers not available");
  }

  const count = width * height;
  const { char: charBuf, fg: fgBuf, bg: bgBuf } = buffers as {
    char: Uint32Array;
    fg: Float32Array;
    bg: Float32Array;
  };

  // Bulk copy char and fg from WASM
  charBuf.set(wasm.outChar.subarray(0, count));
  fgBuf.set(wasm.outFg.subarray(0, count * 4));

  // Fill bg with background color
  const [bgR, bgG, bgB] = background;
  for (let i = 0; i < count; i++) {
    const base = i * 4;
    bgBuf[base] = bgR;
    bgBuf[base + 1] = bgG;
    bgBuf[base + 2] = bgB;
    bgBuf[base + 3] = 1.0;
  }
}

/**
 * Copy block-composited output from WASM to OpenTUI framebuffer.
 * Block mode uses both fg and bg colors per cell.
 */
function copyToFrameBufferBlocks(
  wasm: WasmRenderer,
  width: number,
  height: number,
  frameBuffer: OptimizedBuffer
): void {
  const buffers = (frameBuffer as any).buffers;
  if (!buffers) {
    throw new Error("OpenTUI buffers not available");
  }

  const count = width * height;
  const { char: charBuf, fg: fgBuf, bg: bgBuf } = buffers as {
    char: Uint32Array;
    fg: Float32Array;
    bg: Float32Array;
  };

  // Bulk copy char, fg, and bg from WASM
  charBuf.set(wasm.outChar.subarray(0, count));
  fgBuf.set(wasm.outFg.subarray(0, count * 4));
  bgBuf.set(wasm.outBg.subarray(0, count * 4));
}

/**
 * Copy upscaled output from WASM to OpenTUI framebuffer.
 * Used when scale > 1: WASM renders at native resolution, upscales internally,
 * then we copy the upscaled buffer to OpenTUI.
 */
function copyToFrameBufferUpscaled(
  wasm: WasmRenderer,
  outputWidth: number,
  outputHeight: number,
  frameBuffer: OptimizedBuffer,
  background: Vec3
): void {
  const buffers = (frameBuffer as any).buffers;
  if (!buffers) {
    throw new Error("OpenTUI buffers not available");
  }

  const count = outputWidth * outputHeight;
  const { char: charBuf, fg: fgBuf, bg: bgBuf } = buffers as {
    char: Uint32Array;
    fg: Float32Array;
    bg: Float32Array;
  };

  // Bulk copy from upscaled WASM buffers
  charBuf.set(wasm.upscaledChar.subarray(0, count));
  fgBuf.set(wasm.upscaledFg.subarray(0, count * 4));

  // Fill bg with background color
  const [bgR, bgG, bgB] = background;
  for (let i = 0; i < count; i++) {
    const base = i * 4;
    bgBuf[base] = bgR;
    bgBuf[base + 1] = bgG;
    bgBuf[base + 2] = bgB;
    bgBuf[base + 3] = 1.0;
  }
}

// =============================================================================
// CLI
// =============================================================================

function parseArgs(): {
  time: number;
  animate: boolean;
  fps: number;
  bench: boolean;
  width: number | null;
  height: number | null;
  scale: number;
  scene: string;
  blocks: boolean;
} {
  const args = process.argv.slice(2);
  const result = {
    time: 0,
    animate: false,
    fps: 60,
    bench: false,
    width: null as number | null,
    height: null as number | null,
    scale: 1,
    scene: "slingshot",
    blocks: false,
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
      case "-s":
      case "--scale":
        result.scale = parseInt(args[++i] || "1", 10);
        if (result.scale < 1) result.scale = 1;
        break;
      case "--scene":
        result.scene = args[++i] || "slingshot";
        break;
      case "--blocks":
        result.blocks = true;
        break;
      case "--help":
        console.log(`Usage: bun src/main.ts [options]

Options:
  -t, --time <float>    Time value for scene (default: 0)
  -a, --animate         Run animation loop
  --fps <int>           Frames per second (default: 30)
  -b, --bench           Benchmark mode (no display, prints stats)
  -w, --width <int>     Render width for benchmark (default: 256)
  -h, --height <int>    Render height for benchmark (default: 64)
  -s, --scale <int>     Upscale factor (default: 1, render at 1/scale resolution)
  --scene <name>        Scene to load (default: slingshot)
  --blocks              Use Unicode block characters instead of ASCII
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
  width: number,
  height: number,
  camera: Camera
): Promise<void> {
  const WARMUP_FRAMES = 10;
  const MEASURE_FRAMES = 10;

  console.log(`\n=== BENCHMARK MODE ===`);
  console.log(`Resolution: ${width}x${height}`);
  console.log(`Rays: ${width * height}`);
  console.log(`Warmup frames: ${WARMUP_FRAMES}`);
  console.log(`Measurement frames: ${MEASURE_FRAMES}`);
  console.log();

  // Warmup
  console.log("Warming up...");
  for (let i = 0; i < WARMUP_FRAMES; i++) {
    const t = i * 0.1;
    renderFrameBenchmark(wasm, t, width, height, camera);
  }

  // Measure
  console.log("Measuring...\n");
  const allTimings: FrameTimings[] = [];

  for (let i = 0; i < MEASURE_FRAMES; i++) {
    const t = (WARMUP_FRAMES + i) * 0.1;
    const timings = renderFrameBenchmark(wasm, t, width, height, camera);
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
  console.log(`Resolution: ${width}x${height} (${width * height} rays)`);
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
  console.log(`  composite:     ${last.compositeMs.toFixed(3)}ms`);
  console.log(`  bufferCopy:    ${last.bufferCopyMs.toFixed(3)}ms`);
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
 * Benchmark version of renderFrame - skips the framebuffer copy
 */
function renderFrameBenchmark(
  wasm: WasmRenderer,
  t: number,
  width: number,
  height: number,
  camera: Camera
): FrameTimings {
  const timings: FrameTimings = {
    sceneDataMs: 0,
    compileSceneMs: 0,
    loadSceneMs: 0,
    rayGenMs: 0,
    rayCopyMs: 0,
    marchRaysMs: 0,
    compositeMs: 0,
    bufferCopyMs: 0,
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
  const nRays = width * height;

  if (nRays > wasm.maxRays) {
    console.error(`Too many rays: ${nRays} > ${wasm.maxRays}`);
    return timings;
  }

  // Reset WASM perf metrics
  wasm.exports.reset_perf_metrics();

  // Compile scene at time t and load to WASM
  const scene = getActiveScene();
  let t0 = performance.now();
  const frame = scene.update(t);
  timings.sceneDataMs = performance.now() - t0;

  t0 = performance.now();
  const flatScene = compileScene(frame.objects, scene.groupDefs, scene.config.smoothK);
  timings.compileSceneMs = performance.now() - t0;

  t0 = performance.now();
  loadScene(wasm, flatScene);
  timings.loadSceneMs = performance.now() - t0;

  // Generate rays in WASM (apply per-frame camera override if present)
  t0 = performance.now();
  const frameCamera = new Camera({
    eye: frame.camera?.eye ?? camera.eye,
    at: frame.camera?.at ?? camera.at,
    up: frame.camera?.up ?? camera.up,
    fov: frame.camera?.fov ?? camera.fov,
  });
  setupCamera(wasm, frameCamera, width, height);
  wasm.exports.generate_rays(width, height);
  timings.rayGenMs = performance.now() - t0;
  timings.rayCopyMs = 0;

  // Compute background
  wasm.exports.compute_background(t);

  // Set lighting
  const lighting = frame.lighting ?? scene.config.lighting;
  const [dx, dy, dz] = lighting.directional.direction;
  wasm.exports.set_lighting(lighting.ambient, dx, dy, dz, lighting.directional.intensity);

  // Set point lights
  const pointLights = lighting.pointLights ?? [];
  const numPointLights = Math.min(pointLights.length, wasm.maxPointLights);
  for (let i = 0; i < numPointLights; i++) {
    const pl = pointLights[i]!;
    wasm.pointLightX[i] = pl.position[0];
    wasm.pointLightY[i] = pl.position[1];
    wasm.pointLightZ[i] = pl.position[2];
    wasm.pointLightR[i] = pl.color[0];
    wasm.pointLightG[i] = pl.color[1];
    wasm.pointLightB[i] = pl.color[2];
    wasm.pointLightIntensity[i] = pl.intensity;
    wasm.pointLightRadius[i] = pl.radius;
  }
  wasm.exports.set_point_lights(numPointLights);

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

  // Measure WASM composite (skip framebuffer copy in benchmark)
  t0 = performance.now();
  wasm.exports.composite(width, height);
  timings.compositeMs = performance.now() - t0;

  timings.bufferCopyMs = 0;
  timings.renderToBufferMs = timings.compositeMs;

  timings.totalMs = performance.now() - totalStart;
  return timings;
}

async function main(): Promise<void> {
  const args = parseArgs();

  // Load WASM module
  const wasm = await loadWasm();

  // Initialize scene
  const scene = setActiveScene(args.scene);
  const { config } = scene;

  // Benchmark mode - no renderer needed
  if (args.bench) {
    const width = args.width ?? 256;
    const height = args.height ?? 64;

    const camera = new Camera({
      eye: config.camera.eye,
      at: config.camera.at,
      up: config.camera.up,
      fov: config.camera.fov,
    });

    await runBenchmark(wasm, width, height, camera);
    return;
  }

  // Create OpenTUI renderer
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: args.fps,
    useMouse: true,
  });

  // Layout: left half = stats box, right half = raymarched scene
  const scale = args.scale;
  const sceneOutputWidth = Math.floor(renderer.width / 2);
  const sceneOutputHeight = renderer.height;
  // For block mode: render at 2x height since blocks combine 2 rows into 1
  const nativeWidth = Math.ceil(sceneOutputWidth / scale);
  const nativeHeight = args.blocks
    ? Math.ceil((sceneOutputHeight * 2) / scale)
    : Math.ceil(sceneOutputHeight / scale);

  // Check if we exceed max rays (at native resolution)
  const nRays = nativeWidth * nativeHeight;
  if (nRays > wasm.maxRays) {
    process.stderr.write(`Native resolution too large: ${nativeWidth}x${nativeHeight} = ${nRays} rays, max is ${wasm.maxRays}\n`);
    process.exit(1);
  }

  // Check if output fits (same limit as native since terminal size is the bound)
  if (scale > 1) {
    const nOutput = sceneOutputWidth * sceneOutputHeight;
    if (nOutput > wasm.maxRays) {
      process.stderr.write(`Terminal too large: ${sceneOutputWidth}x${sceneOutputHeight} = ${nOutput}, max is ${wasm.maxRays}\n`);
      process.exit(1);
    }
  }

  // Camera config from scene.ts
  const camera = new Camera({
    eye: config.camera.eye,
    at: config.camera.at,
    up: config.camera.up,
    fov: config.camera.fov,
  });

  // Create FrameBufferRenderable for right half (raymarched scene)
  const canvas = new FrameBufferRenderable(renderer, {
    id: "raymarcher",
    width: sceneOutputWidth,
    height: sceneOutputHeight,
    position: "absolute",
    left: Math.floor(renderer.width / 2),
    top: 0,
    onMouseDown: (event) => {
      const scene = getActiveScene();
      if (scene.onMouseDown) {
        // Adjust x/y to be relative to this canvas
        const localEvent = {
          ...event,
          x: event.x - Math.floor(renderer.width / 2),
          y: event.y
        };
        scene.onMouseDown(localEvent, sceneOutputWidth, sceneOutputHeight);
      }
    },
    onMouseUp: (event) => {
      const scene = getActiveScene();
      if (scene.onMouseUp) {
        // Adjust x/y to be relative to this canvas
        const localEvent = {
          ...event,
          x: event.x - Math.floor(renderer.width / 2),
          y: event.y
        };
        scene.onMouseUp(localEvent, sceneOutputWidth, sceneOutputHeight);
      }
    },
  });

  renderer.root.add(canvas);

  // Create StatsBox on left half with margin/padding
  const boxMargin = 2;
  const boxWidth = Math.floor(renderer.width / 2) - boxMargin * 2;
  const boxHeight = renderer.height - boxMargin * 2;
  const boxLeft = boxMargin;
  const boxTop = boxMargin;

  const statsBox = new StatsBox(
    renderer,
    boxWidth,
    boxHeight,
    boxLeft,
    boxTop
  );

  renderer.root.add(statsBox.container);

  // Setup input handling
  process.stdin.on('data', async (data: Buffer) => {
    const s = data.toString();
    // Map common keys
    if (s === '\u001b[D' || s === 'h') await statsBox.handleInput('ArrowLeft');
    if (s === '\u001b[C' || s === 'l') await statsBox.handleInput('ArrowRight');
    if (s === '\r' || s === '\n') await statsBox.handleInput('Enter');
    if (s === ' ') await statsBox.handleInput(' ');
  });

  // Frame timing tracking
  const frameTimes: number[] = [];
  let worstFrameTime = 0;
  let medianFrameTime = 0;
  let frameCount = 0;

  function updateStats(timings: FrameTimings): void {
    frameTimes.push(timings.totalMs);
    frameCount++;

    // Update stats every FPS frames
    if (frameCount % args.fps === 0) {
      worstFrameTime = Math.max(...frameTimes);
      const sorted = [...frameTimes].sort((a, b) => a - b);
      medianFrameTime = sorted[Math.floor(sorted.length / 2)] ?? 0;
      frameTimes.length = 0; // Clear for next batch
    }

    const scaleInfo = scale > 1 ? ` (${nativeWidth}x${nativeHeight} x${scale})` : "";

    // Only update if we are in "done" state (handled by StatsBox internally)
    statsBox.setDebugStats([
      "",
      `Resolution: ${sceneOutputWidth}x${sceneOutputHeight}${scaleInfo}`,
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
    ].join("\n"));
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

      // Update stats box animation
      statsBox.update(deltaTime);

      const timings = renderFrame(wasm, t, nativeWidth, nativeHeight, sceneOutputWidth, sceneOutputHeight, scale, canvas.frameBuffer, camera, args.blocks, deltaTime / 1000);
      t += deltaTime / 1000;

      updateStats(timings);
    });

    renderer.start();
  } else {
    // Single frame
    canvas.frameBuffer.clear(bgColor);
    const timings = renderFrame(wasm, args.time, nativeWidth, nativeHeight, sceneOutputWidth, sceneOutputHeight, scale, canvas.frameBuffer, camera, args.blocks);

    const scaleInfo = scale > 1 ? ` (${nativeWidth}x${nativeHeight} x${scale})` : "";
    statsBox.setDebugStats([
      "",
      `Resolution: ${sceneOutputWidth}x${sceneOutputHeight}${scaleInfo}`,
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
    ].join("\n"));

    await renderer.idle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    renderer.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
