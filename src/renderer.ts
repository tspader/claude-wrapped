/**
 * Terminal ray marcher for SDFs with lighting and color support.
 */

export type Vec3 = [number, number, number];
export type Points = Vec3[];

// =============================================================================
// Math Helpers
// =============================================================================

export function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len === 0) return v;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

export function abs3(v: Vec3): Vec3 {
  return [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
}

export function max3(v: Vec3, s: number): Vec3 {
  return [Math.max(v[0], s), Math.max(v[1], s), Math.max(v[2], s)];
}

export function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

// =============================================================================
// SDF Base and Primitives
// =============================================================================

export abstract class SDF {
  abstract evaluate(p: Vec3): number;

  union(other: SDF): SDF {
    return new SDFUnion(this, other);
  }

  intersection(other: SDF): SDF {
    return new SDFIntersection(this, other);
  }

  difference(other: SDF): SDF {
    return new SDFDifference(this, other);
  }

  translate(offset: Vec3): SDF {
    return new SDFTranslate(this, offset);
  }

  rotateY(angle: number): SDF {
    return new SDFRotateY(this, angle);
  }

  scale(factor: number): SDF {
    return new SDFScale(this, factor);
  }
}

export class SDFSphere extends SDF {
  constructor(
    public radius: number = 1.0,
    public center: Vec3 = [0, 0, 0]
  ) {
    super();
  }

  evaluate(p: Vec3): number {
    return length(sub(p, this.center)) - this.radius;
  }
}

export class SDFBox extends SDF {
  private halfSize: Vec3;

  constructor(
    size: Vec3 = [1, 1, 1],
    public center: Vec3 = [0, 0, 0]
  ) {
    super();
    this.halfSize = [size[0] / 2, size[1] / 2, size[2] / 2];
  }

  evaluate(p: Vec3): number {
    const q = sub(abs3(sub(p, this.center)), this.halfSize);
    return (
      length(max3(q, 0)) + Math.min(Math.max(q[0], Math.max(q[1], q[2])), 0)
    );
  }
}

export class SDFTorus extends SDF {
  constructor(
    public majorRadius: number = 1.0,
    public minorRadius: number = 0.25
  ) {
    super();
  }

  evaluate(p: Vec3): number {
    const xzLen = Math.sqrt(p[0] * p[0] + p[2] * p[2]);
    const q: [number, number] = [xzLen - this.majorRadius, p[1]];
    return Math.sqrt(q[0] * q[0] + q[1] * q[1]) - this.minorRadius;
  }
}

export class SDFPlane extends SDF {
  private normal: Vec3;

  constructor(
    normal: Vec3 = [0, 1, 0],
    public offset: number = 0
  ) {
    super();
    this.normal = normalize(normal);
  }

  evaluate(p: Vec3): number {
    return dot(p, this.normal) + this.offset;
  }
}

export class SDFUnion extends SDF {
  constructor(
    public a: SDF,
    public b: SDF,
    public k: number = 0
  ) {
    super();
  }

  evaluate(p: Vec3): number {
    const d1 = this.a.evaluate(p);
    const d2 = this.b.evaluate(p);
    if (this.k <= 0) {
      return Math.min(d1, d2);
    }
    const h = clamp(0.5 + (0.5 * (d2 - d1)) / this.k, 0, 1);
    return d2 + (d1 - d2) * h - this.k * h * (1 - h);
  }
}

export class SDFIntersection extends SDF {
  constructor(
    public a: SDF,
    public b: SDF,
    public k: number = 0
  ) {
    super();
  }

  evaluate(p: Vec3): number {
    const d1 = this.a.evaluate(p);
    const d2 = this.b.evaluate(p);
    if (this.k <= 0) {
      return Math.max(d1, d2);
    }
    const h = clamp(0.5 - (0.5 * (d2 - d1)) / this.k, 0, 1);
    return d2 + (d1 - d2) * h + this.k * h * (1 - h);
  }
}

export class SDFDifference extends SDF {
  constructor(
    public a: SDF,
    public b: SDF,
    public k: number = 0
  ) {
    super();
  }

  evaluate(p: Vec3): number {
    const d1 = this.a.evaluate(p);
    const d2 = -this.b.evaluate(p);
    if (this.k <= 0) {
      return Math.max(d1, d2);
    }
    const h = clamp(0.5 - (0.5 * (d2 - d1)) / this.k, 0, 1);
    return d2 + (d1 - d2) * h + this.k * h * (1 - h);
  }
}

export class SDFTranslate extends SDF {
  constructor(
    public sdf: SDF,
    public offset: Vec3
  ) {
    super();
  }

  evaluate(p: Vec3): number {
    return this.sdf.evaluate(sub(p, this.offset));
  }
}

export class SDFRotateY extends SDF {
  private cos: number;
  private sin: number;

  constructor(
    public sdf: SDF,
    angle: number
  ) {
    super();
    this.cos = Math.cos(angle);
    this.sin = Math.sin(angle);
  }

  evaluate(p: Vec3): number {
    const rotated: Vec3 = [
      this.cos * p[0] + this.sin * p[2],
      p[1],
      -this.sin * p[0] + this.cos * p[2],
    ];
    return this.sdf.evaluate(rotated);
  }
}

export class SDFScale extends SDF {
  constructor(
    public sdf: SDF,
    public factor: number
  ) {
    super();
  }

  evaluate(p: Vec3): number {
    const scaled: Vec3 = [
      p[0] / this.factor,
      p[1] / this.factor,
      p[2] / this.factor,
    ];
    return this.sdf.evaluate(scaled) * this.factor;
  }
}

export class SDFSmoothUnion extends SDF {
  constructor(
    public a: SDF,
    public b: SDF,
    public k: number = 0.5
  ) {
    super();
  }

  evaluate(p: Vec3): number {
    const d1 = this.a.evaluate(p);
    const d2 = this.b.evaluate(p);
    const h = clamp(0.5 + (0.5 * (d2 - d1)) / this.k, 0, 1);
    return d2 + (d1 - d2) * h - this.k * h * (1 - h);
  }
}

// =============================================================================
// Convenience Constructors (primitives)
// =============================================================================

export const primitives = {
  sphere: (radius: number = 1.0, center: Vec3 = [0, 0, 0]) =>
    new SDFSphere(radius, center),

  box: (size: Vec3 | number = 1, center: Vec3 = [0, 0, 0]) => {
    const s: Vec3 =
      typeof size === "number" ? [size, size, size] : size;
    return new SDFBox(s, center);
  },

  torus: (majorRadius: number = 1.0, minorRadius: number = 0.25) =>
    new SDFTorus(majorRadius, minorRadius),

  plane: (normal: Vec3 = [0, 1, 0], offset: number = 0) =>
    new SDFPlane(normal, offset),

  smoothUnion: (a: SDF, b: SDF, k: number = 0.5) => new SDFSmoothUnion(a, b, k),
};

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

// =============================================================================
// Ray Marcher
// =============================================================================

export interface RayMarcherConfig {
  maxSteps?: number;
  maxDist?: number;
  hitThreshold?: number;
  normalEps?: number;
}

export class RayMarcher {
  maxSteps: number;
  maxDist: number;
  hitThreshold: number;
  normalEps: number;

  constructor(cfg: RayMarcherConfig = {}) {
    this.maxSteps = cfg.maxSteps ?? 64;
    this.maxDist = cfg.maxDist ?? 100;
    this.hitThreshold = cfg.hitThreshold ?? 0.001;
    this.normalEps = cfg.normalEps ?? 0.001;
  }

  march(
    sdf: (p: Vec3) => number,
    origins: Vec3[],
    directions: Vec3[]
  ): {
    hit: boolean[];
    positions: Vec3[];
    distances: number[];
    steps: number[];
  } {
    const nRays = origins.length;
    const positions: Vec3[] = origins.map((o): Vec3 => [o[0], o[1], o[2]]);
    const distances: number[] = new Array(nRays).fill(0);
    const steps: number[] = new Array(nRays).fill(0);
    const active: boolean[] = new Array(nRays).fill(true);

    for (let step = 0; step < this.maxSteps; step++) {
      let anyActive = false;

      for (let i = 0; i < nRays; i++) {
        if (!active[i]) continue;
        anyActive = true;

        const pos = positions[i]!;
        const d = sdf(pos);
        const newDist = distances[i]! + d;
        distances[i] = newDist;

        const orig = origins[i]!;
        const dir = directions[i]!;
        positions[i] = [
          orig[0] + newDist * dir[0],
          orig[1] + newDist * dir[1],
          orig[2] + newDist * dir[2],
        ];

        steps[i] = steps[i]! + 1;

        if (d < this.hitThreshold) {
          active[i] = false;
        } else if (newDist > this.maxDist) {
          active[i] = false;
        }
      }

      if (!anyActive) break;
    }

    const hit = distances.map((d) => d < this.maxDist);
    return { hit, positions, distances, steps };
  }

  /**
   * Batched ray marching using TypedArrays.
   * sdfBatch evaluates all positions at once: (px, py, pz, out) where each is Float64Array
   */
  marchBatched(
    sdfBatch: (px: Float64Array, py: Float64Array, pz: Float64Array, out: Float64Array) => void,
    origins: Vec3[],
    directions: Vec3[]
  ): {
    hit: boolean[];
    positions: Vec3[];
    distances: number[];
  } {
    const n = origins.length;
    
    // Flatten origins/directions to typed arrays
    const ox = new Float64Array(n);
    const oy = new Float64Array(n);
    const oz = new Float64Array(n);
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    const dz = new Float64Array(n);
    
    for (let i = 0; i < n; i++) {
      ox[i] = origins[i]![0];
      oy[i] = origins[i]![1];
      oz[i] = origins[i]![2];
      dx[i] = directions[i]![0];
      dy[i] = directions[i]![1];
      dz[i] = directions[i]![2];
    }
    
    // Current positions
    const px = new Float64Array(ox);
    const py = new Float64Array(oy);
    const pz = new Float64Array(oz);
    
    const distances = new Float64Array(n);
    const sdfOut = new Float64Array(n);
    const active = new Uint8Array(n).fill(1);
    
    for (let step = 0; step < this.maxSteps; step++) {
      // Batch evaluate SDF at all positions
      sdfBatch(px, py, pz, sdfOut);
      
      let anyActive = false;
      for (let i = 0; i < n; i++) {
        if (!active[i]) continue;
        
        const d = sdfOut[i]!;
        const newDist = distances[i]! + d;
        distances[i] = newDist;
        
        // Update position
        px[i] = ox[i]! + distances[i]! * dx[i]!;
        py[i] = oy[i]! + distances[i]! * dy[i]!;
        pz[i] = oz[i]! + distances[i]! * dz[i]!;
        
        if (d < this.hitThreshold || distances[i]! > this.maxDist) {
          active[i] = 0;
        } else {
          anyActive = true;
        }
      }
      
      if (!anyActive) break;
    }
    
    // Convert back to output format
    const hit: boolean[] = new Array(n);
    const positions: Vec3[] = new Array(n);
    const distOut: number[] = new Array(n);
    
    for (let i = 0; i < n; i++) {
      hit[i] = distances[i]! < this.maxDist;
      positions[i] = [px[i]!, py[i]!, pz[i]!];
      distOut[i] = distances[i]!;
    }
    
    return { hit, positions, distances: distOut };
  }

  estimateNormals(sdf: (p: Vec3) => number, positions: Vec3[]): Vec3[] {
    const eps = this.normalEps;
    const normals: Vec3[] = [];

    for (const p of positions) {
      const nx =
        sdf([p[0] + eps, p[1], p[2]]) - sdf([p[0] - eps, p[1], p[2]]);
      const ny =
        sdf([p[0], p[1] + eps, p[2]]) - sdf([p[0], p[1] - eps, p[2]]);
      const nz =
        sdf([p[0], p[1], p[2] + eps]) - sdf([p[0], p[1], p[2] - eps]);

      normals.push(normalize([nx, ny, nz]));
    }

    return normals;
  }

  /**
   * Batched normal estimation
   */
  estimateNormalsBatched(
    sdfBatch: (px: Float64Array, py: Float64Array, pz: Float64Array, out: Float64Array) => void,
    positions: Vec3[]
  ): Vec3[] {
    const n = positions.length;
    const eps = this.normalEps;
    
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    const pz = new Float64Array(n);
    
    for (let i = 0; i < n; i++) {
      px[i] = positions[i]![0];
      py[i] = positions[i]![1];
      pz[i] = positions[i]![2];
    }
    
    // We need 6 SDF evaluations per point, but we can batch all n points per offset
    const pxPlus = new Float64Array(n);
    const pxMinus = new Float64Array(n);
    const pyPlus = new Float64Array(n);
    const pyMinus = new Float64Array(n);
    const pzPlus = new Float64Array(n);
    const pzMinus = new Float64Array(n);
    
    for (let i = 0; i < n; i++) {
      pxPlus[i] = px[i]! + eps;
      pxMinus[i] = px[i]! - eps;
      pyPlus[i] = py[i]! + eps;
      pyMinus[i] = py[i]! - eps;
      pzPlus[i] = pz[i]! + eps;
      pzMinus[i] = pz[i]! - eps;
    }
    
    const outXPlus = new Float64Array(n);
    const outXMinus = new Float64Array(n);
    const outYPlus = new Float64Array(n);
    const outYMinus = new Float64Array(n);
    const outZPlus = new Float64Array(n);
    const outZMinus = new Float64Array(n);
    
    sdfBatch(pxPlus, py, pz, outXPlus);
    sdfBatch(pxMinus, py, pz, outXMinus);
    sdfBatch(px, pyPlus, pz, outYPlus);
    sdfBatch(px, pyMinus, pz, outYMinus);
    sdfBatch(px, py, pzPlus, outZPlus);
    sdfBatch(px, py, pzMinus, outZMinus);
    
    const normals: Vec3[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const nx = outXPlus[i]! - outXMinus[i]!;
      const ny = outYPlus[i]! - outYMinus[i]!;
      const nz = outZPlus[i]! - outZMinus[i]!;
      normals[i] = normalize([nx, ny, nz]);
    }
    
    return normals;
  }
}
