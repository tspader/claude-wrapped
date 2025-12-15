#!/usr/bin/env bun
/**
 * Standalone dialogue demo - bypasses old StatsBox, uses new dialogue system.
 */

import {
  createCliRenderer,
  FrameBufferRenderable,
  BoxRenderable,
  TextRenderable,
  RGBA,
  t as text,
  fg,
  dim,
  bold,
  StyledText,
  type TextChunk,
} from "@opentui/core";
import { Camera, type Vec3, normalize, cross, sub } from "./camera";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  compileScene,
  setActiveScene,
  getActiveScene,
  type FlatScene,
} from "./scene";
import { ActionQueue, easeOutCubic, easeInOutCubic } from "./scene/script";
import { DialogueExecutor, type DialogueNode } from "./scene/dialogue";

// Register scene (side effect)
import "./scenes/scripted";

// =============================================================================
// Dialogue Nodes
// =============================================================================

const CLAUDE_COLOR = "#E07A3C";

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
    text: text`Welcome to the ${fg("#00FF00")("dialogue")} demo.

This shows the new dialogue system
with camera animations.`,
    script: [
      { type: "lerp", target: "camera.x", to: 1.0, duration: 1.5, easing: easeInOutCubic },
    ],
    next: "prompt",
  },
  {
    id: "prompt",
    type: "prompt",
    text: text`Would you like to see more?`,
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
    text: text`The camera just ${fg("#00FFFF")("orbited")} around.

Press space to return.`,
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
    text: text`Demo complete.

Press Ctrl+C to exit.`,
    next: "end",
  },
];

// =============================================================================
// WASM Loading (copied from main.ts)
// =============================================================================

interface WasmExports {
  memory: WebAssembly.Memory;
  get_bg_ptr: () => number;
  get_shape_types_ptr: () => number;
  get_shape_params_ptr: () => number;
  get_shape_positions_ptr: () => number;
  get_shape_colors_ptr: () => number;
  get_shape_groups_ptr: () => number;
  get_group_blend_modes_ptr: () => number;
  get_point_light_x_ptr: () => number;
  get_point_light_y_ptr: () => number;
  get_point_light_z_ptr: () => number;
  get_point_light_r_ptr: () => number;
  get_point_light_g_ptr: () => number;
  get_point_light_b_ptr: () => number;
  get_point_light_intensity_ptr: () => number;
  get_point_light_radius_ptr: () => number;
  get_max_point_lights: () => number;
  set_point_lights: (count: number) => void;
  get_perf_metrics_ptr: () => number;
  reset_perf_metrics: () => void;
  get_max_rays: () => number;
  get_max_shapes: () => number;
  get_max_groups: () => number;
  set_scene: (count: number, smoothK: number) => void;
  set_groups: (count: number) => void;
  set_camera: (
    ex: number, ey: number, ez: number,
    fx: number, fy: number, fz: number,
    rx: number, ry: number, rz: number,
    ux: number, uy: number, uz: number,
    halfW: number, halfH: number
  ) => void;
  generate_rays: (width: number, height: number) => void;
  compute_background: (time: number) => void;
  set_lighting: (ambient: number, dirX: number, dirY: number, dirZ: number, intensity: number) => void;
  march_rays: () => void;
  get_out_char_ptr: () => number;
  get_out_fg_ptr: () => number;
  get_out_bg_ptr: () => number;
  composite: (width: number, height: number) => void;
  composite_blocks: (width: number, height: number) => void;
  get_upscaled_char_ptr: () => number;
  get_upscaled_fg_ptr: () => number;
  upscale: (nativeW: number, nativeH: number, outW: number, outH: number, scale: number) => void;
}

interface WasmRenderer {
  exports: WasmExports;
  maxRays: number;
  maxShapes: number;
  maxGroups: number;
  maxPointLights: number;
  bgColor: Float32Array;
  shapeTypes: Uint8Array;
  shapeParams: Float32Array;
  shapePositions: Float32Array;
  shapeColors: Float32Array;
  shapeGroups: Uint8Array;
  groupBlendModes: Uint8Array;
  pointLightX: Float32Array;
  pointLightY: Float32Array;
  pointLightZ: Float32Array;
  pointLightR: Float32Array;
  pointLightG: Float32Array;
  pointLightB: Float32Array;
  pointLightIntensity: Float32Array;
  pointLightRadius: Float32Array;
  perfMetrics: Float32Array;
  outChar: Uint32Array;
  outFg: Float32Array;
  outBg: Float32Array;
  upscaledChar: Uint32Array;
  upscaledFg: Float32Array;
}

