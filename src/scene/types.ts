/**
 * Shared types for scene system.
 */

export type Vec3 = [number, number, number];

// =============================================================================
// Shape Types
// =============================================================================

export const ShapeType = {
  SPHERE: 0,
  BOX: 1,
  CYLINDER: 2,
} as const;

export const BlendMode = {
  HARD: 0,    // min() - distinct shapes
  SMOOTH: 1, // smooth union - blobby
} as const;

// =============================================================================
// Scene Data Types
// =============================================================================

export interface ShapeDef {
  type: number;           // ShapeType
  params: number[];       // [radius] for sphere, [w,h,d] for box
  color: Vec3;
}

export interface ObjectDef {
  shape: ShapeDef;
  position: Vec3;
  group: number;          // group ID for hierarchical blending
}

export interface GroupDef {
  blendMode: number;      // BlendMode - how shapes blend within this group
}

export interface FlatScene {
  types: Uint8Array;
  params: Float32Array;   // 4 floats per shape (padded)
  positions: Float32Array; // 3 floats per shape
  colors: Float32Array;    // 3 floats per shape
  groups: Uint8Array;      // group ID per shape
  groupBlendModes: Uint8Array; // blend mode per group
  count: number;
  groupCount: number;
  smoothK: number;
}

// =============================================================================
// Config Types
// =============================================================================

export interface LightingConfig {
  ambient: number;
  directional: {
    direction: Vec3;
    intensity: number;
  };
}

export interface SceneConfig {
  camera: {
    eye: Vec3;
    at: Vec3;
    up: Vec3;
    fov: number;
  };
  lighting: LightingConfig;
  smoothK: number;
}

// =============================================================================
// Scene Interface
// =============================================================================

export interface SceneFrame {
  objects: ObjectDef[];
  lighting?: LightingConfig;  // optional per-frame lighting override
}

export interface Scene {
  name: string;
  config: SceneConfig;
  groupDefs: GroupDef[];
  init(): void;
  update(t: number): SceneFrame;
}
