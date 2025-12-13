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
};

export type Config = typeof config;

// =============================================================================
// Scene State (persistent across frames)
// =============================================================================

const SEED = 42;
const NUM_OBJECTS = 3;
const SMOOTH_K = 8.0;

// Seeded random number generator
function seededRandom(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const rng = seededRandom(SEED);

const basePositions: Vec3[] = [];
const baseSizes: number[] = [];
const phaseOffsets: number[] = [];
const freqMultipliers: number[] = [];
const noiseOffsets: Vec3[] = [];

for (let i = 0; i < NUM_OBJECTS; i++) {
  basePositions.push([
    rng() * 4 - 2,
    rng() * 4 - 2,
    rng() * 4 - 2,
  ]);
  baseSizes.push(rng() + 1);
  phaseOffsets.push(rng() * 2 * Math.PI);
  freqMultipliers.push(rng() + 0.5);
  noiseOffsets.push([rng() * 1000, rng() * 1000, rng() * 1000]);
}

// Simplex noise
const noise2D = createNoise2D(() => rng());

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
  const { sphere, smoothUnion } = prims;

  const driftSpeed = 0.125;
  const driftScale = 1.0;
  const sizeOscSpeed = 0.8;
  const sizeOscAmount = 0.15;
  const noiseSizeAmount = 0.1;

  const shapes: SDF[] = [];

  for (let i = 0; i < NUM_OBJECTS; i++) {
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
    combined = smoothUnion(combined, shapes[i]!, SMOOTH_K);
  }

  const color: Vec3 = [0.388, 0.627, 0.533];

  return {
    scene: [[combined, color]],
    overrides: { camera: { fov: 50 } },
  };
}

/**
 * Batched scene: returns sphere positions/radii and a batch SDF evaluator.
 * The batch evaluator processes all points at once using typed arrays.
 */
export interface BatchedScene {
  color: Vec3;
  /** Evaluate SDF for all points, writes min distance to out */
  sdfBatch: (px: Float64Array, py: Float64Array, pz: Float64Array, out: Float64Array) => void;
}

export function makeSceneBatched(t: number): BatchedScene {
  const driftSpeed = 0.5;
  const driftScale = 10.0;
  const sizeOscSpeed = 0.8;
  const sizeOscAmount = 0.15;
  const noiseSizeAmount = 0.1;

  // Compute sphere centers and radii for this frame
  const centers: Vec3[] = [];
  const radii: number[] = [];

  for (let i = 0; i < NUM_OBJECTS; i++) {
    const [bx, by, bz] = basePositions[i]!;
    const [nx, ny, nz] = noiseOffsets[i]!;

    const dx = pnoise1(nx + t * driftSpeed, 2) * driftScale;
    const dy = pnoise1(ny + t * driftSpeed, 2) * driftScale * 0.5;
    const dz = pnoise1(nz + t * driftSpeed, 2) * driftScale;

    centers.push([bx + dx, by + dy, bz + dz]);

    const phase = phaseOffsets[i]!;
    const freq = freqMultipliers[i]!;
    const osc = Math.sin(t * sizeOscSpeed * freq + phase) * sizeOscAmount;
    const noiseSize = pnoise1(nx + t * 0.5, 1) * noiseSizeAmount;
    radii.push(Math.max(0.1, baseSizes[i]! + osc + noiseSize));
  }

  // Flatten for faster access
  const cx = new Float64Array(NUM_OBJECTS);
  const cy = new Float64Array(NUM_OBJECTS);
  const cz = new Float64Array(NUM_OBJECTS);
  const r = new Float64Array(NUM_OBJECTS);

  for (let i = 0; i < NUM_OBJECTS; i++) {
    cx[i] = centers[i]![0];
    cy[i] = centers[i]![1];
    cz[i] = centers[i]![2];
    r[i] = radii[i]!;
  }

  const k = SMOOTH_K;

  // Batch SDF: smooth union of all spheres
  function sdfBatch(
    px: Float64Array,
    py: Float64Array,
    pz: Float64Array,
    out: Float64Array
  ): void {
    const n = px.length;

    // First sphere - initialize out with its distances
    {
      const sx = cx[0]!, sy = cy[0]!, sz = cz[0]!, sr = r[0]!;
      for (let i = 0; i < n; i++) {
        const dx = px[i]! - sx;
        const dy = py[i]! - sy;
        const dz = pz[i]! - sz;
        out[i] = Math.sqrt(dx * dx + dy * dy + dz * dz) - sr;
      }
    }

    // Remaining spheres - smooth union with accumulated result
    for (let s = 1; s < NUM_OBJECTS; s++) {
      const sx = cx[s]!, sy = cy[s]!, sz = cz[s]!, sr = r[s]!;

      for (let i = 0; i < n; i++) {
        const dx = px[i]! - sx;
        const dy = py[i]! - sy;
        const dz = pz[i]! - sz;
        const d2 = Math.sqrt(dx * dx + dy * dy + dz * dz) - sr;

        // Smooth union: d1 is out[i], d2 is new sphere
        const d1 = out[i]!;
        const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (d2 - d1) / k));
        out[i] = d2 + (d1 - d2) * h - k * h * (1 - h);
      }
    }
  }

  return {
    color: [0.9, 0.9, 0.9],
    sdfBatch,
  };
}