async function loadWasm(): Promise<WasmRenderer> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const wasmPath = join(__dirname, "wasm", "renderer.wasm");
  const wasmBuffer = readFileSync(wasmPath);
  // @ts-ignore
  const result = await WebAssembly.instantiate(wasmBuffer, {});
  // @ts-ignore
  const instance = result.instance as WebAssembly.Instance;
  const exports = instance.exports as unknown as WasmExports;
  const memory = exports.memory;
  const maxRays = exports.get_max_rays();
  const maxShapes = exports.get_max_shapes();
  const maxGroups = exports.get_max_groups();
  const maxPointLights = exports.get_max_point_lights();

  return {
    exports,
    maxRays,
    maxShapes,
    maxGroups,
    maxPointLights,
    bgColor: new Float32Array(memory.buffer, exports.get_bg_ptr(), 3),
    shapeTypes: new Uint8Array(memory.buffer, exports.get_shape_types_ptr(), maxShapes),
    shapeParams: new Float32Array(memory.buffer, exports.get_shape_params_ptr(), maxShapes * 4),
    shapePositions: new Float32Array(memory.buffer, exports.get_shape_positions_ptr(), maxShapes * 3),
    shapeColors: new Float32Array(memory.buffer, exports.get_shape_colors_ptr(), maxShapes * 3),
    shapeGroups: new Uint8Array(memory.buffer, exports.get_shape_groups_ptr(), maxShapes),
    groupBlendModes: new Uint8Array(memory.buffer, exports.get_group_blend_modes_ptr(), maxGroups),
    pointLightX: new Float32Array(memory.buffer, exports.get_point_light_x_ptr(), maxPointLights),
    pointLightY: new Float32Array(memory.buffer, exports.get_point_light_y_ptr(), maxPointLights),
    pointLightZ: new Float32Array(memory.buffer, exports.get_point_light_z_ptr(), maxPointLights),
    pointLightR: new Float32Array(memory.buffer, exports.get_point_light_r_ptr(), maxPointLights),
    pointLightG: new Float32Array(memory.buffer, exports.get_point_light_g_ptr(), maxPointLights),
    pointLightB: new Float32Array(memory.buffer, exports.get_point_light_b_ptr(), maxPointLights),
    pointLightIntensity: new Float32Array(memory.buffer, exports.get_point_light_intensity_ptr(), maxPointLights),
    pointLightRadius: new Float32Array(memory.buffer, exports.get_point_light_radius_ptr(), maxPointLights),
    perfMetrics: new Float32Array(memory.buffer, exports.get_perf_metrics_ptr(), 16),
    outChar: new Uint32Array(memory.buffer, exports.get_out_char_ptr(), maxRays),
    outFg: new Float32Array(memory.buffer, exports.get_out_fg_ptr(), maxRays * 4),
    outBg: new Float32Array(memory.buffer, exports.get_out_bg_ptr(), maxRays * 4),
    upscaledChar: new Uint32Array(memory.buffer, exports.get_upscaled_char_ptr(), maxRays),
    upscaledFg: new Float32Array(memory.buffer, exports.get_upscaled_fg_ptr(), maxRays * 4),
  };
}

// =============================================================================
// Helpers
// =============================================================================

function sliceStyledText(styled: StyledText, maxChars: number): StyledText {
  const chunks: TextChunk[] = [];
  let remaining = maxChars;
  for (const chunk of styled.chunks) {
    if (remaining <= 0) break;
    if (chunk.text.length <= remaining) {
      chunks.push(chunk);
      remaining -= chunk.text.length;
    } else {
      chunks.push({ ...chunk, text: chunk.text.slice(0, remaining) });
      remaining = 0;
    }
  }
  return new StyledText(chunks);
}

