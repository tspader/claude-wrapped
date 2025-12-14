/**
 * Slingshot scene - Claude bouncing between blob columns.
 */

import {
  type Scene,
  type SceneConfig,
  type SceneFrame,
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

const cameraDistance = 8.0;
const cameraHeight = 2.0;

const config: SceneConfig = {
  camera: {
    eye: [0.0, cameraHeight, -cameraDistance] as Vec3,
    at: [0.0, 0.0, 0.0] as Vec3,
    up: [0.0, 1.0, 0.0] as Vec3,
    fov: 60,
  },
  lighting: {
    ambient: 0.1,
    directional: {
      direction: [0.0, cameraHeight, -cameraDistance] as Vec3,
      intensity: 0.9,
    },
  },
  smoothK: 0.0,
};

// Scene-specific config
const sceneParams = {
  seed: 42,

  beams: {
    paddingY: 0.0,
    cylindersPerBeam: 3,
    cylinderRadius: 1.0,
    cylinderHalfHeight: 1.8,
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
      restX: 0,
      launchOffsetX: -1.0,
      launchOffsetY: 1.5,
      peakX: 1.0,
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
  const { paddingY, cylindersPerBeam, cylinderRadius } = sceneParams.beams;

  const basePositions: Vec3[] = [];
  const baseSizes: number[] = [];
  const phaseOffsets: number[] = [];
  const freqMultipliers: number[] = [];
  const noiseOffsets: Vec3[] = [];

  // Calculate visible area from camera (at z=0, camera at z=-8, fov=60)
  const fovRad = (60 / 2) * Math.PI / 180;
  const visibleHalfHeight = 8 * Math.tan(fovRad);
  const visibleHalfWidth = visibleHalfHeight; // Assume ~1:1 aspect for now, will extend past edges

  // Space cylinders evenly across visible width, accounting for radius at edges
  const beamWidth = visibleHalfWidth * 2;
  const usableWidth = beamWidth - 2 * cylinderRadius;
  const spacing = cylindersPerBeam > 1 ? usableWidth / (cylindersPerBeam - 1) : 0;
  const beamXStart = -visibleHalfWidth + cylinderRadius;

  const beamY = visibleHalfHeight - paddingY - cylinderRadius;

  // Top and bottom beams (horizontal rows of cylinders)
  for (const sign of [-1, 1]) {
    for (let i = 0; i < cylindersPerBeam; i++) {
      basePositions.push([beamXStart + i * spacing, sign * beamY, 0]);
      baseSizes.push(cylinderRadius);
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
  const { cycleDuration, windupRatio, restX, launchOffsetX, launchOffsetY, peakX } = slingshot;
  const { paddingY, cylinderRadius } = sceneParams.beams;
  const visibleHalfHeight = 8 * Math.tan((60 / 2) * Math.PI / 180);
  const beamY = visibleHalfHeight - paddingY - cylinderRadius;

  const cycleTime = t % cycleDuration;
  const windupDuration = cycleDuration * windupRatio;
  const flightDuration = cycleDuration * (1 - windupRatio);

  const cycleIndex = Math.floor(t / cycleDuration);
  // Alternate between top (+beamY) and bottom (-beamY)
  const startY = cycleIndex % 2 === 0 ? beamY : -beamY;
  const targetY = -startY;

  // Pull back past the beam before launching
  const launchY = startY + (startY > 0 ? launchOffsetY : -launchOffsetY);
  const launchX = restX + launchOffsetX;

  if (cycleTime < windupDuration) {
    const windupT = easeInOutQuad(cycleTime / windupDuration);
    return [
      restX + (launchX - restX) * windupT,
      startY + (launchY - startY) * windupT,
      z,
    ];
  } else {
    const flightTime = cycleTime - windupDuration;
    const flightT = flightTime / flightDuration;

    const easedT = easeOutQuad(flightT);
    const y = launchY + (targetY - launchY) * easedT;

    // Horizontal wobble during flight (parabolic arc on X)
    const peakOffset = peakX - launchX;
    const parabola = 4 * easedT * (1 - easedT);
    const x = launchX + peakOffset * parabola + (restX - launchX) * easedT;

    return [x, y, z];
  }
}

// =============================================================================
// Scene Implementation
// =============================================================================

function update(t: number): SceneFrame {
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

  // Blob cylinders (oriented along X-axis for left-to-right)
  const { cylinderHalfHeight } = sceneParams.beams;
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
      shape: { type: ShapeType.CYLINDER, params: [radius, cylinderHalfHeight], color: colors.blob },
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

  // Point lights inside the cylinder beams (x=0, at beam Y positions)
  const visibleHalfHeight = cameraDistance * Math.tan((60 / 2) * Math.PI / 180);
  const beamY = visibleHalfHeight - sceneParams.beams.paddingY - sceneParams.beams.cylinderRadius;

  return {
    objects,
    lighting: {
      ambient: 0.15,
      directional: {
        direction: [0, cameraHeight, -cameraDistance] as Vec3,  // light from camera
        intensity: 0.6,
      },
      pointLights: [
        // Top beam light (inside cylinders)
        {
          position: [0, beamY, 0] as Vec3,
          color: [0.4, 0.8, 0.6] as Vec3,  // greenish, matches blob color
          intensity: 1.2,
          radius: 4.0,
        },
        // Bottom beam light (inside cylinders)
        {
          position: [0, -beamY, 0] as Vec3,
          color: [0.4, 0.8, 0.6] as Vec3,
          intensity: 1.2,
          radius: 4.0,
        },
        // Light following Claude
        {
          position: [claudePos[0], claudePos[1] + 0.5, claudePos[2] - 1.0] as Vec3,
          color: [1.0, 0.95, 0.8] as Vec3,  // warm white
          intensity: 1.0,
          radius: 3.0,
        },
      ],
    },
    snow: {
      count: 200,
      baseSpeed: 10.0,
      driftStrength: 2.0,
    },
  };
}

// =============================================================================
// Export
// =============================================================================

const slingshotScene: Scene = {
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
