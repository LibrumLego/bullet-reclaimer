export interface NavigationPoint {
  x: number;
  y: number;
}

export interface NavigationRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

const OBSTACLE_MARGIN = 3;
const CORNER_MARGIN = 8;

const distance = (a: NavigationPoint, b: NavigationPoint): number => Math.hypot(b.x - a.x, b.y - a.y);

const insideArena = (point: NavigationPoint, arena: NavigationRectangle, radius: number): boolean => (
  point.x >= arena.x + radius
  && point.x <= arena.x + arena.width - radius
  && point.y >= arena.y + radius
  && point.y <= arena.y + arena.height - radius
);

const circleTouchesRectangle = (
  point: NavigationPoint,
  rectangle: NavigationRectangle,
  padding: number,
): boolean => {
  const closestX = Math.max(rectangle.x, Math.min(rectangle.x + rectangle.width, point.x));
  const closestY = Math.max(rectangle.y, Math.min(rectangle.y + rectangle.height, point.y));
  return Math.hypot(point.x - closestX, point.y - closestY) < padding;
};

const isWalkable = (
  point: NavigationPoint,
  arena: NavigationRectangle,
  obstacles: NavigationRectangle[],
  radius: number,
): boolean => (
  insideArena(point, arena, radius)
  && obstacles.every((obstacle) => !circleTouchesRectangle(point, obstacle, radius + OBSTACLE_MARGIN))
);

const segmentIntersectsRectangle = (
  start: NavigationPoint,
  end: NavigationPoint,
  rectangle: NavigationRectangle,
  padding: number,
): boolean => {
  const left = rectangle.x - padding;
  const right = rectangle.x + rectangle.width + padding;
  const top = rectangle.y - padding;
  const bottom = rectangle.y + rectangle.height + padding;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let near = 0;
  let far = 1;

  const clip = (origin: number, direction: number, min: number, max: number): boolean => {
    if (Math.abs(direction) < 1e-8) return origin >= min && origin <= max;
    const first = (min - origin) / direction;
    const second = (max - origin) / direction;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    return near <= far;
  };

  return clip(start.x, dx, left, right) && clip(start.y, dy, top, bottom);
};

const segmentTouchesCircle = (
  start: NavigationPoint,
  end: NavigationPoint,
  center: NavigationPoint,
  radius: number,
): boolean => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((center.x - start.x) * dx + (center.y - start.y) * dy) / lengthSquared));
  const closestX = start.x + dx * projection;
  const closestY = start.y + dy * projection;
  return Math.hypot(center.x - closestX, center.y - closestY) < radius;
};

const sweptCircleTouchesRectangle = (
  start: NavigationPoint,
  end: NavigationPoint,
  rectangle: NavigationRectangle,
  radius: number,
): boolean => {
  const horizontalBand = {
    x: rectangle.x - radius,
    y: rectangle.y,
    width: rectangle.width + radius * 2,
    height: rectangle.height,
  };
  const verticalBand = {
    x: rectangle.x,
    y: rectangle.y - radius,
    width: rectangle.width,
    height: rectangle.height + radius * 2,
  };
  if (segmentIntersectsRectangle(start, end, horizontalBand, 0)) return true;
  if (segmentIntersectsRectangle(start, end, verticalBand, 0)) return true;

  const corners = [
    { x: rectangle.x, y: rectangle.y },
    { x: rectangle.x + rectangle.width, y: rectangle.y },
    { x: rectangle.x, y: rectangle.y + rectangle.height },
    { x: rectangle.x + rectangle.width, y: rectangle.y + rectangle.height },
  ];
  return corners.some((corner) => segmentTouchesCircle(start, end, corner, radius));
};

export const hasClearPath = (
  start: NavigationPoint,
  end: NavigationPoint,
  arena: NavigationRectangle,
  obstacles: NavigationRectangle[],
  radius: number,
): boolean => (
  isWalkable(start, arena, obstacles, radius)
  && isWalkable(end, arena, obstacles, radius)
  && obstacles.every((obstacle) => !sweptCircleTouchesRectangle(start, end, obstacle, radius + OBSTACLE_MARGIN))
);

