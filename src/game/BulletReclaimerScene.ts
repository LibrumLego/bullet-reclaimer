import Phaser from "phaser";
import {
  ARENA,
  BULLET_RADIUS,
  BULLET_SPEED,
  DEPTH,
  GAME_HEIGHT,
  GAME_WIDTH,
  MAX_BOUNCES,
  PLAYER_ACCELERATION,
  PLAYER_DECELERATION,
  PLAYER_RADIUS,
  PLAYER_SPEED,
} from "./constants";
import { nearestCombinedRayHit, rayRectangleHit, segmentCircleHit } from "./geometry";
import { findNavigationPath, hasClearPath } from "./pathfinding";
import { calculateRiskReward, enemyPressureMultiplier } from "./risk";
import { SoundManager } from "./SoundManager";
import { STAGES } from "./stages";
import { canEnemiesMove, canPlayerMove, isEnemyMovementBlocked } from "./stateRules";
import type { Bullet, Enemy, EnemyDefinition, EnemyProjectile, GameState, StageDefinition } from "./types";

type Impact =
  | { t: number; kind: "player" }
  | { t: number; kind: "enemy"; enemy: Enemy };

const BULLET_MUZZLE_OFFSET = Math.max(0, PLAYER_RADIUS - BULLET_RADIUS - 2);
const AUTHORING_ARENA = { x: 54, y: 86, width: 1172, height: 574 };
const ENEMY_BASE_SPEED_MULTIPLIER = 1.12;

