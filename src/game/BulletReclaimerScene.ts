import Phaser from "phaser";
import {
  ARENA,
  BULLET_RECLAIM_RADIUS,
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
  RECOVERY_GRACE_MS,
} from "./constants";
import heroRunSheetUrl from "../assets/hero-run-sheet-alpha.png";
import { nearestCombinedRayHit, rayRectangleHit, segmentCircleHit } from "./geometry";
import { findNavigationPath, hasClearPath } from "./pathfinding";
import { calculateRiskReward, enemyPressureMultiplier } from "./risk";
import { SoundManager } from "./SoundManager";
import { STAGES } from "./stages";
import {
  canEnemiesMove,
  canPlayerMove,
  isEnemyMovementBlocked,
  recoveryIndicatorDistance,
} from "./stateRules";
import type { Bullet, Enemy, EnemyDefinition, EnemyProjectile, GameState, StageDefinition } from "./types";

type Impact =
  | { t: number; kind: "player" }
  | { t: number; kind: "enemy"; enemy: Enemy };

type BossPattern = "none" | "telegraph-charge" | "charging" | "telegraph-volley" | "telegraph-leap" | "leaping";

interface TemporaryCover {
  rect: Phaser.Geom.Rectangle;
  visual: Phaser.GameObjects.Graphics;
  landingAt: number;
  expiresAt: number;
  active: boolean;
}

const BULLET_MUZZLE_OFFSET = Math.max(0, PLAYER_RADIUS - BULLET_RADIUS - 2);
const AUTHORING_ARENA = { x: 54, y: 86, width: 1172, height: 574 };
const ENEMY_BASE_SPEED_MULTIPLIER = 1.12;

