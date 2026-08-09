import assert from "node:assert/strict";
import test from "node:test";
import {
  canEnemiesMove,
  canPlayerMove,
  isEnemyMovementBlocked,
  recoveryIndicatorDistance,
} from "../src/game/stateRules.ts";

test("the player is locked while the fired bullet resolves", () => {
  assert.equal(canPlayerMove("aiming"), false);
  assert.equal(canPlayerMove("bullet"), false);
  assert.equal(canPlayerMove("recover"), true);
});

test("enemies freeze while the bullet resolves and chase during recovery", () => {
  assert.equal(canEnemiesMove("aiming"), false);
  assert.equal(canEnemiesMove("bullet"), false);
  assert.equal(canEnemiesMove("recover"), true);
});

test("enemy acceleration is not mistaken for being blocked", () => {
  assert.equal(isEnemyMovementBlocked(8, 58, 0.03, 0.05), false);
  assert.equal(isEnemyMovementBlocked(50, 58, 0, 0.3), true);
});

test("the recovery indicator stays near the player without a distance threshold jump", () => {
  assert.equal(recoveryIndicatorDistance(259), 72);
  assert.equal(recoveryIndicatorDistance(260), 72);
  assert.equal(recoveryIndicatorDistance(261), 72);
  assert.equal(recoveryIndicatorDistance(52), 40);
});
