/**
 * Camera and math utilities for ray generation.
 */

export type Vec3 = [number, number, number];

// =============================================================================
// Math Helpers
// =============================================================================

export function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len === 0) return v;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

// =============================================================================
// Camera
// =============================================================================

export interface CameraConfig {
  eye?: Vec3;
  at?: Vec3;
  up?: Vec3;
  fov?: number;
}

export class Camera {
  eye: Vec3;
  at: Vec3;
  up: Vec3;
  fov: number;

  constructor(cfg: CameraConfig = {}) {
    this.eye = cfg.eye ?? [0, 2, -8];
    this.at = cfg.at ?? [0, 0, 0];
    this.up = cfg.up ?? [0, 1, 0];
    this.fov = cfg.fov ?? 60;
  }
}
