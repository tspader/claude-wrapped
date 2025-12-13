/**
 * Scene configuration - edit this to change the render.
 */

import { createNoise2D } from "simplex-noise";
import type { SDF, Vec3 } from "./renderer";
import { primitives } from "./renderer";

// =============================================================================
// Config
// =============================================================================

export const config = {
  rayMarcher: {
    maxSteps: 32,
    maxDist: 100.0,
    hitThreshold: 0.01,
    normalEps: 0.001,
  },
  camera: {
    eye: [0.0, 2.0, -8.0] as Vec3,
    at: [0.0, 0.0, 0.0] as Vec3,
    up: [0.0, 1.0, 0.0] as Vec3,
    fov: 50,
  },
  render: {
    width: process.stdout.columns,
    height: process.stdout.rows,
    output: "ascii" as "ascii" | "unicode" | "truecolor",
    background: [0.0, 0.0, 0.0] as Vec3,
  },
  lighting: {
    ambient: 0.1,
    directional: {
      direction: [1.0, 1.0, -1.0] as Vec3,
      color: [1.0, 1.0, 1.0] as Vec3,
      intensity: 1.0,
    },
    pointLights: [
      {
        position: [3, 3, -3] as Vec3,
        color: [1, 0.8, 0.6] as Vec3,
        intensity: 1.0,
        radius: 8.0,
      },
    ],
  },
  scene: {
    seed: 42,
    smoothK: 2.0,
    colorBlendK: 0.5,

    columns: {
      x: 8.0,
      spacingY: 3.5,
      spheresPerColumn: 4,
      sphereRadius: 1.8,
    },

    animation: {
      driftSpeed: 0.125,
      driftScale: 1.0,
      sizeOscSpeed: 0.8,
      sizeOscAmount: 0.15,
      noiseSizeAmount: 0.1,
    },

    colors: {
      blob: [0.388, 0.627, 0.533] as Vec3,
    },

    claude: {
      z: -1,
      noiseScale: 0.3,
      slingshot: {
        cycleDuration: 6.0,
        windupRatio: 0.25,
        restY: 0,
        launchOffsetX: 2.0,
        launchOffsetY: -1.0,
        peakY: 1.0,
      },
    },
  },
};

export type Config = typeof config;

// =============================================================================
// Scene State (persistent across frames)
// =============================================================================

function seededRandom(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

interface SceneState {
  basePositions: Vec3[];
  baseSizes: number[];
  phaseOffsets: number[];
  freqMultipliers: number[];
  noiseOffsets: Vec3[];
  claudeNoiseOffset: Vec3;
  rng: () => number;
}

function initSceneState(cfg: typeof config.scene): SceneState {
  const rng = seededRandom(cfg.seed);
  const { x: columnX, spacingY, spheresPerColumn, sphereRadius } = cfg.columns;

  const basePositions: Vec3[] = [];
  const baseSizes: number[] = [];
  const phaseOffsets: number[] = [];
  const freqMultipliers: number[] = [];
  const noiseOffsets: Vec3[] = [];

  const columnYStart = -((spheresPerColumn - 1) / 2) * spacingY;

  // Generate both columns (left at -X, right at +X)
  for (const sign of [-1, 1]) {
    for (let i = 0; i < spheresPerColumn; i++) {
      basePositions.push([sign * columnX, columnYStart + i * spacingY, 0]);
      baseSizes.push(sphereRadius);
      phaseOffsets.push(rng() * 2 * Math.PI);
      freqMultipliers.push(rng() * 0.5 + 0.75);
      noiseOffsets.push([rng() * 1000, rng() * 1000, rng() * 1000]);
    }
  }

  return {
    basePositions,
    baseSizes,
    phaseOffsets,
    freqMultipliers,
    noiseOffsets,
    claudeNoiseOffset: [rng() * 1000, rng() * 1000, rng() * 1000],
    rng,
  };
}

const sceneState = initSceneState(config.scene);

// Simplex noise (must be after sceneState init)
const noise2D = createNoise2D(() => sceneState.rng());

function pnoise1(x: number, octaves: number = 1): number {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    value += noise2D(x * frequency, 0) * amplitude;
    maxValue += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }

  return value / maxValue;
}

// Easing functions
function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}


// Compute Claude position based on slingshot animation
export function getClaudePosition(t: number): Vec3 {
  const { slingshot, z } = config.scene.claude;
  const { cycleDuration, windupRatio, restY, launchOffsetX, launchOffsetY, peakY } = slingshot;
  const columnX = config.scene.columns.x;

  const cycleTime = t % cycleDuration;
  const windupDuration = cycleDuration * windupRatio;
  const flightDuration = cycleDuration * (1 - windupRatio);

  // Determine which side we're on (alternates each cycle)
  const cycleIndex = Math.floor(t / cycleDuration);
  const startX = cycleIndex % 2 === 0 ? columnX : -columnX;
  const targetX = -startX;

  // Launch position: pulled back towards edge and down
  const launchX = startX + (startX > 0 ? launchOffsetX : -launchOffsetX);
  const launchY = restY + launchOffsetY;

  if (cycleTime < windupDuration) {
    // Windup phase: ease from rest to launch position
    const windupT = easeInOutQuad(cycleTime / windupDuration);
    return [
      startX + (launchX - startX) * windupT,
      restY + (launchY - restY) * windupT,
      z,
    ];
  } else {
    // Flight phase
    const flightTime = cycleTime - windupDuration;
    const flightT = flightTime / flightDuration;

    // X: easeOut from launch to target
    const easedT = easeOutQuad(flightT);
    const x = launchX + (targetX - launchX) * easedT;

    // Y: parabola synced with X movement
    const peakOffset = peakY - launchY;
    const parabola = 4 * easedT * (1 - easedT);
    const y = launchY + peakOffset * parabola + (restY - launchY) * easedT;

    return [x, y, z];
  }
}

