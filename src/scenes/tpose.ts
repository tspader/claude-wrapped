/**
 * T-pose scene - Claude centered, arms extended, static.
 */

import {
  type Scene,
  type SceneConfig,
  type GroupDef,
  type ObjectDef,
  type Vec3,
  BlendMode,
  registerScene,
  getClaudeBoxes,
} from "../scene";

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
    eye: [0.0, 0.0, -3.0] as Vec3,
    at: [0.0, 0.0, 0.0] as Vec3,
    up: [0.0, 1.0, 0.0] as Vec3,
    fov: 50,
  },
  render: {
    width: process.stdout.columns,
    height: process.stdout.rows,
    output: "ascii",
    background: [0.0, 0.0, 0.0] as Vec3,
  },
  lighting: {
    ambient: 0.15,
    directional: {
      direction: [0.5, 1.0, -1.0] as Vec3,
      color: [1.0, 1.0, 1.0] as Vec3,
      intensity: 1.0,
    },
    pointLights: [],
  },
  smoothK: 0.5,
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
// Scene Implementation
// =============================================================================

function update(_t: number): ObjectDef[] {
  // Claude centered at origin, static T-pose
  const claudePos: Vec3 = [0, 0, 0];
  return getClaudeBoxes(claudePos, 1.0, SceneGroups.CLAUDE);
}

// =============================================================================
// Export
// =============================================================================

export const tposeScene: Scene = {
  name: "tpose",
  config,
  groupDefs,
  init() {
    // No state to initialize for static scene
  },
  update,
};

// Auto-register
registerScene(tposeScene);
