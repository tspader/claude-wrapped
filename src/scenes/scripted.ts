/**
 * Scripted scene - demonstrates the dialogue + action queue system.
 * Claude with camera interpolations controlled by dialogue nodes.
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
import { ActionQueue, easeOutCubic, easeInOutCubic, type Script } from "../scene/script";
import { DialogueExecutor, type DialogueNode } from "../scene/dialogue";
import { t, green, cyan } from "@opentui/core";

// =============================================================================
// Config
// =============================================================================

const config: SceneConfig = {
  camera: {
    eye: [0.0, 0.5, -5.0] as Vec3,
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
// Dialogue Nodes
// =============================================================================

const nodes: DialogueNode[] = [
  {
    id: "start",
    type: "script",
    script: [
      { type: "lerp", target: "camera.z", to: -3.0, duration: 2.0, easing: easeOutCubic },
    ],
    next: "welcome",
  },
  {
    id: "welcome",
    type: "text",
    text: t`Welcome to the ${green("scripted")} scene demo.

This combines dialogue with camera animations.`,
    script: [
      { type: "lerp", target: "camera.x", to: 1.0, duration: 1.5, easing: easeInOutCubic },
    ],
    next: "prompt",
  },
  {
    id: "prompt",
    type: "prompt",
    text: t`Would you like to see more?`,
    options: [
      { label: "YES", target: "orbit" },
      { label: "NO", target: "end" },
    ],
    next: "orbit",
  },
  {
    id: "orbit",
    type: "script",
    script: [
      { type: "lerp", target: "camera.x", to: 3.0, duration: 1.5, easing: easeInOutCubic },
      { type: "lerp", target: "camera.z", to: 0.0, duration: 1.5, easing: easeInOutCubic },
    ],
    next: "orbited",
  },
  {
    id: "orbited",
    type: "text",
    text: t`The camera just ${cyan("orbited")} around Claude.

Press space to return to start.`,
    next: "return",
  },
  {
    id: "return",
    type: "script",
    script: [
      { type: "lerp", target: "camera.x", to: 0.0, duration: 1.0, easing: easeOutCubic },
      { type: "lerp", target: "camera.z", to: -3.0, duration: 1.0, easing: easeOutCubic },
    ],
    next: "end",
  },
  {
    id: "end",
    type: "text",
    text: t`Demo complete. The scene will now idle.`,
    next: "end", // Terminal
  },
];

// =============================================================================
// State
// =============================================================================

interface SceneState {
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  cameraFov: number;
  actionQueue: ActionQueue;
  dialogue: DialogueExecutor;
}

let state: SceneState | null = null;

function createState(): SceneState {
  const s: Partial<SceneState> = {
    cameraX: config.camera.eye[0],
    cameraY: config.camera.eye[1],
    cameraZ: config.camera.eye[2],
    cameraFov: config.camera.fov,
  };

  // Getter/setter for action targets
  const getter = (target: string): number => {
    switch (target) {
      case "camera.x": return s.cameraX!;
      case "camera.y": return s.cameraY!;
      case "camera.z": return s.cameraZ!;
      case "camera.fov": return s.cameraFov!;
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

  s.actionQueue = new ActionQueue(getter, setter);
  s.dialogue = new DialogueExecutor(nodes, "start", s.actionQueue);

  // Wire up dialogue callbacks (for demo, just log)
  s.dialogue.onTextUpdate = (text, index, finished) => {
    const plain = text.chunks.map(c => c.text).join("");
    // In real use, this would update UI
    if (finished) {
      process.stderr.write(`[dialogue] ${plain}\n`);
    }
  };

  s.dialogue.onShowOptions = (options) => {
    process.stderr.write(`[options] ${options.map(o => o.label).join(" | ")}\n`);
  };

  return s as SceneState;
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

    // Update action queue (runs all interpolations)
    state.actionQueue.tick(dt);

    // Update dialogue (manages node transitions)
    state.dialogue.tick(dt);

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

// Export for external control
export function advanceDialogue(): void {
  state?.dialogue.advance();
}

export function selectOption(index: number): void {
  state?.dialogue.selectOption(index);
}

export function getDialoguePhase(): string {
  return state?.dialogue.phase ?? "unknown";
}

export function isDialogueDone(): boolean {
  return state?.dialogue.done ?? true;
}
