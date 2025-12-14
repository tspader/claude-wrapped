/**
 * Shared utilities for scene system.
 */

import { createNoise2D } from "simplex-noise";
import type { ObjectDef, GroupDef, FlatScene } from "./types";

// =============================================================================
// Random
// =============================================================================

export function seededRandom(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

// =============================================================================
// Noise
// =============================================================================

export function createNoiseGenerator(rng: () => number) {
  const noise2D = createNoise2D(rng);

  return function pnoise1(x: number, octaves: number = 1): number {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let maxValue = 0;

    for (let i = 0; i < octaves; i++) {
      value += noise2D(x * frequency, 0) * amplitude;
      maxValue += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }

    return value / maxValue;
  };
}

// =============================================================================
// Easing
// =============================================================================

export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

// =============================================================================
// Scene Compilation
// =============================================================================

/**
 * Compiles ObjectDef[] to flat typed arrays for WASM.
 */
export function compileScene(
  objects: ObjectDef[],
  groupDefs: GroupDef[],
  smoothK: number
): FlatScene {
  const n = objects.length;
  const types = new Uint8Array(n);
  const params = new Float32Array(n * 4);  // 4 floats per shape (padded)
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const groups = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const obj = objects[i]!;

    types[i] = obj.shape.type;
    groups[i] = obj.group;

    // Copy params (up to 4, rest stays 0)
    for (let j = 0; j < obj.shape.params.length && j < 4; j++) {
      params[i * 4 + j] = obj.shape.params[j]!;
    }

    positions[i * 3] = obj.position[0];
    positions[i * 3 + 1] = obj.position[1];
    positions[i * 3 + 2] = obj.position[2];

    colors[i * 3] = obj.shape.color[0];
    colors[i * 3 + 1] = obj.shape.color[1];
    colors[i * 3 + 2] = obj.shape.color[2];
  }

  // Build group blend modes array
  const groupBlendModes = new Uint8Array(groupDefs.length);
  for (let g = 0; g < groupDefs.length; g++) {
    groupBlendModes[g] = groupDefs[g]!.blendMode;
  }

  return {
    types,
    params,
    positions,
    colors,
    groups,
    groupBlendModes,
    count: n,
    groupCount: groupDefs.length,
    smoothK,
  };
}
