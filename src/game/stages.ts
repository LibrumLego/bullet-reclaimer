import type { StageDefinition } from "./types";

export const STAGES: StageDefinition[] = [
  {
    name: "CALIBRATION",
    briefing: "첫 탄환의 각도와 회수 경로를 익혀라",
    player: { x: 190, y: 550 },
    // A short first lesson: one readable ricochet, one enemy, then a safe recovery route.
    obstacles: [
      { x: 540, y: 210, width: 82, height: 250 },
      { x: 860, y: 470, width: 164, height: 62 },
    ],
    enemies: [{ x: 760, y: 258, speed: 44 }],
  },
  {
    name: "CROSSFIRE",
    briefing: "교차하는 벽을 이용해 한 발로 다수를 노려라",
    player: { x: 130, y: 370 },
    obstacles: [
      { x: 320, y: 120, width: 74, height: 210 },
      { x: 320, y: 450, width: 74, height: 170 },
      { x: 555, y: 275, width: 180, height: 72 },
      { x: 555, y: 470, width: 180, height: 72 },
      { x: 895, y: 120, width: 72, height: 220 },
      { x: 895, y: 445, width: 72, height: 175 },
    ],
    enemies: [
      { x: 475, y: 190, speed: 62 },
      { x: 815, y: 390, speed: 68 },
      { x: 1080, y: 570, speed: 50, kind: "shooter" },
    ],
  },
  {
    name: "RICOCHET LAB",
    briefing: "좁은 반사 통로에서 안전한 회수 지점을 만들어라",
    player: { x: 150, y: 600 },
    obstacles: [
      { x: 230, y: 145, width: 210, height: 66 },
      { x: 230, y: 330, width: 210, height: 66 },
      { x: 510, y: 505, width: 230, height: 68 },
      { x: 550, y: 210, width: 68, height: 210 },
      { x: 785, y: 120, width: 68, height: 235 },
      { x: 920, y: 450, width: 210, height: 68 },
    ],
    enemies: [
      { x: 340, y: 270, speed: 68 },
      { x: 690, y: 150, speed: 50, kind: "shooter" },
      { x: 710, y: 430, speed: 72 },
      { x: 1100, y: 590, speed: 50, kind: "shooter" },
    ],
  },
  {
    name: "THE GAUNTLET",
    briefing: "빠른 추적자들을 벽 사이에 묶고 연속 도탄을 설계하라",
    player: { x: 640, y: 620 },
    obstacles: [
      { x: 170, y: 210, width: 190, height: 62 },
      { x: 170, y: 465, width: 190, height: 62 },
      { x: 465, y: 115, width: 62, height: 210 },
      { x: 465, y: 430, width: 62, height: 200 },
      { x: 755, y: 210, width: 62, height: 230 },
      { x: 935, y: 120, width: 180, height: 62 },
      { x: 935, y: 510, width: 180, height: 62 },
    ],
    enemies: [
      { x: 120, y: 130, speed: 76 },
      { x: 410, y: 380, speed: 80 },
      { x: 700, y: 500, speed: 82 },
      { x: 900, y: 330, speed: 52, kind: "shooter" },
      { x: 1150, y: 220, speed: 78 },
    ],
  },
  {
    name: "RECLAIMER CORE",
    briefing: "코어의 보호막을 세 번 파괴하고 마지막 탄환을 회수하라",
    player: { x: 145, y: 590 },
    // The boss arena starts clean. Its jump pattern drops the only cover the player can use.
    obstacles: [],
    enemies: [{ x: 1080, y: 330, speed: 74, kind: "boss", health: 4 }],
  },
];
