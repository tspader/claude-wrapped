/**
 * Scene configuration - edit this to change the render.
 */

import { createNoise2D } from "simplex-noise";
import type { Vec3 } from "./camera";

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
// WASM Scene Data Types
// =============================================================================

export const ShapeType = {
  SPHERE: 0,
  BOX: 1,
} as const;

// Blend mode for shapes within a group
export const BlendMode = {
  HARD: 0,    // min() - distinct shapes
  SMOOTH: 1, // smooth union - blobby
} as const;

export interface ShapeDef {
  type: number;           // ShapeType
  params: number[];       // [radius] for sphere, [w,h,d] for box
  color: Vec3;
}

export interface ObjectDef {
  shape: ShapeDef;
  position: Vec3;
  group: number;          // group ID for hierarchical blending
}

export interface GroupDef {
  blendMode: number;      // BlendMode - how shapes blend within this group
}

export interface FlatScene {
  types: Uint8Array;
  params: Float32Array;   // 4 floats per shape (padded)
  positions: Float32Array; // 3 floats per shape
  colors: Float32Array;    // 3 floats per shape
  groups: Uint8Array;      // group ID per shape
  groupBlendModes: Uint8Array; // blend mode per group
  count: number;
  groupCount: number;
  smoothK: number;
}

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
 * Returns Claude logo as 7 box ObjectDefs (body, 2 arms, 4 legs).
 * Position is the center of the model.
 */
function getClaudeBoxes(position: Vec3, scale: number = 1, group: number = 0): ObjectDef[] {
  const [px, py, pz] = position;

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

  return [
    // Body
    {
      shape: { type: ShapeType.BOX, params: [bodyW, bodyH, bodyD], color: CLAUDE_COLOR },
      position: [px, py, pz],
      group,
    },
    // Left arm
    {
      shape: { type: ShapeType.BOX, params: [armW, armH, armD], color: CLAUDE_COLOR },
      position: [px - armX, py + armY, pz],
      group,
    },
    // Right arm
    {
      shape: { type: ShapeType.BOX, params: [armW, armH, armD], color: CLAUDE_COLOR },
      position: [px + armX, py + armY, pz],
      group,
    },
    // Left-left leg
    {
      shape: { type: ShapeType.BOX, params: [legW, legH, legD], color: CLAUDE_COLOR },
      position: [px - legX - legSpacing / 2, py + legY, pz],
      group,
    },
    // Left-right leg
    {
      shape: { type: ShapeType.BOX, params: [legW, legH, legD], color: CLAUDE_COLOR },
      position: [px - legX + legSpacing / 2, py + legY, pz],
      group,
    },
    // Right-left leg
    {
      shape: { type: ShapeType.BOX, params: [legW, legH, legD], color: CLAUDE_COLOR },
      position: [px + legX - legSpacing / 2, py + legY, pz],
      group,
    },
    // Right-right leg
    {
      shape: { type: ShapeType.BOX, params: [legW, legH, legD], color: CLAUDE_COLOR },
      position: [px + legX + legSpacing / 2, py + legY, pz],
      group,
    },
  ];
}

// =============================================================================
// WASM Scene Data (flat arrays for C)
// =============================================================================

// Group IDs for scene objects
export const SceneGroups = {
  BLOBS: 0,   // blob columns - smooth union internally
  CLAUDE: 1,  // claude boxes - hard union internally
} as const;

// Group definitions (blend mode per group)
export const sceneGroupDefs: GroupDef[] = [
  { blendMode: BlendMode.SMOOTH }, // BLOBS - smooth union for blobby look
  { blendMode: BlendMode.HARD },   // CLAUDE - hard union for distinct limbs
];

/**
 * Returns scene as ObjectDef[] - plain data, no SDF functions.
 * Mirrors makeScene() logic but outputs data instead of closures.
 */
export function makeSceneData(t: number): ObjectDef[] {
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

  const objects: ObjectDef[] = [];

  // Blob spheres (group 0 - smooth union)
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
    const radius = Math.max(0.1, baseSizes[i]! + osc + noiseSize);

    objects.push({
      shape: { type: ShapeType.SPHERE, params: [radius], color: colors.blob },
      position: pos,
      group: SceneGroups.BLOBS,
    });
  }

  // Claude (7 boxes) - group 1 - hard union for distinct limbs
  const claudeBasePos = getClaudePosition(t);
  const [cx, cy, cz] = claudeBasePos;
  const [cnx, cny, cnz] = claudeNoiseOffset;

  const noiseScale = claudeCfg.noiseScale;
  const cDx = pnoise1(cnx + t * driftSpeed, 2) * driftScale * noiseScale;
  const cDy = pnoise1(cny + t * driftSpeed, 2) * driftScale * noiseScale * 0.67;
  const cDz = pnoise1(cnz + t * driftSpeed, 2) * driftScale * noiseScale;

  const claudePos: Vec3 = [cx + cDx, cy + cDy, cz + cDz];
  const claudeScale = 2.0;
  objects.push(...getClaudeBoxes(claudePos, claudeScale, SceneGroups.CLAUDE));

  return objects;
}

/**
 * Compiles ObjectDef[] to flat typed arrays for WASM.
 */
export function compileScene(
  objects: ObjectDef[],
  groupDefs: GroupDef[],
  smoothK: number
): FlatScene {
  const n = objects.length;
  const types = new Uint8Array(n);
  const params = new Float32Array(n * 4);  // 4 floats per shape (padded)
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const groups = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const obj = objects[i]!;

    types[i] = obj.shape.type;
    groups[i] = obj.group;

    // Copy params (up to 4, rest stays 0)
    for (let j = 0; j < obj.shape.params.length && j < 4; j++) {
      params[i * 4 + j] = obj.shape.params[j]!;
    }

    positions[i * 3] = obj.position[0];
    positions[i * 3 + 1] = obj.position[1];
    positions[i * 3 + 2] = obj.position[2];

    colors[i * 3] = obj.shape.color[0];
    colors[i * 3 + 1] = obj.shape.color[1];
    colors[i * 3 + 2] = obj.shape.color[2];
  }

  // Build group blend modes array
  const groupBlendModes = new Uint8Array(groupDefs.length);
  for (let g = 0; g < groupDefs.length; g++) {
    groupBlendModes[g] = groupDefs[g]!.blendMode;
  }

  return {
    types,
    params,
    positions,
    colors,
    groups,
    groupBlendModes,
    count: n,
    groupCount: groupDefs.length,
    smoothK,
  };
}
