import assert from "node:assert/strict";
import test from "node:test";
import { calculateRiskReward, enemyPressureMultiplier } from "../src/game/risk.ts";

test("unarmed enemies receive a twenty percent speed increase", () => {
  assert.equal(enemyPressureMultiplier(true, false), 1.2);
  assert.equal(enemyPressureMultiplier(false, false), 1);
});

test("late pressure stacks with the unarmed threat", () => {
  assert.equal(enemyPressureMultiplier(true, true), 1.2 * 1.08);
});

test("risk reward rises with distance, ricochets, chains, and close calls", () => {
  const safe = calculateRiskReward({ distance: 120, bounces: 0, kills: 0, nearMisses: 0 });
  const reckless = calculateRiskReward({ distance: 660, bounces: 5, kills: 3, nearMisses: 2 });
  assert.equal(safe.tier, "SAFE");
  assert.equal(safe.bonus, 6);
  assert.equal(reckless.tier, "RECKLESS");
  assert.ok(reckless.multiplier > safe.multiplier);
  assert.ok(reckless.bonus > safe.bonus);
});
