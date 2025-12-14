/**
 * T-pose scene - Claude rotating slowly with gentle float.
 * Rotation is achieved by orbiting the camera around Claude.
 */

import {
  type Scene,
  type SceneConfig,
  type SceneFrame,
  type GroupDef,
  type ObjectDef,
  type LightingConfig,
  type Vec3,
  BlendMode,
  registerScene,
  getClaudeBoxes,
} from "../scene";
import { seededRandom, createNoiseGenerator } from "../scene/utils";

// =============================================================================
// Config
// =============================================================================

const cameraDistance = 3.0;
const cameraHeight = 0.5;

const config: SceneConfig = {
  camera: {
    eye: [0.0, cameraHeight, -cameraDistance] as Vec3,
    at: [0.0, 0.0, 0.0] as Vec3,
    up: [0.0, 1.0, 0.0] as Vec3,
    fov: 30,
  },
  lighting: {
    ambient: 0.1,
    directional: {
      direction: [1.0, 1.0, -1.0] as Vec3,
      intensity: 0.9,
    },
  },
  smoothK: 0.0,
};

// Scene params
const sceneParams = {
  seed: 123,
  rotationSpeed: 0.5,
  floatSpeed: 0.3,
  floatAmount: 0.05,
};

// =============================================================================
// Groups
// =============================================================================

const SceneGroups = {
  CLAUDE: 0,
} as const;

const groupDefs: GroupDef[] = [
  { blendMode: BlendMode.HARD }, // CLAUDE - hard union for distinct limbs
];

// =============================================================================
// State
// =============================================================================

interface SceneState {
  pnoise1: (x: number, octaves?: number) => number;
  noiseOffsetX: number;
  noiseOffsetY: number;
  noiseOffsetZ: number;
}

let state: SceneState | null = null;

function initState(): SceneState {
  const rng = seededRandom(sceneParams.seed);
  const pnoise1 = createNoiseGenerator(rng);
  return {
    pnoise1,
    noiseOffsetX: rng() * 1000,
    noiseOffsetY: rng() * 1000,
    noiseOffsetZ: rng() * 1000,
  };
}

// =============================================================================
// Scene Implementation
// =============================================================================

function update(t: number): SceneFrame {
  if (!state) throw new Error("Scene not initialized");

  const { pnoise1, noiseOffsetX, noiseOffsetY, noiseOffsetZ } = state;
  const { rotationSpeed, floatSpeed, floatAmount } = sceneParams;

  // Gentle floating with perlin noise
  const floatX = pnoise1(noiseOffsetX + t * floatSpeed, 2) * floatAmount;
  const floatY = pnoise1(noiseOffsetY + t * floatSpeed, 2) * floatAmount;
  const floatZ = pnoise1(noiseOffsetZ + t * floatSpeed, 2) * floatAmount;

  // Claude at origin with slight float
  const objects = getClaudeBoxes([floatX, floatY, floatZ], 1.0, SceneGroups.CLAUDE);

  // Camera orbits around Claude (continuous rotation)
  const angle = t * rotationSpeed;
  const camX = Math.sin(angle) * cameraDistance;
  const camZ = -Math.cos(angle) * cameraDistance;

  // Return objects + per-frame camera override via config
  // We need to return camera position for the renderer
return {
  objects,
  camera: {
    eye: [camX, cameraHeight, camZ] as Vec3,
    at: [floatX, floatY, floatZ] as Vec3,
  },
  lighting: {
    ambient: 0.25,
    directional: {
      direction: [camX, cameraHeight, camZ] as Vec3,  // light from camera position
      intensity: 0.75,
    },
  },
};
}

// =============================================================================
// Export
// =============================================================================

const tposeScene: Scene = {
  name: "tpose",
  config,
  groupDefs,
  init() {
    state = initState();
  },
  update,
};

// Auto-register
registerScene(tposeScene);