function setupCamera(wasm: WasmRenderer, camera: Camera, width: number, height: number): void {
  const forward = normalize(sub(camera.at, camera.eye));
  const right = normalize(cross(forward, camera.up));
  const up = cross(right, forward);
  const aspect = width / height;
  const fovRad = (camera.fov * Math.PI) / 180;
  const halfHeight = Math.tan(fovRad / 2);
  const halfWidth = halfHeight * aspect;
  wasm.exports.set_camera(
    camera.eye[0], camera.eye[1], camera.eye[2],
    forward[0], forward[1], forward[2],
    right[0], right[1], right[2],
    up[0], up[1], up[2],
    halfWidth, halfHeight
  );
}

function loadScene(wasm: WasmRenderer, scene: FlatScene): void {
  wasm.shapeTypes.set(scene.types);
  wasm.shapeParams.set(scene.params);
  wasm.shapePositions.set(scene.positions);
  wasm.shapeColors.set(scene.colors);
  wasm.shapeGroups.set(scene.groups);
  wasm.groupBlendModes.set(scene.groupBlendModes);
  wasm.exports.set_scene(scene.count, scene.smoothK);
  wasm.exports.set_groups(scene.groupCount);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const wasm = await loadWasm();

  // Initialize scene (just for the 3D rendering, dialogue is separate)
  const scene = setActiveScene("scripted");
  const { config } = scene;

  // Create renderer
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
  });

  // Layout
  const sceneWidth = Math.floor(renderer.width / 2);
  const sceneHeight = renderer.height;
  const boxWidth = Math.floor(renderer.width / 2) - 4;
  const boxHeight = renderer.height - 4;

  // Create raymarcher canvas (right half)
  const canvas = new FrameBufferRenderable(renderer, {
    id: "raymarcher",
    width: sceneWidth,
    height: sceneHeight,
    position: "absolute",
    left: Math.floor(renderer.width / 2),
    top: 0,
  });
  renderer.root.add(canvas);

  // Create dialogue box (left half)
  const dialogueBox = new BoxRenderable(renderer, {
    id: "dialogue-box",
    width: boxWidth,
    height: boxHeight,
    position: "absolute",
    left: 2,
    top: 2,
    border: true,
    borderStyle: "single",
    borderColor: "#FFFFFF",
    padding: 1,
    flexDirection: "column",
  });

  const titleText = new TextRenderable(renderer, {
    id: "title",
    content: text`${bold(fg(CLAUDE_COLOR)("DIALOGUE"))} ${bold("DEMO")}`,
    marginBottom: 1,
  });

  const contentText = new TextRenderable(renderer, {
    id: "content",
    content: text``,
  });

  const optionsBox = new BoxRenderable(renderer, {
    id: "options",
    flexDirection: "row",
    marginTop: 2,
    visible: false,
  });

  dialogueBox.add(titleText);
  dialogueBox.add(contentText);
  dialogueBox.add(optionsBox);
  renderer.root.add(dialogueBox);

  // ==========================================================================
  // Dialogue State
  // ==========================================================================

  const cameraState = {
    x: config.camera.eye[0],
    y: config.camera.eye[1],
    z: config.camera.eye[2],
    fov: config.camera.fov,
  };

  const actionQueue = new ActionQueue(
    (target) => {
      switch (target) {
        case "camera.x": return cameraState.x;
        case "camera.y": return cameraState.y;
        case "camera.z": return cameraState.z;
        case "camera.fov": return cameraState.fov;
        default: return 0;
      }
    },
    (target, value) => {
      switch (target) {
        case "camera.x": cameraState.x = value; break;
        case "camera.y": cameraState.y = value; break;
        case "camera.z": cameraState.z = value; break;
        case "camera.fov": cameraState.fov = value; break;
      }
    }
  );

  const dialogue = new DialogueExecutor(nodes, "start", actionQueue);

  let currentText: StyledText = text``;
  let currentIndex = 0;
  let typingFinished = false;
  let selectedOption = 0;
  let options: { label: string; target: string }[] = [];

  dialogue.onTextUpdate = (text, index, finished) => {
    currentText = text;
    currentIndex = index;
    typingFinished = finished;
  };

  dialogue.onShowOptions = (opts) => {
    options = opts;
    selectedOption = 0;
    optionsBox.visible = true;
    rebuildOptions();
  };

  dialogue.onHideOptions = () => {
    options = [];
    optionsBox.visible = false;
  };

  function rebuildOptions() {
    // Clear existing
    for (const child of optionsBox.getChildren()) {
      optionsBox.remove(child.id);
    }
    // Add new
    options.forEach((opt, i) => {
      const isSelected = i === selectedOption;
      const label = isSelected
        ? text`${fg("#00FF00")(`> [ ${opt.label} ]`)}`
        : text`${dim(opt.label)}`;
      const optText = new TextRenderable(renderer, {
        id: `opt-${i}`,
        content: label,
        marginRight: 3,
      });
      optionsBox.add(optText);
    });
  }

  // ==========================================================================
  // Input Handling
  // ==========================================================================

  process.stdin.on("data", (data) => {
    const s = data.toString();

    if (s === "\u001b[C" || s === "l") {
      // Right arrow
      if (options.length > 0 && dialogue.phase === "waiting") {
        selectedOption = Math.min(selectedOption + 1, options.length - 1);
        rebuildOptions();
      }
    } else if (s === "\u001b[D" || s === "h") {
      // Left arrow
      if (options.length > 0 && dialogue.phase === "waiting") {
        selectedOption = Math.max(selectedOption - 1, 0);
        rebuildOptions();
      }
    } else if (s === " " || s === "\r" || s === "\n") {
      // Space/Enter - select option if on prompt, otherwise advance
      if (options.length > 0 && dialogue.phase === "waiting") {
        dialogue.selectOption(selectedOption);
      } else {
        dialogue.advance();
      }
    }
  });

  // ==========================================================================
  // Render Loop
  // ==========================================================================

  let time = 0;

  renderer.setFrameCallback(async (deltaTime) => {
    const dt = deltaTime / 1000;
    time += dt;

    // Update dialogue and actions
    actionQueue.tick(dt);
    dialogue.tick(dt);

    // Update content text
    const visibleText = sliceStyledText(currentText, currentIndex);
    contentText.content = typingFinished ? visibleText : new StyledText([
      ...visibleText.chunks,
      { __isChunk: true, text: "█", attributes: 0, fg: RGBA.fromHex("#CCCCCC") } as TextChunk,
    ]);

    // Update 3D scene
    wasm.exports.compute_background(time);
    const bg: Vec3 = [wasm.bgColor[0]!, wasm.bgColor[1]!, wasm.bgColor[2]!];
    renderer.setBackgroundColor(RGBA.fromValues(bg[0], bg[1], bg[2], 1));
    canvas.frameBuffer.clear(RGBA.fromValues(bg[0], bg[1], bg[2], 1));

    const sceneObj = getActiveScene();
    const frame = sceneObj.update(time);
    const flatScene = compileScene(frame.objects, sceneObj.groupDefs, sceneObj.config.smoothK);
    loadScene(wasm, flatScene);

    // Use dialogue-controlled camera
    const camera = new Camera({
      eye: [cameraState.x, cameraState.y, cameraState.z] as Vec3,
      at: config.camera.at,
      up: config.camera.up,
      fov: cameraState.fov,
    });

    setupCamera(wasm, camera, sceneWidth, sceneHeight);
    wasm.exports.generate_rays(sceneWidth, sceneHeight);

    const lighting = frame.lighting ?? sceneObj.config.lighting;
    const [dx, dy, dz] = lighting.directional.direction;
    wasm.exports.set_lighting(lighting.ambient, dx, dy, dz, lighting.directional.intensity);
    wasm.exports.set_point_lights(0);
    wasm.exports.march_rays();
    wasm.exports.composite(sceneWidth, sceneHeight);

    // Copy to framebuffer
    const buffers = (canvas.frameBuffer as any).buffers;
    const count = sceneWidth * sceneHeight;
    buffers.char.set(wasm.outChar.subarray(0, count));
    buffers.fg.set(wasm.outFg.subarray(0, count * 4));
    for (let i = 0; i < count; i++) {
      const base = i * 4;
      buffers.bg[base] = bg[0];
      buffers.bg[base + 1] = bg[1];
      buffers.bg[base + 2] = bg[2];
      buffers.bg[base + 3] = 1.0;
    }
  });

  renderer.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
