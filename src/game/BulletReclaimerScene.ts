import Phaser from "phaser";
import {
  ARENA,
  BULLET_RADIUS,
  BULLET_SPEED,
  DEPTH,
  GAME_HEIGHT,
  GAME_WIDTH,
  MAX_BOUNCES,
  PLAYER_RADIUS,
  PLAYER_SPEED,
} from "./constants";
import { nearestCombinedRayHit, rayRectangleHit, segmentCircleHit } from "./geometry";
import { findNavigationPath } from "./pathfinding";
import { SoundManager } from "./SoundManager";
import { STAGES } from "./stages";
import type { Bullet, Enemy, EnemyDefinition, GameState, StageDefinition } from "./types";

type Impact =
  | { t: number; kind: "player" }
  | { t: number; kind: "enemy"; enemy: Enemy };

const BULLET_MUZZLE_OFFSET = Math.max(0, PLAYER_RADIUS - BULLET_RADIUS - 2);

export class BulletReclaimerScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Sprite;
  private playerRing!: Phaser.GameObjects.Ellipse;
  private enemies: Enemy[] = [];
  private obstacles: Phaser.Geom.Rectangle[] = [];
  private bullet?: Bullet;
  private state: GameState = "title";
  private stageIndex = 0;
  private cursorKeys!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<"W" | "A" | "S" | "D" | "R", Phaser.Input.Keyboard.Key>;
  private startKeys!: Record<"ENTER" | "SPACE", Phaser.Input.Keyboard.Key>;
  private aimGuide!: Phaser.GameObjects.Graphics;
  private overlay!: Phaser.GameObjects.Graphics;
  private recoveryGuide!: Phaser.GameObjects.Graphics;
  private recoveryText!: Phaser.GameObjects.Text;
  private dangerVignette!: Phaser.GameObjects.Graphics;
  private titleLayer?: Phaser.GameObjects.Container;
  private statusText!: Phaser.GameObjects.Text;
  private objectiveText!: Phaser.GameObjects.Text;
  private stageText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private recoveryPulse = 0;
  private initialEnemyCount = 0;
  private tensionPulseAt = 0;
  private latePressure = false;
  private score = 0;
  private combatTimeScale = 1;
  private aimStartedAt = 0;
  private readonly sounds = new SoundManager();
  private readonly handleWindowBlur = (): void => this.cancelAim();

  constructor() {
    super("bullet-reclaimer");
  }

  init(data: { stageIndex?: number; showTitle?: boolean; score?: number } = {}): void {
    this.stageIndex = Phaser.Math.Clamp(data.stageIndex ?? 0, 0, STAGES.length - 1);
    this.enemies = [];
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
  }

  create(): void {
    const stage = STAGES[this.stageIndex];
    this.time.timeScale = 1;
    this.cameras.main.setBackgroundColor("#080b12");
    this.createPixelTextures();
    this.drawArena();
    this.createHud(stage);

    this.playerRing = this.add.ellipse(stage.player.x, stage.player.y + 11, 38, 13, 0x03070b, 0.72).setDepth(DEPTH.actor - 1);
    this.player = this.add.sprite(stage.player.x, stage.player.y, "hero")
      .setScale(2)
      .setOrigin(0.5, 0.7)
      .setDepth(DEPTH.actor);
    this.overlay = this.add.graphics().setDepth(DEPTH.freeze);
    this.aimGuide = this.add.graphics().setDepth(DEPTH.guide);
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
      fontFamily: "monospace",
      fontSize: "13px",
      fontStyle: "bold",
      color: "#ffd76b",
      backgroundColor: "#141621",
      padding: { x: 7, y: 4 },
    }).setOrigin(0.5).setDepth(DEPTH.hud).setVisible(false);

    this.cursorKeys = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys("W,A,S,D,R") as Record<"W" | "A" | "S" | "D" | "R", Phaser.Input.Keyboard.Key>;
    this.startKeys = this.input.keyboard!.addKeys("ENTER,SPACE") as Record<"ENTER" | "SPACE", Phaser.Input.Keyboard.Key>;

    this.input.on("pointerdown", () => this.handlePointerDown());
    this.input.on("pointerup", (pointer: Phaser.Input.Pointer) => {
      if (this.state === "aiming") this.fire(pointer.worldX, pointer.worldY);
    });
    this.input.on("pointerupoutside", () => this.cancelAim());
    this.input.on("gameout", () => this.cancelAim());
    window.addEventListener("blur", this.handleWindowBlur);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => window.removeEventListener("blur", this.handleWindowBlur));

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
      this.drawAimGuide();
      return;
    }

    this.aimGuide.clear();
    if (this.state !== "won" && this.state !== "lost") this.overlay.clear();

    if (this.state === "playing" || this.state === "bullet" || this.state === "recover") {
      this.movePlayer(dt);
      this.moveEnemies(dt);
      this.checkEnemyContact();
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
    }
    this.playerRing.setPosition(this.player.x, this.player.y + 11);
  }

  private createPixelTextures(): void {
    if (this.textures.exists("hero")) return;
    const g = this.make.graphics({ x: 0, y: 0 });
    const makeTexture = (key: string, width: number, height: number, draw: () => void): void => {
      g.clear();
      draw();
      g.generateTexture(key, width, height);
    };

    makeTexture("hero", 16, 20, () => {
      g.fillStyle(0x1a1026).fillRect(4, 0, 8, 3);
      g.fillStyle(0xf3d1bd).fillRect(5, 3, 6, 5);
      g.fillStyle(0xfff3d2).fillRect(7, 4, 1, 1);
      g.fillStyle(0x283e72).fillRect(3, 8, 10, 8);
      g.fillStyle(0x5978ae).fillRect(4, 9, 8, 5);
      g.fillStyle(0xe8edf7).fillRect(2, 10, 2, 5);
      g.fillStyle(0x121a35).fillRect(4, 16, 3, 4).fillRect(9, 16, 3, 4);
    });

    makeTexture("enemy", 16, 16, () => {
      g.fillStyle(0x4b1932).fillRect(2, 3, 12, 10);
      g.fillStyle(0x8b3152).fillRect(1, 6, 14, 7);
      g.fillStyle(0xc65b6d).fillRect(3, 4, 10, 8);
      g.fillStyle(0x250d1d).fillRect(4, 7, 2, 2).fillRect(10, 7, 2, 2);
      g.fillStyle(0xffd070).fillRect(4, 7, 1, 1).fillRect(11, 7, 1, 1);
      g.fillStyle(0x3a1426).fillRect(5, 13, 2, 3).fillRect(9, 13, 2, 3);
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

    makeTexture("bullet", 6, 6, () => {
      g.fillStyle(0xa6552d).fillRect(1, 0, 4, 6);
      g.fillStyle(0xffd76b).fillRect(0, 1, 6, 4);
      g.fillStyle(0xfff4bd).fillRect(2, 2, 2, 2);
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
    floor.fillStyle(0x10131f).fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    floor.fillStyle(0x172234).fillRect(ARENA.x, ARENA.y, ARENA.width, ARENA.height);
    for (let y = ARENA.y + 6; y < ARENA.bottom; y += 24) {
      for (let x = ARENA.x + 6; x < ARENA.right; x += 24) {
        const tileColor = (Math.floor(x / 24) + Math.floor(y / 24)) % 2 === 0 ? 0x1c2a3e : 0x19263a;
        floor.fillStyle(tileColor).fillRect(x, y, 20, 20);
        floor.fillStyle(0x263750, 0.45).fillRect(x + 2, y + 2, 3, 2);
      }
    }

    const frame = this.add.graphics().setDepth(DEPTH.arena + 1);
    frame.fillStyle(0x071019).fillRect(ARENA.x - 10, ARENA.y - 10, ARENA.width + 20, 10);
    frame.fillStyle(0x071019).fillRect(ARENA.x - 10, ARENA.bottom, ARENA.width + 20, 10);
    frame.fillStyle(0x071019).fillRect(ARENA.x - 10, ARENA.y, 10, ARENA.height);
    frame.fillStyle(0x071019).fillRect(ARENA.right, ARENA.y, 10, ARENA.height);
    frame.fillStyle(0x57728f).fillRect(ARENA.x - 5, ARENA.y - 5, ARENA.width + 10, 5);
    frame.fillStyle(0x314860).fillRect(ARENA.x - 5, ARENA.bottom, ARENA.width + 10, 5);
    frame.fillStyle(0x46647f).fillRect(ARENA.x - 5, ARENA.y, 5, ARENA.height);
    frame.fillStyle(0x20384e).fillRect(ARENA.right, ARENA.y, 5, ARENA.height);
    frame.fillStyle(0x9fc3d6, 0.52).fillRect(ARENA.x, ARENA.y, ARENA.width, 2);

    this.add.text(54, 22, "BULLET RECLAIMER", {
      fontFamily: "monospace",
      fontSize: "26px",
      fontStyle: "bold",
      color: "#f5e2c2",
      letterSpacing: 1,
    }).setDepth(DEPTH.hud);
  }

  private showTitleScreen(): void {
    this.overlay.clear().fillStyle(0x050812, 0.9).fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    const title = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 92, "BULLET RECLAIMER", {
      fontFamily: "monospace",
      fontSize: "50px",
      fontStyle: "bold",
      color: "#f5e2c2",
      stroke: "#172238",
      strokeThickness: 8,
    }).setOrigin(0.5);
    const mission = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 22, "총알은 단 한 발. 쏜 뒤에는 직접 회수하라.", {
      fontFamily: "monospace",
      fontSize: "18px",
      color: "#b8d7e2",
    }).setOrigin(0.5);
    const prompt = this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 62, "[ 클릭 / ENTER / SPACE ]  작전 시작", {
      fontFamily: "monospace",
      fontSize: "20px",
      fontStyle: "bold",
      color: "#ffd76b",
      backgroundColor: "#151d2e",
      padding: { x: 18, y: 10 },
    }).setOrigin(0.5);

    this.titleLayer = this.add.container(0, 0, [title, mission, prompt]).setDepth(DEPTH.message);
    this.tweens.add({ targets: prompt, alpha: 0.45, duration: 700, yoyo: true, repeat: -1 });
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
      fontFamily: "monospace",
      fontSize: "16px",
      fontStyle: "bold",
      color: "#f8fbff",
    }).setOrigin(1, 0).setDepth(DEPTH.hud);

    this.stageText = this.add.text(54, 58, `STAGE ${this.stageIndex + 1}/${STAGES.length} · ${stage.name} — ${stage.briefing}`, {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#c5a987",
    }).setDepth(DEPTH.hud);

    this.objectiveText = this.add.text(54, 678, "", {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#b7a99a",
    }).setDepth(DEPTH.hud);

    this.scoreText = this.add.text(1226, 678, "", {
      fontFamily: "monospace",
      fontSize: "14px",
      fontStyle: "bold",
      color: "#ffd76b",
    }).setOrigin(1, 0).setDepth(DEPTH.hud);

    this.add.text(GAME_WIDTH / 2, 40, "WASD 이동  ·  마우스 누름: 시간 정지 조준  ·  놓기: 발사  ·  R: 재시작", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#b8a58d",
    }).setOrigin(0.5).setDepth(DEPTH.hud);
  }

  private createStage(stage: StageDefinition): void {
    this.obstacles = stage.obstacles.map((item) => new Phaser.Geom.Rectangle(item.x, item.y, item.width, item.height));
    const obstacleLayer = this.add.graphics().setDepth(DEPTH.obstacle);
    for (const rect of this.obstacles) {
      obstacleLayer.fillStyle(0x101722).fillRect(rect.x - 4, rect.y - 4, rect.width + 8, rect.height + 8);
      obstacleLayer.fillStyle(0x3b4d62).fillRect(rect.x, rect.y, rect.width, rect.height);
      obstacleLayer.fillStyle(0x637a8b).fillRect(rect.x, rect.y, rect.width, 6);
      obstacleLayer.fillStyle(0x28394d).fillRect(rect.x, rect.bottom - 8, rect.width, 8);
      for (let x = rect.x + 10; x < rect.right - 5; x += 20) {
        obstacleLayer.fillStyle(0x91a7af, 0.38).fillRect(x, rect.y + 12, 7, 4);
      }
    }
    this.enemies = stage.enemies.map((definition) => this.makeEnemy(definition));
    this.initialEnemyCount = stage.enemies.length;
  }

  private makeEnemy(definition: EnemyDefinition): Enemy {
    const kind = definition.kind ?? "chaser";
    const radius = kind === "boss" ? 42 : 12;
    const health = definition.health ?? 1;
    const color = kind === "boss" ? 0xb06cff : 0xff637b;
    const halo = this.add.ellipse(
      definition.x,
      definition.y + (kind === "boss" ? 27 : 13),
      kind === "boss" ? 112 : 40,
      kind === "boss" ? 32 : 13,
      kind === "boss" ? 0x2b1244 : 0x240b18,
      0.62,
    ).setDepth(DEPTH.actor - 1);
    const body = this.add.sprite(definition.x, definition.y, kind === "boss" ? "boss" : "enemy")
      .setScale(kind === "boss" ? 2.65 : 2)
      .setOrigin(0.5, 0.72)
      .setDepth(DEPTH.actor);
    if (kind === "boss") body.setTint(color);
    return {
      body,
      halo,
      speed: definition.speed,
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
      canDash: kind === "boss" || definition.speed >= 75,
      dashState: "chase",
      dashReadyAt: this.time.now + Phaser.Math.Between(1800, 4200),
      dashUntil: 0,
      dashVx: 0,
      dashVy: 0,
    };
  }

  private movePlayer(dt: number): void {
    let x = 0;
    let y = 0;
    if (this.wasd.W.isDown || this.cursorKeys.up.isDown) y -= 1;
    if (this.wasd.S.isDown || this.cursorKeys.down.isDown) y += 1;
    if (this.wasd.A.isDown || this.cursorKeys.left.isDown) x -= 1;
    if (this.wasd.D.isDown || this.cursorKeys.right.isDown) x += 1;
    if (x === 0 && y === 0) return;

    const move = new Phaser.Math.Vector2(x, y).normalize().scale(PLAYER_SPEED * dt);
    this.tryMoveCircle(this.player, move.x, move.y, PLAYER_RADIUS);
    if (x !== 0) this.player.setFlipX(x < 0);
  }

  private moveEnemies(dt: number): void {
    const unarmed = this.state === "bullet" || this.state === "recover";
    const pressureMultiplier = (unarmed ? 1.14 : 1) * (this.latePressure ? 1.08 : 1);
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      if (this.updateEnemyDash(enemy, dt, pressureMultiplier)) continue;

      const targetMoved = !Number.isFinite(enemy.lastTargetX)
        || Phaser.Math.Distance.Between(enemy.lastTargetX, enemy.lastTargetY, this.player.x, this.player.y) > 24;
      const needsPath = enemy.pathIndex >= enemy.path.length;
      if (this.time.now >= enemy.nextPathAt && (needsPath || targetMoved)) {
        enemy.path = findNavigationPath(
          { x: enemy.body.x, y: enemy.body.y },
          { x: this.player.x, y: this.player.y },
          ARENA,
          this.obstacles,
          enemy.radius,
        );
        enemy.pathIndex = 0;
        enemy.nextPathAt = this.time.now + (enemy.kind === "boss" ? 220 : 300) + Phaser.Math.Between(0, 90);
        enemy.lastTargetX = this.player.x;
        enemy.lastTargetY = this.player.y;
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
      this.tryMoveCircle(enemy.body, direction.x * chaseSpeed * dt, direction.y * chaseSpeed * dt, enemy.radius);
      const moved = Phaser.Math.Distance.Between(previousX, previousY, enemy.body.x, enemy.body.y);
      if (moved < chaseSpeed * dt * 0.2) {
        enemy.path = [];
        enemy.pathIndex = 0;
        enemy.nextPathAt = this.time.now + 50;
      }
      enemy.halo.setFillStyle(enemy.kind === "boss" ? 0x2b1244 : unarmed ? 0x68142a : 0x240b18, unarmed ? 0.88 : 0.62);
      this.syncEnemyVisual(enemy);
      if (Math.abs(direction.x) > 0.05) enemy.body.setFlipX(direction.x > 0);
    }
  }

  private updateEnemyDash(enemy: Enemy, dt: number, speedMultiplier: number): boolean {
    const now = this.time.now;
    if (enemy.dashState === "telegraph") {
      if (now < enemy.dashUntil) {
        const flash = Math.floor(now / 70) % 2 === 0;
        enemy.body.setTint(flash ? 0xffffff : 0xff365d);
        enemy.halo.setFillStyle(0xff294f, 0.9 + (flash ? 0.1 : 0));
        this.syncEnemyVisual(enemy);
        return true;
      }
      const direction = new Phaser.Math.Vector2(this.player.x - enemy.body.x, this.player.y - enemy.body.y).normalize();
      enemy.dashState = "dashing";
      enemy.dashUntil = now + (enemy.kind === "boss" ? 420 : 300);
      enemy.dashVx = direction.x;
      enemy.dashVy = direction.y;
      enemy.body.setTint(0xff496f);
      this.sounds.dash();
    }

    if (enemy.dashState === "dashing") {
      const previousX = enemy.body.x;
      const previousY = enemy.body.y;
      const dashSpeed = enemy.speed * speedMultiplier * (enemy.kind === "boss" ? 2.5 : 3.15);
      this.tryMoveCircle(enemy.body, enemy.dashVx * dashSpeed * dt, enemy.dashVy * dashSpeed * dt, enemy.radius);
      const moved = Phaser.Math.Distance.Between(previousX, previousY, enemy.body.x, enemy.body.y);
      this.syncEnemyVisual(enemy);
      if (Math.abs(enemy.dashVx) > 0.05) enemy.body.setFlipX(enemy.dashVx > 0);
      if (now >= enemy.dashUntil || moved < dashSpeed * dt * 0.35) {
        enemy.dashState = "chase";
        enemy.dashReadyAt = now + Phaser.Math.Between(2600, 4600);
        enemy.path = [];
        enemy.pathIndex = 0;
        enemy.nextPathAt = now + 80;
        this.restoreEnemyAppearance(enemy);
      }
      return true;
    }

    const playerDistance = Phaser.Math.Distance.Between(enemy.body.x, enemy.body.y, this.player.x, this.player.y);
    if (enemy.canDash && now >= enemy.dashReadyAt && playerDistance > 120 && playerDistance < 520) {
      enemy.dashState = "telegraph";
      enemy.dashUntil = now + (enemy.kind === "boss" ? 560 : 430);
      this.sounds.dashWarning();
      return true;
    }
    return false;
  }

  private syncEnemyVisual(enemy: Enemy): void {
    enemy.halo.setPosition(enemy.body.x, enemy.body.y + (enemy.kind === "boss" ? 27 : 13));
  }

  private restoreEnemyAppearance(enemy: Enemy): void {
    if (enemy.kind === "boss") enemy.body.setTint(0xb06cff);
    else enemy.body.clearTint();
    enemy.halo.setFillStyle(enemy.kind === "boss" ? 0x2b1244 : 0x240b18, 0.62);
  }

  private tryMoveCircle(body: Phaser.GameObjects.Sprite, dx: number, dy: number, radius: number): void {
    const nextX = Phaser.Math.Clamp(body.x + dx, ARENA.x + radius, ARENA.right - radius);
    const nextY = Phaser.Math.Clamp(body.y + dy, ARENA.y + radius, ARENA.bottom - radius);
    if (!this.circleHitsObstacle(nextX, body.y, radius)) body.x = nextX;
    if (!this.circleHitsObstacle(body.x, nextY, radius)) body.y = nextY;
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
    this.state = "bullet";
    const trail = this.add.graphics().setDepth(DEPTH.effects);
    const body = this.add.sprite(
      this.player.x + direction.x * BULLET_MUZZLE_OFFSET,
      this.player.y + direction.y * BULLET_MUZZLE_OFFSET,
      "bullet",
    )
      .setScale(2)
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
    bullet.trail.lineStyle(3, 0xffd76b, 0.58);

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
        if (nearMiss !== undefined) this.triggerNearMiss();
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
      targets: [enemy.body, enemy.halo],
      scale: enemy.kind === "boss" ? 2.7 : 1.9,
      alpha: 0,
      duration: enemy.kind === "boss" ? 320 : 180,
      onComplete: () => { enemy.body.destroy(); enemy.halo.destroy(); },
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
    enemy.speed *= 1.18;
    enemy.canDash = true;
    enemy.dashReadyAt = this.time.now + 520;
    this.cameras.main.flash(180, 105, 30, 145, false);
    this.cameras.main.shake(220, 0.009);
    this.sounds.phase();
    this.showFloatingText(enemy.body.x, enemy.body.y - 82, `CORE PHASE ${phase}`, "#e3a7ff");

    const reinforcement = enemy.health === 2
      ? { x: 1160, y: 260, speed: 88 }
      : { x: 900, y: 120, speed: 94 };
    if (!this.circleHitsObstacle(reinforcement.x, reinforcement.y, 12)) {
      const minion = this.makeEnemy(reinforcement);
      minion.dashReadyAt = this.time.now + 1100;
      this.enemies.push(minion);
      this.burst(reinforcement.x, reinforcement.y, 0xb364ff, 18);
    }
  }

  private triggerNearMiss(): void {
    if (!this.bullet || this.bullet.nearMissTriggered) return;
    this.bullet.nearMissTriggered = true;
    this.combatTimeScale = 0.35;
    this.time.timeScale = 0.35;
    this.cameras.main.flash(80, 95, 225, 255, false);
    this.showFloatingText(this.player.x, this.player.y - 48, "NEAR MISS", "#8df3ff");
    this.sounds.nearMiss();
    this.time.delayedCall(45, () => {
      this.combatTimeScale = 1;
      this.time.timeScale = 1;
    });
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

  private drawAimGuide(): void {
    this.drawFreezeOverlay();
    this.aimGuide.clear();
    const pointer = this.input.activePointer;
    const direction = new Phaser.Math.Vector2(pointer.worldX - this.player.x, pointer.worldY - this.player.y);
    if (direction.lengthSq() === 0) return;
    direction.normalize();
    this.aimGuide.lineStyle(2, 0xe9feff, 0.96);

    let x = this.player.x + direction.x * BULLET_MUZZLE_OFFSET;
    let y = this.player.y + direction.y * BULLET_MUZZLE_OFFSET;
    let vx = direction.x;
    let vy = direction.y;
    for (let i = 0; i < MAX_BOUNCES; i++) {
      const hit = this.findRayHit(x, y, vx, vy, 2000);
      if (!hit) break;
      const nextX = x + vx * hit.distance;
      const nextY = y + vy * hit.distance;
      this.aimGuide.lineBetween(x, y, nextX, nextY);
      this.aimGuide.fillStyle(0x8df3ff, 0.95).fillCircle(nextX, nextY, 4);
      x = nextX + hit.normalX * 1.5;
      y = nextY + hit.normalY * 1.5;
      if (hit.normalX) vx *= -1;
      if (hit.normalY) vy *= -1;
    }
  }

  private drawFreezeOverlay(): void {
    this.overlay.clear();
    this.overlay.fillStyle(0x04131c, 0.48).fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    this.overlay.lineStyle(2, 0x63e6ff, 0.3).strokeRoundedRect(ARENA.x + 2, ARENA.y + 2, ARENA.width - 4, ARENA.height - 4, 14);
  }

  private cancelAim(): void {
    if (this.state !== "aiming") return;
    this.resumeEnemyClocks();
    this.state = "playing";
    this.overlay.clear();
    this.aimGuide.clear();
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
    this.updateHud();
  }

  private reclaimBullet(): void {
    if (!this.bullet) return;
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

    this.recoveryGuide.clear();
    this.recoveryText.setVisible(false);
    if (unarmed && this.bullet?.body.visible) {
      const direction = new Phaser.Math.Vector2(this.bullet.body.x - this.player.x, this.bullet.body.y - this.player.y);
      const distance = direction.length();
      if (distance > 1) {
        direction.normalize();
        const perpendicular = new Phaser.Math.Vector2(-direction.y, direction.x);
        const startX = this.player.x + direction.x * 28;
        const startY = this.player.y + direction.y * 28;
        const tipX = this.player.x + direction.x * 60;
        const tipY = this.player.y + direction.y * 60;
        const color = this.state === "recover" ? 0xffd76b : 0xff9a63;
        this.recoveryGuide.lineStyle(5, color, 0.92).lineBetween(startX, startY, tipX, tipY);
        this.recoveryGuide.fillStyle(color, 1).fillTriangle(
          tipX,
          tipY,
          tipX - direction.x * 13 + perpendicular.x * 8,
          tipY - direction.y * 13 + perpendicular.y * 8,
          tipX - direction.x * 13 - perpendicular.x * 8,
          tipY - direction.y * 13 - perpendicular.y * 8,
        );
        const labelX = Phaser.Math.Clamp(this.player.x + direction.x * 92, ARENA.left + 54, ARENA.right - 54);
        const labelY = Phaser.Math.Clamp(this.player.y + direction.y * 92, ARENA.top + 24, ARENA.bottom - 24);
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
  }

  private updateHud(): void {
    const alive = this.enemies.filter((enemy) => enemy.alive).length;
    const boss = this.enemies.find((enemy) => enemy.alive && enemy.kind === "boss");
    const status: Record<GameState, string> = {
      title: "AWAITING DEPLOYMENT",
      playing: "ARMED · 한 발 장전됨",
      aiming: "TIME FROZEN · 경로를 설계하라",
      bullet: "UNARMED · 탄환이 날아가는 중",
      recover: "UNARMED · 탄환을 회수하라",
      won: this.stageIndex === STAGES.length - 1 ? "MISSION COMPLETE" : "AREA CLEARED",
      lost: "MISSION FAILED",
    };
    this.statusText.setText(status[this.state]);
    this.statusText.setColor(this.state === "aiming" ? "#8df3ff" : this.state === "recover" ? "#ffd76b" : this.state === "lost" ? "#ff97aa" : "#f8fbff");
    const bossStatus = boss ? `  ·  코어 보호막 ${boss.health}/${boss.maxHealth}` : "";
    this.objectiveText.setText(`목표: 적 ${alive}명 제거${bossStatus}  ·  최대 ${MAX_BOUNCES}회 반사  ·  내 탄환에도 즉사`);
    this.scoreText.setText(`SCORE ${this.score.toString().padStart(6, "0")}`);
    this.stageText.setAlpha(this.state === "aiming" ? 1 : 0.82);
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
