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

////////////
// CONFIG //
////////////
const cameraDistance = 3.0;
const cameraHeight = 1.0;

const config: SceneConfig = {
  camera: {
    eye: [0.0, cameraHeight, -cameraDistance] as Vec3,
    at: [0.0, 0.0, 0.0] as Vec3,
    up: [0.0, 1.0, 0.0] as Vec3,
    fov: 25,
  },
  lighting: {
    ambient: 0.1,
    directional: {
      direction: [0.5, 0.6, -0.8] as Vec3,
      intensity: 0.9,
    },
  },
  smoothK: 0.0,
};

const snowParams = {
  count: 30,
  radius: 0.05,
  baseSpeed: 0.2,
  speedJitter: 0.1,
  driftStrength: 0.3,
  // world space bounds
  minX: -1.5,
  maxX: 1.5,
  minY: -1.0,
  maxY: 1.0,
  minZ: -1.0,
  maxZ: 1.0,
};

const sceneParams = {
  seed: 123,
  rotationSpeed: 0.5,
  floatSpeed: 0.3,
  floatAmount: 0.05,
};

////////////
// GROUPS //
////////////
const SceneGroups = {
  CLAUDE: 0,
  SNOW: 1,
} as const;

const groupDefs: GroupDef[] = [
  { blendMode: BlendMode.HARD }, // claude
  { blendMode: BlendMode.HARD }, // snow
];

////////////
// EXPORT //
////////////
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


///////////
// STATE //
///////////
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

  const snowflakes: Snowflake[] = [];
  const { count, minX, maxX, minY, maxY, minZ, maxZ, baseSpeed, speedJitter, driftStrength } = snowParams;

  // Spawn snowflakes in a circle above Claude
  const spawnRadius = 1.5;

  for (let i = 0; i < count; i++) {
    // Random point in circle (uniform distribution)
    const angle = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * spawnRadius;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;

    snowflakes.push({
      x,
      y: minY + rng() * (maxY - minY), // random initial Y within range
      z,
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

////////////
// UPDATE //
////////////
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

  const pointLights = snowflakes.map((flake) => ({
    position: [flake.x, flake.y, flake.z] as Vec3,
    color: [0.8, 0.9, 1.0] as Vec3,  // cool white/blue
    intensity: 2.0,
    radius: 0.2,
  }));

  return {
    objects,
    camera: {
      eye: [camX, cameraHeight, camZ] as Vec3,
      at: [floatX, floatY, floatZ] as Vec3,
    },
    lighting: {
      ambient: 0.0,
      directional: {
        direction: [.5, .75, -.25] as Vec3,  // mirrored camera position
        intensity: 1.0,
      },
      pointLights,
    },
    // snow: {
    //   count: 200,
    //   baseSpeed: 3.0,
    //   driftStrength: 8.0,
    // },
  };
}

