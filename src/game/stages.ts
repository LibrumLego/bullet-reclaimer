import type { StageDefinition } from "./types";

export const STAGES: StageDefinition[] = [
  {
    name: "CALIBRATION",
    briefing: "첫 탄환의 각도와 회수 경로를 익혀라",
    player: { x: 190, y: 550 },
    obstacles: [
      { x: 355, y: 142, width: 86, height: 230 },
      { x: 565, y: 385, width: 232, height: 76 },
      { x: 846, y: 154, width: 88, height: 246 },
      { x: 970, y: 492, width: 150, height: 72 },
      { x: 180, y: 436, width: 118, height: 62 },
      { x: 620, y: 160, width: 130, height: 58 },
    ],
    enemies: [
      { x: 640, y: 304, speed: 58 },
      { x: 514, y: 590, speed: 54 },
    ],
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
      { x: 475, y: 190, speed: 66 },
      { x: 675, y: 200, speed: 70 },
      { x: 815, y: 390, speed: 72 },
      { x: 1090, y: 180, speed: 65 },
      { x: 1080, y: 570, speed: 54, kind: "shooter" },
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
      { x: 340, y: 270, speed: 72 },
      { x: 690, y: 150, speed: 54, kind: "shooter" },
      { x: 710, y: 430, speed: 73 },
      { x: 1010, y: 250, speed: 79 },
      { x: 1100, y: 590, speed: 52, kind: "shooter" },
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
      { x: 120, y: 130, speed: 80 },
      { x: 410, y: 380, speed: 84 },
      { x: 650, y: 180, speed: 82 },
      { x: 700, y: 500, speed: 86 },
      { x: 900, y: 330, speed: 78 },
      { x: 1150, y: 220, speed: 84 },
      { x: 1130, y: 620, speed: 56, kind: "shooter" },
    ],
  },
  {
    name: "RECLAIMER CORE",
    briefing: "코어의 보호막을 세 번 파괴하고 마지막 탄환을 회수하라",
    player: { x: 145, y: 590 },
    // The boss arena starts clean. Its jump pattern drops the only cover the player can use.
    obstacles: [],
    enemies: [
      { x: 470, y: 330, speed: 54, kind: "shooter" },
      { x: 920, y: 600, speed: 82 },
      { x: 1080, y: 330, speed: 74, kind: "boss", health: 4 },
    ],
  },
];