export class BulletReclaimerScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Sprite;
  private playerRing!: Phaser.GameObjects.Ellipse;
  private enemies: Enemy[] = [];
  private enemyProjectiles: EnemyProjectile[] = [];
  private temporaryCovers: TemporaryCover[] = [];
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
  private bossPatternText!: Phaser.GameObjects.Text;
  private bossTelegraph!: Phaser.GameObjects.Graphics;
  private enemyAimGuide!: Phaser.GameObjects.Graphics;
  private tutorialText?: Phaser.GameObjects.Text;
  private recoveryPulse = 0;
  private initialEnemyCount = 0;
  private tensionPulseAt = 0;
  private latePressure = false;
  private score = 0;
  private combatTimeScale = 1;
  private aimStartedAt = 0;
  private nearMissCooldownAt = 0;
  private recoveryGraceUntil = 0;
  private bossPattern: BossPattern = "none";
  private bossPatternUntil = 0;
  private bossPatternNextAt = 0;
  private bossPatternIndex = 0;
  private readonly bossPatternTarget = new Phaser.Math.Vector2();
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
    this.temporaryCovers = [];
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
    this.recoveryGraceUntil = 0;
    this.bossPattern = "none";
    this.bossPatternUntil = 0;
    this.bossPatternNextAt = 0;
    this.bossPatternIndex = 0;
    this.bossPatternTarget.set(0, 0);
    this.playerVelocity.set(0, 0);
  }

  preload(): void {
    this.load.spritesheet("hero-art", heroRunSheetUrl, { frameWidth: 511, frameHeight: 770 });
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
    this.player = this.add.sprite(stage.player.x, stage.player.y, "hero-art", 0)
      .setScale(0.18)
      .setOrigin(0.5, 0.78)
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
    this.bossTelegraph = this.add.graphics().setDepth(DEPTH.guide + 1);
    this.enemyAimGuide = this.add.graphics().setDepth(DEPTH.guide + 1);
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
    if (this.stageIndex === STAGES.length - 1) this.beginBossEntrance();
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
      this.player.setTexture("hero-art", 0).setScale(0.18);
    }

    this.enemyAimGuide.clear();
    const recoveryGraceActive = this.state === "recover" && this.time.now < this.recoveryGraceUntil;
    if (canEnemiesMove(this.state) && !recoveryGraceActive) {
      this.moveEnemies(dt);
      this.moveEnemyProjectiles(dt);
      this.updateTemporaryCovers();
      this.checkEnemyNearMisses();
      this.checkEnemyContact();
    } else if (this.state === "bullet" || recoveryGraceActive) {
      for (const enemy of this.enemies) {
        if (!enemy.alive) continue;
        this.updateEnemyThreatVisual(enemy, this.state === "recover");
        this.syncEnemyVisual(enemy);
      }
    }

    if (this.state === "bullet" && this.bullet) this.moveBullet(dt);

    if (this.state === "recover" && this.bullet) {
      this.recoveryPulse += dt;
      const scale = 2 + Math.sin(this.recoveryPulse * 8) * 0.16;
      this.bullet.body.setScale(scale);
      if (Phaser.Math.Distance.Between(this.player.x, this.player.y, this.bullet.body.x, this.bullet.body.y) < BULLET_RECLAIM_RADIUS) {
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
    this.playerRing.setPosition(this.player.x, this.player.y + 18);
  }

  private createPixelTextures(): void {
    if (this.textures.exists("hero")) return;
    const g = this.make.graphics({ x: 0, y: 0 });
    const makeTexture = (key: string, width: number, height: number, draw: () => void): void => {
      g.clear();
      draw();
      g.generateTexture(key, width, height);
    };

    const drawHero = (pose: 0 | 1 | 2 | 3): void => {
      const running = pose !== 0;
      const lean = pose === 2 ? 2 : pose === 3 ? 1 : 0;
      const scarf = pose === 1 ? [[1, 15, 9, 4], [0, 19, 6, 3], [3, 22, 4, 2]]
        : pose === 2 ? [[0, 16, 11, 4], [0, 21, 8, 3], [2, 24, 5, 2]]
          : pose === 3 ? [[3, 14, 7, 4], [1, 18, 6, 3]]
            : [[3, 14, 6, 4], [1, 18, 4, 2]];
      // A sharp hood, glowing visor and asymmetric reclaim blade create the hero silhouette.
      g.fillStyle(0x4d2030).fillRect(9 + lean, 11, 5, 18);
      g.fillStyle(0xe57b4f);
      for (const [x, y, w, h] of scarf) g.fillRect(x, y, w, h);
      g.fillStyle(0x070d19).fillRect(11 + lean, 10, 13, 17);
      g.fillStyle(0x17314c).fillRect(12 + lean, 11, 11, 14);
      g.fillStyle(0x275979).fillRect(14 + lean, 14, 8, 9);
      g.fillStyle(0x07101e).fillRect(13 + lean, 3, 11, 9);
      g.fillStyle(0x325875).fillRect(14 + lean, 2, 8, 4).fillRect(11 + lean, 5, 3, 5);
      g.fillStyle(0xdbe9e7).fillRect(16 + lean, 5, 7, 5);
      g.fillStyle(0x87faf1).fillRect(18 + lean, 6, 5, 2);
      g.fillStyle(0x0d1b2c).fillRect(15 + lean, 10, 10, 3);
      g.fillStyle(0x7cecdf).fillRect(22 + lean, 8, 2, 2);
      const bladeX = pose === 1 ? 25 : pose === 2 ? 27 : pose === 3 ? 23 : 24;
      const bladeY = pose === 1 ? 11 : pose === 2 ? 14 : pose === 3 ? 9 : 12;
      g.fillStyle(0x07101c).fillRect(bladeX - 2, bladeY, 7, 9);
      g.fillStyle(0x35667c).fillRect(bladeX - 1, bladeY + 1, 6, 7);
      g.fillStyle(0x9cfaf0).fillRect(bladeX + 3, bladeY + 2, 4, 3);
      g.fillStyle(0xffd271).fillRect(bladeX + 6, bladeY + 3, 2, 1);
      g.fillStyle(0x08101d);
      if (pose === 1) {
        g.fillRect(9, 25, 5, 9).fillRect(21, 28, 6, 6);
        g.fillStyle(0x47788c).fillRect(6, 31, 8, 4).fillRect(21, 31, 8, 3);
      } else if (pose === 2) {
        g.fillRect(12, 26, 5, 8).fillRect(23, 22, 6, 11);
        g.fillStyle(0x47788c).fillRect(8, 31, 9, 4).fillRect(24, 29, 8, 4);
      } else if (pose === 3) {
        g.fillRect(8, 28, 6, 6).fillRect(20, 24, 5, 10);
        g.fillStyle(0x47788c).fillRect(5, 31, 9, 4).fillRect(20, 31, 8, 3);
      } else {
        g.fillRect(12, 26, 5, 8).fillRect(20, 26, 5, 8);
        g.fillStyle(0x47788c).fillRect(10, 31, 7, 3).fillRect(20, 31, 7, 3);
      }
      if (running) g.fillStyle(0x8bf5f1, 0.65).fillRect(11 + lean, 27, 3, 2);
    };
    makeTexture("hero", 34, 36, () => drawHero(0));
    makeTexture("hero-run-1", 34, 36, () => drawHero(1));
    makeTexture("hero-run-2", 34, 36, () => drawHero(2));
    makeTexture("hero-run-3", 34, 36, () => drawHero(3));
    makeTexture("hero-step", 34, 36, () => drawHero(1));

    const drawHunter = (pose: 0 | 1 | 2): void => {
      const lean = pose === 1 ? 1 : pose === 2 ? 2 : 0;
      g.fillStyle(0x110a18).fillRect(7 + lean, 4, 15, 14);
      g.fillStyle(0x56203b).fillRect(4 + lean, 8, 20, 10);
      g.fillStyle(0xb43d58).fillRect(7 + lean, 5, 14, 10);
      g.fillStyle(0xf06d72).fillRect(9 + lean, 4, 10, 3);
      g.fillStyle(0x1f0d1d).fillRect(8 + lean, 9, 12, 5);
      g.fillStyle(0xffdf76).fillRect(9 + lean, 10, 3, 2).fillRect(16 + lean, 10, 3, 2);
      g.fillStyle(0xff6f6d).fillRect(5 + lean, 1, 3, 6).fillRect(19 + lean, 1, 3, 6);
      g.fillStyle(0x260e20).fillRect(1 + lean, 11, 6, 6).fillRect(21 + lean, 10, 6, 7);
      g.fillStyle(0xe85e6d).fillRect(2 + lean, 13, 3, 2).fillRect(23 + lean, 12, 3, 2);
      g.fillStyle(0x210f20);
      if (pose === 1) {
        g.fillRect(5, 17, 6, 8).fillRect(19, 20, 7, 5);
        g.fillStyle(0x703047).fillRect(3, 23, 9, 3).fillRect(20, 23, 9, 3);
      } else if (pose === 2) {
        g.fillRect(9, 19, 6, 6).fillRect(21, 16, 6, 9);
        g.fillStyle(0x703047).fillRect(6, 23, 9, 3).fillRect(22, 22, 8, 4);
      } else {
        g.fillRect(9, 18, 5, 7).fillRect(19, 18, 5, 7);
        g.fillStyle(0x703047).fillRect(7, 23, 8, 3).fillRect(19, 23, 8, 3);
      }
    };
    makeTexture("enemy", 30, 27, () => drawHunter(0));
    makeTexture("enemy-run-1", 30, 27, () => drawHunter(1));
    makeTexture("enemy-run-2", 30, 27, () => drawHunter(2));
    makeTexture("enemy-lunge", 30, 27, () => drawHunter(1));
    makeTexture("enemy-step", 30, 27, () => drawHunter(1));

    const drawShooter = (pose: 0 | 1 | 2): void => {
      const lift = pose === 1 ? -2 : pose === 2 ? 1 : 0;
      g.fillStyle(0x081424).fillRect(5, 6 + lift, 18, 14);
      g.fillStyle(0x1d4668).fillRect(3, 8 + lift, 22, 10);
      g.fillStyle(0x3f7ea0).fillRect(7, 4 + lift, 14, 13);
      g.fillStyle(0x0b1a30).fillRect(9, 8 + lift, 10, 6);
      g.fillStyle(0x9bfff5).fillRect(10, 10 + lift, 3, 2).fillRect(16, 10 + lift, 3, 2);
      g.fillStyle(0x70bfe0).fillRect(11, 1 + lift, 6, 4);
      g.fillStyle(0x102a45).fillRect(0, 11 + lift, 7, 5).fillRect(21, 9 + lift, 7, 7);
      g.fillStyle(0x76eaf1).fillRect(23, 11 + lift, 6, 3);
      g.fillStyle(0x58cedb).fillRect(11, 18 + lift, 5, 5).fillRect(17, 18 + lift, 4, 5);
      if (pose !== 0) g.fillStyle(0x77fff3, 0.6).fillRect(8, 23 + lift, 12, 3);
    };
    makeTexture("shooter", 30, 27, () => drawShooter(0));
    makeTexture("shooter-hover-1", 30, 27, () => drawShooter(1));
    makeTexture("shooter-hover-2", 30, 27, () => drawShooter(2));

    makeTexture("enemy-bolt", 10, 6, () => {
      g.fillStyle(0x15334d).fillRect(0, 1, 3, 4);
      g.fillStyle(0x54d9ef).fillRect(2, 0, 5, 6);
      g.fillStyle(0xe1ffff).fillRect(6, 1, 4, 4);
    });

    const drawBoss = (pose: 0 | 1 | 2 | 3 | 4): void => {
      const lean = pose === 1 ? 2 : pose === 2 ? 4 : pose === 3 ? 5 : 0;
      const airborne = pose === 4;
      const coreY = airborne ? 8 : 12;
      // Large asymmetrical reactor beast: shoulder pylons, a bright core and heavy clawed legs.
      g.fillStyle(0x12091f).fillRect(13 + lean, coreY, 22, 29);
      g.fillStyle(0x30204d).fillRect(8 + lean, coreY + 7, 33, 22);
      g.fillStyle(0x604188).fillRect(13 + lean, coreY + 2, 22, 11);
      g.fillStyle(0x171029).fillRect(16 + lean, coreY + 7, 17, 9);
      g.fillStyle(0xf1d8ff).fillRect(18 + lean, coreY + 10, 4, 2).fillRect(28 + lean, coreY + 10, 4, 2);
      g.fillStyle(0xc779ff).fillRect(19 + lean, coreY + 10, 2, 2).fillRect(29 + lean, coreY + 10, 2, 2);
      g.fillStyle(0x201333).fillRect(15 + lean, coreY + 18, 21, 15);
      g.fillStyle(0x7651a5).fillRect(19 + lean, coreY + 19, 13, 11);
      g.fillStyle(0xe7b9ff).fillRect(22 + lean, coreY + 21, 7, 7);
      g.fillStyle(0xffffff).fillRect(24 + lean, coreY + 23, 3, 3);
      g.fillStyle(0x443060).fillRect(3 + lean, coreY + 11, 10, 15).fillRect(35 + lean, coreY + 10, 10, 16);
      g.fillStyle(0x8d63bd).fillRect(0 + lean, coreY + 15, 7, 8).fillRect(41 + lean, coreY + 14, 7, 9);
      g.fillStyle(0xe6c3ff).fillRect(1 + lean, coreY + 16, 3, 3).fillRect(44 + lean, coreY + 15, 3, 3);
      if (pose === 3) {
        g.fillStyle(0x9e72d8).fillRect(3, coreY + 17, 11, 8).fillRect(36, coreY + 15, 13, 9);
        g.fillStyle(0xffd1ff).fillRect(0, coreY + 19, 5, 3).fillRect(45, coreY + 17, 5, 3);
      }
      g.fillStyle(0x241635);
      if (pose === 1) {
        g.fillRect(12, coreY + 31, 10, 10).fillRect(31, coreY + 34, 12, 7);
        g.fillStyle(0x5b4277).fillRect(7, coreY + 38, 16, 5).fillRect(32, coreY + 38, 15, 4);
      } else if (pose === 2) {
        g.fillRect(17, coreY + 34, 11, 7).fillRect(35, coreY + 29, 10, 12);
        g.fillStyle(0x5b4277).fillRect(12, coreY + 38, 16, 5).fillRect(36, coreY + 37, 14, 5);
      } else if (airborne) {
        g.fillStyle(0xb778ee, 0.72).fillRect(14, 37, 22, 4).fillRect(18, 42, 14, 3);
      } else {
        g.fillRect(16, coreY + 32, 10, 9).fillRect(32, coreY + 32, 10, 9);
        g.fillStyle(0x5b4277).fillRect(12, coreY + 38, 15, 4).fillRect(31, coreY + 38, 15, 4);
      }
      g.fillStyle(0xa968df).fillRect(8 + lean, coreY + 1, 4, 4).fillRect(38 + lean, coreY + 1, 4, 4).fillRect(23 + lean, coreY - 4, 5, 4);
    };
    makeTexture("boss", 56, 50, () => drawBoss(0));
    makeTexture("boss-step-1", 56, 50, () => drawBoss(1));
    makeTexture("boss-step-2", 56, 50, () => drawBoss(2));
    makeTexture("boss-charge", 56, 50, () => drawBoss(3));
    makeTexture("boss-air", 56, 50, () => drawBoss(4));

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

    const operative = this.add.sprite(425, 382, "hero-art", 0).setScale(0.56).setOrigin(0.5, 0.78);
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
      fontSize: "14px",
      fontStyle: "bold",
      color: "#b9d5df",
      letterSpacing: 0.8,
    }).setDepth(DEPTH.hud);

    this.stageText.setText(`STAGE ${this.stageIndex + 1}/${STAGES.length}  //  ${stage.name}`);

    this.objectiveText = this.add.text(54, 678, "", {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "14px",
      color: "#c3d5db",
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

    this.bossPatternText = this.add.text(GAME_WIDTH / 2, 643, "", {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "13px",
      fontStyle: "bold",
      color: "#ffb4aa",
      backgroundColor: "#241018",
      padding: { x: 12, y: 6 },
      letterSpacing: 1.2,
    }).setOrigin(0.5).setDepth(DEPTH.hud + 1).setVisible(false);

    this.add.text(GAME_WIDTH / 2, 40, "WASD 이동  ·  마우스 누름: 시간 정지 조준  ·  놓기: 발사  ·  우클릭/ESC: 취소  ·  R: 재시작", {
      fontFamily: '"Segoe UI", sans-serif',
      fontSize: "13px",
      color: "#a7c2ca",
      letterSpacing: 0.55,
    }).setOrigin(0.5).setDepth(DEPTH.hud);
    if (this.stageIndex === 0) {
      this.tutorialText = this.add.text(GAME_WIDTH / 2, 94, "LEARN THE LOOP  //  BANK ONE SHOT  ·  DODGE  ·  RECLAIM", {
        fontFamily: '"Segoe UI", sans-serif',
        fontSize: "14px",
        fontStyle: "bold",
        color: "#9ff6e8",
        backgroundColor: "#0b1722",
        padding: { x: 10, y: 5 },
        letterSpacing: 1.1,
      }).setOrigin(0.5).setDepth(DEPTH.hud);
    }
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
      invulnerable: false,
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
      shootTelegraphUntil: 0,
      shootTargetX: 0,
      shootTargetY: 0,
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
    const runFrame = 1 + Math.floor(this.time.now / 88) % 3;
    this.player.setTexture("hero-art", movement > 0.14 ? runFrame : 0);
    const step = Math.sin(this.time.now * 0.043) * 0.055 * movement;
    const breathing = Math.sin(this.time.now * 0.004) * 0.012 * (1 - movement);
    this.player.setScale(0.18 - Math.abs(step) * 0.04, 0.18 + step * 0.13 + breathing * 0.08);
  }

  private moveEnemies(dt: number): void {
    const unarmed = this.state === "recover";
    const pressureMultiplier = enemyPressureMultiplier(unarmed, this.latePressure);
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      this.updateEnemyThreatVisual(enemy, unarmed);
      if (enemy.kind === "boss" && this.updateBossEncounter(enemy, dt, pressureMultiplier)) continue;
      if (enemy.kind === "shooter" && this.updateShooterAttack(enemy)) {
        this.syncEnemyVisual(enemy);
        continue;
      }
      if (enemy.kind !== "boss" && this.updateEnemyDash(enemy, dt, pressureMultiplier, unarmed)) continue;

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

  private updateShooterAttack(enemy: Enemy): boolean {
    const now = this.time.now;
    if (enemy.shootTelegraphUntil > 0) {
      const direction = new Phaser.Math.Vector2(enemy.shootTargetX - enemy.body.x, enemy.shootTargetY - enemy.body.y).normalize();
      const flashing = Math.floor(now / 80) % 2 === 0;
      this.enemyAimGuide.lineStyle(2, 0x8df6ff, flashing ? 0.86 : 0.42)
        .lineBetween(enemy.body.x, enemy.body.y - 4, enemy.shootTargetX, enemy.shootTargetY);
      this.enemyAimGuide.lineStyle(1.5, 0xefffff, 0.8).strokeCircle(enemy.shootTargetX, enemy.shootTargetY, 13);
      enemy.eyeGlow.setFillStyle(0xeaffff, 1).setAlpha(flashing ? 1 : 0.45);
      if (now < enemy.shootTelegraphUntil) return true;
      this.spawnEnemyProjectile(enemy.body.x, enemy.body.y - 4, direction.x, direction.y, 300, 0x6ee8ef);
      enemy.shootTelegraphUntil = 0;
      enemy.shootReadyAt = now + Phaser.Math.Between(1500, 1950);
      this.cameras.main.flash(35, 70, 210, 225, false);
      return true;
    }
    if (now < enemy.shootReadyAt) return false;
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
      return false;
    }
    enemy.shootTargetX = this.player.x;
    enemy.shootTargetY = this.player.y;
    enemy.shootTelegraphUntil = now + 560;
    enemy.eyeGlow.setAlpha(1);
    this.showFloatingText(enemy.body.x, enemy.body.y - 30, "LOCK", "#9ef6ff");
    return true;
  }

  private beginBossEntrance(): void {
    const boss = this.enemies.find((enemy) => enemy.kind === "boss");
    if (!boss) return;
    boss.invulnerable = true;
    boss.body.setPosition(ARENA.centerX, ARENA.top - 84).setAlpha(0).setScale(2.1);
    boss.halo.setPosition(ARENA.centerX, ARENA.top - 57).setAlpha(0);
    boss.eyeGlow.setPosition(ARENA.centerX, ARENA.top - 101).setAlpha(0);
    this.showBossPattern("CORE DESCENT // 중앙 코어가 강하한다", "#e3a7ff");
    this.cameras.main.flash(180, 115, 58, 180, false);
    this.tweens.add({
      targets: [boss.body, boss.halo, boss.eyeGlow],
      alpha: 1,
      duration: 220,
    });
    this.tweens.add({
      targets: boss.body,
      y: ARENA.centerY - 24,
      scale: 2.65,
      duration: 920,
      ease: "Cubic.Out",
      onComplete: () => {
        boss.invulnerable = false;
        this.syncEnemyVisual(boss);
        this.burst(boss.body.x, boss.body.y, 0xd9a3ff, 26);
        this.cameras.main.shake(250, 0.01);
        this.bossPatternNextAt = this.time.now + 560;
        this.hideBossPattern();
      },
    });
    this.tweens.add({
      targets: boss.halo,
      y: ARENA.centerY + 3,
      duration: 920,
      ease: "Cubic.Out",
    });
    this.tweens.add({
      targets: boss.eyeGlow,
      y: ARENA.centerY - 41,
      duration: 920,
      ease: "Cubic.Out",
    });
  }

  private updateBossEncounter(enemy: Enemy, dt: number, pressureMultiplier: number): boolean {
    if (enemy.invulnerable) {
      this.syncEnemyVisual(enemy);
      return true;
    }

    this.syncEnemyVisual(enemy);

    const now = this.time.now;
    if (this.bossPattern === "none" && now >= this.bossPatternNextAt) this.startBossPattern(enemy);

    if (this.bossPattern === "telegraph-charge" || this.bossPattern === "telegraph-volley" || this.bossPattern === "telegraph-leap") {
      if (now < this.bossPatternUntil) return true;
      if (this.bossPattern === "telegraph-charge") {
        this.bossPattern = "charging";
        this.bossPatternUntil = now + 900;
        this.showBossPattern("CHARGE ACTIVE // 측면으로 이탈", "#ff8b7e");
        return true;
      }
      if (this.bossPattern === "telegraph-volley") {
        this.fireBossVolley(enemy);
        this.finishBossPattern(620);
        return true;
      }
      this.bossPattern = "leaping";
      this.bossPatternUntil = now + 360;
      enemy.body.setAlpha(0.3).setScale(3.1);
      enemy.halo.setAlpha(0.2);
      enemy.eyeGlow.setAlpha(0.25);
      this.showBossPattern("JUMP ACTIVE // 착지 지점에서 이탈", "#ffd17d");
      return true;
    }

    if (this.bossPattern === "charging") {
      const speed = enemy.speed * pressureMultiplier * 5.4;
      const nextX = enemy.body.x + this.bossPatternTarget.x * speed * dt;
      const nextY = enemy.body.y + this.bossPatternTarget.y * speed * dt;
      const brokeCover = this.breakTemporaryCoversAt(nextX, nextY, enemy.radius + 8);
      const beforeX = enemy.body.x;
      const beforeY = enemy.body.y;
      this.tryMoveCircle(enemy.body, this.bossPatternTarget.x * speed * dt, this.bossPatternTarget.y * speed * dt, enemy.radius);
      this.syncEnemyVisual(enemy);
      if (brokeCover) this.burst(enemy.body.x, enemy.body.y, 0xffa27e, 15);
      if (now >= this.bossPatternUntil || Phaser.Math.Distance.Between(beforeX, beforeY, enemy.body.x, enemy.body.y) < speed * dt * 0.28) {
        this.cameras.main.shake(160, 0.006);
        this.finishBossPattern(420);
      }
      return true;
    }

    if (this.bossPattern === "leaping") {
      if (now < this.bossPatternUntil) return true;
      const landing = this.findSafeBossLanding(this.bossPatternTarget.x, this.bossPatternTarget.y, enemy.radius);
      enemy.body.setPosition(landing.x, landing.y).setAlpha(1).setScale(2.65);
      enemy.halo.setAlpha(1);
      enemy.eyeGlow.setAlpha(1);
      this.syncEnemyVisual(enemy);
      this.burst(landing.x, landing.y, 0xffd37f, 30);
      this.cameras.main.flash(120, 255, 178, 98, false);
      this.cameras.main.shake(260, 0.012);
      this.finishBossPattern(430);
      return true;
    }
    return false;
  }

  private startBossPattern(enemy: Enemy): void {
    const phase = enemy.maxHealth - enemy.health + 1;
    const patterns: BossPattern[] = phase >= 3
      ? ["telegraph-leap", "telegraph-charge", "telegraph-volley", "telegraph-charge"]
      : ["telegraph-leap", "telegraph-volley", "telegraph-charge"];
    this.bossPattern = patterns[this.bossPatternIndex++ % patterns.length];
    const direction = new Phaser.Math.Vector2(this.player.x - enemy.body.x, this.player.y - enemy.body.y);
    if (direction.lengthSq() < 1) direction.set(1, 0);
    direction.normalize();
    this.bossPatternTarget.set(direction.x, direction.y);

    if (this.bossPattern === "telegraph-charge") {
      this.bossPatternUntil = this.time.now + Math.max(500, 880 - phase * 60);
      const targetX = Phaser.Math.Clamp(enemy.body.x + direction.x * 860, ARENA.left + 28, ARENA.right - 28);
      const targetY = Phaser.Math.Clamp(enemy.body.y + direction.y * 860, ARENA.top + 28, ARENA.bottom - 28);
      this.bossTelegraph.clear().lineStyle(5, 0xff665f, 0.76).lineBetween(enemy.body.x, enemy.body.y, targetX, targetY);
      this.bossTelegraph.lineStyle(1.5, 0xffd2bc, 0.9).strokeCircle(targetX, targetY, 24);
      this.showBossPattern("CHARGE INCOMING // 낙하 엄폐물 뒤로", "#ff8b7e");
      this.sounds.dashWarning();
      return;
    }

    if (this.bossPattern === "telegraph-volley") {
      this.bossPatternUntil = this.time.now + Math.max(460, 760 - phase * 45);
      this.bossTelegraph.clear().lineStyle(2, 0xd9a3ff, 0.8).strokeCircle(enemy.body.x, enemy.body.y, 58);
      this.showBossPattern("CORE VOLLEY // 빈 공간으로 회피", "#d9a3ff");
      this.sounds.dashWarning();
      return;
    }

    // Cover lands first; the player gets a readable window to choose a side or use it as a shield.
    this.bossPatternUntil = this.time.now + Math.max(1120, 1580 - phase * 90);
    const landing = this.findSafeBossLanding(this.player.x + this.playerVelocity.x * 0.4, this.player.y + this.playerVelocity.y * 0.4, enemy.radius);
    this.bossPatternTarget.set(landing.x, landing.y);
    this.bossTelegraph.clear().lineStyle(3, 0xffd37f, 0.86).strokeCircle(landing.x, landing.y, 46);
    this.bossTelegraph.lineStyle(1.5, 0xfff1ba, 0.9).strokeCircle(landing.x, landing.y, 18);
    this.spawnFallingCovers();
    this.showBossPattern("JUMP INCOMING // 낙하 엄폐물 활용", "#ffd17d");
    this.sounds.dashWarning();
  }

  private fireBossVolley(enemy: Enemy): void {
    const phase = enemy.maxHealth - enemy.health + 1;
    const direction = new Phaser.Math.Vector2(this.player.x - enemy.body.x, this.player.y - enemy.body.y).normalize();
    const count = phase >= 3 ? 6 : 5;
    const spread = phase >= 3 ? 0.9 : 0.68;
    for (let index = 0; index < count; index += 1) {
      const offset = Phaser.Math.Linear(-spread / 2, spread / 2, index / (count - 1));
      const angle = Math.atan2(direction.y, direction.x) + offset;
      this.spawnEnemyProjectile(enemy.body.x, enemy.body.y - 9, Math.cos(angle), Math.sin(angle), 286 + phase * 18, 0xd9a3ff);
    }
    this.burst(enemy.body.x, enemy.body.y, 0xc77dff, 16);
    this.cameras.main.flash(70, 178, 93, 225, false);
  }

  private finishBossPattern(delay: number): void {
    this.clearBossPatternEffects();
    this.bossPatternNextAt = this.time.now + delay;
  }

  private clearBossPatternEffects(): void {
    this.bossPattern = "none";
    this.bossPatternUntil = 0;
    this.bossTelegraph.clear();
    this.hideBossPattern();
  }

  private showBossPattern(message: string, color: string): void {
    this.bossPatternText.setText(`BOSS SIGNAL // ${message}`).setColor(color).setVisible(true);
  }

  private hideBossPattern(): void {
    this.bossPatternText.setVisible(false);
  }

  private spawnFallingCovers(): void {
    const candidates = [
      { x: ARENA.centerX - 210, y: ARENA.centerY + 102 },
      { x: ARENA.centerX + 24, y: ARENA.centerY - 116 },
      { x: ARENA.centerX + 226, y: ARENA.centerY + 122 },
    ];
    for (const candidate of candidates) {
      const width = 76;
      const height = 38;
      const rect = new Phaser.Geom.Rectangle(candidate.x - width / 2, candidate.y - height / 2, width, height);
      if (this.obstacles.some((obstacle) => Phaser.Geom.Intersects.RectangleToRectangle(obstacle, rect))) continue;
      const visual = this.add.graphics().setDepth(DEPTH.obstacle + 2).setPosition(candidate.x, ARENA.top - 44);
      visual.fillStyle(0x06111d, 0.9).fillRect(-width / 2 + 4, -height / 2 + 5, width, height);
      visual.fillStyle(0x284d68).fillRect(-width / 2, -height / 2, width, height);
      visual.fillStyle(0x447c93).fillRect(-width / 2 + 4, -height / 2 + 4, width - 8, height - 8);
      visual.lineStyle(2, 0x9aeadf, 0.9).strokeRect(-width / 2, -height / 2, width, height);
      visual.fillStyle(0xd4a660, 0.9).fillRect(-width / 2 + 10, height / 2 - 9, width - 20, 3);
      this.temporaryCovers.push({
        rect,
        visual,
        landingAt: this.time.now + 640,
        expiresAt: this.time.now + 7000,
        active: false,
      });
      this.tweens.add({
        targets: visual,
        y: candidate.y,
        duration: 640,
        ease: "Cubic.In",
        onComplete: () => this.cameras.main.shake(60, 0.002),
      });
    }
  }

  private updateTemporaryCovers(): void {
    for (let index = this.temporaryCovers.length - 1; index >= 0; index -= 1) {
      const cover = this.temporaryCovers[index];
      if (!cover.active && this.time.now >= cover.landingAt) {
        cover.active = true;
        this.obstacles.push(cover.rect);
      }
      if (this.time.now < cover.expiresAt) continue;
      this.destroyTemporaryCover(index, false);
    }
  }

  private breakTemporaryCoversAt(x: number, y: number, radius: number): boolean {
    let broken = false;
    for (let index = this.temporaryCovers.length - 1; index >= 0; index -= 1) {
      const cover = this.temporaryCovers[index];
      if (!cover.active || !this.circleHitsRectangle(x, y, radius, cover.rect)) continue;
      this.destroyTemporaryCover(index, true);
      broken = true;
    }
    return broken;
  }

  private destroyTemporaryCover(index: number, shattered: boolean): void {
    const cover = this.temporaryCovers[index];
    if (cover.active) {
      const obstacleIndex = this.obstacles.indexOf(cover.rect);
      if (obstacleIndex >= 0) this.obstacles.splice(obstacleIndex, 1);
    }
    if (shattered) this.burst(cover.rect.centerX, cover.rect.centerY, 0xffbd88, 18);
    cover.visual.destroy();
    this.temporaryCovers.splice(index, 1);
  }

  private findSafeBossLanding(x: number, y: number, radius: number): { x: number; y: number } {
    const target = {
      x: Phaser.Math.Clamp(x, ARENA.left + radius, ARENA.right - radius),
      y: Phaser.Math.Clamp(y, ARENA.top + radius, ARENA.bottom - radius),
    };
    if (!this.circleHitsObstacle(target.x, target.y, radius)) return target;
    for (let distance = 24; distance <= 180; distance += 24) {
      for (let index = 0; index < 12; index += 1) {
        const angle = index / 12 * Math.PI * 2;
        const candidate = {
          x: Phaser.Math.Clamp(target.x + Math.cos(angle) * distance, ARENA.left + radius, ARENA.right - radius),
          y: Phaser.Math.Clamp(target.y + Math.sin(angle) * distance, ARENA.top + radius, ARENA.bottom - radius),
        };
        if (!this.circleHitsObstacle(candidate.x, candidate.y, radius)) return candidate;
      }
    }
    return { x: ARENA.centerX, y: ARENA.centerY };
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
      const runFrame = Math.floor((this.time.now + enemy.body.x * 2) / 82) % 2;
      enemy.body.setTexture(enemy.dashState === "dashing"
        ? "enemy-lunge"
        : moving ? (runFrame === 0 ? "enemy-run-1" : "enemy-run-2") : "enemy");
    } else if (enemy.kind === "shooter") {
      const hoverFrame = Math.floor((this.time.now + enemy.body.x) / 145) % 2;
      enemy.body.setTexture(hoverFrame === 0 ? "shooter-hover-1" : "shooter-hover-2");
    } else {
      const strideFrame = Math.floor(this.time.now / 120) % 2;
      const moving = Math.hypot(enemy.moveVx, enemy.moveVy) > 8;
      const texture = this.bossPattern === "charging" || this.bossPattern === "telegraph-charge"
        ? "boss-charge"
        : this.bossPattern === "leaping" || this.bossPattern === "telegraph-leap"
          ? "boss-air"
          : moving ? (strideFrame === 0 ? "boss-step-1" : "boss-step-2") : "boss";
      enemy.body.setTexture(texture);
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
    return this.obstacles.some((rect) => this.circleHitsRectangle(x, y, radius, rect));
  }

  private circleHitsRectangle(x: number, y: number, radius: number, rect: Phaser.Geom.Rectangle): boolean {
    const closestX = Phaser.Math.Clamp(x, rect.left, rect.right);
    const closestY = Phaser.Math.Clamp(y, rect.top, rect.bottom);
    return Phaser.Math.Distance.Between(x, y, closestX, closestY) < radius;
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
    if (enemy.invulnerable) {
      this.showFloatingText(enemy.body.x, enemy.body.y - enemy.radius - 18, "CORE LOCKED", "#d9a3ff");
      return "blocked";
    }
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
    if (enemy.kind === "boss") {
      this.clearBossPatternEffects();
      this.bossPatternNextAt = Number.POSITIVE_INFINITY;
    }
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
    this.bossPattern = "none";
    this.bossPatternNextAt = this.time.now + 200;
    this.bossTelegraph.clear();
    this.hideBossPattern();
    this.cameras.main.flash(180, 105, 30, 145, false);
    this.cameras.main.shake(260, 0.011);
    this.sounds.phase();
    this.showFloatingText(enemy.body.x, enemy.body.y - 82, `CORE PHASE ${phase}`, "#e3a7ff");

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
    const x = this.player.x + direction.x * BULLET_MUZZLE_OFFSET;
    const y = this.player.y + direction.y * BULLET_MUZZLE_OFFSET;
    // Planning shows commitment, not a solved ricochet. Every bounce after this vector is unknown.
    const hit = this.findRayHit(x, y, direction.x, direction.y, 320);
    const distance = hit ? Math.min(hit.distance, 320) : 320;
    const nextX = x + direction.x * distance;
    const nextY = y + direction.y * distance;
    this.aimGuide.fillStyle(0xe8fffb, 0.92).fillCircle(x, y, 2.5);
    this.drawDashedTrajectory(x, y, nextX, nextY, 0xbaf8ee, 0.86, 2.1);
    this.aimGuide.fillStyle(0x9ff6e8, 0.85).fillTriangle(
      nextX + direction.x * 7, nextY + direction.y * 7,
      nextX - direction.y * 5, nextY + direction.x * 5,
      nextX + direction.y * 5, nextY - direction.x * 5,
    );
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
      enemy.shootReadyAt += frozenFor;
      if (enemy.shootTelegraphUntil > 0) enemy.shootTelegraphUntil += frozenFor;
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
    this.recoveryGraceUntil = this.time.now + RECOVERY_GRACE_MS;
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
        enemy.dashReadyAt = Math.min(enemy.dashReadyAt, this.recoveryGraceUntil + Phaser.Math.Between(220, 540));
      }
    }
    this.showFloatingText(GAME_WIDTH / 2, 126, "RECOVERY HUNT // 0.7s WINDOW", "#ffda81");
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
    this.clearBossPatternEffects();
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
    this.clearBossPatternEffects();
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
        const indicatorDistance = recoveryIndicatorDistance(distance);
        const tipX = this.player.x + direction.x * indicatorDistance;
        const tipY = this.player.y + direction.y * indicatorDistance;
        const startX = tipX - direction.x * 32;
        const startY = tipY - direction.y * 32;
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
    this.tutorialText?.setVisible(this.state === "playing" || this.state === "aiming");
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
    this.scene.restart({ stageIndex: this.stageIndex, showTitle: false, score: 0 });
  }
}