// =============================================================================
// Claude Model
// =============================================================================

// Claude logo colors (orange from the web image)
const CLAUDE_COLOR: Vec3 = [0.85, 0.45, 0.35];

/**
 * Creates a Claude logo SDF at origin, facing -Z (towards camera).
 * Scale parameter controls overall size (1.0 = ~1 unit tall).
 *
 * Based on the pixel art logo:
 * - Wide rectangular body
 * - Small stubby arms on sides
 * - 4 legs (2 pairs, close together on each side)
 */
function makeClaudeSdf(prims: typeof primitives, scale: number = 1): SDF {
  const { box, smoothUnion } = prims;
  const k = 0.06 * scale; // smooth union factor for rounded look

  // Body: wide and squat (roughly 2:1 width:height)
  const bodyW = 0.7 * scale;
  const bodyH = 0.28 * scale;
  const bodyD = 0.25 * scale;

  // Arms: short stubby protrusions
  const armW = 0.2 * scale;
  const armH = 0.15 * scale;
  const armD = 0.18 * scale;
  const armY = 0.0; // centered vertically on body
  const armX = bodyW / 2 + armW / 2 - 0.03 * scale;

  // Legs: positioned at outer edges of body
  const legW = 0.07 * scale;
  const legH = 0.22 * scale;
  const legD = 0.12 * scale;
  const legY = -bodyH / 2 - legH / 2 + 0.04 * scale;
  const legSpacing = 0.14 * scale; // gap between legs in a pair
  const legX = bodyW / 2 - 0.12 * scale; // align with body edges

  // Build the model
  const body = box([bodyW, bodyH, bodyD]);

  // Arms
  const armL = box([armW, armH, armD]).translate([-armX, armY, 0]);
  const armR = box([armW, armH, armD]).translate([armX, armY, 0]);

  // Legs (2 on left, 2 on right)
  const legLL = box([legW, legH, legD]).translate([-legX - legSpacing / 2, legY, 0]);
  const legLR = box([legW, legH, legD]).translate([-legX + legSpacing / 2, legY, 0]);
  const legRL = box([legW, legH, legD]).translate([legX - legSpacing / 2, legY, 0]);
  const legRR = box([legW, legH, legD]).translate([legX + legSpacing / 2, legY, 0]);

  // Combine with smooth union for organic feel
  let claude: SDF = body;
  claude = smoothUnion(claude, armL, k);
  claude = smoothUnion(claude, armR, k);
  claude = smoothUnion(claude, legLL, k);
  claude = smoothUnion(claude, legLR, k);
  claude = smoothUnion(claude, legRL, k);
  claude = smoothUnion(claude, legRR, k);

  return claude;
}

// =============================================================================
// Scene Definition
// =============================================================================

export interface SceneResult {
  scene: Array<[SDF, Vec3]>;
  overrides?: {
    camera?: Partial<typeof config.camera>;
    lighting?: Partial<typeof config.lighting>;
  };
}

export function makeScene(
  t: number,
  prims: typeof primitives
): SceneResult {
  const { sphere } = prims;
  const { animation, colors, claude: claudeCfg } = config.scene;
  const { driftSpeed, driftScale, sizeOscSpeed, sizeOscAmount, noiseSizeAmount } = animation;
  const {
    basePositions,
    baseSizes,
    phaseOffsets,
    freqMultipliers,
    noiseOffsets,
    claudeNoiseOffset,
  } = sceneState;

  const shapes: SDF[] = [];

  for (let i = 0; i < basePositions.length; i++) {
    const [bx, by, bz] = basePositions[i]!;
    const [nx, ny, nz] = noiseOffsets[i]!;

    const dx = pnoise1(nx + t * driftSpeed, 2) * driftScale;
    const dy = pnoise1(ny + t * driftSpeed, 2) * driftScale * 0.5;
    const dz = pnoise1(nz + t * driftSpeed, 2) * driftScale;

    const pos: Vec3 = [bx + dx, by + dy, bz + dz];

    const phase = phaseOffsets[i]!;
    const freq = freqMultipliers[i]!;
    const osc = Math.sin(t * sizeOscSpeed * freq + phase) * sizeOscAmount;
    const noiseSize = pnoise1(nx + t * 0.5, 1) * noiseSizeAmount;
    const size = Math.max(0.1, baseSizes[i]! + osc + noiseSize);

    shapes.push(sphere(size).translate(pos));
  }

  // Claude with slingshot animation + noise sway
  const claudeBasePos = getClaudePosition(t);
  const [cx, cy, cz] = claudeBasePos;
  const [cnx, cny, cnz] = claudeNoiseOffset;

  const noiseScale = claudeCfg.noiseScale;
  const cDx = pnoise1(cnx + t * driftSpeed, 2) * driftScale * noiseScale;
  const cDy = pnoise1(cny + t * driftSpeed, 2) * driftScale * noiseScale * 0.67;
  const cDz = pnoise1(cnz + t * driftSpeed, 2) * driftScale * noiseScale;

  const claudePos: Vec3 = [cx + cDx, cy + cDy, cz + cDz];
  const claudeScale = 2.0; // Scale to fit nicely in the scene
  const claude = makeClaudeSdf(prims, claudeScale).translate(claudePos);

  return {
    scene: [
      ...shapes.map((s): [SDF, Vec3] => [s, colors.blob]),
      [claude, CLAUDE_COLOR],
    ],
    overrides: { camera: { fov: 45 } },
  };
}


