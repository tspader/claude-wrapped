/**
 * Scripted scene - demonstrates the script executor system.
 * Claude with camera interpolations controlled by a script.
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
import { ScriptRunner, easeOutCubic, easeInOutCubic, type Script } from "../scene/script";

// =============================================================================
// Config
// =============================================================================

const config: SceneConfig = {
  camera: {
    eye: [0.0, 1.0, -5.0] as Vec3,
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

const SceneGroups = {
  CLAUDE: 0,
} as const;

const groupDefs: GroupDef[] = [
  { blendMode: BlendMode.HARD },
];

// =============================================================================
// Script Definition
// =============================================================================

const introScript: Script = [
  // Start zoomed out, then zoom in
  { type: "lerp", target: "camera.z", to: -3.0, duration: 2.0, easing: easeOutCubic },
  { type: "wait", duration: 0.5 },
  // Pan right while adjusting FOV
  { type: "parallel", actions: [
    { type: "lerp", target: "camera.x", to: 2.0, duration: 1.5, easing: easeInOutCubic },
    { type: "lerp", target: "camera.fov", to: 35, duration: 1.5, easing: easeInOutCubic },
  ]},
  { type: "wait", duration: 0.5 },
  // Pan back to center
  { type: "lerp", target: "camera.x", to: 0.0, duration: 1.0, easing: easeOutCubic },
  { type: "wait", duration: 0.5 },
  // Orbit around (move camera in a quarter circle)
  { type: "parallel", actions: [
    { type: "lerp", target: "camera.x", to: 3.0, duration: 2.0, easing: easeInOutCubic },
    { type: "lerp", target: "camera.z", to: 0.0, duration: 2.0, easing: easeInOutCubic },
  ]},
  { type: "wait", duration: 0.5 },
  // Return to start
  { type: "parallel", actions: [
    { type: "lerp", target: "camera.x", to: 0.0, duration: 1.5, easing: easeOutCubic },
    { type: "lerp", target: "camera.z", to: -3.0, duration: 1.5, easing: easeOutCubic },
    { type: "lerp", target: "camera.fov", to: 25, duration: 1.5, easing: easeOutCubic },
  ]},
];

// =============================================================================
// State
// =============================================================================

interface SceneState {
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  cameraFov: number;
  runner: ScriptRunner;
}

let state: SceneState | null = null;

function createState(): SceneState {
  const s: SceneState = {
    cameraX: config.camera.eye[0],
    cameraY: config.camera.eye[1],
    cameraZ: config.camera.eye[2],
    cameraFov: config.camera.fov,
    runner: null!,
  };

  // Getter/setter for script targets
  const getter = (target: string): number => {
    switch (target) {
      case "camera.x": return s.cameraX;
      case "camera.y": return s.cameraY;
      case "camera.z": return s.cameraZ;
      case "camera.fov": return s.cameraFov;
      default: throw new Error(`Unknown target: ${target}`);
    }
  };

  const setter = (target: string, value: number): void => {
    switch (target) {
      case "camera.x": s.cameraX = value; break;
      case "camera.y": s.cameraY = value; break;
      case "camera.z": s.cameraZ = value; break;
      case "camera.fov": s.cameraFov = value; break;
      default: throw new Error(`Unknown target: ${target}`);
    }
  };

  s.runner = new ScriptRunner(introScript, getter, setter);
  return s;
}

// =============================================================================
// Scene
// =============================================================================

let lastT = 0;

const scriptedScene: Scene = {
  name: "scripted",
  config,
  groupDefs,

  init() {
    state = createState();
    lastT = 0;
  },

  update(t: number): SceneFrame {
    if (!state) throw new Error("Scene not initialized");

    const dt = t - lastT;
    lastT = t;

    // Update script
    state.runner.tick(dt);

    // Claude at origin
    const objects: ObjectDef[] = getClaudeBoxes([0, 0, 0], 1.0, SceneGroups.CLAUDE);

    return {
      objects,
      camera: {
        eye: [state.cameraX, state.cameraY, state.cameraZ] as Vec3,
        fov: state.cameraFov,
      },
    };
  },
};

// Auto-register
registerScene(scriptedScene);

// Export for external skip control
export function skipScript(): void {
  state?.runner.skip();
}

export function resetScript(): void {
  state?.runner.reset();
}

export function isScriptDone(): boolean {
  return state?.runner.done ?? true;
}
