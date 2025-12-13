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

  generateRays(
    width: number,
    height: number
  ): { origins: Vec3[]; directions: Vec3[] } {
    const forward = normalize(sub(this.at, this.eye));
    const right = normalize(cross(forward, this.up));
    const up = cross(right, forward);

    const aspect = width / height;
    const fovRad = (this.fov * Math.PI) / 180;
    const halfHeight = Math.tan(fovRad / 2);
    const halfWidth = halfHeight * aspect;

    const origins: Vec3[] = [];
    const directions: Vec3[] = [];

    for (let row = 0; row < height; row++) {
      const v = 1 - (2 * row) / (height - 1); // +1 top, -1 bottom
      for (let col = 0; col < width; col++) {
        const u = (2 * col) / (width - 1) - 1; // -1 left, +1 right

        const dir: Vec3 = [
          forward[0] + u * halfWidth * right[0] + v * halfHeight * up[0],
          forward[1] + u * halfWidth * right[1] + v * halfHeight * up[1],
          forward[2] + u * halfWidth * right[2] + v * halfHeight * up[2],
        ];

        origins.push([...this.eye]);
        directions.push(normalize(dir));
      }
    }

    return { origins, directions };
  }
}
