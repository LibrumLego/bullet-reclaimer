import Phaser from "phaser";
import "./style.css";
import { GAME_HEIGHT, GAME_WIDTH } from "./game/constants";
import { BulletReclaimerScene } from "./game/BulletReclaimerScene";

const debugStage = import.meta.env.DEV
  ? Number.parseInt(new URLSearchParams(window.location.search).get("stage") ?? "", 10)
  : Number.NaN;

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  scene: [BulletReclaimerScene],
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  render: { antialias: false, pixelArt: true, roundPixels: true },
});

if (Number.isInteger(debugStage) && debugStage >= 0 && debugStage < 5) {
  window.setTimeout(() => {
    game.scene.start("bullet-reclaimer", { stageIndex: debugStage, showTitle: false });
  }, 500);
}
