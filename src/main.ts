import Phaser from "phaser";
import "./style.css";

const GAME_WIDTH = 1280;
const GAME_HEIGHT = 720;

class BootScene extends Phaser.Scene {
  constructor() {
    super("boot");
  }

  create(): void {
    const centerX = this.scale.width / 2;
    const centerY = this.scale.height / 2;

    this.cameras.main.setBackgroundColor("#080b12");

    this.add
      .text(centerX, centerY - 105, "탄환 회수자", {
        color: "#f5f7ff",
        fontFamily: "system-ui, sans-serif",
        fontSize: "64px",
        fontStyle: "bold",
      })
      .setOrigin(0.5);

    this.add
      .text(centerX, centerY - 25, "한 발이면 충분하다. 다시 주울 수만 있다면.", {
        color: "#8ee7ff",
        fontFamily: "system-ui, sans-serif",
        fontSize: "24px",
      })
      .setOrigin(0.5);

    const bullet = this.add.circle(centerX, centerY + 70, 9, 0xffd166);
    this.tweens.add({
      targets: bullet,
      x: centerX + 160,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: "Sine.inOut",
    });

    this.add
      .text(centerX, centerY + 145, "개발 환경 준비 완료", {
        color: "#7d8495",
        fontFamily: "system-ui, sans-serif",
        fontSize: "18px",
      })
      .setOrigin(0.5);
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: "#080b12",
  scene: [BootScene],
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    antialias: true,
    pixelArt: false,
  },
});

