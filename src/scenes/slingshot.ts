/**
 * Slingshot scene - Claude bouncing between blob columns.
 */

import {
  type Scene,
  type SceneConfig,
  type GroupDef,
  type ObjectDef,
  type Vec3,
  ShapeType,
  BlendMode,
  registerScene,
  getClaudeBoxes,
} from "../scene";
import { seededRandom, createNoiseGenerator, easeInOutQuad, easeOutQuad } from "../scene/utils";

// =============================================================================
// Config
// =============================================================================

const config: SceneConfig = {
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
    fov: 40,
  },
  render: {
    width: process.stdout.columns,
    height: process.stdout.rows,
    output: "ascii",
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
  smoothK: 2.0,
};

// Scene-specific config
const sceneParams = {
  seed: 42,
  colorBlendK: 0.5,

  columns: {
    x: 8.0,
    spacingY: 3.5,
    spheresPerColumn: 3,
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
};

// =============================================================================
// Groups
// =============================================================================

const SceneGroups = {
  BLOBS: 0,
  CLAUDE: 1,
} as const;

const groupDefs: GroupDef[] = [
  { blendMode: BlendMode.SMOOTH }, // BLOBS
  { blendMode: BlendMode.HARD },   // CLAUDE
];

// =============================================================================
// State
// =============================================================================

interface SceneState {
  basePositions: Vec3[];
  baseSizes: number[];
  phaseOffsets: number[];
  freqMultipliers: number[];
  noiseOffsets: Vec3[];
  claudeNoiseOffset: Vec3;
  pnoise1: (x: number, octaves?: number) => number;
}

let state: SceneState | null = null;

function initState(): SceneState {
  const rng = seededRandom(sceneParams.seed);
  const { x: columnX, spacingY, spheresPerColumn, sphereRadius } = sceneParams.columns;

  const basePositions: Vec3[] = [];
  const baseSizes: number[] = [];
  const phaseOffsets: number[] = [];
  const freqMultipliers: number[] = [];
  const noiseOffsets: Vec3[] = [];

  const columnYStart = -((spheresPerColumn - 1) / 2) * spacingY;

  for (const sign of [-1, 1]) {
    for (let i = 0; i < spheresPerColumn; i++) {
      basePositions.push([sign * columnX, columnYStart + i * spacingY, 0]);
      baseSizes.push(sphereRadius);
      phaseOffsets.push(rng() * 2 * Math.PI);
      freqMultipliers.push(rng() * 0.5 + 0.75);
      noiseOffsets.push([rng() * 1000, rng() * 1000, rng() * 1000]);
    }
  }

  const pnoise1 = createNoiseGenerator(rng);

  return {
    basePositions,
    baseSizes,
    phaseOffsets,
    freqMultipliers,
    noiseOffsets,
    claudeNoiseOffset: [rng() * 1000, rng() * 1000, rng() * 1000],
    pnoise1,
  };
}

// =============================================================================
// Animation
// =============================================================================

function getClaudePosition(t: number): Vec3 {
  const { slingshot, z } = sceneParams.claude;
  const { cycleDuration, windupRatio, restY, launchOffsetX, launchOffsetY, peakY } = slingshot;
  const columnX = sceneParams.columns.x;

  const cycleTime = t % cycleDuration;
  const windupDuration = cycleDuration * windupRatio;
  const flightDuration = cycleDuration * (1 - windupRatio);

  const cycleIndex = Math.floor(t / cycleDuration);
  const startX = cycleIndex % 2 === 0 ? columnX : -columnX;
  const targetX = -startX;

  const launchX = startX + (startX > 0 ? launchOffsetX : -launchOffsetX);
  const launchY = restY + launchOffsetY;

  if (cycleTime < windupDuration) {
    const windupT = easeInOutQuad(cycleTime / windupDuration);
    return [
      startX + (launchX - startX) * windupT,
      restY + (launchY - restY) * windupT,
      z,
    ];
  } else {
    const flightTime = cycleTime - windupDuration;
    const flightT = flightTime / flightDuration;

    const easedT = easeOutQuad(flightT);
    const x = launchX + (targetX - launchX) * easedT;

    const peakOffset = peakY - launchY;
    const parabola = 4 * easedT * (1 - easedT);
    const y = launchY + peakOffset * parabola + (restY - launchY) * easedT;

    return [x, y, z];
  }
}

// =============================================================================
// Scene Implementation
// =============================================================================

function update(t: number): ObjectDef[] {
  if (!state) {
    throw new Error("Scene not initialized");
  }

  const { animation, colors, claude: claudeCfg } = sceneParams;
  const { driftSpeed, driftScale, sizeOscSpeed, sizeOscAmount, noiseSizeAmount } = animation;
  const {
    basePositions,
    baseSizes,
    phaseOffsets,
    freqMultipliers,
    noiseOffsets,
    claudeNoiseOffset,
    pnoise1,
  } = state;

  const objects: ObjectDef[] = [];

  // Blob spheres
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

  // Claude
  const claudeBasePos = getClaudePosition(t);
  const [cx, cy, cz] = claudeBasePos;
  const [cnx, cny, cnz] = claudeNoiseOffset;

  const noiseScale = claudeCfg.noiseScale;
  const cDx = pnoise1(cnx + t * driftSpeed, 2) * driftScale * noiseScale;
  const cDy = pnoise1(cny + t * driftSpeed, 2) * driftScale * noiseScale * 0.67;
  const cDz = pnoise1(cnz + t * driftSpeed, 2) * driftScale * noiseScale;

  const claudePos: Vec3 = [cx + cDx, cy + cDy, cz + cDz];
  objects.push(...getClaudeBoxes(claudePos, 1.0, SceneGroups.CLAUDE));

  return objects;
}

// =============================================================================
// Export
// =============================================================================

export const slingshotScene: Scene = {
  name: "slingshot",
  config,
  groupDefs,
  init() {
    state = initState();
  },
  update,
};

// Auto-register
registerScene(slingshotScene);
