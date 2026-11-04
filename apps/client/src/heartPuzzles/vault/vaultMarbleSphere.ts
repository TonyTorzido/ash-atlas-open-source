/**
 * Software sphere shading for the painted marble. The painted ball's veined interior becomes a surface map; each
 * frame the visible hemisphere is looked up through the marble's 3D orientation, so the veins slide over the ball,
 * foreshorten at the rim and turn exactly as far as the ball has rolled (angle = distance / radius about the axis
 * perpendicular to travel). The outline ring and the light (shading, highlight, contact shadow) stay fixed.
 * Pure apart from the input pixels, so it is unit tested.
 */

/** Row-major 3x3 rotation: body (surface) space to view space. */
export type MarbleOrientation = readonly [number, number, number, number, number, number, number, number, number];

export type MarbleSurface = Readonly<{
  /** size x size RGB samples over [-1, 1]^2 of the painted interior, shading flattened. */
  size: number;
  rgb: Float32Array;
}>;

/** Where the sphere ends and the painted outline ring starts, as a fraction of the ball radius. */
export const MARBLE_SPHERE_INNER = 0.88;
/** The surface map reads this fraction of the painted ball (inside its outline). */
export const MARBLE_SURFACE_READ = 0.8;
const OUTLINE_RGB = [44, 36, 36] as const;
/** Fixed light toward the upper left and the viewer, matching the painted highlight. */
const LIGHT = (() => {
  const v = [-0.42, -0.55, 0.72];
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l] as const;
})();

/**
 * Builds the surface map from the painted ball's RGBA pixels (`width` x `height`, ball centred, `ballRadiusPx`).
 * A least-squares luminance plane over the interior is divided out, so the painted shading does not roll around.
 */
export function buildMarbleSurface(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  ballRadiusPx: number,
  size = 128
): MarbleSurface {
  const rgb = new Float32Array(size * size * 3);
  const cx = width / 2;
  const cy = height / 2;
  const reach = ballRadiusPx * MARBLE_SURFACE_READ;
  // Fit L = a + b x + c y over the disc.
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sl = 0, slx = 0, sly = 0;
  const samples: Array<[number, number, number, number, number, number]> = [];
  for (let j = 0; j < size; j += 1) {
    for (let i = 0; i < size; i += 1) {
      const u = ((i + 0.5) / size) * 2 - 1;
      const v = ((j + 0.5) / size) * 2 - 1;
      const px = Math.min(width - 1, Math.max(0, Math.round(cx + u * reach)));
      const py = Math.min(height - 1, Math.max(0, Math.round(cy + v * reach)));
      const k = (py * width + px) * 4;
      const r = rgba[k]!, g = rgba[k + 1]!, b = rgba[k + 2]!;
      samples.push([i, j, r, g, b, u * u + v * v]);
      if (u * u + v * v <= 1) {
        const lum = 0.3 * r + 0.59 * g + 0.11 * b;
        n += 1; sx += u; sy += v; sxx += u * u; syy += v * v; sxy += u * v; sl += lum; slx += lum * u; sly += lum * v;
      }
    }
  }
  // Solve the 3x3 normal equations by Cramer's rule.
  const m = [n, sx, sy, sx, sxx, sxy, sy, sxy, syy];
  const det3 = (a: number[]): number =>
    a[0]! * (a[4]! * a[8]! - a[5]! * a[7]!) - a[1]! * (a[3]! * a[8]! - a[5]! * a[6]!) + a[2]! * (a[3]! * a[7]! - a[4]! * a[6]!);
  const d = det3(m);
  const rhs = [sl, slx, sly];
  const solve = (col: number): number => {
    const a = [...m];
    for (let r = 0; r < 3; r += 1) a[r * 3 + col] = rhs[r]!;
    return det3(a) / d;
  };
  const a0 = Math.abs(d) > 1e-6 ? solve(0) : sl / Math.max(1, n);
  const bx = Math.abs(d) > 1e-6 ? solve(1) : 0;
  const cy2 = Math.abs(d) > 1e-6 ? solve(2) : 0;
  for (const [i, j, r, g, b] of samples) {
    const u = ((i + 0.5) / size) * 2 - 1;
    const v = ((j + 0.5) / size) * 2 - 1;
    const plane = a0 + bx * u + cy2 * v;
    const k = a0 > 1 && plane > 1 ? Math.min(1.6, Math.max(0.6, a0 / plane)) : 1;
    const o = (j * size + i) * 3;
    rgb[o] = r * k; rgb[o + 1] = g * k; rgb[o + 2] = b * k;
  }
  return { size, rgb };
}

