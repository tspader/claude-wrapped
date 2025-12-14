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
  ShapeType,
  registerScene,
  getClaudeBoxes,
} from "../scene";
import { seededRandom, createNoiseGenerator } from "../scene/utils";

// =============================================================================
// Config
// =============================================================================

const cameraDistance = 3.0;
const cameraHeight = 1.0;

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
  SNOW: 1,
} as const;

const groupDefs: GroupDef[] = [
  { blendMode: BlendMode.HARD }, // CLAUDE - hard union for distinct limbs
  { blendMode: BlendMode.HARD }, // SNOW - distinct snowflakes
];

// =============================================================================
// Snow Config
// =============================================================================

const snowParams = {
  count: 20,
  radius: 0.05,
  // World-space bounds for snowfall (smaller to stay in view)
  minX: -1.5,
  maxX: 1.5,
  minY: -1.0,
  maxY: 1.5,
  minZ: -1.5,
  maxZ: 0.5,
  // Speed
  baseSpeed: 0.3,
  speedJitter: 0.1,
  driftStrength: 0.2,
};

// =============================================================================
// State
// =============================================================================

interface Snowflake {
  x: number;
  y: number;
  z: number;
  speed: number;
  driftX: number;
  driftZ: number;
}

interface SceneState {
  pnoise1: (x: number, octaves?: number) => number;
  noiseOffsetX: number;
  noiseOffsetY: number;
  noiseOffsetZ: number;
  snowflakes: Snowflake[];
  lastT: number;
}

let state: SceneState | null = null;

function initState(): SceneState {
  const rng = seededRandom(sceneParams.seed);
  const pnoise1 = createNoiseGenerator(rng);
  
  // Initialize snowflakes
  const snowflakes: Snowflake[] = [];
  const { count, minX, maxX, minY, maxY, minZ, maxZ, baseSpeed, speedJitter, driftStrength } = snowParams;
  
  for (let i = 0; i < count; i++) {
    snowflakes.push({
      x: minX + rng() * (maxX - minX),
      y: minY + rng() * (maxY - minY),
      z: minZ + rng() * (maxZ - minZ),
      speed: baseSpeed + (rng() - 0.5) * 2 * speedJitter,
      driftX: (rng() - 0.5) * 2 * driftStrength,
      driftZ: (rng() - 0.5) * 2 * driftStrength,
    });
  }
  
  return {
    pnoise1,
    noiseOffsetX: rng() * 1000,
    noiseOffsetY: rng() * 1000,
    noiseOffsetZ: rng() * 1000,
    snowflakes,
    lastT: 0,
  };
}

// =============================================================================
// Scene Implementation
// =============================================================================

function update(t: number): SceneFrame {
  if (!state) throw new Error("Scene not initialized");

  const { pnoise1, noiseOffsetX, noiseOffsetY, noiseOffsetZ, snowflakes, lastT } = state;
  const { rotationSpeed, floatSpeed, floatAmount } = sceneParams;
  const { minX, maxX, minY, maxY, minZ, maxZ, radius } = snowParams;

  // Compute delta time
  const dt = t - lastT;
  state.lastT = t;

  // Gentle floating with perlin noise
  const floatX = pnoise1(noiseOffsetX + t * floatSpeed, 2) * floatAmount;
  const floatY = pnoise1(noiseOffsetY + t * floatSpeed, 2) * floatAmount;
  const floatZ = pnoise1(noiseOffsetZ + t * floatSpeed, 2) * floatAmount;

  // Claude at origin with slight float
  const objects: ObjectDef[] = getClaudeBoxes([floatX, floatY, floatZ], 1.0, SceneGroups.CLAUDE);

  // Update snowflakes and add as SDF spheres
  for (const flake of snowflakes) {
    // Update position
    flake.y -= flake.speed * dt;
    flake.x += flake.driftX * dt;
    flake.z += flake.driftZ * dt;

    // Wrap horizontally
    if (flake.x < minX) flake.x += (maxX - minX);
    if (flake.x > maxX) flake.x -= (maxX - minX);
    if (flake.z < minZ) flake.z += (maxZ - minZ);
    if (flake.z > maxZ) flake.z -= (maxZ - minZ);

    // Reset to top if fallen below
    if (flake.y < minY) {
      flake.y = maxY;
    }

    // Add as SDF sphere
    objects.push({
      shape: {
        type: ShapeType.SPHERE,
        params: [radius],
        color: [1.0, 1.0, 1.0] as Vec3, // white
      },
      position: [flake.x, flake.y, flake.z] as Vec3,
      group: SceneGroups.SNOW,
    });
  }

  // Camera orbits around Claude (continuous rotation)
  const angle = t * rotationSpeed;
  const camX = Math.sin(angle) * cameraDistance;
  const camZ = -Math.cos(angle) * cameraDistance;

  // Return objects + per-frame camera override via config
  // We need to return camera position for the renderer
  // Point light above Claude's head, orbits with camera
  const lightOrbitRadius = 1.0;
  const lightHeight = 1.5;
  const lightX = Math.sin(angle + 0.5) * lightOrbitRadius;
  const lightZ = -Math.cos(angle + 0.5) * lightOrbitRadius;

  return {
    objects,
    camera: {
      eye: [camX, cameraHeight, camZ] as Vec3,
      at: [floatX, floatY, floatZ] as Vec3,
    },
    lighting: {
      ambient: 0.3,
      directional: {
        direction: [camX, cameraHeight, camZ] as Vec3,  // light from camera position
        intensity: 0.3,
      },
      pointLights: [
        {
          position: [lightX + floatX, lightHeight + floatY, lightZ + floatZ] as Vec3,
          color: [1.0, 0.9, 0.7] as Vec3,  // warm white
          intensity: 1.0,
          radius: 3.0,
        },
      ],
    },
    // snow: {
    //   count: 200,
    //   baseSpeed: 3.0,
    //   driftStrength: 8.0,
    // },
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
