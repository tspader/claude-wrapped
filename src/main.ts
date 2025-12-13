#!/usr/bin/env bun
/**
 * Terminal ray marcher CLI.
 */

import {
  Camera,
  RayMarcher,
  normalize,
  primitives,
  type Vec3,
  dot,
  sub,
  scale,
  length,
} from "./renderer";
import { config, makeScene } from "./scene";

// =============================================================================
// Render Frame
// =============================================================================

function renderFrame(
  t: number,
  width: number,
  height: number,
  outputMode: "ascii" | "unicode" | "truecolor",
  background: Vec3,
  lighting: typeof config.lighting
): string {
  const result = makeScene(t, primitives);
  const scene = result.scene;
  const overrides = result.overrides ?? {};

  const camOverride = overrides.camera ?? {};
  const camera = new Camera({
    eye: camOverride.eye ?? config.camera.eye,
    at: camOverride.at ?? config.camera.at,
    up: camOverride.up ?? config.camera.up,
    fov: camOverride.fov ?? config.camera.fov,
  });

  const marcher = new RayMarcher(config.rayMarcher);

  const lightOverride = overrides.lighting ?? {};
  const mergedLighting = { ...lighting, ...lightOverride };
  const ambient = mergedLighting.ambient ?? 0.1;
  const dirLight = mergedLighting.directional ?? lighting.directional;
  const dirDirection = normalize(dirLight.direction);
  const dirColor = dirLight.color;
  const dirIntensity = dirLight.intensity;
  const pointLights = mergedLighting.pointLights ?? [];

  // Generate rays
  const { origins, directions } = camera.generateRays(width, height);
  const nRays = origins.length;

  // Combined SDF
  function combinedSdf(p: Vec3): number {
    let minDist = Infinity;
    for (const [sdf] of scene) {
      const d = sdf.evaluate(p);
      minDist = Math.min(minDist, d);
    }
    return minDist;
  }

  // March rays
  const { hit, positions } = marcher.march(combinedSdf, origins, directions);

  // Compute colors
  const colors: Vec3[] = new Array(nRays);
  for (let i = 0; i < nRays; i++) {
    colors[i] = [0, 0, 0];
  }

  // Find hit indices
  const hitIndices: number[] = [];
  for (let i = 0; i < nRays; i++) {
    if (hit[i]) hitIndices.push(i);
  }

  if (hitIndices.length > 0) {
    const hitPositions = hitIndices.map((i) => positions[i]!);

    // Determine base color by finding closest shape
    const hitColors: Vec3[] = new Array(hitIndices.length);
    const minDists: number[] = new Array(hitIndices.length).fill(Infinity);

    for (let hi = 0; hi < hitIndices.length; hi++) {
      hitColors[hi] = [0, 0, 0];
    }

    for (const [sdf, color] of scene) {
      for (let hi = 0; hi < hitIndices.length; hi++) {
        const d = sdf.evaluate(hitPositions[hi]!);
        if (d < minDists[hi]!) {
          hitColors[hi] = [...color];
          minDists[hi] = d;
        }
      }
    }

    // Compute normals
    const normals = marcher.estimateNormals(combinedSdf, hitPositions);

    // Compute lighting
    for (let hi = 0; hi < hitIndices.length; hi++) {
      const hitColor = hitColors[hi]!;
      const normal = normals[hi]!;
      const hitPos = hitPositions[hi]!;

      // Start with ambient
      let litColor: Vec3 = [
        hitColor[0] * ambient,
        hitColor[1] * ambient,
        hitColor[2] * ambient,
      ];

      // Directional light
      if (dirIntensity > 0) {
        const nDotL = Math.max(0, dot(normal, dirDirection));
        const diffuse = nDotL * dirIntensity;
        litColor = [
          litColor[0] + hitColor[0] * diffuse * dirColor[0],
          litColor[1] + hitColor[1] * diffuse * dirColor[1],
          litColor[2] + hitColor[2] * diffuse * dirColor[2],
        ];
      }

      // Point lights
      for (const pl of pointLights) {
        const plPos = pl.position;
        const plColor = pl.color;
        const plIntensity = pl.intensity;
        const plRadius = pl.radius;

        const toLight = sub(plPos, hitPos);
        const distToLight = length(toLight);
        const lightDir = scale(toLight, 1 / (distToLight + 1e-6));

        const attenuation =
          plIntensity / (1.0 + (distToLight / plRadius) ** 2);

        const nDotL = Math.max(0, dot(normal, lightDir));
        const diffuse = nDotL * attenuation;

        litColor = [
          litColor[0] + hitColor[0] * diffuse * plColor[0],
          litColor[1] + hitColor[1] * diffuse * plColor[1],
          litColor[2] + hitColor[2] * diffuse * plColor[2],
        ];
      }

      // Clamp
      colors[hitIndices[hi]!] = [
        Math.min(1, Math.max(0, litColor[0])),
        Math.min(1, Math.max(0, litColor[1])),
        Math.min(1, Math.max(0, litColor[2])),
      ];
    }
  }

  return renderOutput(colors, width, height, outputMode, background);
}