/**
 * Renders the ball into `out` (RGBA, `px` x `px`, the ball filling the square). The surface point under each view
 * normal n is R^T n, read through an equal-area hemisphere map (far side mirrored), bilinear filtered.
 */
export function renderMarbleSphere(out: Uint8ClampedArray, px: number, orient: MarbleOrientation, surface: MarbleSurface): void {
  const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = orient;
  const inner = MARBLE_SPHERE_INNER;
  const s = surface.size;
  const map = surface.rgb;
  for (let j = 0; j < px; j += 1) {
    const v = ((j + 0.5) / px) * 2 - 1;
    for (let i = 0; i < px; i += 1) {
      const u = ((i + 0.5) / px) * 2 - 1;
      const o = (j * px + i) * 4;
      const d = Math.hypot(u, v);
      if (d > 1) { out[o + 3] = 0; continue; }
      if (d > inner) {
        out[o] = OUTLINE_RGB[0]; out[o + 1] = OUTLINE_RGB[1]; out[o + 2] = OUTLINE_RGB[2];
        out[o + 3] = Math.round(255 * Math.min(1, (1 - d) * px * 0.5));
        continue;
      }
      const nx = u / inner;
      const ny = v / inner;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      // Body-space point: transpose of the orientation applied to the view normal.
      const bx = r00 * nx + r10 * ny + r20 * nz;
      const by = r01 * nx + r11 * ny + r21 * nz;
      const bz = r02 * nx + r12 * ny + r22 * nz;
      // Lambert azimuthal (equal-area) map of the hemisphere, the far hemisphere mirrored through the equator:
      // smooth everywhere, continuous across the equator, no stretched rings at the rim.
      const q = 1 / Math.sqrt(1 + Math.abs(bz));
      const fx = (bx * q * 0.5 + 0.5) * s - 0.5;
      const fy = (by * q * 0.5 + 0.5) * s - 0.5;
      const x0 = Math.max(0, Math.min(s - 2, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(s - 2, Math.floor(fy)));
      const tx = Math.max(0, Math.min(1, fx - x0));
      const ty = Math.max(0, Math.min(1, fy - y0));
      const k00 = (y0 * s + x0) * 3, k10 = k00 + 3, k01 = k00 + s * 3, k11 = k01 + 3;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      const lambert = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
      const shade = Math.min(1.08, 0.5 + 0.6 * lambert);
      for (let c = 0; c < 3; c += 1) {
        out[o + c] = (map[k00 + c]! * w00 + map[k10 + c]! * w10 + map[k01 + c]! * w01 + map[k11 + c]! * w11) * shade;
      }
      out[o + 3] = 255;
    }
  }
}

/** Rodrigues rotation about a unit axis (ax, ay, 0), row-major. */
export const marbleAxisAngle = (ax: number, ay: number, angle: number): [number, number, number, number, number, number, number, number, number] => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [t * ax * ax + c, t * ax * ay, ay * s, t * ax * ay, t * ay * ay + c, -ax * s, -ay * s, ax * s, c];
};

/** One rolling step: the ball moved (dx, dy) board pixels at radius `radius`. Returns the new orientation. */
export function rollMarble(orient: MarbleOrientation, dx: number, dy: number, radius: number): MarbleOrientation {
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6 || radius <= 0) return orient;
  const a = marbleAxisAngle(-dy / dist, dx / dist, dist / radius);
  const o = [0, 0, 0, 0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number, number, number, number];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) o[r * 3 + c] = a[r * 3]! * orient[c]! + a[r * 3 + 1]! * orient[3 + c]! + a[r * 3 + 2]! * orient[6 + c]!;
  }
  return o;
}
