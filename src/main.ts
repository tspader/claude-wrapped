#!/usr/bin/env bun
/**
 * Claude Wrapped - TUI with raymarched scene and dialogue system.
 */

import {
  createCliRenderer,
  FrameBufferRenderable,
  BoxRenderable,
  TextRenderable,
  SliderRenderable,
  RGBA,
  t as text,
  fg,
  dim,
  bold,
  underline,
  StyledText,
  type TextChunk,
  brightYellow,
  brightCyan,
} from "@opentui/core";
import { Camera, type Vec3, normalize, cross, sub } from "./camera";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  compileScene,
  getClaudeBoxes,
  type FlatScene,
  ShapeType,
  BlendMode,
  type ObjectDef,
  type GroupDef,
} from "./scene";
import { ActionQueue, easeInOutCubic, easeInQuad } from "./scene/script";
import { DialogueExecutor, type DialogueNode } from "./scene/dialogue";
import { seededRandom } from "./scene/utils";
import { checkStatsExistence, readStatsCache, postStatsToApi, invokeClaudeStats } from "./utils/stats";

// =============================================================================
// Scene Config (inlined from scripted.ts)
// =============================================================================

const sceneConfig = {
  camera: {
    eye: [0.0, 0.5, -5.0] as Vec3,
    at: [0.0, 0.0, 0.0] as Vec3,
    up: [0.0, 1.0, 0.0] as Vec3,
    fov: 25,
  },
};

const CLAUDE_GROUP = 0;
const SNOW_GROUP = 1;

const groupDefs: GroupDef[] = [
  { blendMode: BlendMode.HARD }, // claude
  { blendMode: BlendMode.HARD }, // snow
];

// =============================================================================
// Snow Config
// =============================================================================

const snowParams = {
  count: 30,
  radius: 0.025,
  baseSpeed: 0.2,
  speedJitter: 0.1,
  driftStrength: 0.3,
  minX: -1.5,
  maxX: 1.5,
  minY: -1.0,
  maxY: 1.0,
  minZ: -1.0,
  maxZ: 1.0,
};

interface Snowflake {
  x: number;
  y: number;
  z: number;
  speed: number;
  driftX: number;
  driftZ: number;
}

// =============================================================================
// Dialogue Nodes
// =============================================================================

const CLAUDE_COLOR = "#E07A3C";

