export function segmentCircleHit(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  centerX: number,
  centerY: number,
  radius: number,
): number | undefined {
  const dx = endX - startX;
  const dy = endY - startY;
  const fx = startX - centerX;
  const fy = startY - centerY;
  const a = dx * dx + dy * dy;

  if (a === 0) return fx * fx + fy * fy <= radius * radius ? 0 : undefined;

  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return undefined;

  const root = Math.sqrt(discriminant);
  const near = (-b - root) / (2 * a);
  const far = (-b + root) / (2 * a);
  if (near >= 0 && near <= 1) return near;
  if (far >= 0 && far <= 1) return far;
  return undefined;
}

export interface RayHit {
  distance: number;
  normalX: number;
  normalY: number;
}

export function rayRectangleHit(
  x: number,
  y: number,
  dx: number,
  dy: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): RayHit | undefined {
  if (x > left && x < right && y > top && y < bottom) {
    const exits: RayHit[] = [
      { distance: x - left, normalX: -1, normalY: 0 },
      { distance: right - x, normalX: 1, normalY: 0 },
      { distance: y - top, normalX: 0, normalY: -1 },
      { distance: bottom - y, normalX: 0, normalY: 1 },
    ];
    const nearestExit = exits.sort((a, b) => a.distance - b.distance)[0];
    return { ...nearestExit, distance: 0 };
  }

  let nearX = Number.NEGATIVE_INFINITY;
  let farX = Number.POSITIVE_INFINITY;
  let nearY = Number.NEGATIVE_INFINITY;
  let farY = Number.POSITIVE_INFINITY;

  if (Math.abs(dx) < 1e-8) {
    if (x < left || x > right) return undefined;
  } else {
    const first = (left - x) / dx;
    const second = (right - x) / dx;
    nearX = Math.min(first, second);
    farX = Math.max(first, second);
  }
  if (Math.abs(dy) < 1e-8) {
    if (y < top || y > bottom) return undefined;
  } else {
    const first = (top - y) / dy;
    const second = (bottom - y) / dy;
    nearY = Math.min(first, second);
    farY = Math.max(first, second);
  }

  const entry = Math.max(nearX, nearY);
  const exit = Math.min(farX, farY);
  if (entry > exit || exit < 0 || entry < 0) return undefined;

  const cornerHit = Number.isFinite(nearX) && Number.isFinite(nearY) && Math.abs(nearX - nearY) < 0.001;
  return {
    distance: entry,
    normalX: cornerHit || nearX > nearY ? (dx > 0 ? -1 : 1) : 0,
    normalY: cornerHit || nearY > nearX ? (dy > 0 ? -1 : 1) : 0,
  };
}

export function nearestCombinedRayHit(candidates: RayHit[], tolerance = 0.05): RayHit | undefined {
  if (candidates.length === 0) return undefined;
  const nearest = candidates.reduce((best, candidate) => candidate.distance < best.distance ? candidate : best);
  let normalX = nearest.normalX;
  let normalY = nearest.normalY;

  for (const candidate of candidates) {
    if (Math.abs(candidate.distance - nearest.distance) > tolerance) continue;
    if (candidate.normalX !== 0) normalX = candidate.normalX;
    if (candidate.normalY !== 0) normalY = candidate.normalY;
  }
  return { distance: nearest.distance, normalX, normalY };
}
