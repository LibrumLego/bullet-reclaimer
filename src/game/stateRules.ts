import type { GameState } from "./types";

export function canPlayerMove(state: GameState): boolean {
  return state === "playing" || state === "recover";
}

export function canEnemiesMove(state: GameState): boolean {
  return state === "playing" || state === "recover";
}

export function isEnemyMovementBlocked(
  currentSpeed: number,
  chaseSpeed: number,
  movedDistance: number,
  requestedDistance: number,
): boolean {
  return currentSpeed > chaseSpeed * 0.6 && movedDistance < requestedDistance * 0.2;
}
