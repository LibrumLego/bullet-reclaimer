import Phaser from "phaser";
import "./style.css";

const GAME_WIDTH = 1280;
const GAME_HEIGHT = 720;
const ARENA = new Phaser.Geom.Rectangle(54, 86, 1172, 574);
const PLAYER_SPEED = 250;
const BULLET_SPEED = 760;
const MAX_BOUNCES = 5;

type GameState = "playing" | "aiming" | "bullet" | "recover" | "won" | "lost";

interface Enemy {
  body: Phaser.GameObjects.Arc;
  halo: Phaser.GameObjects.Arc;
  speed: number;
  alive: boolean;
}

interface Bullet {
  body: Phaser.GameObjects.Arc;
  trail: Phaser.GameObjects.Graphics;
  vx: number;
  vy: number;
  bounces: number;
  age: number;
  stopped: boolean;
}

class BulletReclaimerScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Arc;
  private playerRing!: Phaser.GameObjects.Arc;
  private playerDirection = new Phaser.Math.Vector2(1, 0);
  private enemies: Enemy[] = [];
  private obstacles: Phaser.Geom.Rectangle[] = [];
  private bullet?: Bullet;
  private state: GameState = "playing";
  private cursorKeys!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<"W" | "A" | "S" | "D" | "R", Phaser.Input.Keyboard.Key>;
  private aimGuide!: Phaser.GameObjects.Graphics;
  private overlay!: Phaser.GameObjects.Graphics;
  private statusText!: Phaser.GameObjects.Text;
  private objectiveText!: Phaser.GameObjects.Text;
  private recoveryPulse = 0;

  constructor() {
    super("bullet-reclaimer");
  }

  create(): void {
    this.cameras.main.setBackgroundColor("#080b12");
    this.drawArena();
    this.createHud();

    this.playerRing = this.add.circle(190, 550, 22, 0x7ee8fa, 0.12);
    this.player = this.add.circle(190, 550, 13, 0xeffaff).setStrokeStyle(3, 0x49d7ef);
    this.aimGuide = this.add.graphics();
    this.overlay = this.add.graphics();

    this.cursorKeys = this.input.keyboard!.createCursorKeys();
    this.wasd = this.input.keyboard!.addKeys("W,A,S,D,R") as Record<"W" | "A" | "S" | "D" | "R", Phaser.Input.Keyboard.Key>;

    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (this.state === "playing") {
        this.state = "aiming";
        this.playerDirection.set(pointer.worldX - this.player.x, pointer.worldY - this.player.y).normalize();
        this.updateHud();
      } else if (this.state === "won" || this.state === "lost") {
        this.restart();
      }
    });

    this.input.on("pointerup", (pointer: Phaser.Input.Pointer) => {
      if (this.state === "aiming") {
        this.fire(pointer.worldX, pointer.worldY);
      }
    });

    this.createStage();
    this.updateHud();
  }

  update(_time: number, delta: number): void {
    const dt = Math.min(delta / 1000, 0.033);

    if (Phaser.Input.Keyboard.JustDown(this.wasd.R)) {
      this.restart();
      return;
    }

    if (this.state === "aiming") {
      const pointer = this.input.activePointer;
      this.playerDirection.set(pointer.worldX - this.player.x, pointer.worldY - this.player.y).normalize();
      this.drawAimGuide();
      return;
    }

    this.aimGuide.clear();

    if (this.state === "playing" || this.state === "recover") {
      this.movePlayer(dt);
      this.moveEnemies(dt);
      this.checkEnemyContact();
    }

    if (this.state === "bullet" && this.bullet) {
      this.moveBullet(dt);
    }

    if (this.state === "recover" && this.bullet) {
      this.recoveryPulse += dt;
      const scale = 1 + Math.sin(this.recoveryPulse * 8) * 0.13;
      this.bullet.body.setScale(scale);
      if (Phaser.Math.Distance.Between(this.player.x, this.player.y, this.bullet.body.x, this.bullet.body.y) < 28) {
        this.reclaimBullet();
      }
    }

    this.playerRing.setPosition(this.player.x, this.player.y);
  }

  private drawArena(): void {
    const grid = this.add.graphics();
    grid.lineStyle(1, 0x173044, 0.54);
    for (let x = ARENA.x; x <= ARENA.right; x += 42) grid.lineBetween(x, ARENA.y, x, ARENA.bottom);
    for (let y = ARENA.y; y <= ARENA.bottom; y += 42) grid.lineBetween(ARENA.x, y, ARENA.right, y);

    const frame = this.add.graphics();
    frame.fillStyle(0x0d1722, 0.86).fillRoundedRect(ARENA.x, ARENA.y, ARENA.width, ARENA.height, 16);
    frame.lineStyle(3, 0x2a6381, 1).strokeRoundedRect(ARENA.x, ARENA.y, ARENA.width, ARENA.height, 16);
    frame.lineStyle(1, 0x80dfff, 0.35).strokeRoundedRect(ARENA.x + 7, ARENA.y + 7, ARENA.width - 14, ARENA.height - 14, 11);

    this.add.text(54, 24, "BULLET RECLAIMER", {
      fontFamily: "system-ui, sans-serif",
      fontSize: "28px",
      fontStyle: "bold",
      color: "#ecfbff",
      letterSpacing: 2,
    });
  }

  private createHud(): void {
    this.statusText = this.add.text(1226, 28, "", {
      fontFamily: "system-ui, sans-serif",
      fontSize: "18px",
      fontStyle: "bold",
      color: "#f8fbff",
    }).setOrigin(1, 0);

    this.objectiveText = this.add.text(54, 678, "", {
      fontFamily: "system-ui, sans-serif",
      fontSize: "17px",
      color: "#a6bdcc",
    });

    this.add.text(GAME_WIDTH / 2, 43, "WASD 이동  ·  마우스 누름: 시간 정지 조준  ·  놓기: 발사  ·  R: 재시작", {
      fontFamily: "system-ui, sans-serif",
      fontSize: "15px",
      color: "#7fa0b3",
    }).setOrigin(0.5);
  }

  private createStage(): void {
    this.obstacles = [
      new Phaser.Geom.Rectangle(355, 142, 86, 230),
      new Phaser.Geom.Rectangle(565, 385, 232, 76),
      new Phaser.Geom.Rectangle(846, 154, 88, 246),
      new Phaser.Geom.Rectangle(970, 492, 150, 72),
      new Phaser.Geom.Rectangle(180, 436, 118, 62),
      new Phaser.Geom.Rectangle(620, 160, 130, 58),
    ];

    const obstacleLayer = this.add.graphics();
    for (const rect of this.obstacles) {
      obstacleLayer.fillStyle(0x1b3347, 1).fillRoundedRect(rect.x, rect.y, rect.width, rect.height, 9);
      obstacleLayer.lineStyle(2, 0x5284a1, 0.9).strokeRoundedRect(rect.x, rect.y, rect.width, rect.height, 9);
      obstacleLayer.lineStyle(1, 0xa6e6ff, 0.22).lineBetween(rect.x + 10, rect.y + 12, rect.right - 10, rect.y + 12);
    }

    this.enemies = [
      this.makeEnemy(644, 304, 63),
      this.makeEnemy(1054, 240, 70),
      this.makeEnemy(1090, 602, 56),
      this.makeEnemy(514, 590, 61),
    ];
  }

  private makeEnemy(x: number, y: number, speed: number): Enemy {
    const halo = this.add.circle(x, y, 21, 0xff5e79, 0.1);
    const body = this.add.circle(x, y, 12, 0xff637b).setStrokeStyle(3, 0xffb2bd);
    return { body, halo, speed, alive: true };
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
    this.tryMoveCircle(this.player, move.x, move.y, 13);
  }

  private moveEnemies(dt: number): void {
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const direction = new Phaser.Math.Vector2(this.player.x - enemy.body.x, this.player.y - enemy.body.y).normalize();
      this.tryMoveCircle(enemy.body, direction.x * enemy.speed * dt, direction.y * enemy.speed * dt, 12);
      enemy.halo.setPosition(enemy.body.x, enemy.body.y);
    }
  }

  private tryMoveCircle(body: Phaser.GameObjects.Arc, dx: number, dy: number, radius: number): void {
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
    const direction = new Phaser.Math.Vector2(targetX - this.player.x, targetY - this.player.y).normalize();
    if (direction.lengthSq() === 0) {
      this.state = "playing";
      return;
    }

    this.state = "bullet";
    const trail = this.add.graphics();
    const body = this.add.circle(this.player.x + direction.x * 20, this.player.y + direction.y * 20, 8, 0xffdb70)
      .setStrokeStyle(2, 0xfff3bd);
    this.bullet = { body, trail, vx: direction.x * BULLET_SPEED, vy: direction.y * BULLET_SPEED, bounces: 0, age: 0, stopped: false };
    this.updateHud();
  }

  private moveBullet(dt: number): void {
    const bullet = this.bullet!;
    bullet.age += dt;
    let remaining = BULLET_SPEED * dt;
    let safety = 0;
    bullet.trail.clear();
    bullet.trail.lineStyle(3, 0xffd76b, 0.54);

    while (remaining > 0.01 && safety++ < 4 && !bullet.stopped) {
      const direction = new Phaser.Math.Vector2(bullet.vx, bullet.vy).normalize();
      const hit = this.findRayHit(bullet.body.x, bullet.body.y, direction.x, direction.y, remaining);
      const travel = hit ? hit.distance : remaining;
      const startX = bullet.body.x;
      const startY = bullet.body.y;
      bullet.body.x += direction.x * travel;
      bullet.body.y += direction.y * travel;
      bullet.trail.lineBetween(startX, startY, bullet.body.x, bullet.body.y);
      remaining -= travel;

      if (!hit) break;
      if (hit.kind === "wall" || hit.kind === "obstacle") {
        bullet.bounces += 1;
        if (hit.normalX !== 0) bullet.vx *= -1;
        if (hit.normalY !== 0) bullet.vy *= -1;
        bullet.body.x += hit.normalX * 1.5;
        bullet.body.y += hit.normalY * 1.5;
        if (bullet.bounces >= MAX_BOUNCES) this.stopBullet();
      }
    }

    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      if (Phaser.Math.Distance.Between(bullet.body.x, bullet.body.y, enemy.body.x, enemy.body.y) < 21) {
        this.killEnemy(enemy);
      }
    }

    if (bullet.age > 0.22 && Phaser.Math.Distance.Between(bullet.body.x, bullet.body.y, this.player.x, this.player.y) < 20) {
      this.lose();
    }
  }

  private findRayHit(x: number, y: number, dx: number, dy: number, maxDistance: number): { distance: number; normalX: number; normalY: number; kind: "wall" | "obstacle" } | undefined {
    const candidates: Array<{ distance: number; normalX: number; normalY: number; kind: "wall" | "obstacle" }> = [];
    const addCandidate = (distance: number, normalX: number, normalY: number, kind: "wall" | "obstacle") => {
      if (distance > 0.2 && distance <= maxDistance + 0.01) candidates.push({ distance, normalX, normalY, kind });
    };

    if (dx > 0) addCandidate((ARENA.right - 8 - x) / dx, -1, 0, "wall");
    if (dx < 0) addCandidate((ARENA.left + 8 - x) / dx, 1, 0, "wall");
    if (dy > 0) addCandidate((ARENA.bottom - 8 - y) / dy, 0, -1, "wall");
    if (dy < 0) addCandidate((ARENA.top + 8 - y) / dy, 0, 1, "wall");

    for (const rect of this.obstacles) {
      const expanded = new Phaser.Geom.Rectangle(rect.x - 8, rect.y - 8, rect.width + 16, rect.height + 16);
      const hit = this.rayRect(x, y, dx, dy, expanded);
      if (hit) addCandidate(hit.distance, hit.normalX, hit.normalY, "obstacle");
    }

    return candidates.sort((a, b) => a.distance - b.distance)[0];
  }

  private rayRect(x: number, y: number, dx: number, dy: number, rect: Phaser.Geom.Rectangle): { distance: number; normalX: number; normalY: number } | undefined {
    let nearX = -Infinity;
    let farX = Infinity;
    let nearY = -Infinity;
    let farY = Infinity;

    if (dx === 0) {
      if (x < rect.left || x > rect.right) return undefined;
    } else {
      const t1 = (rect.left - x) / dx;
      const t2 = (rect.right - x) / dx;
      nearX = Math.min(t1, t2);
      farX = Math.max(t1, t2);
    }
    if (dy === 0) {
      if (y < rect.top || y > rect.bottom) return undefined;
    } else {
      const t1 = (rect.top - y) / dy;
      const t2 = (rect.bottom - y) / dy;
      nearY = Math.min(t1, t2);
      farY = Math.max(t1, t2);
    }

    const entry = Math.max(nearX, nearY);
    const exit = Math.min(farX, farY);
    if (entry > exit || exit < 0 || entry < 0) return undefined;
    if (nearX > nearY) return { distance: entry, normalX: dx > 0 ? -1 : 1, normalY: 0 };
    return { distance: entry, normalX: 0, normalY: dy > 0 ? -1 : 1 };
  }

  private drawAimGuide(): void {
    this.aimGuide.clear();
    const pointer = this.input.activePointer;
    const direction = new Phaser.Math.Vector2(pointer.worldX - this.player.x, pointer.worldY - this.player.y).normalize();
    if (direction.lengthSq() === 0) return;

    this.overlay.clear().fillStyle(0x06111b, 0.28).fillRect(ARENA.x, ARENA.y, ARENA.width, ARENA.height);
    this.aimGuide.lineStyle(3, 0x77efff, 0.9);
    this.aimGuide.lineStyle(1, 0xe9feff, 0.96);

    let x = this.player.x + direction.x * 20;
    let y = this.player.y + direction.y * 20;
    let vx = direction.x;
    let vy = direction.y;
    for (let i = 0; i < MAX_BOUNCES + 1; i++) {
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

  private killEnemy(enemy: Enemy): void {
    enemy.alive = false;
    this.tweens.add({ targets: [enemy.body, enemy.halo], scale: 1.9, alpha: 0, duration: 180, onComplete: () => { enemy.body.destroy(); enemy.halo.destroy(); } });
    if (this.enemies.every((item) => !item.alive)) {
      this.stopBullet();
      this.win();
    }
  }

  private checkEnemyContact(): void {
    for (const enemy of this.enemies) {
      if (enemy.alive && Phaser.Math.Distance.Between(this.player.x, this.player.y, enemy.body.x, enemy.body.y) < 24) {
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
    this.bullet?.body.destroy();
    this.bullet?.trail.destroy();
    this.bullet = undefined;
    this.state = "playing";
    this.updateHud();
  }

  private win(): void {
    this.state = "won";
    this.overlay.clear().fillStyle(0x0b1f1f, 0.67).fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    this.showCenterMessage("AREA CLEARED", "클릭하거나 R 키를 눌러 다시 시작");
    this.updateHud();
  }

  private lose(): void {
    if (this.state === "lost" || this.state === "won") return;
    this.state = "lost";
    this.overlay.clear().fillStyle(0x2c0710, 0.7).fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    this.player.setFillStyle(0xff7890);
    this.showCenterMessage("YOU WERE HIT", "한 발은 적도, 나도 즉사시킨다 · 클릭 또는 R로 재시작");
    this.updateHud();
  }

  private showCenterMessage(title: string, subtitle: string): void {
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 14, title, { fontFamily: "system-ui, sans-serif", fontSize: "42px", fontStyle: "bold", color: "#f7fbff" }).setOrigin(0.5);
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 + 39, subtitle, { fontFamily: "system-ui, sans-serif", fontSize: "18px", color: "#b8d7e2" }).setOrigin(0.5);
  }

  private updateHud(): void {
    const alive = this.enemies.filter((enemy) => enemy.alive).length;
    const status: Record<GameState, string> = {
      playing: "ARMED · 한 발 장전됨",
      aiming: "TIME FROZEN · 경로를 설계하라",
      bullet: "UNARMED · 탄환이 날아가는 중",
      recover: "UNARMED · 탄환을 회수하라",
      won: "AREA CLEARED",
      lost: "MISSION FAILED",
    };
    this.statusText.setText(status[this.state]);
    this.statusText.setColor(this.state === "aiming" ? "#8df3ff" : this.state === "recover" ? "#ffd76b" : this.state === "lost" ? "#ff97aa" : "#f8fbff");
    this.objectiveText.setText(`목표: 적 ${alive}명 제거  ·  탄환은 벽과 장애물에 최대 ${MAX_BOUNCES}회 반사됨  ·  내 탄환에도 즉사`);
  }

  private restart(): void {
    this.scene.restart();
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  scene: [BulletReclaimerScene],
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  render: { antialias: true, pixelArt: false },
});