const nodes: DialogueNode[] = [
  {
    id: "start",
    type: "prompt",
    text: text`This program grabs Claude Code usage stats, uploads to a database, and compare to other users across the world.

The data is neither sensitive nor identifiable. It's just ${brightYellow("/stats")}.

There's a special surprise at the end!

If you'd still rather not, you can quit the program now`,
    options: [
      { label: "Play", target: "upload-stats"},
      { label: "Quit", target: "quit"},
    ],
    next: "upload-stats"
  },
  {
    id: "quit",
    type: "exit",
    code: 0,
  },
  {
    id: "upload-stats",
    type: "action",
    text: text`Fetching stats from Claude...`,
    onEnter: async (ctx) => {
      const signal = ctx.abortSignal;
      const delay = (ms: number) => new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });

      try {
        ctx.setStatus(text`Running ${brightYellow("claude /stats")}...`);
        await invokeClaudeStats();

        if (!checkStatsExistence()) {
          throw new Error("Stats file not generated.");
        }

        ctx.setStatus(text`Reading local stats...`);
        const stats = readStatsCache();

        ctx.setStatus(text`Posting to backend...`);

        // Retry with exponential backoff: 1s, 4s, 16s, 64s
        const delays = [1, 4, 16, 64];
        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= delays.length; attempt++) {
          if (signal.aborted) return;
          try {
            const response = await postStatsToApi(stats);
            ctx.setData("entry", response.entry);
            ctx.setData("percentiles", response.percentiles);
            ctx.setData("global", response.global);
            ctx.setData("stats", stats);
            ctx.setStatus(text`${fg("#66FF66")("Success!")}`);
            await delay(500);
            ctx.advance();
            return;
          } catch (e: any) {
            lastError = e;
            if (attempt < delays.length) {
              const delaySeconds = delays[attempt]!;
              for (let remaining = delaySeconds; remaining >= 0; remaining--) {
                if (signal.aborted) return;
                ctx.setStatus(text`Failed to upload. Retry ${fg("#FFFF66")(`${attempt + 1}/${delays.length}`)} in ${fg("#FFFF66")(String(remaining))}s...`);
                await delay(1000);
              }
            }
          }
        }

        throw lastError || new Error("Failed to post stats after retries");
      } catch (err: any) {
        if (err.name === "AbortError") return;
        const msg = err instanceof Error ? err.message : String(err);
        ctx.setStatus(text`${fg("#FF6666")("Error:")} ${msg}`);
        await delay(2000);
        ctx.advance();
      }
    },
    next: "lights-off",
  },
  {
    id: "lights-off",
    type: "script",
    script: [
      { type: "lerp", target: "directionalIntensity", to: 0.0, duration: 1, easing: easeInOutCubic },
      { type: "lerp", target: "ambientIntensity", to: 0.1, duration: 1, easing: easeInOutCubic },
    ],
    next: "lights-on",
  },

  {
    id: "lights-on",
    type: "script",
    script: [
      { type: "lerp", target: "snowLightIntensity", to: 2.0, duration: 4, easing: easeInQuad },
    ],
    next: "light-rise",
  },
  {
    id: "light-rise",
    type: "script",
    script: [
      { type: "lerp", target: "light.y", to: 0.8, duration: 2.0, easing: easeInOutCubic },
      { type: "lerp", target: "light.z", to: -0.3, duration: 2.0, easing: easeInOutCubic },
      { type: "lerp", target: "light.intensity", to: 2.0, duration: 2.0, easing: easeInQuad },
      { type: "lerp", target: "ambientIntensity", to: 0.4, duration: 2.0, easing: easeInOutCubic },
    ],
    next: "move-top-left",
  },

  // Stats display nodes
  {
    id: "move-top-left",
    type: "script",
    script: [
      { type: "lerp", target: "directionalIntensity", to: 0.1, duration: 1.0, easing: easeInOutCubic },
      { type: "lerp", target: "camera.x", to: -2.0, duration: 1.5, easing: easeInOutCubic },
      { type: "lerp", target: "camera.y", to: 1.0, duration: 1.5, easing: easeInOutCubic },
      { type: "lerp", target: "camera.z", to: -2.0, duration: 1.5, easing: easeInOutCubic },
    ],
    next: "stat-messages",
  },
  {
    id: "stat-messages",
    type: "text",
    text: (getData) => {
      const entry = getData("entry");
      const percentiles = getData("percentiles");
      const pct = Math.round(percentiles?.messages || 0);
      return text`Messages: ${fg(CLAUDE_COLOR)(String(entry?.total_messages || 0))} (${pct}th percentile)`;
    },
    next: "move-center",
  },

  {
    id: "move-center",
    type: "script",
    script: [
      { type: "lerp", target: "camera.x", to: 0.0, duration: 1.5, easing: easeInOutCubic },
      { type: "lerp", target: "camera.y", to: 1.0, duration: 1.5, easing: easeInOutCubic },
      { type: "lerp", target: "camera.z", to: -3.0, duration: 1.5, easing: easeInOutCubic },
      { type: "lerp", target: "smoothK", to: 0.3, duration: 4, easing: easeInOutCubic },
    ],
    next: "stat-tokens",
  },
  {
    id: "stat-tokens",
    type: "text",
    text: (getData) => {
      const entry = getData("entry");
      const percentiles = getData("percentiles");
      const pct = Math.round(percentiles?.tokens || 0);
      const tokens = entry?.total_tokens || 0;
      const formatted = tokens >= 1000000 ? `${(tokens / 1000000).toFixed(1)}M` : tokens >= 1000 ? `${(tokens / 1000).toFixed(0)}K` : String(tokens);
      return text`Tokens: ${fg(CLAUDE_COLOR)(formatted)} (${pct}th percentile)`;
    },
    next: "move-top-right",
  },

  {
    id: "move-under",
    type: "script",
    script: [
      { type: "lerp", target: "camera.x", to: 0.0, duration: 1.5, easing: easeInOutCubic },
      { type: "lerp", target: "camera.y", to: -0.8, duration: 1.5, easing: easeInOutCubic },
      { type: "lerp", target: "camera.z", to: -1.5, duration: 1.5, easing: easeInOutCubic },
    ],
    next: "stat-persona",
  },
  {
    id: "stat-persona",
    type: "text",
    text: (getData) => {
      const entry = getData("entry");
      const persona = entry?.time_persona ?? 4;
      const labels = ["Morning Person", "Afternoon Person", "Evening Person", "Night Owl", "Mystery"];
      const label = labels[persona] || "Mystery";
      const counts = [
        entry?.morning_count || 0,
        entry?.afternoon_count || 0,
        entry?.evening_count || 0,
        entry?.night_count || 0,
      ];
      const total = counts.reduce((a, b) => a + b, 0);
      const pct = total > 0 ? Math.round((counts[persona] || 0) / total * 100) : 0;
      return text`You're a ${fg(CLAUDE_COLOR)(label)} (${pct}% of sessions)`;
    },
    next: "move-top-right",
  },

  {
    id: "move-top-right",
    type: "script",
    script: [
      { type: "lerp", target: "camera.x", to: 2.0, duration: 1.5, easing: easeInOutCubic },
      { type: "lerp", target: "camera.y", to: 1.0, duration: 1.5, easing: easeInOutCubic },
      { type: "lerp", target: "camera.z", to: -2.0, duration: 1.5, easing: easeInOutCubic },
      { type: "lerp", target: "smoothK", to: 0.6, duration: 4, easing: easeInOutCubic },
    ],
    next: "stat-cost",
  },
  {
    id: "stat-cost",
    type: "text",
    text: (getData) => {
      const entry = getData("entry");
      const percentiles = getData("percentiles");
      const pct = Math.round(percentiles?.cost || 0);
      const cost = entry?.total_cost || 0;
      return text`Cost: ${fg(CLAUDE_COLOR)(`$${cost.toFixed(2)}`)} (${pct}th percentile)`;
    },
    next: "clean",
  },
  {
    id: "clean",
    type: "script",
    script: [
      { type: "lerp", target: "camera.x", to: 0.0, duration: 1.5, easing: easeInOutCubic },
      { type: "lerp", target: "camera.y", to: 1.0, duration: 1.5, easing: easeInOutCubic },
      { type: "lerp", target: "camera.z", to: -3.0, duration: 1.5, easing: easeInOutCubic },
      { type: "lerp", target: "smoothK", to: 0.0, duration: 4, easing: easeInOutCubic },
    ],
    next: "epilogue_001",
  },
  {
    id: "epilogue_001",
    type: "text",
    text: text`That's it. It's done.

Did I spend far, far too much time writing an SDF raymarcher instead of making this a fun wrapped?

Yeah, probably. But, damn it, this is the world we live in! A world where TUIs are worth a billion dollars, and text streams are the universal interface.

A world with WebAssembly, and LLVM, and Bun, with HTML and CSS and Yoga and OpenTUI, and Zig, and unimaginable opportunity for making money by having fun with computers.

I'm thankful for a world with Inigo Quilez! And Andrew Kelley, and jart, and Carmack, and Karpathy, and Jon, and Casey, and all the other folks who I've looked up to programming and have taught me so much.`,
    next: "epilogue_002"
  },
  {
    id: "epilogue_002",
    type: "text",
    text: text`And, of course, a world with Fabrice Bellard. Fabrice, if this gets to you -- thanks. You're the god damn man.

If you made it this far, thanks. There's a renderer sandbox on the next screen which is fun to play with. But why does mankind do anything if not for the chance of opportunistic shilling...?`,
    next: "end"
  },
  {
    id: "end",
    type: "text",
    text: text`If you enjoyed this, try Deep Copy's free demo. It's a point-and-click literary puzzle game set in a hand-painted science fiction world, for lovers of Philip K. Dick, Pynchon, Disco Elysium, and classic adventure games.

  http://store.steampowered.com/app/2639990/Deep_Copy

Or try my website, within which the imagination reels with the infinite possiblity of creation. Like, uh...articles about writing good looking C. Infinite, folks.

  https://spader.zone/tricks/

And, if by some miracle, you're still reading, have a look at my extremely unreleased "Cargo but for C"

  https://github.com/tspader/spn

And now, the sandbox!`,
    next: "sandbox",
  },
  {
    id: "sandbox",
    type: "action",
    text: text`Scene Sandbox - use arrow keys to adjust sliders, q to quit`,
    onEnter: async (ctx) => {
      ctx.setData("sandboxMode", true);
    },
    next: "sandbox",
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

  const titleBox = new BoxRenderable(renderer, {
    id: "title-box",
    width: "100%",
    alignItems: "center",
    marginBottom: 1,
  });

  const titleText = new TextRenderable(renderer, {
    id: "title",
    content: text`${bold(fg(CLAUDE_COLOR)("CLAUDE"))} ${bold("WRAPPED")}`,
  });

  titleBox.add(titleText);

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

  const continueBox = new BoxRenderable(renderer, {
    id: "continue-box",
    width: "100%",
    alignItems: "center",
    marginTop: 2,
    visible: false,
  });

  const continueText = new TextRenderable(renderer, {
    id: "continue-text",
    content: text`press ${brightCyan("space")} to continue`,
  });

  continueBox.add(continueText);

  const sandboxBox = new BoxRenderable(renderer, {
    id: "sandbox-box",
    width: "100%",
    flexDirection: "column",
    visible: false,
  });

  interface SliderConfig {
    id: string;
    label: string;
    min: number;
    max: number;
    initial: number;
    getValue: () => number;
    setValue: (v: number) => void;
  }

  const sliderConfigs: SliderConfig[] = [];
  const sliderRefs: { slider: SliderRenderable; label: TextRenderable; config: SliderConfig }[] = [];

  const createSliderRow = (config: SliderConfig) => {
    const row = new BoxRenderable(renderer, {
      id: `slider-row-${config.id}`,
      width: "100%",
      flexDirection: "row",
      alignItems: "center",
      marginBottom: 1,
    });

    const labelText = new TextRenderable(renderer, {
      id: `slider-label-${config.id}`,
      content: text`${config.label}: ${config.initial.toFixed(2)}`,
      width: 20,
    });

    const slider = new SliderRenderable(renderer, {
      id: `slider-${config.id}`,
      orientation: "horizontal",
      width: boxWidth - 26,
      height: 1,
      min: config.min,
      max: config.max,
      value: config.initial,
      backgroundColor: "#333333",
      foregroundColor: CLAUDE_COLOR,
      onChange: (value) => {
        config.setValue(value);
        labelText.content = text`${config.label}: ${value.toFixed(2)}`;
      },
    });

    row.add(labelText);
    row.add(slider);
    sandboxBox.add(row);
    sliderRefs.push({ slider, label: labelText, config });
  };

  dialogueBox.add(titleBox);
  dialogueBox.add(contentText);
  dialogueBox.add(optionsBox);
  dialogueBox.add(continueBox);
  dialogueBox.add(sandboxBox);
  renderer.root.add(dialogueBox);

  // ==========================================================================
  // Dialogue State
  // ==========================================================================

  const cameraState = {
    x: sceneConfig.camera.eye[0],
    y: sceneConfig.camera.eye[1],
    z: sceneConfig.camera.eye[2],
    fov: sceneConfig.camera.fov,
  };

  // Static lighting config
  let ambientIntensity = 0.4;
  let directionalIntensity = 1.0;
  const lightDirection: Vec3 = [0.5, 0.75, -1.0];

  // Dramatic point light state (dialogue-controlled)
  const dramaticLight = {
    x: 0.0,
    y: 0.0,
    z: -1.0,
    intensity: 0,
  };
  const dramaticLightColor: Vec3 = [0.8, 0.9, 1.0];

  // Snowflake point lights (dialogue-controlled intensity)
  let snowLightIntensity = 0;
  const snowLightColor: Vec3 = [0.8, 0.9, 1.0];
  const snowLightRadius = 0.2;

  const dramaticLightRadius = 0.5;

  let smoothK = 0.0;

  // ==========================================================================
  // Sandbox Sliders
  // ==========================================================================

  createSliderRow({
    id: "cam-x", label: "Camera X", min: -5.0, max: 5.0, initial: cameraState.x,
    getValue: () => cameraState.x, setValue: (v) => { cameraState.x = v; },
  });
  createSliderRow({
    id: "cam-y", label: "Camera Y", min: -2.0, max: 3.0, initial: cameraState.y,
    getValue: () => cameraState.y, setValue: (v) => { cameraState.y = v; },
  });
  createSliderRow({
    id: "cam-z", label: "Camera Z", min: -10.0, max: -1.0, initial: cameraState.z,
    getValue: () => cameraState.z, setValue: (v) => { cameraState.z = v; },
  });
  createSliderRow({
    id: "fov", label: "FOV", min: 10, max: 90, initial: cameraState.fov,
    getValue: () => cameraState.fov, setValue: (v) => { cameraState.fov = v; },
  });
  createSliderRow({
    id: "ambient", label: "Ambient", min: 0.0, max: 1.0, initial: ambientIntensity,
    getValue: () => ambientIntensity, setValue: (v) => { ambientIntensity = v; },
  });
  createSliderRow({
    id: "directional", label: "Directional", min: 0.0, max: 2.0, initial: directionalIntensity,
    getValue: () => directionalIntensity, setValue: (v) => { directionalIntensity = v; },
  });
  createSliderRow({
    id: "smooth-k", label: "Shape Blending", min: 0.0, max: 1.0, initial: smoothK,
    getValue: () => smoothK, setValue: (v) => { smoothK = v; },
  });
  createSliderRow({
    id: "snow-light", label: "Snow Light", min: 0.0, max: 5.0, initial: snowLightIntensity,
    getValue: () => snowLightIntensity, setValue: (v) => { snowLightIntensity = v; },
  });

  // ==========================================================================
  // Snow State
  // ==========================================================================

  const rng = seededRandom(123);

  // Initialize snowflakes
  const snowflakes: Snowflake[] = [];
  const { count, minX, maxX, minY, maxY, minZ, maxZ, baseSpeed, speedJitter, driftStrength } = snowParams;
  const spawnRadius = 1.5;

  for (let i = 0; i < count; i++) {
    const angle = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * spawnRadius;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;

    snowflakes.push({
      x,
      y: minY + rng() * (maxY - minY),
      z,
      speed: baseSpeed + (rng() - 0.5) * 2 * speedJitter,
      driftX: (rng() - 0.5) * 2 * driftStrength,
      driftZ: (rng() - 0.5) * 2 * driftStrength,
    });
  }

  let lastTime = 0;

  const actionQueue = new ActionQueue(
    (target) => {
      switch (target) {
        case "camera.x": return cameraState.x;
        case "camera.y": return cameraState.y;
        case "camera.z": return cameraState.z;
        case "camera.fov": return cameraState.fov;
        case "light.x": return dramaticLight.x;
        case "light.y": return dramaticLight.y;
        case "light.z": return dramaticLight.z;
        case "light.intensity": return dramaticLight.intensity;
        case "snowLightIntensity": return snowLightIntensity;
        case "directionalIntensity": return directionalIntensity;
        case "ambientIntensity": return ambientIntensity;
        case "smoothK": return smoothK;
        default: return 0;
      }
    },
    (target, value) => {
      switch (target) {
        case "camera.x": cameraState.x = value; break;
        case "camera.y": cameraState.y = value; break;
        case "camera.z": cameraState.z = value; break;
        case "camera.fov": cameraState.fov = value; break;
        case "light.x": dramaticLight.x = value; break;
        case "light.y": dramaticLight.y = value; break;
        case "light.z": dramaticLight.z = value; break;
        case "light.intensity": dramaticLight.intensity = value; break;
        case "snowLightIntensity": snowLightIntensity = value; break;
        case "directionalIntensity": directionalIntensity = value; break;
        case "ambientIntensity": ambientIntensity = value; break;
        case "smoothK": smoothK = value; break;
      }
    }
  );

  const dialogue = new DialogueExecutor(nodes, "start", actionQueue);

  let currentText: StyledText = text``;
  let currentIndex = 0;
  let typingFinished = false;
  let selectedOption = 0;
  let options: { label: string; target: string }[] = [];
  let sandboxMode = false;
  let selectedSlider = 0;

  dialogue.onTextUpdate = (textContent, index, finished) => {
    currentText = textContent;
    currentIndex = index;
    typingFinished = finished;
    if (index === 0 && !finished) {
      contentText.scrollY = 0;
    }
    if (dialogue.currentNodeId === "sandbox" && !sandboxMode) {
      sandboxMode = true;
      sandboxBox.visible = true;
      continueBox.visible = false;
      for (const { slider, label, config } of sliderRefs) {
        slider.value = config.getValue();
        label.content = text`${config.label}: ${config.getValue().toFixed(2)}`;
      }
      updateSliderSelection();
    }
  };

  function updateSliderSelection() {
    sliderRefs.forEach(({ slider }, i) => {
      slider.foregroundColor = i === selectedSlider ? "#00FF00" : CLAUDE_COLOR;
    });
  }

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

  dialogue.onExit = (code) => {
    renderer.stop();
    process.exit(code);
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

    if (sandboxMode) {
      if (s === "q" || s === "\u0003") {
        renderer.stop();
        process.exit(0);
      } else if (s === "\u001b[A" || s === "k") {
        selectedSlider = Math.max(0, selectedSlider - 1);
        updateSliderSelection();
      } else if (s === "\u001b[B" || s === "j") {
        selectedSlider = Math.min(sliderRefs.length - 1, selectedSlider + 1);
        updateSliderSelection();
      } else if (s === "\u001b[C" || s === "l") {
        const ref = sliderRefs[selectedSlider];
        if (ref) {
          const range = ref.config.max - ref.config.min;
          const step = range / 50;
          ref.slider.value = Math.min(ref.config.max, ref.slider.value + step);
        }
      } else if (s === "\u001b[D" || s === "h") {
        const ref = sliderRefs[selectedSlider];
        if (ref) {
          const range = ref.config.max - ref.config.min;
          const step = range / 50;
          ref.slider.value = Math.max(ref.config.min, ref.slider.value - step);
        }
      }
      return;
    }

    if (s === "\u001b[C" || s === "l") {
      if (options.length > 0 && dialogue.phase === "waiting") {
        selectedOption = Math.min(selectedOption + 1, options.length - 1);
        rebuildOptions();
      }
    } else if (s === "\u001b[D" || s === "h") {
      if (options.length > 0 && dialogue.phase === "waiting") {
        selectedOption = Math.max(selectedOption - 1, 0);
        rebuildOptions();
      }
    } else if (s === " " || s === "\r" || s === "\n") {
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
    if (!typingFinished) {
      contentText.content = new StyledText([
        ...visibleText.chunks,
        { __isChunk: true, text: "█", attributes: 0, fg: RGBA.fromHex("#CCCCCC") } as TextChunk,
      ]);
      continueBox.visible = false;
    } else if (options.length === 0 && dialogue.phase === "waiting") {
      contentText.content = visibleText;
      continueBox.visible = true;
    } else {
      contentText.content = visibleText;
      continueBox.visible = false;
    }

    // Update 3D scene
    wasm.exports.compute_background(time);
    const bg: Vec3 = [wasm.bgColor[0]!, wasm.bgColor[1]!, wasm.bgColor[2]!];
    renderer.setBackgroundColor(RGBA.fromValues(bg[0], bg[1], bg[2], 1));
    canvas.frameBuffer.clear(RGBA.fromValues(bg[0], bg[1], bg[2], 1));

    // Update snowflakes
    const snowDt = time - lastTime;
    lastTime = time;
    for (const flake of snowflakes) {
      flake.y -= flake.speed * snowDt;
      flake.x += flake.driftX * snowDt;
      flake.z += flake.driftZ * snowDt;

      // Wrap horizontally
      if (flake.x < minX) flake.x += (maxX - minX);
      if (flake.x > maxX) flake.x -= (maxX - minX);
      if (flake.z < minZ) flake.z += (maxZ - minZ);
      if (flake.z > maxZ) flake.z -= (maxZ - minZ);

      // Reset to top if fallen below
      if (flake.y < minY) {
        flake.y = maxY;
      }
    }

    // Build scene objects: Claude + snowflakes
    const claudeObjects = getClaudeBoxes([0, 0, 0], 1.0, CLAUDE_GROUP);
    const snowObjects: ObjectDef[] = snowflakes.map((flake) => ({
      shape: {
        type: ShapeType.SPHERE,
        params: [snowParams.radius],
        color: [1.0, 1.0, 1.0] as Vec3,
      },
      position: [flake.x, flake.y, flake.z] as Vec3,
      group: SNOW_GROUP,
    }));

    const allObjects = [...claudeObjects, ...snowObjects];
    const flatScene = compileScene(allObjects, groupDefs, smoothK);
    loadScene(wasm, flatScene);

    const camera = new Camera({
      eye: [cameraState.x, cameraState.y, cameraState.z] as Vec3,
      at: sceneConfig.camera.at,
      up: sceneConfig.camera.up,
      fov: cameraState.fov,
    });

    setupCamera(wasm, camera, sceneWidth, sceneHeight);
    wasm.exports.generate_rays(sceneWidth, sceneHeight);

    // Directional light
    const [dx, dy, dz] = lightDirection;
    wasm.exports.set_lighting(ambientIntensity, dx, dy, dz, directionalIntensity);

    // Dramatic point light (index 0)
    wasm.pointLightX[0] = dramaticLight.x;
    wasm.pointLightY[0] = dramaticLight.y;
    wasm.pointLightZ[0] = dramaticLight.z;
    wasm.pointLightR[0] = dramaticLightColor[0];
    wasm.pointLightG[0] = dramaticLightColor[1];
    wasm.pointLightB[0] = dramaticLightColor[2];
    wasm.pointLightIntensity[0] = dramaticLight.intensity;
    wasm.pointLightRadius[0] = dramaticLightRadius;

    // Snowflake point lights (indices 1-30)
    const numSnowLights = Math.min(snowflakes.length, 30);
    for (let i = 0; i < numSnowLights; i++) {
      const flake = snowflakes[i]!;
      const idx = i + 1;
      wasm.pointLightX[idx] = flake.x;
      wasm.pointLightY[idx] = flake.y;
      wasm.pointLightZ[idx] = flake.z;
      wasm.pointLightR[idx] = snowLightColor[0];
      wasm.pointLightG[idx] = snowLightColor[1];
      wasm.pointLightB[idx] = snowLightColor[2];
      wasm.pointLightIntensity[idx] = snowLightIntensity;
      wasm.pointLightRadius[idx] = snowLightRadius;
    }
    wasm.exports.set_point_lights(1 + numSnowLights);
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