const nearestWalkablePoint = (
  target: NavigationPoint,
  arena: NavigationRectangle,
  obstacles: NavigationRectangle[],
  radius: number,
): NavigationPoint | undefined => {
  const clamped = {
    x: Math.max(arena.x + radius, Math.min(arena.x + arena.width - radius, target.x)),
    y: Math.max(arena.y + radius, Math.min(arena.y + arena.height - radius, target.y)),
  };
  if (isWalkable(clamped, arena, obstacles, radius)) return clamped;

  for (let ring = 8; ring <= 160; ring += 8) {
    let best: NavigationPoint | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < 32; index += 1) {
      const angle = index / 32 * Math.PI * 2;
      const candidate = {
        x: clamped.x + Math.cos(angle) * ring,
        y: clamped.y + Math.sin(angle) * ring,
      };
      if (!isWalkable(candidate, arena, obstacles, radius)) continue;
      const candidateDistance = distance(candidate, target);
      if (candidateDistance < bestDistance) {
        best = candidate;
        bestDistance = candidateDistance;
      }
    }
    if (best) return best;
  }
  return undefined;
};

/**
 * Builds a shortest route through mutually visible, radius-safe obstacle corners.
 * This is considerably cheaper than a fine navigation grid and produces smooth,
 * direct routes around the rectangular walls used by the arena.
 */
export const findNavigationPath = (
  start: NavigationPoint,
  target: NavigationPoint,
  arena: NavigationRectangle,
  obstacles: NavigationRectangle[],
  radius: number,
): NavigationPoint[] => {
  const safeStart = nearestWalkablePoint(start, arena, obstacles, radius);
  const safeTarget = nearestWalkablePoint(target, arena, obstacles, radius);
  if (!safeStart || !safeTarget) return [];
  if (hasClearPath(safeStart, safeTarget, arena, obstacles, radius)) return [safeTarget];

  const cornerPadding = radius + CORNER_MARGIN;
  const nodes: NavigationPoint[] = [safeStart, safeTarget];
  for (const obstacle of obstacles) {
    const corners = [
      { x: obstacle.x - cornerPadding, y: obstacle.y - cornerPadding },
      { x: obstacle.x + obstacle.width + cornerPadding, y: obstacle.y - cornerPadding },
      { x: obstacle.x - cornerPadding, y: obstacle.y + obstacle.height + cornerPadding },
      { x: obstacle.x + obstacle.width + cornerPadding, y: obstacle.y + obstacle.height + cornerPadding },
    ];
    for (const corner of corners) {
      if (isWalkable(corner, arena, obstacles, radius)) nodes.push(corner);
    }
  }

  const edges: Array<Array<{ index: number; cost: number }>> = nodes.map(() => []);
  for (let from = 0; from < nodes.length; from += 1) {
    for (let to = from + 1; to < nodes.length; to += 1) {
      if (!hasClearPath(nodes[from], nodes[to], arena, obstacles, radius)) continue;
      const cost = distance(nodes[from], nodes[to]);
      edges[from].push({ index: to, cost });
      edges[to].push({ index: from, cost });
    }
  }

  const costs = new Array<number>(nodes.length).fill(Number.POSITIVE_INFINITY);
  const previous = new Array<number>(nodes.length).fill(-1);
  const visited = new Array<boolean>(nodes.length).fill(false);
  costs[0] = 0;

  for (let step = 0; step < nodes.length; step += 1) {
    let current = -1;
    for (let index = 0; index < nodes.length; index += 1) {
      if (!visited[index] && (current === -1 || costs[index] < costs[current])) current = index;
    }
    if (current === -1 || !Number.isFinite(costs[current])) break;
    if (current === 1) break;
    visited[current] = true;
    for (const edge of edges[current]) {
      const nextCost = costs[current] + edge.cost;
      if (nextCost >= costs[edge.index]) continue;
      costs[edge.index] = nextCost;
      previous[edge.index] = current;
    }
  }

  if (previous[1] === -1) return [];
  const path: NavigationPoint[] = [];
  let current = 1;
  while (current > 0) {
    path.unshift(nodes[current]);
    current = previous[current];
  }
  return path;
};