// =============================================================================
// Output Rendering
// =============================================================================

function dither(brightness: number, row: number, col: number): number {
  const bayer2x2 = [
    [0.0, 0.5],
    [0.75, 0.25],
  ];
  const threshold = bayer2x2[row % 2]![col % 2]!;
  return brightness + (threshold - 0.5) * 0.15;
}

function renderOutput(
  colors: Vec3[],
  width: number,
  height: number,
  mode: "ascii" | "unicode" | "truecolor",
  background: Vec3
): string {
  const bgR = Math.floor(background[0] * 255);
  const bgG = Math.floor(background[1] * 255);
  const bgB = Math.floor(background[2] * 255);

  const lines: string[] = [];

  if (mode === "ascii") {
    const chars = " .:-=+*#%@";
    for (let row = 0; row < height; row++) {
      let line = "";
      for (let col = 0; col < width; col++) {
        const idx = row * width + col;
        const c = colors[idx]!;
        let brightness = (c[0] + c[1] + c[2]) / 3;
        brightness = dither(brightness, row, col);
        let charIdx = Math.floor(brightness * (chars.length - 1));
        charIdx = Math.max(0, Math.min(chars.length - 1, charIdx));

        const r = Math.floor(c[0] * 255);
        const g = Math.floor(c[1] * 255);
        const b = Math.floor(c[2] * 255);

        if (r > 10 || g > 10 || b > 10) {
          line += `\x1b[38;2;${r};${g};${b}m${chars[charIdx]}\x1b[0m`;
        } else {
          line += `\x1b[38;2;8;13;11m@\x1b[0m`;
        }
      }
      lines.push(line);
    }
  } else if (mode === "unicode") {
    const blocks = " \u2591\u2592\u2593\u2588";
    for (let row = 0; row < height; row++) {
      let line = "";
      for (let col = 0; col < width; col++) {
        const idx = row * width + col;
        const c = colors[idx]!;
        let brightness = (c[0] + c[1] + c[2]) / 3;
        brightness = dither(brightness, row, col);
        let blockIdx = Math.floor(brightness * (blocks.length - 1));
        blockIdx = Math.max(0, Math.min(blocks.length - 1, blockIdx));

        const r = Math.floor(c[0] * 255);
        const g = Math.floor(c[1] * 255);
        const b = Math.floor(c[2] * 255);

        if (r > 10 || g > 10 || b > 10) {
          line += `\x1b[38;2;${r};${g};${b}m${blocks[blockIdx]}\x1b[0m`;
        } else {
          line += blocks[blockIdx];
        }
      }
      lines.push(line);
    }
  } else {
    // truecolor
    for (let row = 0; row < height; row++) {
      let line = "";
      for (let col = 0; col < width; col++) {
        const idx = row * width + col;
        const c = colors[idx]!;

        let r: number, g: number, b: number;
        if (c[0] > 0.01 || c[1] > 0.01 || c[2] > 0.01) {
          r = Math.min(255, Math.floor(c[0] * 255));
          g = Math.min(255, Math.floor(c[1] * 255));
          b = Math.min(255, Math.floor(c[2] * 255));
        } else {
          r = bgR;
          g = bgG;
          b = bgB;
        }
        line += `\x1b[48;2;${bgR};${bgG};${bgB}m\x1b[38;2;${r};${g};${b}m\u2588\x1b[0m`;
      }
      lines.push(line);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Animation Loop
// =============================================================================

function runAnimation(
  width: number,
  height: number,
  output: "ascii" | "unicode" | "truecolor",
  fps: number
): void {
  const frameTime = 1000 / fps;
  let t = 0;

  // Hide cursor and clear screen
  process.stdout.write("\x1b[?25l\x1b[2J");

  const cleanup = () => {
    process.stdout.write("\x1b[?25h");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const renderLoop = () => {
    const start = performance.now();

    const w = width || config.render.width;
    const h = height || config.render.height;
    const outMode = output || config.render.output;
    const bg = config.render.background;
    const lighting = config.lighting;

    const frame = renderFrame(t, w, h, outMode, bg, lighting);
    const elapsed = performance.now() - start;
    const actualFps = 1000 / elapsed;
    const status = `\x1b[0m ${elapsed.toFixed(1)}ms | ${actualFps.toFixed(1)} fps | ${w}x${h}`;
    process.stdout.write(`\x1b[H${frame}\n${status}`);

    t += frameTime / 1000;

    const sleepTime = frameTime - elapsed;

    if (sleepTime > 0) {
      setTimeout(renderLoop, sleepTime);
    } else {
      setImmediate(renderLoop);
    }
  };

  renderLoop();
}

// =============================================================================
// CLI
// =============================================================================

function parseArgs(): {
  time: number;
  width: number | null;
  height: number | null;
  output: "ascii" | "unicode" | "truecolor" | null;
  animate: boolean;
  fps: number;
} {
  const args = process.argv.slice(2);
  const result = {
    time: 0,
    width: null as number | null,
    height: null as number | null,
    output: null as "ascii" | "unicode" | "truecolor" | null,
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
      case "-o":
      case "--output":
        const val = args[++i];
        if (val === "ascii" || val === "unicode" || val === "truecolor") {
          result.output = val;
        }
        break;
      case "-a":
      case "--animate":
        result.animate = true;
        break;
      case "--fps":
        result.fps = parseInt(args[++i] || "30", 10);
        break;
      case "--help":
        console.log(`Usage: bun src/main.ts [options]

Options:
  -t, --time <float>    Time value for scene (default: 0)
  -w, --width <int>     Width in characters
  -h, --height <int>    Height in characters
  -o, --output <mode>   Output mode: ascii, unicode, truecolor
  -a, --animate         Run animation loop
  --fps <int>           Frames per second (default: 30)
  --help                Show this help`);
        process.exit(0);
    }
  }

  return result;
}

function main(): void {
  const args = parseArgs();

  // Get terminal size
  const termWidth = process.stdout.columns || 80;
  const termHeight = (process.stdout.rows || 24) - 1;

  const width = args.width ?? config.render.width ?? termWidth;
  const height = args.height ?? config.render.height ?? termHeight;
  const outMode = args.output ?? config.render.output;
  const bg = config.render.background;
  const lighting = config.lighting;

  if (args.animate) {
    runAnimation(width, height, outMode, args.fps);
  } else {
    const frame = renderFrame(args.time, width, height, outMode, bg, lighting);
    console.log(frame);
  }
}

main();
