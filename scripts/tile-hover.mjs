export const MODULE_ID = "r7-coc-houserules";
export const HOVER_FLAG = "highlightOnHover";

// Exact DoorControl.draw / _onMouseOver values from Foundry V14.367.
// These are PIXI graphics, not CSS. Scale distances by canvas.dimensions.uiScale.
export const DOOR_HOVER_STYLE = Object.freeze({
  background: 0x000000,
  backgroundAlpha: 0.25,
  border: 0xFF5500,
  borderAlpha: 0.8,
  borderWidth: 1,
  padding: 2,
  radius: 5,
});

class TileHoverHighlight {
  constructor(tile, canvas) {
    this.tile = tile;
    this.canvas = canvas;
    this.background = new PIXI.Graphics();
    this.border = new PIXI.Graphics();
    this.background.eventMode = this.border.eventMode = "none";
    this.refresh();
  }

  refresh() {
    const { shape } = this.tile.document;
    const { mesh } = this.tile;
    const { primary, controls, dimensions } = this.canvas;
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
      this.background.clear().beginFill(style.background, style.backgroundAlpha)
        .drawRoundedRect(...rectangle).endFill();
      this.border.clear().lineStyle(style.borderWidth * scale, style.border, style.borderAlpha)
        .drawRoundedRect(...rectangle);
      this._geometryKey = geometryKey;
    }

    for (const graphic of [this.background, this.border]) {
      graphic.position.set(shape.x, shape.y);
      graphic.angle = shape.rotation;
    }

    // Put the background BEHIND the original artwork, not over it. Keep its
    // native sort tuple so Foundry's primary sort keeps the pair together.
    let sortChanged = false;
    for (const key of ["elevation", "sortLayer", "sort", "zIndex"]) {
      if (this.background[key] !== mesh[key]) {
        this.background[key] = mesh[key];
        sortChanged = true;
      }
    }
    if (this.background.parent !== primary) {
      primary.addChildAt(this.background, primary.getChildIndex(mesh));
    }
    if (sortChanged) {
      primary.sortDirty = true;
    }
    if (this.border.parent !== controls) {
      controls.addChildAt(this.border, 0);
    }
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
  constructor(canvas, game, {
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (frame) => cancelAnimationFrame(frame),
  } = {}) {
    Object.assign(this, { canvas, game, requestFrame, cancelFrame });
    this.tiles = new Map();
    this._frame = null;
    this._clientPoint = null;
    this._highlight = null;
    this._previousCursor = null;
  }

  addTile(tile) {
    if (tile.document.parent !== this.canvas.scene || tile.isPreview) {
      return;
    }
    if (tile.document.getFlag(MODULE_ID, HOVER_FLAG) === true) {
      this.tiles.set(tile.id, tile);
    } else {
      this.tiles.delete(tile.id);
    }
    this.requestRefresh();
  }

  removeTile(tile) {
    if (this.tiles.get(tile.id) !== tile) {
      return;
    }
    this.tiles.delete(tile.id);
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
    this.requestRefresh();
  }

  requestRefresh() {
    if (!this._clientPoint || this._frame !== null
      || (!this.tiles.size && !this._highlight)) {
      return;
    }
    this._frame = this.requestFrame(() => {
      this._frame = null;
      this._refresh();
    });
  }

  clear() {
    if (this._frame !== null) {
      this.cancelFrame(this._frame);
      this._frame = null;
    }
    this._clientPoint = null;
    this._clearHighlight();
  }

  destroy() {
    this.clear();
    this.tiles.clear();
  }

  _refresh() {
    const canvas = this.canvas;
    if (!canvas.ready || canvas.activeLayer !== canvas.tokens
      || (this.game.paused && !this.game.user.isGM)) {
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
        this._highlight = new TileHoverHighlight(selected, canvas);
        this._previousCursor = canvas.app.view.style.cursor;
        canvas.app.view.style.cursor = "pointer";
      }
    } else {
      this._highlight?.refresh();
    }
  }

  _canHighlight(tile, point) {
    const { document, mesh } = tile;
    if (tile.destroyed || tile.isPreview || !tile.visible || !tile.isVisible
      || document.parent !== this.canvas.scene
      || document.getFlag(MODULE_ID, HOVER_FLAG) !== true
      || !document.includedInLevel(this.canvas.level)
      || !mesh || mesh.destroyed || !mesh.visible || mesh.alpha <= 0
      || mesh.parent !== this.canvas.primary || tile.occluded
      || (document.hidden && !this.game.user.isGM)
      || !document.shape.testPoint(point)) {
      return false;
    }

    // The interface border bypasses fog, so never draw it at an unseen point.
    return this.canvas.visibility.testVisibility([point], { tolerance: 0 });
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
