#!/usr/bin/env bun
/**
 * WASM-based terminal ray marcher using OpenTUI for rendering.
 * Separate entry point from main.ts - uses SIMD WASM for raymarching.
 */

import {
  createCliRenderer,
  FrameBufferRenderable,
  RGBA,
} from "@opentui/core";
import { Camera, type Vec3 } from "./renderer";
import type { OptimizedBuffer } from "@opentui/core";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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
  // Functions
  get_max_rays: () => number;
  get_max_shapes: () => number;
  set_ray_count: (count: number) => void;
  set_scene: (count: number, smoothK: number) => void;
  compute_background: (time: number) => void;
  march_rays: () => void;
}

interface WasmRenderer {
  exports: WasmExports;
  maxRays: number;
  maxShapes: number;
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

  return {
    exports,
    maxRays,
    maxShapes,
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
  };
}

// =============================================================================
// Shape Types (must match C enum)
// =============================================================================

const ShapeType = {
  SPHERE: 0,
  BOX: 1,
} as const;

// =============================================================================
// Test Scene: 3 spheres with different colors
// =============================================================================

function setTestScene(wasm: WasmRenderer): void {
  // 3 spheres: red left, green center, blue right
  const shapes: Array<{
    type: number;
    params: [number, number, number, number];
    pos: Vec3;
    color: Vec3;
  }> = [
    { type: ShapeType.SPHERE, params: [1.0, 0, 0, 0], pos: [-2.5, 0, 0], color: [0.8, 0.2, 0.2] },
    { type: ShapeType.SPHERE, params: [1.2, 0, 0, 0], pos: [0, 0, 0], color: [0.2, 0.8, 0.3] },
    { type: ShapeType.SPHERE, params: [1.0, 0, 0, 0], pos: [2.5, 0, 0], color: [0.2, 0.3, 0.8] },
  ];

  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i]!;
    wasm.shapeTypes[i] = s.type;
    // Params: 4 floats per shape
    wasm.shapeParams[i * 4] = s.params[0];
    wasm.shapeParams[i * 4 + 1] = s.params[1];
    wasm.shapeParams[i * 4 + 2] = s.params[2];
    wasm.shapeParams[i * 4 + 3] = s.params[3];
    // Position
    wasm.shapePositions[i * 3] = s.pos[0];
    wasm.shapePositions[i * 3 + 1] = s.pos[1];
    wasm.shapePositions[i * 3 + 2] = s.pos[2];
    // Color
    wasm.shapeColors[i * 3] = s.color[0];
    wasm.shapeColors[i * 3 + 1] = s.color[1];
    wasm.shapeColors[i * 3 + 2] = s.color[2];
  }

  wasm.exports.set_scene(shapes.length, 0.8); // count, smoothK
}

// =============================================================================
// Render Frame using WASM
// =============================================================================

function renderFrame(
  wasm: WasmRenderer,
  t: number,
  width: number,
  height: number,
  frameBuffer: OptimizedBuffer,
  camera: Camera
): void {
  const nRays = width * height;

  if (nRays > wasm.maxRays) {
    console.error(`Too many rays: ${nRays} > ${wasm.maxRays}`);
    return;
  }

  // Generate rays using JS Camera
  const { origins, directions } = camera.generateRays(width, height);

  // Copy rays to WASM buffers
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

  // Set ray count and compute background
  wasm.exports.set_ray_count(nRays);
  wasm.exports.compute_background(t);

  // Do the raymarching in WASM
  wasm.exports.march_rays();

  // Read results and render to buffer
  const bg: Vec3 = [wasm.bgColor[0]!, wasm.bgColor[1]!, wasm.bgColor[2]!];
  renderToBuffer(wasm, width, height, frameBuffer, bg);
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

function renderToBuffer(
  wasm: WasmRenderer,
  width: number,
  height: number,
  frameBuffer: OptimizedBuffer,
  background: Vec3
): void {
  const chars = " .:-=+*#%@";
  const bgColor = RGBA.fromValues(background[0], background[1], background[2], 1);

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col;
      const r = wasm.outR[idx]!;
      const g = wasm.outG[idx]!;
      const b = wasm.outB[idx]!;

      let brightness = (r + g + b) / 3;
      brightness = dither(brightness, row, col);
      let charIdx = Math.floor(brightness * (chars.length - 1));
      charIdx = Math.max(0, Math.min(chars.length - 1, charIdx));

      // Check if pixel has color (not background)
      if (r > 0.04 || g > 0.04 || b > 0.04) {
        const fg = RGBA.fromValues(r, g, b, 1);
        frameBuffer.setCell(col, row, chars[charIdx]!, fg, bgColor, 0);
      } else {
        // Dark background character
        const darkFg = RGBA.fromValues(0.03, 0.05, 0.04, 1);
        frameBuffer.setCell(col, row, "@", darkFg, bgColor, 0);
      }
    }
  }
}

// =============================================================================
// CLI
// =============================================================================

function parseArgs(): {
  time: number;
  width: number | null;
  height: number | null;
  animate: boolean;
  fps: number;
} {
  const args = process.argv.slice(2);
  const result = {
    time: 0,
    width: null as number | null,
    height: null as number | null,
    animate: false,
    fps: 30,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "-t":
      case "--time":
        result.time = parseFloat(args[++i] || "0");
        break;
      case "-w":
      case "--width":
        result.width = parseInt(args[++i] || "80", 10);
        break;
      case "-h":
      case "--height":
        result.height = parseInt(args[++i] || "40", 10);
        break;
      case "-a":
      case "--animate":
        result.animate = true;
        break;
      case "--fps":
        result.fps = parseInt(args[++i] || "30", 10);
        break;
      case "--help":
        console.log(`Usage: bun src/main-wasm.ts [options]

WASM-based raymarcher (dynamic scene test)

Options:
  -t, --time <float>    Time value for scene (default: 0)
  -w, --width <int>     Width in characters
  -h, --height <int>    Height in characters
  -a, --animate         Run animation loop
  --fps <int>           Frames per second (default: 30)
  --help                Show this help`);
        process.exit(0);
    }
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs();

  // Load WASM module
  const wasm = await loadWasm();

  // Create OpenTUI renderer
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: args.fps,
  });

  // Use terminal dimensions or args
  const width = args.width ?? renderer.width;
  const height = args.height ?? renderer.height;

  // Check if we exceed max rays
  const nRays = width * height;
  if (nRays > wasm.maxRays) {
    process.stderr.write(`Terminal too large: ${width}x${height} = ${nRays} rays, max is ${wasm.maxRays}\n`);
    process.stderr.write(`Use -w and -h to specify smaller dimensions\n`);
    process.exit(1);
  }

  // Set up test scene (3 colored spheres)
  setTestScene(wasm);

  // Camera config
  const camera = new Camera({
    eye: [0, 0, -8],
    at: [0, 0, 0],
    up: [0, 1, 0],
    fov: 50,
  });

  // Create FrameBufferRenderable
  const canvas = new FrameBufferRenderable(renderer, {
    id: "raymarcher",
    width,
    height,
    position: "absolute",
    left: 0,
    top: 0,
  });

  renderer.root.add(canvas);

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
      renderFrame(wasm, t, width, height, canvas.frameBuffer, camera);
      t += deltaTime / 1000;
    });

    renderer.start();
  } else {
    // Single frame
    canvas.frameBuffer.clear(bgColor);
    renderFrame(wasm, args.time, width, height, canvas.frameBuffer, camera);

    await renderer.idle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    renderer.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
