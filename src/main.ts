#!/usr/bin/env bun
/**
 * Terminal ray marcher CLI using OpenTUI for rendering.
 */

import {
  createCliRenderer,
  FrameBufferRenderable,
  BoxRenderable,
  TextRenderable,
  RGBA,
} from "@opentui/core";
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
import type { OptimizedBuffer } from "@opentui/core";

// =============================================================================
// Render Frame
// =============================================================================

function renderFrame(
  t: number,
  width: number,
  height: number,
  frameBuffer: OptimizedBuffer,
  background: Vec3,
  lighting: typeof config.lighting
): void {
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

  renderToBuffer(colors, width, height, frameBuffer, background);
}

// =============================================================================
// Output Rendering (ASCII mode only)
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
  colors: Vec3[],
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
      const c = colors[idx]!;

      let brightness = (c[0] + c[1] + c[2]) / 3;
      brightness = dither(brightness, row, col);
      let charIdx = Math.floor(brightness * (chars.length - 1));
      charIdx = Math.max(0, Math.min(chars.length - 1, charIdx));

      const r = c[0];
      const g = c[1];
      const b = c[2];

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
        console.log(`Usage: bun src/main.ts [options]

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

  // Create OpenTUI renderer
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: args.fps,
  });

  // Use terminal dimensions (renderer.width/height are set from stdout.columns/rows)
  const width = args.width ?? renderer.width;
  const height = args.height ?? renderer.height;
  const bg = config.render.background;
  const lighting = config.lighting;

  // Create FrameBufferRenderable for raymarched content
  const canvas = new FrameBufferRenderable(renderer, {
    id: "raymarcher",
    width,
    height,
    position: "absolute",
    left: 0,
    top: 0,
  });

  renderer.root.add(canvas);

  // Create centered box with title
  const boxWidth = 20;
  const boxHeight = 5;
  const boxLeft = Math.floor((width - boxWidth) / 2);
  const boxTop = Math.floor((height - boxHeight) / 2);

  const titleBox = new BoxRenderable(renderer, {
    id: "title-box",
    width: boxWidth,
    height: boxHeight,
    position: "absolute",
    left: boxLeft,
    top: boxTop,
    border: true,
    borderStyle: "double",
    borderColor: "#FFFFFF",
    backgroundColor: RGBA.fromValues(0, 0, 0, 0.7),
  });

  const titleText = new TextRenderable(renderer, {
    id: "title-text",
    content: "SP",
    fg: "#FFFFFF",
  });

  titleBox.justifyContent = "center";
  titleBox.alignItems = "center";
  titleBox.add(titleText);
  renderer.root.add(titleBox);

  // Set background color
  const bgColor = RGBA.fromValues(bg[0], bg[1], bg[2], 1);
  renderer.setBackgroundColor(bgColor);

  if (args.animate) {
    // Animation loop
    let t = 0;

    renderer.setFrameCallback(async (deltaTime) => {
      canvas.frameBuffer.clear(bgColor);
      renderFrame(t, width, height, canvas.frameBuffer, bg, lighting);
      t += deltaTime / 1000;
    });

    renderer.start();
  } else {
    // Single frame
    canvas.frameBuffer.clear(bgColor);
    renderFrame(args.time, width, height, canvas.frameBuffer, bg, lighting);
    
    // Wait for render to complete then exit
    await renderer.idle();
    
    // Small delay to ensure output is flushed
    await new Promise((resolve) => setTimeout(resolve, 100));
    renderer.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
