import assert from "node:assert/strict";
import test from "node:test";

import { generateSeededStage } from "../src/game/mapGenerator.ts";
import { findNavigationPath } from "../src/game/pathfinding.ts";
import type { StageDefinition } from "../src/game/types.ts";

const arena = { x: 0, y: 0, width: 1000, height: 520 };
const stage: StageDefinition = {
  name: "TEST",
  briefing: "seeded arena",
  player: { x: 70, y: 70 },
  obstacles: [
    { x: 140, y: 100, width: 70, height: 180 },
    { x: 360, y: 250, width: 190, height: 62 },
    { x: 690, y: 100, width: 65, height: 190 },
    { x: 720, y: 390, width: 160, height: 55 },
  ],
  enemies: [
    { x: 800, y: 100, speed: 60 },
    { x: 750, y: 420, speed: 52, kind: "shooter" },
  ],
};

test("the same map seed reproduces the same layout", () => {
  assert.deepEqual(generateSeededStage(stage, arena, "ALPHA42"), generateSeededStage(stage, arena, "ALPHA42"));
});

test("different seeds produce different non-boss layouts", () => {
  assert.notDeepEqual(generateSeededStage(stage, arena, "ALPHA42"), generateSeededStage(stage, arena, "BRAVO17"));
});

test("seeded layouts preserve counts and navigation routes", () => {
  for (const seed of ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX"]) {
    const generated = generateSeededStage(stage, arena, seed);
    assert.equal(generated.obstacles.length, stage.obstacles.length);
    assert.equal(generated.enemies.length, stage.enemies.length);
    for (const enemy of generated.enemies) {
      assert.ok(findNavigationPath(enemy, generated.player, arena, generated.obstacles, 14).length > 0, seed);
    }
  }
});
