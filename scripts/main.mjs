import { TileHoverController } from "./tile-hover.mjs";
import { addTileHoverOption } from "./tile-config.mjs";

let hover = null;
let listeners = null;

function stopHover() {
  listeners?.abort();
  listeners = null;
  hover?.destroy();
  hover = null;
}

Hooks.on("renderTileConfig", addTileHoverOption);

Hooks.on("canvasReady", () => {
  stopHover();
  hover = new TileHoverController(canvas, game);
  for (const tile of canvas.tiles.placeables) {
    hover.addTile(tile);
  }

  listeners = new AbortController();
  const options = { signal: listeners.signal };

  document.addEventListener("pointermove", (event) => hover.handlePointerMove(event), options);
  canvas.app.view.addEventListener("pointerleave", () => hover.clear(), options);
  window.addEventListener("blur", () => hover.clear(), options);
  window.addEventListener("pagehide", stopHover, options);
});

Hooks.on("canvasTearDown", stopHover);

Hooks.on("drawTile", (tile) => hover?.addTile(tile));

Hooks.on("refreshTile", (tile) => hover?.addTile(tile));

Hooks.on("updateTile", (document) => {
  if (document.parent === canvas.scene && document.object) {
    hover?.addTile(document.object);
  }
});

Hooks.on("destroyTile", (tile) => hover?.removeTile(tile));

Hooks.on("deleteTile", (document) => {
  if (document.parent === canvas.scene && document.object) {
    hover?.removeTile(document.object);
  }
});

for (const hook of ["canvasPan", "sightRefresh", "controlToken", "pauseGame"]) {
  Hooks.on(hook, () => hover?.requestRefresh());
}

for (const hook of ["activateCanvasLayer", "deactivateCanvasLayer"]) {
  Hooks.on(hook, () => hover?.clear());
}
