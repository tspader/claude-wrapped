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
      redBall: [180 / 255, 101 / 255, 111 / 255] as Vec3,
    },

    redBall: {
      radiusRatio: 1 / 8,
      z: -1,
      noiseScale: 0.3,
      slingshot: {
        cycleDuration: 8.0,
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

///////////
// TOOLS //
///////////
// Seeded random number generator
function seededRandom(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

// Simplex noise
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


// =============================================================================
// Scene State (persistent across frames)
// =============================================================================

interface SceneState {
  basePositions: Vec3[];
  baseSizes: number[];
  phaseOffsets: number[];
  freqMultipliers: number[];
  noiseOffsets: Vec3[];
  redBallNoiseOffset: Vec3;
  redBallRadius: number;
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
    redBallNoiseOffset: [rng() * 1000, rng() * 1000, rng() * 1000],
    redBallRadius: sphereRadius * cfg.redBall.radiusRatio,
    rng,
  };
}

const sceneState = initSceneState(config.scene);


// Compute red ball position based on slingshot animation
export function getRedBallPosition(t: number): Vec3 {
  const { slingshot, z } = config.scene.redBall;
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
// Scene Definition
// =============================================================================

export interface SceneResult {
  scene: Array<[SDF, Vec3]>;
  /** Optional SDF for ray marching (e.g. smooth union). If not provided, renderer uses min() of scene SDFs. */
  marchingSdf?: SDF;
  /** Optional blend factor for color transitions between shapes. If provided, colors blend in transition zones using smooth union math. */
  colorBlendK?: number;
  overrides?: {
    camera?: Partial<typeof config.camera>;
    lighting?: Partial<typeof config.lighting>;
  };
}

export function makeScene(
  t: number,
  prims: typeof primitives
): SceneResult {
  const { sphere, smoothUnion } = prims;
  const { animation, colors, smoothK, colorBlendK, redBall: redBallCfg } = config.scene;
  const { driftSpeed, driftScale, sizeOscSpeed, sizeOscAmount, noiseSizeAmount } = animation;
  const {
    basePositions,
    baseSizes,
    phaseOffsets,
    freqMultipliers,
    noiseOffsets,
    redBallNoiseOffset,
    redBallRadius,
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

  let combined = shapes[0]!;
  for (let i = 1; i < shapes.length; i++) {
    combined = smoothUnion(combined, shapes[i]!, smoothK);
  }

  // Red ball with slingshot animation + noise sway
  const redBallBasePos = getRedBallPosition(t);
  const [rbx, rby, rbz] = redBallBasePos;
  const [rnx, rny, rnz] = redBallNoiseOffset;

  const noiseScale = redBallCfg.noiseScale;
  const rbDx = pnoise1(rnx + t * driftSpeed, 2) * driftScale * noiseScale;
  const rbDy = pnoise1(rny + t * driftSpeed, 2) * driftScale * noiseScale * 0.67;
  const rbDz = pnoise1(rnz + t * driftSpeed, 2) * driftScale * noiseScale;

  const redBallPos: Vec3 = [rbx + rbDx, rby + rbDy, rbz + rbDz];
  const redBallSize = Math.max(0.1, redBallRadius);
  const redBall = sphere(redBallSize).translate(redBallPos);

  // Keep green blob separate for color lookup, merge everything for marching
  const greenBlob = combined;
  const fullMerged = smoothUnion(greenBlob, redBall, smoothK);

  return {
    scene: [
      [greenBlob, colors.blob],
      [redBall, colors.redBall],
    ],
    marchingSdf: fullMerged,
    colorBlendK,
    overrides: { camera: { fov: 45 } },
  };
}


