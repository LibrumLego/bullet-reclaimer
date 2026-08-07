import assert from "node:assert/strict";
import test from "node:test";
import { nearestCombinedRayHit, rayRectangleHit, segmentCircleHit } from "../src/game/geometry.ts";
import { findNavigationPath, hasClearPath } from "../src/game/pathfinding.ts";

test("detects a circle crossed between frames", () => {
  const hit = segmentCircleHit(0, 0, 100, 0, 50, 0, 10);
  assert.equal(hit, 0.4);
});

test("returns undefined when the segment misses", () => {
  const hit = segmentCircleHit(0, 0, 100, 0, 50, 20, 10);
  assert.equal(hit, undefined);
});

test("detects a tangent hit", () => {
  const hit = segmentCircleHit(0, 0, 100, 0, 50, 10, 10);
  assert.equal(hit, 0.5);
});

test("handles a stationary point inside the circle", () => {
  const hit = segmentCircleHit(5, 5, 5, 5, 5, 5, 10);
  assert.equal(hit, 0);
});

test("reflects both axes when a ray hits an obstacle corner", () => {
  const hit = rayRectangleHit(0, 0, 1, 1, 10, 10, 20, 20);

  assert.deepEqual(hit, { distance: 10, normalX: -1, normalY: -1 });
});

test("combines simultaneous arena wall hits at a corner", () => {
  const hit = nearestCombinedRayHit([
    { distance: 25, normalX: -1, normalY: 0 },
    { distance: 25.00001, normalX: 0, normalY: 1 },
  ]);

  assert.deepEqual(hit, { distance: 25, normalX: -1, normalY: 1 });
});

test("detects and ejects a ray that starts inside an obstacle", () => {
  const hit = rayRectangleHit(12, 15, 1, 0, 10, 10, 20, 20);

  assert.deepEqual(hit, { distance: 0, normalX: -1, normalY: 0 });
});

test("navigation routes around an obstacle instead of crossing it", () => {
  const arena = { x: 0, y: 0, width: 500, height: 300 };
  const obstacles = [{ x: 200, y: 50, width: 80, height: 200 }];
  const start = { x: 80, y: 150 };
  const target = { x: 420, y: 150 };
  const path = findNavigationPath(start, target, arena, obstacles, 12);

  assert.ok(path.length >= 2);
  let previous = start;
  for (const waypoint of path) {
    assert.equal(hasClearPath(previous, waypoint, arena, obstacles, 12), true);
    previous = waypoint;
  }
  assert.deepEqual(path.at(-1), target);
});

test("navigation keeps a direct route when no wall blocks the target", () => {
  const arena = { x: 0, y: 0, width: 500, height: 300 };
  const start = { x: 80, y: 80 };
  const target = { x: 420, y: 220 };
  const path = findNavigationPath(start, target, arena, [], 12);

  assert.deepEqual(path, [target]);
});

test("navigation does not falsely trap an enemy beside a rounded obstacle corner", () => {
  const arena = { x: 0, y: 0, width: 120, height: 120 };
  const obstacles = [{ x: 20, y: 20, width: 30, height: 30 }];
  const start = { x: 15, y: 15 };
  const target = { x: 8, y: 8 };

  assert.equal(hasClearPath(start, target, arena, obstacles, 3), true);
});

test("every stage four enemy can find a route to the player", () => {
  const arena = { x: 54, y: 86, width: 1172, height: 574 };
  const obstacles = [
    { x: 170, y: 210, width: 190, height: 62 },
    { x: 170, y: 465, width: 190, height: 62 },
    { x: 465, y: 115, width: 62, height: 210 },
    { x: 465, y: 430, width: 62, height: 200 },
    { x: 755, y: 210, width: 62, height: 230 },
    { x: 935, y: 120, width: 180, height: 62 },
    { x: 935, y: 510, width: 180, height: 62 },
  ];
  const player = { x: 640, y: 620 };
  const enemies = [
    { x: 120, y: 130 },
    { x: 410, y: 380 },
    { x: 650, y: 180 },
    { x: 700, y: 500 },
    { x: 900, y: 330 },
    { x: 1150, y: 220 },
    { x: 1130, y: 620 },
  ];

  for (const enemy of enemies) {
    assert.ok(findNavigationPath(enemy, player, arena, obstacles, 12).length > 0);
  }
});
