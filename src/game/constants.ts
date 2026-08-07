import Phaser from "phaser";

export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;
export const ARENA = new Phaser.Geom.Rectangle(54, 86, 1172, 574);
export const PLAYER_SPEED = 250;
export const BULLET_SPEED = 760;
export const MAX_BOUNCES = 5;
export const PLAYER_RADIUS = 13;
export const BULLET_RADIUS = 8;

export const DEPTH = {
  arena: 0,
  obstacle: 5,
  actor: 10,
  freeze: 20,
  guide: 30,
  effects: 35,
  hud: 40,
  message: 50,
} as const;
