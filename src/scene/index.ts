/**
 * Scene system - registry and active scene management.
 */

export * from "./types";
export { compileScene } from "./utils";
export { getClaudeBoxes } from "./models/claude";

import type { Scene } from "./types";

// Scene registry
const scenes = new Map<string, Scene>();

let activeScene: Scene | null = null;

export function registerScene(scene: Scene): void {
  scenes.set(scene.name, scene);
}

export function setActiveScene(name: string): Scene {
  const scene = scenes.get(name);
  if (!scene) {
    const available = Array.from(scenes.keys()).join(", ");
    throw new Error(`Scene not found: ${name}. Available: ${available}`);
  }
  activeScene = scene;
  activeScene.init();
  return activeScene;
}

export function getActiveScene(): Scene {
  if (!activeScene) {
    throw new Error("No active scene. Call setActiveScene() first.");
  }
  return activeScene;
}
