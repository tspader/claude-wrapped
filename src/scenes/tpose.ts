/**
 * T-pose scene - Claude rotating slowly with gentle sway.
 */

import {
  type Scene,
  type SceneConfig,
  type SceneFrame,
  type GroupDef,
  type ObjectDef,
  type Vec3,
  BlendMode,
  registerScene,
  getClaudeBoxes,
} from "../scene";
import { seededRandom, createNoiseGenerator } from "../scene/utils";

// =============================================================================
// Config
// =============================================================================

const config: SceneConfig = {
  camera: {
    eye: [1.5, 0.5, -3.0] as Vec3,  // slightly above and to the side
    at: [0.0, 0.0, 0.0] as Vec3,     // looking at origin
    up: [0.0, 1.0, 0.0] as Vec3,
    fov: 20,
  },
  lighting: {
    ambient: 0.0,
    directional: {
      direction: [0.25, 0.5, -0.75] as Vec3,
      intensity: 1.0,
    },
  },
  smoothK: 0.0,
};

// Scene params
const sceneParams = {
  seed: 123,
  rotationSpeed: 0.3,
  swaySpeed: 0.2,
  swayAmount: 0.15,
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
  const { rotationSpeed, swaySpeed, swayAmount } = sceneParams;

  // Gentle sway with perlin noise
  const swayX = pnoise1(noiseOffsetX + t * swaySpeed, 2) * swayAmount;
  const swayY = pnoise1(noiseOffsetY + t * swaySpeed, 2) * swayAmount * 0.5;
  const swayZ = pnoise1(noiseOffsetZ + t * swaySpeed, 2) * swayAmount;

  // Rotation around Y axis
  const angle = t * rotationSpeed;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Get base claude boxes at origin
  const baseBoxes = getClaudeBoxes([0, 0, 0], 1.0, SceneGroups.CLAUDE);

  // Apply rotation and sway to each box
  const objects = baseBoxes.map((obj) => {
    const [x, y, z] = obj.position;
    // Rotate around Y axis
    const rx = x * cos - z * sin;
    const rz = x * sin + z * cos;
    return {
      ...obj,
      position: [rx + swayX, y + swayY, rz + swayZ] as Vec3,
    };
  });

  return { objects };
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