export class BulletReclaimerScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Sprite;
  private playerRing!: Phaser.GameObjects.Ellipse;
  private enemies: Enemy[] = [];
  private enemyProjectiles: EnemyProjectile[] = [];
  private obstacles: Phaser.Geom.Rectangle[] = [];
  private bullet?: Bullet;
  private state: GameState = "title";
  private stageIndex = 0;
  private cursorKeys!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<"W" | "A" | "S" | "D" | "R", Phaser.Input.Keyboard.Key>;
  private startKeys!: Record<"ENTER" | "SPACE", Phaser.Input.Keyboard.Key>;
  private cancelKey!: Phaser.Input.Keyboard.Key;
  private aimGuide!: Phaser.GameObjects.Graphics;
  private aimWarningText!: Phaser.GameObjects.Text;
  private overlay!: Phaser.GameObjects.Graphics;
  private recoveryGuide!: Phaser.GameObjects.Graphics;
  private recoveryText!: Phaser.GameObjects.Text;
  private dangerVignette!: Phaser.GameObjects.Graphics;
  private pressureWash!: Phaser.GameObjects.Rectangle;
  private titleLayer?: Phaser.GameObjects.Container;
  private statusText!: Phaser.GameObjects.Text;
  private objectiveText!: Phaser.GameObjects.Text;
  private stageText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private riskText!: Phaser.GameObjects.Text;
  private recoveryPulse = 0;
  private initialEnemyCount = 0;
  private tensionPulseAt = 0;
  private latePressure = false;
  private score = 0;
  private combatTimeScale = 1;
  private aimStartedAt = 0;
  private nearMissCooldownAt = 0;
  private readonly playerVelocity = new Phaser.Math.Vector2();
  private readonly sounds = new SoundManager();
  private readonly handleWindowBlur = (): void => this.cancelAim();
  private readonly focusGameCanvas = (): void => this.game.canvas.focus();
  private readonly suppressContextMenu = (event: MouseEvent): void => event.preventDefault();

  constructor() {
    super("bullet-reclaimer");
  }

  init(data: { stageIndex?: number; showTitle?: boolean; score?: number } = {}): void {
    this.stageIndex = Phaser.Math.Clamp(data.stageIndex ?? 0, 0, STAGES.length - 1);
    this.enemies = [];
    this.enemyProjectiles = [];
    this.obstacles = [];
    this.bullet = undefined;
    this.titleLayer = undefined;
    this.state = (data.showTitle ?? data.stageIndex === undefined) ? "title" : "playing";
    this.recoveryPulse = 0;
    this.initialEnemyCount = 0;
    this.tensionPulseAt = 0;
    this.latePressure = false;
    this.score = data.score ?? 0;
    this.combatTimeScale = 1;
    this.aimStartedAt = 0;
    this.nearMissCooldownAt = 0;
    this.playerVelocity.set(0, 0);
  }

  private compactPoint(point: { x: number; y: number }): { x: number; y: number } {
    const scaleX = ARENA.width / AUTHORING_ARENA.width;
    const scaleY = ARENA.height / AUTHORING_ARENA.height;
    return {
      x: ARENA.x + (point.x - AUTHORING_ARENA.x) * scaleX,
      y: ARENA.y + (point.y - AUTHORING_ARENA.y) * scaleY,
    };
  }

  private compactEnemy(definition: EnemyDefinition): EnemyDefinition {
    const point = this.compactPoint(definition);
    return { ...definition, ...point };
  }

  private compactStage(stage: StageDefinition): StageDefinition {
    const scaleX = ARENA.width / AUTHORING_ARENA.width;
    const scaleY = ARENA.height / AUTHORING_ARENA.height;
    return {
      ...stage,
      player: this.compactPoint(stage.player),
      obstacles: stage.obstacles.map((obstacle) => {
        const point = this.compactPoint(obstacle);
        return { ...obstacle, ...point, width: obstacle.width * scaleX, height: obstacle.height * scaleY };
      }),
      enemies: stage.enemies.map((enemy) => this.compactEnemy(enemy)),
    };
  }

  create(): void {
    const stage = this.compactStage(STAGES[this.stageIndex]);
    this.time.timeScale = 1;
    this.cameras.main.setBackgroundColor("#080b12");
    this.game.canvas.tabIndex = 0;
    this.game.canvas.setAttribute("aria-label", "Bullet Reclaimer game canvas");
    this.game.canvas.addEventListener("pointerdown", this.focusGameCanvas);
    this.game.canvas.addEventListener("contextmenu", this.suppressContextMenu);
    this.createPixelTextures();
    this.drawArena();
    this.pressureWash = this.add.rectangle(
      ARENA.centerX,
      ARENA.centerY,
      ARENA.width,
      ARENA.height,
      0x5a1028,
      1,
    ).setDepth(DEPTH.obstacle - 1).setAlpha(0);
    this.createHud(stage);

    this.playerRing = this.add.ellipse(stage.player.x, stage.player.y + 14, 44, 14, 0x02050c, 0.68).setDepth(DEPTH.actor - 1);
    this.player = this.add.sprite(stage.player.x, stage.player.y, "hero")
      .setScale(1.7)
      .setOrigin(0.5, 0.72)
      .setDepth(DEPTH.actor);
    this.overlay = this.add.graphics().setDepth(DEPTH.freeze);
    this.aimGuide = this.add.graphics().setDepth(DEPTH.guide);
    this.aimWarningText = this.add.text(0, 0, "RETURN FIRE", {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "11px",
      fontStyle: "bold",
      color: "#ff9b96",
      backgroundColor: "#190d18",
      padding: { x: 7, y: 4 },
      letterSpacing: 1.4,
    }).setOrigin(0.5).setDepth(DEPTH.guide + 1).setVisible(false);
    this.recoveryGuide = this.add.graphics().setDepth(DEPTH.guide);
    this.dangerVignette = this.add.graphics().setDepth(DEPTH.actor + 1);
    this.dangerVignette
      .fillStyle(0x8b102b, 0.7)
      .fillRect(ARENA.x, ARENA.y, ARENA.width, 18)
      .fillRect(ARENA.x, ARENA.bottom - 18, ARENA.width, 18)
      .fillRect(ARENA.x, ARENA.y, 18, ARENA.height)
      .fillRect(ARENA.right - 18, ARENA.y, 18, ARENA.height)
      .setAlpha(0);
    this.recoveryText = this.add.text(0, 0, "", {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "13px",
      fontStyle: "bold",
      color: "#ffd76b",
      backgroundColor: "#141621",
      padding: { x: 7, y: 4 },
    }).setOrigin(0.5).setDepth(DEPTH.hud).setVisible(false);

    this.cursorKeys = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys("W,A,S,D,R") as Record<"W" | "A" | "S" | "D" | "R", Phaser.Input.Keyboard.Key>;
    this.startKeys = this.input.keyboard!.addKeys("ENTER,SPACE") as Record<"ENTER" | "SPACE", Phaser.Input.Keyboard.Key>;
    this.cancelKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.ESC);

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonDown()) {
        this.cancelAim();
        return;
      }
      this.handlePointerDown();
    });
    this.input.on("pointerup", (pointer: Phaser.Input.Pointer) => {
      if (this.state === "aiming") this.fire(pointer.worldX, pointer.worldY);
    });
    this.input.on("pointerupoutside", () => this.cancelAim());
    this.input.on("gameout", () => this.cancelAim());
    window.addEventListener("blur", this.handleWindowBlur);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      window.removeEventListener("blur", this.handleWindowBlur);
      this.game.canvas.removeEventListener("pointerdown", this.focusGameCanvas);
      this.game.canvas.removeEventListener("contextmenu", this.suppressContextMenu);
    });

    this.createStage(stage);
    if (this.state === "title") this.showTitleScreen();
    this.updateHud();
  }

  update(_time: number, delta: number): void {
    const dt = Math.min(delta / 1000, 0.033) * this.combatTimeScale;

    if (this.state === "title") {
      if (Phaser.Input.Keyboard.JustDown(this.startKeys.ENTER) || Phaser.Input.Keyboard.JustDown(this.startKeys.SPACE)) {
        this.startGame();
      }
      return;
    }

    if (Phaser.Input.Keyboard.JustDown(this.wasd.R)) {
      this.restartStage();
      return;
    }

    if (this.state === "aiming") {
      if (Phaser.Input.Keyboard.JustDown(this.cancelKey)) {
        this.cancelAim();
        return;
      }
      this.playerVelocity.set(0, 0);
      this.drawAimGuide();
      if (this.time.now >= this.tensionPulseAt) {
        this.sounds.aimHeartbeat();
        this.tensionPulseAt = this.time.now + 720;
      }
      return;
    }

    this.aimGuide.clear();
    this.aimWarningText.setVisible(false);
    if (this.state !== "won" && this.state !== "lost") this.overlay.clear();

    if (canPlayerMove(this.state)) {
      this.movePlayer(dt);
    } else if (this.state === "bullet") {
      this.playerVelocity.set(0, 0);
      this.player.setTexture("hero").setScale(1.7);
    }

    if (canEnemiesMove(this.state)) {
      this.moveEnemies(dt);
      this.moveEnemyProjectiles(dt);
      this.checkEnemyNearMisses();
      this.checkEnemyContact();
    } else if (this.state === "bullet") {
      for (const enemy of this.enemies) {
        if (!enemy.alive) continue;
        this.updateEnemyThreatVisual(enemy, true);
        this.syncEnemyVisual(enemy);
      }
    }

    if (this.state === "bullet" && this.bullet) this.moveBullet(dt);

    if (this.state === "recover" && this.bullet) {
      this.recoveryPulse += dt;
      const scale = 2 + Math.sin(this.recoveryPulse * 8) * 0.16;
      this.bullet.body.setScale(scale);
      if (Phaser.Math.Distance.Between(this.player.x, this.player.y, this.bullet.body.x, this.bullet.body.y) < 28) {
        this.reclaimBullet();
      }
    }

    this.updateTensionEffects();

    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const pulse = 1 + Math.sin(this.time.now * 0.005 + enemy.body.x) * (enemy.kind === "boss" ? 0.09 : 0.05);
      enemy.halo.setScale(pulse);
      const eyePulse = 1 + Math.sin(this.time.now * 0.011 + enemy.body.y) * 0.12;
      enemy.eyeGlow.setScale(eyePulse, 1);
    }
    this.playerRing.setPosition(this.player.x, this.player.y + 14);
  }

  private createPixelTextures(): void {
    if (this.textures.exists("hero")) return;
    const g = this.make.graphics({ x: 0, y: 0 });
    const makeTexture = (key: string, width: number, height: number, draw: () => void): void => {
      g.clear();
      draw();
      g.generateTexture(key, width, height);
    };

    const drawHero = (stride: boolean): void => {
      // Amber scarf and long coat create a readable silhouette even at game scale.
      g.fillStyle(0x8f4e38).fillRect(4, 10, 4, 13);
      g.fillStyle(0xd8894d).fillRect(2, stride ? 12 : 11, 5, 4).fillRect(1, stride ? 15 : 14, 4, 2);
      g.fillStyle(0x11192c).fillRect(7, 10, 11, 14);
      g.fillStyle(0x263c59).fillRect(8, 11, 9, 11);
      g.fillStyle(0x385d78).fillRect(9, 13, 7, 7);
      g.fillStyle(0xdde4df).fillRect(8, 3, 9, 7);
      g.fillStyle(0xf6eee0).fillRect(10, 4, 8, 5);
      g.fillStyle(0xc8d1cd).fillRect(7, 2, 4, 5).fillRect(14, 1, 4, 3);
      g.fillStyle(0x1c2638).fillRect(9, 8, 9, 3);
      g.fillStyle(0x75e2df).fillRect(15, 7, 2, 2);
      // Oversized reclaim gauntlet makes the hero feel authored rather than generic.
      g.fillStyle(0x0b1322).fillRect(17, 12, 5, 8);
      g.fillStyle(0x32647a).fillRect(18, 13, 5, 6);
      g.fillStyle(0x92f2e7).fillRect(21, 14, 3, 3);
      g.fillStyle(0xf3c86a).fillRect(22, 15, 2, 1);
      if (stride) {
        g.fillStyle(0x0a1020).fillRect(7, 22, 4, 6).fillRect(15, 21, 4, 5);
        g.fillStyle(0x506c7c).fillRect(6, 26, 5, 2).fillRect(15, 25, 5, 2);
      } else {
        g.fillStyle(0x0a1020).fillRect(8, 22, 4, 6).fillRect(14, 22, 4, 6);
        g.fillStyle(0x506c7c).fillRect(7, 26, 5, 2).fillRect(14, 26, 5, 2);
      }
    };
    makeTexture("hero", 24, 28, () => drawHero(false));
    makeTexture("hero-step", 24, 28, () => drawHero(true));

    const drawHunter = (stride: boolean): void => {
      g.fillStyle(0x180f20).fillRect(5, 4, 13, 13);
      g.fillStyle(0x5b203d).fillRect(3, 7, 17, 9);
      g.fillStyle(0xb74762).fillRect(5, 5, 13, 9);
      g.fillStyle(0xe56a73).fillRect(7, 4, 9, 3);
      g.fillStyle(0x25101f).fillRect(6, 8, 11, 4);
      g.fillStyle(0xffe28a).fillRect(7, 9, 3, 2).fillRect(14, 9, 3, 2);
      g.fillStyle(0xff786d).fillRect(4, 2, 3, 4).fillRect(16, 1, 3, 5);
      g.fillStyle(0x371326).fillRect(1, 10, 4, 5).fillRect(18, 10, 4, 5);
      if (stride) {
        g.fillStyle(0x210f20).fillRect(5, 15, 4, 5).fillRect(15, 14, 4, 4);
      } else {
        g.fillStyle(0x210f20).fillRect(6, 15, 4, 5).fillRect(14, 15, 4, 5);
      }
    };
    makeTexture("enemy", 22, 20, () => drawHunter(false));
    makeTexture("enemy-step", 22, 20, () => drawHunter(true));

    makeTexture("shooter", 24, 22, () => {
      g.fillStyle(0x0d1728).fillRect(4, 5, 16, 14);
      g.fillStyle(0x244a70).fillRect(2, 7, 20, 10);
      g.fillStyle(0x3d7897).fillRect(5, 4, 14, 12);
      g.fillStyle(0x101c31).fillRect(7, 7, 10, 6);
      g.fillStyle(0x8bf5f1).fillRect(8, 9, 3, 2).fillRect(14, 9, 3, 2);
      g.fillStyle(0x75b8dd).fillRect(9, 1, 6, 4);
      g.fillStyle(0x15263c).fillRect(0, 10, 4, 5).fillRect(20, 10, 4, 5);
      g.fillStyle(0x66d8e6).fillRect(10, 17, 4, 4);
    });

    makeTexture("enemy-bolt", 10, 6, () => {
      g.fillStyle(0x15334d).fillRect(0, 1, 3, 4);
      g.fillStyle(0x54d9ef).fillRect(2, 0, 5, 6);
      g.fillStyle(0xe1ffff).fillRect(6, 1, 4, 4);
    });

    makeTexture("boss", 36, 40, () => {
      g.fillStyle(0x140c24).fillRect(8, 4, 20, 32);
      g.fillStyle(0x2e1f4e).fillRect(4, 9, 28, 23);
      g.fillStyle(0x4f3678).fillRect(1, 13, 8, 14).fillRect(27, 13, 8, 14);
      g.fillStyle(0x26183e).fillRect(0, 17, 5, 8).fillRect(31, 17, 5, 8);
      g.fillStyle(0x7654a5).fillRect(9, 5, 18, 8);
      g.fillStyle(0x1a112e).fillRect(11, 8, 14, 8);
      g.fillStyle(0xf3d7ff).fillRect(12, 10, 4, 2).fillRect(20, 10, 4, 2);
      g.fillStyle(0xb364ff).fillRect(13, 10, 3, 2).fillRect(20, 10, 3, 2);
      g.fillStyle(0x201333).fillRect(8, 17, 20, 15);
      g.fillStyle(0x6c4596).fillRect(11, 18, 14, 12);
      g.fillStyle(0xd991ff).fillRect(14, 20, 8, 8);
      g.fillStyle(0xffe4ff).fillRect(16, 21, 4, 5);
      g.fillStyle(0x39225b).fillRect(7, 32, 8, 6).fillRect(21, 32, 8, 6);
      g.fillStyle(0xa968df).fillRect(2, 5, 4, 4).fillRect(30, 5, 4, 4).fillRect(16, 0, 4, 4);
      g.fillStyle(0xf0c8ff).fillRect(3, 6, 2, 2).fillRect(31, 6, 2, 2).fillRect(17, 1, 2, 2);
    });

    makeTexture("bullet", 9, 5, () => {
      g.fillStyle(0x69412c).fillRect(0, 1, 3, 3);
      g.fillStyle(0xf0aa53).fillRect(2, 0, 5, 5);
      g.fillStyle(0xfff1ae).fillRect(5, 1, 4, 3);
      g.fillStyle(0xffffff).fillRect(7, 2, 2, 1);
    });

    makeTexture("spark", 8, 8, () => {
      g.fillStyle(0xffd76b).fillRect(3, 0, 2, 8).fillRect(0, 3, 8, 2);
      g.fillStyle(0xfff7d2).fillRect(3, 3, 2, 2);
    });
    g.destroy();
  }

  private handlePointerDown(): void {
    if (this.state === "title") {
      this.startGame();
      return;
    }
    if (this.state === "playing") {
      this.state = "aiming";
      this.aimStartedAt = this.time.now;
      this.tensionPulseAt = 0;
      this.playerVelocity.set(0, 0);
      this.drawFreezeOverlay();
      this.updateHud();
      return;
    }
    if (this.state === "won") {
      this.advanceStage();
      return;
    }
    if (this.state === "lost") this.restartStage();
  }

  private drawArena(): void {
    const floor = this.add.graphics().setDepth(DEPTH.arena);
    floor.fillStyle(0x070a12).fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    floor.fillStyle(0x101827).fillRect(ARENA.x, ARENA.y, ARENA.width, ARENA.height);
    // Broad panels and tiny service lights read as a designed space instead of a checkerboard.
    for (let y = ARENA.y; y < ARENA.bottom; y += 64) {
      for (let x = ARENA.x; x < ARENA.right; x += 64) {
        const alternate = (Math.floor(x / 64) + Math.floor(y / 64)) % 2 === 0;
        floor.fillStyle(alternate ? 0x131e2e : 0x111b2a).fillRect(x + 2, y + 2, 60, 60);
        floor.lineStyle(1, 0x22344a, 0.5).strokeRect(x + 2, y + 2, 60, 60);
        floor.fillStyle(0x5a7891, 0.32).fillCircle(x + 8, y + 8, 1.5).fillCircle(x + 56, y + 56, 1.5);
      }
    }
    floor.lineStyle(2, 0x1e4d5a, 0.34).lineBetween(ARENA.x + 18, ARENA.centerY, ARENA.right - 18, ARENA.centerY);
    floor.fillStyle(0x5ce0d0, 0.22);
    for (let x = ARENA.x + 34; x < ARENA.right; x += 156) floor.fillRect(x, ARENA.centerY - 1, 26, 2);

    const frame = this.add.graphics().setDepth(DEPTH.arena + 1);
    frame.fillStyle(0x03060d).fillRect(ARENA.x - 9, ARENA.y - 9, ARENA.width + 18, 9);
    frame.fillStyle(0x03060d).fillRect(ARENA.x - 9, ARENA.bottom, ARENA.width + 18, 9);
    frame.fillStyle(0x03060d).fillRect(ARENA.x - 9, ARENA.y, 9, ARENA.height);
    frame.fillStyle(0x03060d).fillRect(ARENA.right, ARENA.y, 9, ARENA.height);
    frame.lineStyle(2, 0x486277, 0.86).strokeRect(ARENA.x - 3, ARENA.y - 3, ARENA.width + 6, ARENA.height + 6);
    frame.lineStyle(3, 0x76eadc, 0.72);
    const corner = 34;
    frame.lineBetween(ARENA.x, ARENA.y, ARENA.x + corner, ARENA.y).lineBetween(ARENA.x, ARENA.y, ARENA.x, ARENA.y + corner);
    frame.lineBetween(ARENA.right, ARENA.bottom, ARENA.right - corner, ARENA.bottom).lineBetween(ARENA.right, ARENA.bottom, ARENA.right, ARENA.bottom - corner);

    this.add.text(54, 22, "BULLET RECLAIMER", {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "23px",
      fontStyle: "bold",
      color: "#edf7f4",
      letterSpacing: 3,
    }).setDepth(DEPTH.hud);
  }

  private showTitleScreen(): void {
    this.overlay.clear().fillStyle(0x040812, 0.88).fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    const operative = this.add.sprite(425, 358, "hero").setScale(6.6).setOrigin(0.5, 0.72);
    const operativeGlow = this.add.ellipse(425, 430, 210, 42, 0x5ce0d0, 0.13);
    const kicker = this.add.text(626, 242, "TACTICAL RICOCHET // 01", {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "13px",
      fontStyle: "bold",
      color: "#76eadc",
      letterSpacing: 2.5,
    });
    const title = this.add.text(620, 278, "BULLET\nRECLAIMER", {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "54px",
      fontStyle: "bold",
      color: "#f2f7f5",
      lineSpacing: -7,
      letterSpacing: 2,
    });
    const mission = this.add.text(626, 405, "단 한 발로 길을 만들고,\n무장 해제된 전장을 가로질러 회수하라.", {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "16px",
      color: "#aec4cb",
      lineSpacing: 7,
    });
    const prompt = this.add.text(626, 486, "DEPLOY  ·  CLICK / ENTER / SPACE", {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "14px",
      fontStyle: "bold",
      color: "#071119",
      backgroundColor: "#76eadc",
      padding: { x: 18, y: 11 },
      letterSpacing: 1.5,
    });

    this.titleLayer = this.add.container(0, 0, [operativeGlow, operative, kicker, title, mission, prompt]).setDepth(DEPTH.message);
    this.tweens.add({ targets: operative, y: operative.y - 5, duration: 1200, ease: "Sine.easeInOut", yoyo: true, repeat: -1 });
    this.tweens.add({ targets: prompt, alpha: 0.68, duration: 800, yoyo: true, repeat: -1 });
  }

  private startGame(): void {
    if (this.state !== "title") return;
    if (this.titleLayer) {
      this.tweens.killTweensOf(this.titleLayer.list);
      this.titleLayer.destroy(true);
      this.titleLayer = undefined;
    }
    this.overlay.clear();
    this.state = "playing";
    this.updateHud();
  }

  private createHud(stage: StageDefinition): void {
    this.statusText = this.add.text(1226, 26, "", {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "14px",
      fontStyle: "bold",
      color: "#f8fbff",
      letterSpacing: 1.1,
    }).setOrigin(1, 0).setDepth(DEPTH.hud);

    this.stageText = this.add.text(54, 58, `STAGE ${this.stageIndex + 1}/${STAGES.length} · ${stage.name} — ${stage.briefing}`, {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "12px",
      color: "#9fb4bc",
      letterSpacing: 0.6,
    }).setDepth(DEPTH.hud);

    this.objectiveText = this.add.text(54, 678, "", {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "13px",
      color: "#a5b8be",
    }).setDepth(DEPTH.hud);

    this.scoreText = this.add.text(1226, 678, "", {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "13px",
      fontStyle: "bold",
      color: "#ffd76b",
    }).setOrigin(1, 0).setDepth(DEPTH.hud);

    this.riskText = this.add.text(1226, 58, "", {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "12px",
      fontStyle: "bold",
      color: "#ffdf72",
    }).setOrigin(1, 0).setDepth(DEPTH.hud);

    this.add.text(GAME_WIDTH / 2, 40, "WASD 이동  ·  마우스 누름: 시간 정지 조준  ·  놓기: 발사  ·  우클릭/ESC: 취소  ·  R: 재시작", {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "12px",
      color: "#80969f",
      letterSpacing: 0.4,
    }).setOrigin(0.5).setDepth(DEPTH.hud);
  }

  private createStage(stage: StageDefinition): void {
    this.obstacles = stage.obstacles.map((item) => new Phaser.Geom.Rectangle(item.x, item.y, item.width, item.height));
    const obstacleLayer = this.add.graphics().setDepth(DEPTH.obstacle);
    for (const rect of this.obstacles) {
      obstacleLayer.fillStyle(0x050912, 0.85).fillRect(rect.x + 6, rect.y + 7, rect.width + 3, rect.height + 3);
      obstacleLayer.fillStyle(0x182638).fillRect(rect.x, rect.y, rect.width, rect.height);
      obstacleLayer.fillStyle(0x263b50).fillRect(rect.x + 4, rect.y + 4, rect.width - 8, rect.height - 8);
      obstacleLayer.fillStyle(0x355268).fillRect(rect.x + 4, rect.y + 4, rect.width - 8, 4);
      obstacleLayer.fillStyle(0x101b2a).fillRect(rect.x + 7, rect.bottom - 10, rect.width - 14, 6);
      obstacleLayer.lineStyle(2, 0x6c8ba0, 0.58).strokeRect(rect.x, rect.y, rect.width, rect.height);
      obstacleLayer.lineStyle(2, 0x76eadc, 0.5)
        .lineBetween(rect.x, rect.y, rect.x + 15, rect.y)
        .lineBetween(rect.x, rect.y, rect.x, rect.y + 15);
      for (let x = rect.x + 13; x < rect.right - 8; x += 28) {
        obstacleLayer.fillStyle(0x94b3c2, 0.46).fillCircle(x, rect.y + 14, 2);
      }
      if (rect.width > 110) {
        for (let x = rect.x + 12; x < rect.right - 18; x += 34) {
          obstacleLayer.fillStyle(0xd69a4c, 0.5).fillRect(x, rect.bottom - 8, 16, 3);
        }
      }
    }
    this.enemies = stage.enemies.map((definition) => this.makeEnemy(definition));
    this.initialEnemyCount = stage.enemies.length;
  }

  private makeEnemy(definition: EnemyDefinition): Enemy {
    const kind = definition.kind ?? "chaser";
    const radius = kind === "boss" ? 42 : 12;
    const health = definition.health ?? 1;
    const color = kind === "boss" ? 0xb06cff : kind === "shooter" ? 0x6ee8ef : 0xff637b;
    const isBoss = kind === "boss";
    const isShooter = kind === "shooter";
    const halo = this.add.ellipse(
      definition.x,
      definition.y + (isBoss ? 27 : 13),
      isBoss ? 112 : 40,
      isBoss ? 32 : 13,
      isBoss ? 0x2b1244 : isShooter ? 0x102c43 : 0x240b18,
      0.62,
    ).setDepth(DEPTH.actor - 1);
    const body = this.add.sprite(definition.x, definition.y, isBoss ? "boss" : isShooter ? "shooter" : "enemy")
      .setScale(isBoss ? 2.65 : 1.72)
      .setOrigin(0.5, 0.72)
      .setDepth(DEPTH.actor);
    const eyeGlow = this.add.rectangle(
      definition.x,
      definition.y - (isBoss ? 17 : 7),
      isBoss ? 34 : 17,
      isBoss ? 6 : 4,
      isBoss ? 0xe9b7ff : isShooter ? 0x85f7ff : 0xffdf72,
      0.18,
    ).setDepth(DEPTH.actor + 1);
    if (isBoss || isShooter) body.setTint(color);
    return {
      body,
      halo,
      eyeGlow,
      speed: Math.round(definition.speed * ENEMY_BASE_SPEED_MULTIPLIER),
      radius,
      kind,
      health,
      maxHealth: health,
      alive: true,
      path: [],
      pathIndex: 0,
      nextPathAt: 0,
      lastTargetX: Number.NaN,
      lastTargetY: Number.NaN,
      canDash: !isShooter && (isBoss || definition.speed >= 54),
      dashState: "chase",
      dashReadyAt: this.time.now + Phaser.Math.Between(1100, 2300),
      dashUntil: 0,
      dashVx: 0,
      dashVy: 0,
      moveVx: 0,
      moveVy: 0,
      nearMissReadyAt: this.time.now + 900,
      shootReadyAt: this.time.now + Phaser.Math.Between(isBoss ? 1000 : 1300, isBoss ? 1500 : 2100),
    };
  }

  private movePlayer(dt: number): void {
    let x = 0;
    let y = 0;
    if (this.wasd.W.isDown || this.cursorKeys.up.isDown) y -= 1;
    if (this.wasd.S.isDown || this.cursorKeys.down.isDown) y += 1;
    if (this.wasd.A.isDown || this.cursorKeys.left.isDown) x -= 1;
    if (this.wasd.D.isDown || this.cursorKeys.right.isDown) x += 1;
    const hasInput = x !== 0 || y !== 0;
    const desired = hasInput
      ? new Phaser.Math.Vector2(x, y).normalize().scale(PLAYER_SPEED)
      : new Phaser.Math.Vector2();
    const response = hasInput ? PLAYER_ACCELERATION : PLAYER_DECELERATION;
    const blend = 1 - Math.exp(-response * dt);
    this.playerVelocity.x = Phaser.Math.Linear(this.playerVelocity.x, desired.x, blend);
    this.playerVelocity.y = Phaser.Math.Linear(this.playerVelocity.y, desired.y, blend);
    if (!hasInput && this.playerVelocity.lengthSq() < 4) this.playerVelocity.set(0, 0);

    const previousX = this.player.x;
    const previousY = this.player.y;
    this.tryMoveCircle(this.player, this.playerVelocity.x * dt, this.playerVelocity.y * dt, PLAYER_RADIUS);
    if (Math.abs(this.player.x - previousX) < 0.01) this.playerVelocity.x *= 0.2;
    if (Math.abs(this.player.y - previousY) < 0.01) this.playerVelocity.y *= 0.2;
    if (Math.abs(this.playerVelocity.x) > 8) this.player.setFlipX(this.playerVelocity.x < 0);

    const movement = Math.min(1, this.playerVelocity.length() / PLAYER_SPEED);
    const stepPhase = Math.floor(this.time.now / 115) % 2 === 0;
    this.player.setTexture(movement > 0.14 && stepPhase ? "hero-step" : "hero");
    const step = Math.sin(this.time.now * 0.026) * 0.045 * movement;
    const breathing = Math.sin(this.time.now * 0.004) * 0.012 * (1 - movement);
    this.player.setScale(1.7 - Math.abs(step) * 0.28, 1.7 + step + breathing);
  }

  private moveEnemies(dt: number): void {
    const unarmed = this.state === "recover";
    const pressureMultiplier = enemyPressureMultiplier(unarmed, this.latePressure);
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      this.updateEnemyThreatVisual(enemy, unarmed);
      if (enemy.kind === "boss") this.updateBossBarrage(enemy);
      if (enemy.kind === "shooter") this.updateShooterAttack(enemy);
      if (this.updateEnemyDash(enemy, dt, pressureMultiplier, unarmed)) continue;

      const navigationTarget = enemy.kind === "shooter"
        ? this.getShooterNavigationTarget(enemy)
        : { x: this.player.x, y: this.player.y };

      const targetMoved = !Number.isFinite(enemy.lastTargetX)
        || Phaser.Math.Distance.Between(enemy.lastTargetX, enemy.lastTargetY, navigationTarget.x, navigationTarget.y) > 24;
      const needsPath = enemy.pathIndex >= enemy.path.length;
      if (this.time.now >= enemy.nextPathAt && (needsPath || targetMoved)) {
        enemy.path = findNavigationPath(
          { x: enemy.body.x, y: enemy.body.y },
          navigationTarget,
          ARENA,
          this.obstacles,
          enemy.radius,
        );
        enemy.pathIndex = 0;
        const pathInterval = unarmed
          ? enemy.kind === "boss" ? 85 : enemy.kind === "shooter" ? 130 : 115
          : enemy.kind === "boss" ? 150 : enemy.kind === "shooter" ? 220 : 200;
        enemy.nextPathAt = this.time.now + pathInterval + Phaser.Math.Between(0, 70);
        enemy.lastTargetX = navigationTarget.x;
        enemy.lastTargetY = navigationTarget.y;
      }

      while (enemy.pathIndex < enemy.path.length - 1) {
        const waypoint = enemy.path[enemy.pathIndex];
        if (Phaser.Math.Distance.Between(enemy.body.x, enemy.body.y, waypoint.x, waypoint.y) > Math.max(10, enemy.radius * 0.35)) break;
        enemy.pathIndex += 1;
      }

      const waypoint = enemy.path[enemy.pathIndex];
      if (!waypoint) continue;
      const direction = new Phaser.Math.Vector2(waypoint.x - enemy.body.x, waypoint.y - enemy.body.y);
      if (direction.lengthSq() < 1) continue;
      direction.normalize();
      const previousX = enemy.body.x;
      const previousY = enemy.body.y;
      const chaseSpeed = enemy.speed * pressureMultiplier;
      const steering = 1 - Math.exp(-(enemy.kind === "boss" ? 5.5 : enemy.kind === "shooter" ? 6.5 : 8) * dt);
      enemy.moveVx = Phaser.Math.Linear(enemy.moveVx, direction.x * chaseSpeed, steering);
      enemy.moveVy = Phaser.Math.Linear(enemy.moveVy, direction.y * chaseSpeed, steering);
      const currentSpeed = Math.hypot(enemy.moveVx, enemy.moveVy);
      if (currentSpeed > chaseSpeed) {
        enemy.moveVx = enemy.moveVx / currentSpeed * chaseSpeed;
        enemy.moveVy = enemy.moveVy / currentSpeed * chaseSpeed;
      }
      this.tryMoveCircle(enemy.body, enemy.moveVx * dt, enemy.moveVy * dt, enemy.radius);
      const moved = Phaser.Math.Distance.Between(previousX, previousY, enemy.body.x, enemy.body.y);
      const requestedDistance = Math.hypot(enemy.moveVx, enemy.moveVy) * dt;
      if (isEnemyMovementBlocked(currentSpeed, chaseSpeed, moved, requestedDistance)) {
        enemy.moveVx *= 0.25;
        enemy.moveVy *= 0.25;
        enemy.path = [];
        enemy.pathIndex = 0;
        enemy.nextPathAt = this.time.now + 50;
      }
      this.syncEnemyVisual(enemy);
      if (Math.abs(enemy.moveVx) > 4) enemy.body.setFlipX(enemy.moveVx > 0);
    }
  }

  private getShooterNavigationTarget(enemy: Enemy): { x: number; y: number } {
    const away = new Phaser.Math.Vector2(enemy.body.x - this.player.x, enemy.body.y - this.player.y);
    const distance = away.length();
    if (distance < 0.01) away.set(1, 0);
    else away.scale(1 / distance);

    if (distance < 205) {
      return { x: this.player.x + away.x * 310, y: this.player.y + away.y * 310 };
    }
    if (distance > 370) return { x: this.player.x, y: this.player.y };

    // Alternate orbit direction by position so multiple shooters do not stack on one route.
    const orbitSign = Math.sin(enemy.body.x * 0.017 + enemy.body.y * 0.009) > 0 ? 1 : -1;
    return {
      x: this.player.x - away.y * 280 * orbitSign,
      y: this.player.y + away.x * 280 * orbitSign,
    };
  }

  private updateShooterAttack(enemy: Enemy): void {
    const now = this.time.now;
    if (now < enemy.shootReadyAt) return;
    const direction = new Phaser.Math.Vector2(this.player.x - enemy.body.x, this.player.y - enemy.body.y);
    const distance = direction.length();
    if (distance < 130 || distance > 610 || !hasClearPath(
      { x: enemy.body.x, y: enemy.body.y },
      { x: this.player.x, y: this.player.y },
      ARENA,
      this.obstacles,
      2,
    )) {
      enemy.shootReadyAt = now + 260;
      return;
    }
    direction.scale(1 / distance);
    this.spawnEnemyProjectile(enemy.body.x, enemy.body.y - 4, direction.x, direction.y, 300, 0x6ee8ef);
    enemy.shootReadyAt = now + Phaser.Math.Between(1450, 1900);
    enemy.eyeGlow.setAlpha(1);
    this.cameras.main.flash(45, 70, 210, 225, false);
  }

  private updateBossBarrage(enemy: Enemy): void {
    if (this.time.now < enemy.shootReadyAt || enemy.dashState !== "chase") return;
    const phase = enemy.maxHealth - enemy.health + 1;
    const direction = new Phaser.Math.Vector2(this.player.x - enemy.body.x, this.player.y - enemy.body.y);
    if (direction.lengthSq() < 1) return;
    direction.normalize();
    const count = phase >= 4 ? 5 : phase >= 3 ? 4 : 3;
    const spread = phase >= 4 ? 0.72 : 0.46;
    for (let index = 0; index < count; index += 1) {
      const offset = Phaser.Math.Linear(-spread / 2, spread / 2, index / (count - 1));
      const angle = Math.atan2(direction.y, direction.x) + offset;
      this.spawnEnemyProjectile(enemy.body.x, enemy.body.y - 9, Math.cos(angle), Math.sin(angle), 260 + phase * 18, 0xd9a3ff);
    }
    enemy.shootReadyAt = this.time.now + Math.max(900, 1850 - phase * 190);
    this.burst(enemy.body.x, enemy.body.y, 0xc77dff, 9);
    this.sounds.dashWarning();
  }

  private spawnEnemyProjectile(x: number, y: number, dx: number, dy: number, speed: number, tint: number): void {
    const body = this.add.sprite(x, y, "enemy-bolt")
      .setTint(tint)
      .setScale(1.15)
      .setDepth(DEPTH.effects + 1)
      .setRotation(Math.atan2(dy, dx));
    this.enemyProjectiles.push({
      body,
      vx: dx * speed,
      vy: dy * speed,
      radius: 4,
      expiresAt: this.time.now + 3200,
    });
  }

  private moveEnemyProjectiles(dt: number): void {
    for (let index = this.enemyProjectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.enemyProjectiles[index];
      const startX = projectile.body.x;
      const startY = projectile.body.y;
      const nextX = startX + projectile.vx * dt;
      const nextY = startY + projectile.vy * dt;
      const hitPlayer = segmentCircleHit(
        startX,
        startY,
        nextX,
        nextY,
        this.player.x,
        this.player.y,
        PLAYER_RADIUS + projectile.radius,
      );
      const expires = this.time.now >= projectile.expiresAt
        || nextX < ARENA.left || nextX > ARENA.right || nextY < ARENA.top || nextY > ARENA.bottom
        || this.circleHitsObstacle(nextX, nextY, projectile.radius);
      if (hitPlayer !== undefined) {
        projectile.body.destroy();
        this.enemyProjectiles.splice(index, 1);
        this.lose();
        return;
      }
      if (expires) {
        projectile.body.destroy();
        this.enemyProjectiles.splice(index, 1);
        continue;
      }
      projectile.body.setPosition(nextX, nextY);
      projectile.body.setRotation(Math.atan2(projectile.vy, projectile.vx));
    }
  }

  private updateEnemyDash(enemy: Enemy, dt: number, speedMultiplier: number, aggressive: boolean): boolean {
    if (enemy.kind === "shooter") return false;
    const now = this.time.now;
    if (enemy.dashState === "telegraph") {
      if (now < enemy.dashUntil) {
        const flash = Math.floor(now / 70) % 2 === 0;
        enemy.body.setTint(flash ? 0xffffff : 0xff365d);
        enemy.halo.setFillStyle(0xff294f, 0.9 + (flash ? 0.1 : 0));
        enemy.eyeGlow.setFillStyle(0xfff0f3, 1).setAlpha(flash ? 1 : 0.55);
        this.syncEnemyVisual(enemy);
        return true;
      }
      const direction = new Phaser.Math.Vector2(this.player.x - enemy.body.x, this.player.y - enemy.body.y).normalize();
      enemy.dashState = "dashing";
      enemy.dashUntil = now + (enemy.kind === "boss" ? 420 : 300);
      enemy.dashVx = direction.x;
      enemy.dashVy = direction.y;
      enemy.moveVx = direction.x * enemy.speed;
      enemy.moveVy = direction.y * enemy.speed;
      enemy.body.setTint(0xff496f);
      this.sounds.dash();
    }

    if (enemy.dashState === "dashing") {
      const previousX = enemy.body.x;
      const previousY = enemy.body.y;
      const dashSpeed = enemy.speed * speedMultiplier * (enemy.kind === "boss" ? 2.75 : 3.4);
      this.tryMoveCircle(enemy.body, enemy.dashVx * dashSpeed * dt, enemy.dashVy * dashSpeed * dt, enemy.radius);
      const moved = Phaser.Math.Distance.Between(previousX, previousY, enemy.body.x, enemy.body.y);
      this.syncEnemyVisual(enemy);
      if (Math.abs(enemy.dashVx) > 0.05) enemy.body.setFlipX(enemy.dashVx > 0);
      if (now >= enemy.dashUntil || moved < dashSpeed * dt * 0.35) {
        enemy.dashState = "chase";
        enemy.dashReadyAt = now + (aggressive ? Phaser.Math.Between(800, 1400) : Phaser.Math.Between(1600, 2800));
        enemy.path = [];
        enemy.pathIndex = 0;
        enemy.nextPathAt = now + 80;
        this.restoreEnemyAppearance(enemy);
      }
      return true;
    }

    const playerDistance = Phaser.Math.Distance.Between(enemy.body.x, enemy.body.y, this.player.x, this.player.y);
    const recoveryDash = aggressive && enemy.speed >= 60;
    if ((enemy.canDash || recoveryDash) && now >= enemy.dashReadyAt && playerDistance > 105 && playerDistance < 620) {
      enemy.dashState = "telegraph";
      enemy.dashUntil = now + (enemy.kind === "boss" ? 560 : 430);
      this.sounds.dashWarning();
      return true;
    }
    return false;
  }

  private syncEnemyVisual(enemy: Enemy): void {
    if (enemy.kind === "chaser") {
      const moving = Math.hypot(enemy.moveVx, enemy.moveVy) > 12 || enemy.dashState === "dashing";
      const stepPhase = Math.floor((this.time.now + enemy.body.x * 2) / 125) % 2 === 0;
      enemy.body.setTexture(moving && stepPhase ? "enemy-step" : "enemy");
    }
    enemy.halo.setPosition(enemy.body.x, enemy.body.y + (enemy.kind === "boss" ? 27 : 13));
    enemy.eyeGlow.setPosition(enemy.body.x, enemy.body.y - (enemy.kind === "boss" ? 17 : 7));
  }

  private restoreEnemyAppearance(enemy: Enemy): void {
    if (enemy.kind === "boss") enemy.body.setTint(0xb06cff);
    else if (enemy.kind === "shooter") enemy.body.setTint(0x6ee8ef);
    else enemy.body.clearTint();
    enemy.halo.setFillStyle(enemy.kind === "boss" ? 0x2b1244 : enemy.kind === "shooter" ? 0x102c43 : 0x240b18, 0.62);
    enemy.eyeGlow
      .setFillStyle(enemy.kind === "boss" ? 0xe9b7ff : enemy.kind === "shooter" ? 0x85f7ff : 0xffdf72, 1)
      .setAlpha(0.18);
  }

  private updateEnemyThreatVisual(enemy: Enemy, unarmed: boolean): void {
    if (enemy.dashState === "telegraph") return;
    const pulse = 0.76 + Math.sin(this.time.now * 0.016 + enemy.body.x) * 0.24;
    const armedColor = enemy.kind === "boss" ? 0x2b1244 : enemy.kind === "shooter" ? 0x102c43 : 0x240b18;
    const threatColor = enemy.kind === "boss" ? 0x51205f : enemy.kind === "shooter" ? 0x174b63 : 0x68142a;
    enemy.halo.setFillStyle(unarmed ? threatColor : armedColor, unarmed ? 0.9 : 0.62);
    enemy.eyeGlow
      .setFillStyle(unarmed ? 0xffffb0 : enemy.kind === "boss" ? 0xe9b7ff : enemy.kind === "shooter" ? 0x85f7ff : 0xffdf72, 1)
      .setAlpha(unarmed ? 0.72 + pulse * 0.28 : 0.18);
  }

  private checkEnemyNearMisses(): void {
    const now = this.time.now;
    for (const enemy of this.enemies) {
      if (!enemy.alive || now < enemy.nearMissReadyAt) continue;
      const distance = Phaser.Math.Distance.Between(this.player.x, this.player.y, enemy.body.x, enemy.body.y);
      const collisionDistance = PLAYER_RADIUS + enemy.radius;
      if (distance > collisionDistance && distance < collisionDistance + 22) {
        if (this.triggerNearMiss("CLOSE CALL")) enemy.nearMissReadyAt = now + 2200;
      }
    }
  }

  private tryMoveCircle(body: Phaser.GameObjects.Sprite, dx: number, dy: number, radius: number): void {
    this.resolveCirclePenetration(body, radius);
    const nextX = Phaser.Math.Clamp(body.x + dx, ARENA.x + radius, ARENA.right - radius);
    const nextY = Phaser.Math.Clamp(body.y + dy, ARENA.y + radius, ARENA.bottom - radius);
    if (!this.circleHitsObstacle(nextX, body.y, radius)) body.x = nextX;
    if (!this.circleHitsObstacle(body.x, nextY, radius)) body.y = nextY;
    this.resolveCirclePenetration(body, radius);
  }

  // Collision used to only reject the requested axis. A dash or a compressed map can
  // leave an actor microscopically inside a corner, after which both axes are rejected.
  // Depenetrating before and after movement guarantees a walkable escape direction.
  private resolveCirclePenetration(body: Phaser.GameObjects.Sprite, radius: number): void {
    for (let pass = 0; pass < 4; pass += 1) {
      let corrected = false;
      for (const rect of this.obstacles) {
        const closestX = Phaser.Math.Clamp(body.x, rect.left, rect.right);
        const closestY = Phaser.Math.Clamp(body.y, rect.top, rect.bottom);
        const offsetX = body.x - closestX;
        const offsetY = body.y - closestY;
        const distance = Math.hypot(offsetX, offsetY);
        if (distance >= radius - 0.001) continue;

        if (distance > 0.001) {
          const push = radius - distance + 0.06;
          body.x += offsetX / distance * push;
          body.y += offsetY / distance * push;
        } else {
          const exits = [
            { distance: body.x - rect.left, x: rect.left - radius - 0.06, y: body.y },
            { distance: rect.right - body.x, x: rect.right + radius + 0.06, y: body.y },
            { distance: body.y - rect.top, x: body.x, y: rect.top - radius - 0.06 },
            { distance: rect.bottom - body.y, x: body.x, y: rect.bottom + radius + 0.06 },
          ];
          const exit = exits.reduce((nearest, candidate) => candidate.distance < nearest.distance ? candidate : nearest);
          body.setPosition(exit.x, exit.y);
        }
        body.x = Phaser.Math.Clamp(body.x, ARENA.x + radius, ARENA.right - radius);
        body.y = Phaser.Math.Clamp(body.y, ARENA.y + radius, ARENA.bottom - radius);
        corrected = true;
      }
      if (!corrected) break;
    }
  }

  private circleHitsObstacle(x: number, y: number, radius: number): boolean {
    return this.obstacles.some((rect) => {
      const closestX = Phaser.Math.Clamp(x, rect.left, rect.right);
      const closestY = Phaser.Math.Clamp(y, rect.top, rect.bottom);
      return Phaser.Math.Distance.Between(x, y, closestX, closestY) < radius;
    });
  }

  private fire(targetX: number, targetY: number): void {
    const direction = new Phaser.Math.Vector2(targetX - this.player.x, targetY - this.player.y);
    if (direction.lengthSq() === 0) {
      this.cancelAim();
      return;
    }
    direction.normalize();
    this.resumeEnemyClocks();
    this.overlay.clear();
    this.aimGuide.clear();
    this.aimWarningText.setVisible(false);
    this.state = "bullet";
    const trail = this.add.graphics().setDepth(DEPTH.effects);
    const body = this.add.sprite(
      this.player.x + direction.x * BULLET_MUZZLE_OFFSET,
      this.player.y + direction.y * BULLET_MUZZLE_OFFSET,
      "bullet",
    )
      .setScale(2)
      .setRotation(direction.angle())
      .setDepth(DEPTH.effects);
    this.bullet = {
      body,
      trail,
      vx: direction.x * BULLET_SPEED,
      vy: direction.y * BULLET_SPEED,
      bounces: 0,
      age: 0,
      stopped: false,
      kills: 0,
      nearMissTriggered: false,
      nearMisses: 0,
      recoveryDistance: 0,
    };
    this.burst(body.x, body.y, 0xffe499, 7);
    this.cameras.main.shake(55, 0.0018);
    this.sounds.shot();
    this.updateHud();
  }

  private moveBullet(dt: number): void {
    const bullet = this.bullet!;
    bullet.age += dt;
    let remaining = BULLET_SPEED * dt;
    let safety = 0;
    bullet.trail.clear();
    bullet.trail.lineStyle(2, 0xffd98a, 0.72);

    while (remaining > 0.01 && safety++ < 8 && !bullet.stopped) {
      const direction = new Phaser.Math.Vector2(bullet.vx, bullet.vy).normalize();
      const wallHit = this.findRayHit(bullet.body.x, bullet.body.y, direction.x, direction.y, remaining);
      const travel = wallHit ? wallHit.distance : remaining;
      const startX = bullet.body.x;
      const startY = bullet.body.y;
      const endX = startX + direction.x * travel;
      const endY = startY + direction.y * travel;
      const stopT = this.processBulletImpacts(startX, startY, endX, endY);
      const actualT = stopT ?? 1;
      const actualX = Phaser.Math.Linear(startX, endX, actualT);
      const actualY = Phaser.Math.Linear(startY, endY, actualT);
      bullet.body.setPosition(actualX, actualY);
      bullet.trail.lineBetween(startX, startY, actualX, actualY);
      remaining -= travel * actualT;

      if (stopT !== undefined || this.state === "won" || this.state === "lost") return;
      if (!wallHit) break;

      bullet.bounces += 1;
      if (wallHit.normalX !== 0) bullet.vx *= -1;
      if (wallHit.normalY !== 0) bullet.vy *= -1;
      bullet.body.setRotation(Math.atan2(bullet.vy, bullet.vx));
      bullet.body.x += wallHit.normalX * 1.5;
      bullet.body.y += wallHit.normalY * 1.5;
      this.burst(bullet.body.x, bullet.body.y, 0x7ee8fa, 5);
      this.cameras.main.shake(35, 0.001);
      this.sounds.bounce();
      if (bullet.bounces >= MAX_BOUNCES) this.stopBullet();
    }
  }

  private processBulletImpacts(startX: number, startY: number, endX: number, endY: number): number | undefined {
    const impacts: Impact[] = [];
    if (this.bullet && this.bullet.age > 0.22) {
      const t = segmentCircleHit(startX, startY, endX, endY, this.player.x, this.player.y, PLAYER_RADIUS + BULLET_RADIUS - 1);
      if (t !== undefined) impacts.push({ t, kind: "player" });
      else if (!this.bullet.nearMissTriggered) {
        const nearMiss = segmentCircleHit(startX, startY, endX, endY, this.player.x, this.player.y, PLAYER_RADIUS + BULLET_RADIUS + 20);
        if (nearMiss !== undefined) this.triggerNearMiss("BULLET GRAZE");
      }
    }
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const t = segmentCircleHit(startX, startY, endX, endY, enemy.body.x, enemy.body.y, enemy.radius + BULLET_RADIUS);
      if (t !== undefined) impacts.push({ t, kind: "enemy", enemy });
    }

    impacts.sort((a, b) => a.t - b.t);
    for (const impact of impacts) {
      if (impact.kind === "player") {
        this.lose();
        return impact.t;
      }
      const result = this.damageEnemy(impact.enemy);
      if (result === "blocked") {
        this.stopBullet();
        return impact.t;
      }
      if (this.state === "won") return impact.t;
    }
    return undefined;
  }

  private damageEnemy(enemy: Enemy): "destroyed" | "blocked" {
    if (!enemy.alive) return "destroyed";
    enemy.health -= 1;
    if (enemy.health > 0) {
      this.burst(enemy.body.x, enemy.body.y, 0xd9a3ff, 16);
      this.cameras.main.shake(110, 0.006);
      enemy.body.setTint(0xffffff);
      this.time.delayedCall(100, () => {
        if (!enemy.alive) return;
        if (enemy.kind === "boss") enemy.body.setTint(0xb06cff);
        else enemy.body.clearTint();
      });
      this.sounds.shield();
      if (enemy.kind === "boss") this.advanceBossPhase(enemy);
      this.updateHud();
      return "blocked";
    }

    enemy.alive = false;
    this.awardEnemyKill(enemy);
    this.burst(enemy.body.x, enemy.body.y, enemy.kind === "boss" ? 0xc77dff : 0xff637b, enemy.kind === "boss" ? 32 : 16);
    this.cameras.main.shake(enemy.kind === "boss" ? 260 : 100, enemy.kind === "boss" ? 0.012 : 0.004);
    this.sounds.hit();
    this.tweens.add({
      targets: [enemy.body, enemy.halo, enemy.eyeGlow],
      scale: enemy.kind === "boss" ? 2.7 : 1.9,
      alpha: 0,
      duration: enemy.kind === "boss" ? 320 : 180,
      onComplete: () => {
        enemy.body.destroy();
        enemy.halo.destroy();
        enemy.eyeGlow.destroy();
      },
    });
    if (this.enemies.every((item) => !item.alive)) this.win();
    this.updateHud();
    return "destroyed";
  }

  private awardEnemyKill(enemy: Enemy): void {
    if (!this.bullet) return;
    this.bullet.kills += 1;
    const chain = this.bullet.kills;
    const base = enemy.kind === "boss" ? 600 : 100;
    const gained = base + this.bullet.bounces * 40 + Math.max(0, chain - 1) * 150;
    this.score += gained;
    const label = chain > 1 ? `CHAIN x${chain}  +${gained}` : `RICOCHET +${gained}`;
    this.showFloatingText(enemy.body.x, enemy.body.y - enemy.radius - 18, label, chain > 1 ? "#fff08a" : "#9ff3ff");
    this.sounds.reward(chain);
  }

  private advanceBossPhase(enemy: Enemy): void {
    const phase = enemy.maxHealth - enemy.health + 1;
    enemy.speed *= 1.24;
    enemy.canDash = true;
    enemy.dashReadyAt = this.time.now + 260;
    enemy.shootReadyAt = this.time.now + 380;
    this.cameras.main.flash(180, 105, 30, 145, false);
    this.cameras.main.shake(260, 0.011);
    this.sounds.phase();
    this.showFloatingText(enemy.body.x, enemy.body.y - 82, `CORE PHASE ${phase}`, "#e3a7ff");
    this.updateBossBarrage(enemy);

    const reinforcementAuthored: EnemyDefinition[] = enemy.health === 3
      ? [{ x: 1160, y: 260, speed: 58, kind: "shooter" }]
      : enemy.health === 2
        ? [
          { x: 900, y: 120, speed: 94 },
          { x: 1160, y: 260, speed: 60, kind: "shooter" },
        ]
        : [
          { x: 900, y: 120, speed: 98 },
          { x: 1160, y: 260, speed: 64, kind: "shooter" },
          { x: 920, y: 590, speed: 92 },
        ];
    for (const definition of reinforcementAuthored) {
      const reinforcement = this.compactEnemy(definition);
      if (this.circleHitsObstacle(reinforcement.x, reinforcement.y, 12)) continue;
      const minion = this.makeEnemy(reinforcement);
      minion.dashReadyAt = this.time.now + 900;
      minion.shootReadyAt = this.time.now + 1050;
      this.enemies.push(minion);
      this.burst(reinforcement.x, reinforcement.y, 0xb364ff, 18);
    }
  }

  private triggerNearMiss(label: "BULLET GRAZE" | "CLOSE CALL"): boolean {
    if (this.time.now < this.nearMissCooldownAt) return false;
    this.nearMissCooldownAt = this.time.now + 900;
    if (this.bullet) {
      if (label === "BULLET GRAZE") this.bullet.nearMissTriggered = true;
      this.bullet.nearMisses += 1;
    }
    this.combatTimeScale = 0.35;
    this.time.timeScale = 0.35;
    this.cameras.main.flash(80, 95, 225, 255, false);
    this.showFloatingText(this.player.x, this.player.y - 48, label, "#8df3ff");
    this.sounds.nearMiss();
    this.time.delayedCall(45, () => {
      this.combatTimeScale = 1;
      this.time.timeScale = 1;
    });
    return true;
  }

  private showFloatingText(x: number, y: number, message: string, color: string): void {
    const text = this.add.text(x, y, message, {
      fontFamily: "monospace",
      fontSize: "15px",
      fontStyle: "bold",
      color,
      stroke: "#080b12",
      strokeThickness: 4,
    }).setOrigin(0.5).setDepth(DEPTH.effects);
    this.tweens.add({
      targets: text,
      y: y - 28,
      alpha: 0,
      duration: 720,
      ease: "Cubic.Out",
      onComplete: () => text.destroy(),
    });
  }

  private findRayHit(x: number, y: number, dx: number, dy: number, maxDistance: number): { distance: number; normalX: number; normalY: number } | undefined {
    const candidates: Array<{ distance: number; normalX: number; normalY: number }> = [];
    const addCandidate = (distance: number, normalX: number, normalY: number): void => {
      if (distance >= 0 && distance <= maxDistance + 0.01) candidates.push({ distance, normalX, normalY });
    };

    if (dx > 0) addCandidate((ARENA.right - BULLET_RADIUS - x) / dx, -1, 0);
    if (dx < 0) addCandidate((ARENA.left + BULLET_RADIUS - x) / dx, 1, 0);
    if (dy > 0) addCandidate((ARENA.bottom - BULLET_RADIUS - y) / dy, 0, -1);
    if (dy < 0) addCandidate((ARENA.top + BULLET_RADIUS - y) / dy, 0, 1);

    for (const rect of this.obstacles) {
      const expanded = new Phaser.Geom.Rectangle(
        rect.x - BULLET_RADIUS,
        rect.y - BULLET_RADIUS,
        rect.width + BULLET_RADIUS * 2,
        rect.height + BULLET_RADIUS * 2,
      );
      const hit = rayRectangleHit(x, y, dx, dy, expanded.left, expanded.top, expanded.right, expanded.bottom);
      if (hit) addCandidate(hit.distance, hit.normalX, hit.normalY);
    }
    return nearestCombinedRayHit(candidates);
  }

  private drawDashedTrajectory(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: number,
    alpha: number,
    width: number,
  ): void {
    const distance = Phaser.Math.Distance.Between(x1, y1, x2, y2);
    if (distance < 0.01) return;
    const dx = (x2 - x1) / distance;
    const dy = (y2 - y1) / distance;
    this.aimGuide.lineStyle(width, color, alpha);
    for (let cursor = 0; cursor < distance; cursor += 18) {
      const end = Math.min(cursor + 10, distance);
      this.aimGuide.lineBetween(x1 + dx * cursor, y1 + dy * cursor, x1 + dx * end, y1 + dy * end);
    }
  }

  private drawAimGuide(): void {
    this.drawFreezeOverlay();
    this.aimGuide.clear();
    this.aimWarningText.setVisible(false);
    const pointer = this.input.activePointer;
    const direction = new Phaser.Math.Vector2(pointer.worldX - this.player.x, pointer.worldY - this.player.y);
    if (direction.lengthSq() === 0) return;
    direction.normalize();

    let x = this.player.x + direction.x * BULLET_MUZZLE_OFFSET;
    let y = this.player.y + direction.y * BULLET_MUZZLE_OFFSET;
    let vx = direction.x;
    let vy = direction.y;
    this.aimGuide.fillStyle(0xe8fffb, 0.92).fillCircle(x, y, 2.5);
    for (let i = 0; i < MAX_BOUNCES; i++) {
      const hit = this.findRayHit(x, y, vx, vy, 2000);
      if (!hit) break;
      const nextX = x + vx * hit.distance;
      const nextY = y + vy * hit.distance;
      const selfHit = i > 0
        ? segmentCircleHit(x, y, nextX, nextY, this.player.x, this.player.y, PLAYER_RADIUS + BULLET_RADIUS + 2)
        : undefined;
      const segmentColor = selfHit !== undefined ? 0xff817d : i === 0 ? 0xbaf8ee : 0x78aeb5;
      const segmentAlpha = selfHit !== undefined ? 0.95 : Math.max(0.3, 0.72 - i * 0.09);
      this.drawDashedTrajectory(x, y, nextX, nextY, segmentColor, segmentAlpha, selfHit !== undefined ? 2.4 : 1.35);

      if (selfHit !== undefined) {
        const dangerX = Phaser.Math.Linear(x, nextX, selfHit);
        const dangerY = Phaser.Math.Linear(y, nextY, selfHit);
        this.aimGuide.lineStyle(2, 0xff817d, 0.95)
          .lineBetween(dangerX - 7, dangerY - 7, dangerX + 7, dangerY + 7)
          .lineBetween(dangerX + 7, dangerY - 7, dangerX - 7, dangerY + 7);
        this.aimWarningText
          .setPosition(
            Phaser.Math.Clamp(dangerX, ARENA.left + 56, ARENA.right - 56),
            Phaser.Math.Clamp(dangerY - 28, ARENA.top + 18, ARENA.bottom - 18),
          )
          .setVisible(true);
        break;
      }

      const markerAlpha = Math.max(0.3, 0.82 - i * 0.1);
      this.aimGuide.lineStyle(1.5, 0x9de9df, markerAlpha)
        .strokeRect(nextX - 4, nextY - 4, 8, 8);
      x = nextX + hit.normalX * 1.5;
      y = nextY + hit.normalY * 1.5;
      if (hit.normalX) vx *= -1;
      if (hit.normalY) vy *= -1;
    }
  }

  private drawFreezeOverlay(): void {
    this.overlay.clear();
    this.overlay.fillStyle(0x06101d, 0.34).fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    this.overlay.fillStyle(0x76eadc, 0.16).fillRect(ARENA.x, ARENA.y, 3, ARENA.height);
    this.overlay.fillStyle(0x76eadc, 0.07).fillRect(ARENA.right - 3, ARENA.y, 3, ARENA.height);
    this.overlay.lineStyle(1, 0xb7fff3, 0.16).strokeRect(ARENA.x + 5, ARENA.y + 5, ARENA.width - 10, ARENA.height - 10);
  }

  private cancelAim(): void {
    if (this.state !== "aiming") return;
    this.resumeEnemyClocks();
    this.state = "playing";
    this.overlay.clear();
    this.aimGuide.clear();
    this.aimWarningText.setVisible(false);
    this.updateHud();
  }

  private resumeEnemyClocks(): void {
    if (this.aimStartedAt <= 0) return;
    const frozenFor = Math.max(0, this.time.now - this.aimStartedAt);
    for (const enemy of this.enemies) {
      enemy.nextPathAt += frozenFor;
      enemy.dashReadyAt += frozenFor;
      if (enemy.dashUntil > 0) enemy.dashUntil += frozenFor;
    }
    this.tensionPulseAt += frozenFor;
    this.aimStartedAt = 0;
  }

  private checkEnemyContact(): void {
    for (const enemy of this.enemies) {
      if (enemy.alive && Phaser.Math.Distance.Between(this.player.x, this.player.y, enemy.body.x, enemy.body.y) < PLAYER_RADIUS + enemy.radius) {
        this.lose();
        return;
      }
    }
  }

  private stopBullet(): void {
    if (!this.bullet || this.bullet.stopped) return;
    this.bullet.stopped = true;
    this.bullet.vx = 0;
    this.bullet.vy = 0;
    this.state = "recover";
    this.recoveryPulse = 0;
    this.bullet.recoveryDistance = Phaser.Math.Distance.Between(
      this.player.x,
      this.player.y,
      this.bullet.body.x,
      this.bullet.body.y,
    );
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      enemy.path = [];
      enemy.pathIndex = 0;
      enemy.nextPathAt = 0;
      const recoveryDash = this.stageIndex > 0 && enemy.speed >= 65;
      if (enemy.canDash || recoveryDash) {
        enemy.dashReadyAt = Math.min(enemy.dashReadyAt, this.time.now + Phaser.Math.Between(420, 820));
      }
    }
    this.showFloatingText(GAME_WIDTH / 2, 126, "RECOVERY HUNT", "#ffb36b");
    this.updateHud();
  }

  private reclaimBullet(): void {
    if (!this.bullet) return;
    const reward = calculateRiskReward({
      distance: this.bullet.recoveryDistance,
      bounces: this.bullet.bounces,
      kills: this.bullet.kills,
      nearMisses: this.bullet.nearMisses,
    });
    if (reward.bonus > 0) {
      this.score += reward.bonus;
      this.showFloatingText(
        this.bullet.body.x,
        this.bullet.body.y - 34,
        `${reward.tier} RECLAIM  x${reward.multiplier.toFixed(1)}  +${reward.bonus}`,
        reward.tier === "RECKLESS" ? "#ff8c74" : "#ffe38a",
      );
    }
    this.burst(this.bullet.body.x, this.bullet.body.y, 0xffdc72, 18);
    this.cameras.main.flash(90, 105, 232, 250, false);
    this.sounds.reclaim();
    this.bullet.body.destroy();
    this.bullet.trail.destroy();
    this.bullet = undefined;
    this.state = "playing";
    this.updateHud();
  }

  private win(): void {
    this.stopBullet();
    this.state = "won";
    this.combatTimeScale = 1;
    this.time.timeScale = 1;
    this.hideBulletForResult();
    this.overlay.clear().fillStyle(0x071d1c, 0.78).fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    const finalStage = this.stageIndex === STAGES.length - 1;
    this.showCenterMessage(
      finalStage ? "CORE RECLAIMED" : "AREA CLEARED",
      finalStage ? "모든 구역 확보 · 클릭하면 첫 스테이지부터 다시 시작" : "클릭하면 다음 구역으로 이동",
    );
    this.sounds.clear();
    this.updateHud();
  }

  private lose(): void {
    if (this.state === "lost" || this.state === "won") return;
    this.state = "lost";
    this.combatTimeScale = 1;
    this.time.timeScale = 1;
    this.hideBulletForResult();
    this.overlay.clear().fillStyle(0x2c0710, 0.76).fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    this.player.setTint(0xff7890);
    this.burst(this.player.x, this.player.y, 0xff7890, 24);
    this.cameras.main.shake(280, 0.014);
    this.showCenterMessage("YOU WERE HIT", "한 발은 적도, 나도 즉사시킨다 · 클릭 또는 R로 재시작");
    this.sounds.fail();
    this.updateHud();
  }

  private showCenterMessage(title: string, subtitle: string): void {
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 14, title, {
      fontFamily: "monospace",
      fontSize: "42px",
      fontStyle: "bold",
      color: "#f7fbff",
    }).setOrigin(0.5).setDepth(DEPTH.message);
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 39, subtitle, {
      fontFamily: "monospace",
      fontSize: "18px",
      color: "#b8d7e2",
    }).setOrigin(0.5).setDepth(DEPTH.message);
  }

  private burst(x: number, y: number, color: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const size = Phaser.Math.Between(3, 7);
      const particle = this.add.rectangle(x, y, size, size, color, 0.95).setDepth(DEPTH.effects);
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const distance = Phaser.Math.Between(18, count > 20 ? 92 : 58);
      this.tweens.add({
        targets: particle,
        x: x + Math.cos(angle) * distance,
        y: y + Math.sin(angle) * distance,
        alpha: 0,
        scale: 0.25,
        duration: Phaser.Math.Between(180, 420),
        ease: "Cubic.Out",
        onComplete: () => particle.destroy(),
      });
    }
  }

  private updateTensionEffects(): void {
    const active = this.state !== "won" && this.state !== "lost" && this.state !== "title";
    if (!active) {
      this.recoveryGuide.clear();
      this.recoveryText.setVisible(false);
      this.dangerVignette.setAlpha(0);
      this.pressureWash.setAlpha(0);
      return;
    }

    const alive = this.enemies.filter((enemy) => enemy.alive).length;
    const boss = this.enemies.find((enemy) => enemy.alive && enemy.kind === "boss");
    const lateThreshold = Math.max(1, Math.ceil(this.initialEnemyCount * 0.35));
    const shouldPressure = (alive > 0 && alive <= lateThreshold && alive < this.initialEnemyCount)
      || Boolean(boss && boss.health === 1);
    if (shouldPressure && !this.latePressure) {
      this.showFloatingText(GAME_WIDTH / 2, 126, "THREAT ESCALATED", "#ff8399");
      this.sounds.tension(1);
    }
    this.latePressure = shouldPressure;

    const unarmed = this.state === "bullet" || this.state === "recover";
    const tension = Math.min(1, (unarmed ? 0.68 : 0) + (this.latePressure ? 0.38 : 0));
    const pulse = 0.78 + Math.sin(this.time.now * (0.008 + tension * 0.006)) * 0.22;
    this.dangerVignette.setAlpha(tension * 0.48 * pulse);
    this.pressureWash.setAlpha(this.latePressure ? 0.08 + pulse * 0.055 : 0);

    this.recoveryGuide.clear();
    this.recoveryText.setVisible(false);
    if (unarmed && this.bullet?.body.visible) {
      const direction = new Phaser.Math.Vector2(this.bullet.body.x - this.player.x, this.bullet.body.y - this.player.y);
      const distance = direction.length();
      if (distance > 1) {
        direction.normalize();
        const perpendicular = new Phaser.Math.Vector2(-direction.y, direction.x);
        const farAway = distance > 260;
        const horizontalLimit = direction.x > 0
          ? (ARENA.right - 34 - this.player.x) / direction.x
          : direction.x < 0
            ? (ARENA.left + 34 - this.player.x) / direction.x
            : Number.POSITIVE_INFINITY;
        const verticalLimit = direction.y > 0
          ? (ARENA.bottom - 34 - this.player.y) / direction.y
          : direction.y < 0
            ? (ARENA.top + 34 - this.player.y) / direction.y
            : Number.POSITIVE_INFINITY;
        const edgeDistance = Math.max(70, Math.min(horizontalLimit, verticalLimit));
        const indicatorDistance = farAway ? edgeDistance : 60;
        const tipX = this.player.x + direction.x * indicatorDistance;
        const tipY = this.player.y + direction.y * indicatorDistance;
        const startX = tipX - direction.x * (farAway ? 38 : 32);
        const startY = tipY - direction.y * (farAway ? 38 : 32);
        const color = this.state === "recover" ? 0xffd76b : 0xff9a63;
        const distancePressure = Phaser.Math.Clamp((distance - 180) / 500, 0, 1);
        const arrowPulse = 0.68 + Math.sin(this.time.now * (0.012 + distancePressure * 0.01)) * 0.26;
        this.recoveryGuide.lineStyle(5 + distancePressure * 2, color, arrowPulse).lineBetween(startX, startY, tipX, tipY);
        this.recoveryGuide.fillStyle(color, 1).fillTriangle(
          tipX,
          tipY,
          tipX - direction.x * 13 + perpendicular.x * 8,
          tipY - direction.y * 13 + perpendicular.y * 8,
          tipX - direction.x * 13 - perpendicular.x * 8,
          tipY - direction.y * 13 - perpendicular.y * 8,
        );
        const labelX = Phaser.Math.Clamp(tipX - direction.x * 58, ARENA.left + 62, ARENA.right - 62);
        const labelY = Phaser.Math.Clamp(tipY - direction.y * 58, ARENA.top + 24, ARENA.bottom - 24);
        this.recoveryText
          .setText(`${this.state === "recover" ? "회수" : "탄환"} ${Math.round(distance)}px`)
          .setPosition(labelX, labelY)
          .setColor(this.state === "recover" ? "#ffd76b" : "#ffab79")
          .setVisible(true);
      }
    }

    if (tension > 0 && this.time.now >= this.tensionPulseAt) {
      this.sounds.tension(tension);
      this.tensionPulseAt = this.time.now + 920 - tension * 380;
    }
    this.updateRiskDisplay();
  }

  private updateHud(): void {
    const alive = this.enemies.filter((enemy) => enemy.alive).length;
    const boss = this.enemies.find((enemy) => enemy.alive && enemy.kind === "boss");
    const status: Record<GameState, string> = {
      title: "READY · 작전 대기",
      playing: "ARMED · 한 발 장전됨",
      aiming: "TIME FROZEN · 경로를 설계하라",
      bullet: "TIME FROZEN · 탄도 해결 중 · 전장 정지",
      recover: "UNARMED · 탄환을 회수하라",
      won: this.stageIndex === STAGES.length - 1 ? "MISSION COMPLETE" : "AREA CLEARED",
      lost: "MISSION FAILED",
    };
    this.statusText.setText(status[this.state]);
    this.statusText.setColor(this.state === "aiming" ? "#8df3ff" : this.state === "recover" ? "#ffd76b" : this.state === "lost" ? "#ff97aa" : "#f8fbff");
    const bossStatus = boss ? `  ·  코어 보호막 ${boss.health}/${boss.maxHealth}` : "";
    this.objectiveText.setText(`목표: 적 ${alive}명 제거${bossStatus}  ·  최대 ${MAX_BOUNCES}회 반사  ·  내 탄환에도 즉사`);
    this.scoreText.setText(`SCORE ${this.score.toString().padStart(6, "0")}`);
    this.updateRiskDisplay();
    this.stageText.setAlpha(this.state === "aiming" ? 1 : 0.82);
  }

  private updateRiskDisplay(): void {
    const showRisk = this.state === "bullet" || this.state === "recover";
    const risk = showRisk && this.bullet?.body.active
      ? calculateRiskReward({
        distance: this.bullet.recoveryDistance || Phaser.Math.Distance.Between(
          this.player.x,
          this.player.y,
          this.bullet.body.x,
          this.bullet.body.y,
        ),
        bounces: this.bullet.bounces,
        kills: this.bullet.kills,
        nearMisses: this.bullet.nearMisses,
      }) : undefined;
    const riskStatus = risk ? `RISK ${risk.tier} x${risk.multiplier.toFixed(1)}` : "";
    this.riskText
      .setText(riskStatus)
      .setColor(risk?.tier === "RECKLESS" ? "#ff8c74" : risk?.tier === "BOLD" ? "#ffe38a" : "#9ff3ff");
  }

  private advanceStage(): void {
    const nextStage = this.stageIndex === STAGES.length - 1 ? 0 : this.stageIndex + 1;
    this.scene.restart({ stageIndex: nextStage, showTitle: nextStage === 0, score: nextStage === 0 ? 0 : this.score });
  }

  private hideBulletForResult(): void {
    if (!this.bullet) return;
    this.bullet.body.setVisible(false);
    this.bullet.trail.clear().setVisible(false);
  }

  private restartStage(): void {
    this.scene.restart({ stageIndex: this.stageIndex, showTitle: false, score: this.score });
  }
}
