import { TileUI } from "./tile-ui.mjs";

export const MODULE_ID = "r7-coc-houserules";
export const HOVER_FLAG = "highlightOnHover";

// Exact DoorControl.draw / _onMouseOver values from Foundry V14.367.
// These are PIXI graphics, not CSS. Scale distances by canvas.dimensions.uiScale.
export const DOOR_HOVER_STYLE = Object.freeze({
  background: 0x000000,
  backgroundAlpha: 0.25,
  border: 0xff5500,
  borderAlpha: 0.8,
  borderWidth: 1,
  padding: 2,
  radius: 5,
});

class TileHoverHighlight {
  constructor(tile, canvas, ui) {
    this.tile = tile;
    this.canvas = canvas;
    this.ui = ui;
    this.background = new PIXI.Graphics();
    this.border = new PIXI.Graphics();
    this.background.eventMode = this.border.eventMode = "none";
    this.refresh();
  }

  refresh() {
    const { shape } = this.tile.document;
    const { dimensions } = this.canvas;
    const scale = dimensions.uiScale;
    const style = DOOR_HOVER_STYLE;
    const padding = style.padding * scale;
    const rectangle = [
      -shape.width * shape.anchorX - padding,
      -shape.height * shape.anchorY - padding,
      shape.width + padding * 2,
      shape.height + padding * 2,
      style.radius * scale,
    ];
    const geometryKey = rectangle.join(",");
    if (this._geometryKey !== geometryKey) {
      this.background
        .clear()
        .beginFill(style.background, style.backgroundAlpha)
        .drawRoundedRect(...rectangle)
        .endFill();

      this.border
        .clear()
        .lineStyle(style.borderWidth * scale, style.border, style.borderAlpha)
        .drawRoundedRect(...rectangle);

      this._geometryKey = geometryKey;
    }

    for (const graphic of [this.background, this.border]) {
      graphic.position.set(shape.x, shape.y);
      graphic.angle = shape.rotation;
    }

    const layer = this.ui.layer;
    const sprite = this.ui.entries.get(this.tile).sprite;

    this.background.parent?.removeChild(this.background);
    this.border.parent?.removeChild(this.border);

    layer.addChildAt(this.background, layer.getChildIndex(sprite));
    layer.addChildAt(this.border, layer.getChildIndex(sprite) + 1);
  }

  destroy() {
    for (const graphic of [this.background, this.border]) {
      if (!graphic.destroyed) {
        graphic.parent?.removeChild(graphic);
        graphic.destroy();
      }
    }
  }
}

/**
 * Local-only, event-driven hover detection. Index only opted-in Tiles and
 * coalesce pointer/visibility updates; never start a permanent animation loop.
 */
export class TileHoverController {
  constructor(
    canvas,
    game,
    {
      requestFrame = (callback) => requestAnimationFrame(callback),
      cancelFrame = (frame) => cancelAnimationFrame(frame),
    } = {},
  ) {
    Object.assign(this, { canvas, game, requestFrame, cancelFrame });
    this.tiles = new Map();
    this._frame = null;
    this._clientPoint = null;
    this._highlight = null;
    this._previousCursor = null;
    this._ui = new TileUI(canvas, game);
    this._uiDirty = false;
  }

  addTile(tile) {
    if (tile.document.parent !== this.canvas.scene || tile.isPreview) {
      return;
    }
    if (tile.document.getFlag(MODULE_ID, HOVER_FLAG) === true) {
      this.tiles.set(tile.id, tile);
    } else {
      this.tiles.delete(tile.id);
      this._ui.remove(tile);
    }
    this.requestRefresh();
  }

  removeTile(tile) {
    if (this.tiles.get(tile.id) !== tile) {
      return;
    }

    this.tiles.delete(tile.id);
    this._ui.remove(tile);

    if (this._highlight?.tile === tile) {
      this._clearHighlight();
    }
    this.requestRefresh();
  }

  handlePointerMove(event) {
    if (event.target !== this.canvas.app.view || event.buttons) {
      this.clear();
      return;
    }
    this._clientPoint = { x: event.clientX, y: event.clientY };
    this.requestRefresh(false);
  }

  requestRefresh(refreshUI = true) {
    this._uiDirty ||= refreshUI;

    if (
      (!this._clientPoint && !this._uiDirty) ||
      this._frame !== null ||
      (!this.tiles.size && !this._highlight)
    ) {
      return;
    }
    this._frame = this.requestFrame(() => {
      this._frame = null;
      this._refresh();
    });
  }

  clear() {
    if (this._frame !== null && !this._uiDirty) {
      this.cancelFrame(this._frame);
      this._frame = null;
    }
    this._clientPoint = null;
    this._clearHighlight();
  }

  destroy() {
    this.clear();
    if (this._frame !== null) {
      this.cancelFrame(this._frame);
      this._frame = null;
    }
    this._ui.destroy();
    this.tiles.clear();
  }

  _refresh() {
    const canvas = this.canvas;
    if (this._uiDirty) {
      this._ui.refresh(this.tiles);
      this._uiDirty = false;
    }

    if (
      !canvas.ready ||
      canvas.activeLayer !== canvas.tokens ||
      !this._clientPoint ||
      (this.game.paused && !this.game.user.isGM)
    ) {
      this._clearHighlight();
      return;
    }

    const point = canvas.canvasCoordinatesFromClient(this._clientPoint);
    let selected = null;
    for (const tile of this.tiles.values()) {
      if (!this._canHighlight(tile, point)) {
        continue;
      }
      if (!selected || this._isAbove(tile, selected)) {
        selected = tile;
      }
    }

    if (selected !== this._highlight?.tile) {
      this._clearHighlight();
      if (selected) {
        this._highlight = new TileHoverHighlight(selected, canvas, this._ui);
        this._previousCursor = canvas.app.view.style.cursor;
        canvas.app.view.style.cursor = "pointer";
      }
    } else {
      this._highlight?.refresh();
    }
  }

  _canHighlight(tile, point) {
    const { document, mesh } = tile;
    if (
      tile.destroyed ||
      tile.isPreview ||
      !tile.visible ||
      !tile.isVisible ||
      document.parent !== this.canvas.scene ||
      document.getFlag(MODULE_ID, HOVER_FLAG) !== true ||
      !this._ui.entries.get(tile)?.sprite.visible ||
      !document.includedInLevel(this.canvas.level) ||
      !mesh ||
      mesh.destroyed ||
      !mesh.visible ||
      mesh.alpha <= 0 ||
      mesh.parent !== this.canvas.primary ||
      tile.occluded ||
      (document.hidden && !this.game.user.isGM) ||
      !document.shape.testPoint(point)
    ) {
      return false;
    }

    return this._ui.contains(point);
  }

  _isAbove(tile, other) {
    for (const key of ["elevation", "sortLayer", "sort", "zIndex"]) {
      const difference = (tile.mesh[key] ?? 0) - (other.mesh[key] ?? 0);
      if (difference) {
        return difference > 0;
      }
    }
    const primary = this.canvas.primary;
    return primary.getChildIndex(tile.mesh) > primary.getChildIndex(other.mesh);
  }

  _clearHighlight() {
    this._highlight?.destroy();
    this._highlight = null;
    const view = this.canvas.app.view;
    if (this._previousCursor !== null && view.style.cursor === "pointer") {
      view.style.cursor = this._previousCursor;
    }
    this._previousCursor = null;
  }
}
