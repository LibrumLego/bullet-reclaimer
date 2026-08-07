import type Phaser from "phaser";
import type { NavigationPoint } from "./pathfinding";

export type GameState = "title" | "playing" | "aiming" | "bullet" | "recover" | "won" | "lost";
export type EnemyKind = "chaser" | "boss";

export interface EnemyDefinition {
  x: number;
  y: number;
  speed: number;
  kind?: EnemyKind;
  health?: number;
}

export interface ObstacleDefinition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StageDefinition {
  name: string;
  briefing: string;
  player: { x: number; y: number };
  obstacles: ObstacleDefinition[];
  enemies: EnemyDefinition[];
}

export interface Enemy {
  body: Phaser.GameObjects.Sprite;
  halo: Phaser.GameObjects.Ellipse;
  speed: number;
  radius: number;
  kind: EnemyKind;
  health: number;
  maxHealth: number;
  alive: boolean;
  path: NavigationPoint[];
  pathIndex: number;
  nextPathAt: number;
  lastTargetX: number;
  lastTargetY: number;
  canDash: boolean;
  dashState: "chase" | "telegraph" | "dashing";
  dashReadyAt: number;
  dashUntil: number;
  dashVx: number;
  dashVy: number;
}

export interface Bullet {
  body: Phaser.GameObjects.Sprite;
  trail: Phaser.GameObjects.Graphics;
  vx: number;
  vy: number;
  bounces: number;
  age: number;
  stopped: boolean;
  kills: number;
  nearMissTriggered: boolean;
}
