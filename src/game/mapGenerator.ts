import { findNavigationPath } from "./pathfinding.ts";
import type { EnemyDefinition, ObstacleDefinition, StageDefinition } from "./types.ts";

export interface MapArena {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PLAYER_CLEARANCE = 104;
const OBSTACLE_GAP = 22;
const EDGE_MARGIN = 22;
const ENEMY_CLEARANCE = 28;

const hashSeed = (seed: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const makeRandom = (seed: string): (() => number) => {
  let state = hashSeed(seed);
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
};

const range = (random: () => number, min: number, max: number): number => min + (max - min) * random();

const rectanglesOverlap = (a: ObstacleDefinition, b: ObstacleDefinition, gap = 0): boolean => (
  a.x < b.x + b.width + gap
  && a.x + a.width + gap > b.x
  && a.y < b.y + b.height + gap
  && a.y + a.height + gap > b.y
);

const pointTouchesObstacle = (
  point: { x: number; y: number },
  obstacle: ObstacleDefinition,
  clearance: number,
): boolean => {
  const closestX = Math.max(obstacle.x, Math.min(obstacle.x + obstacle.width, point.x));
  const closestY = Math.max(obstacle.y, Math.min(obstacle.y + obstacle.height, point.y));
  return Math.hypot(point.x - closestX, point.y - closestY) < clearance;
};

const cornerSpawn = (arena: MapArena, random: () => number): { x: number; y: number } => {
  const insetX = 76;
  const insetY = 68;
  const corners = [
    { x: arena.x + insetX, y: arena.y + insetY },
    { x: arena.x + arena.width - insetX, y: arena.y + insetY },
    { x: arena.x + insetX, y: arena.y + arena.height - insetY },
    { x: arena.x + arena.width - insetX, y: arena.y + arena.height - insetY },
  ];
  const selected = corners[Math.floor(random() * corners.length)];
  return {
    x: selected.x + range(random, -24, 24),
    y: selected.y + range(random, -20, 20),
  };
};

const placeObstacles = (
  templates: ObstacleDefinition[],
  player: { x: number; y: number },
  arena: MapArena,
  random: () => number,
): ObstacleDefinition[] => {
  const ordered = [...templates].sort((a, b) => b.width * b.height - a.width * a.height);
  const placed: ObstacleDefinition[] = [];

  for (const template of ordered) {
    let accepted: ObstacleDefinition | undefined;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const rotate = random() < 0.38;
      const scale = range(random, 0.88, 1.06);
      const width = (rotate ? template.height : template.width) * scale;
      const height = (rotate ? template.width : template.height) * scale;
      const candidate = {
        x: range(random, arena.x + EDGE_MARGIN, arena.x + arena.width - width - EDGE_MARGIN),
        y: range(random, arena.y + EDGE_MARGIN, arena.y + arena.height - height - EDGE_MARGIN),
        width,
        height,
      };
      if (pointTouchesObstacle(player, candidate, PLAYER_CLEARANCE)) continue;
      if (placed.some((obstacle) => rectanglesOverlap(candidate, obstacle, OBSTACLE_GAP))) continue;
      accepted = candidate;
      break;
    }
    if (accepted) placed.push(accepted);
  }
  return placed;
};

const placeEnemies = (
  templates: EnemyDefinition[],
  player: { x: number; y: number },
  obstacles: ObstacleDefinition[],
  arena: MapArena,
  random: () => number,
): EnemyDefinition[] => {
  const placed: EnemyDefinition[] = [];
  for (const template of templates) {
    let point: { x: number; y: number } | undefined;
    for (let attempt = 0; attempt < 220; attempt += 1) {
      const candidate = {
        x: range(random, arena.x + 42, arena.x + arena.width - 42),
        y: range(random, arena.y + 42, arena.y + arena.height - 42),
      };
      if (Math.hypot(candidate.x - player.x, candidate.y - player.y) < 300) continue;
      if (obstacles.some((obstacle) => pointTouchesObstacle(candidate, obstacle, ENEMY_CLEARANCE))) continue;
      if (placed.some((enemy) => Math.hypot(candidate.x - enemy.x, candidate.y - enemy.y) < 76)) continue;
      point = candidate;
      break;
    }
    if (point) placed.push({ ...template, ...point });
  }
  return placed;
};

const allEnemiesReachPlayer = (stage: StageDefinition, arena: MapArena): boolean => (
  stage.enemies.length > 0
  && stage.enemies.every((enemy) => findNavigationPath(enemy, stage.player, arena, stage.obstacles, 14).length > 0)
);

export const createRandomSeed = (): string => {
  const entropy = `${Date.now()}-${Math.random()}-${performance.now()}`;
  return hashSeed(entropy).toString(36).toUpperCase().padStart(7, "0").slice(-7);
};

export const generateSeededStage = (
  source: StageDefinition,
  arena: MapArena,
  seed: string,
): StageDefinition => {
  for (let layoutAttempt = 0; layoutAttempt < 16; layoutAttempt += 1) {
    const random = makeRandom(`${seed}:${layoutAttempt}`);
    const player = cornerSpawn(arena, random);
    const obstacles = placeObstacles(source.obstacles, player, arena, random);
    const enemies = placeEnemies(source.enemies, player, obstacles, arena, random);
    const candidate = { ...source, player, obstacles, enemies };
    if (obstacles.length === source.obstacles.length
      && enemies.length === source.enemies.length
      && allEnemiesReachPlayer(candidate, arena)) return candidate;
  }
  return source;
};
