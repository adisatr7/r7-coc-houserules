/** Renders opted-in Tile textures above lighting, clipped to this client's LOS. */
export class TileUI {
  constructor(canvas, game) {
    Object.assign(this, { canvas, game });
    this.entries = new Map();

    this.layer = new PIXI.Container();
    this.layer.eventMode = "none";

    this.clip = new PIXI.Graphics();
    this.clip.eventMode = "none";

    canvas.controls.addChildAt(this.layer, 0);
    canvas.controls.addChildAt(this.clip, 0);
  }

  refresh(tiles) {
    for (const tile of this.entries.keys()) {
      if (!tiles.has(tile.id) || tiles.get(tile.id) !== tile) {
        this.remove(tile);
      }
    }

    const sources = [...this.canvas.effects.visionSources.values()].filter(
      (source) => source.active && !source.isPreview,
    );

    this.unrestricted =
      !this.canvas.scene.tokenVision ||
      (!sources.length && this.game.user.isGM);

    this.sources = sources.filter(
      (source) =>
        !source.isBlinded && source.level === this.canvas.level && source.los,
    );

    this.clip.clear().beginFill(0xffffff);

    for (const source of this.sources) {
      this.clip.drawPolygon(source.los.points);
    }

    this.clip.endFill();
    this.layer.mask = this.unrestricted ? null : this.clip;
    this.clip.renderable = false;
    this.layer.visible = this.unrestricted || this.sources.length > 0;

    for (const tile of tiles.values()) {
      const mesh = tile.mesh;

      let entry = this.entries.get(tile);
      if (entry && entry.mesh !== mesh) {
        this.remove(tile);
        entry = null;
      }

      if (!mesh || mesh.destroyed) {
        continue;
      }

      if (!entry) {
        const sprite = new PIXI.Sprite(mesh.texture);
        sprite.eventMode = "none";
        entry = { mesh, sprite, renderable: mesh.renderable };
        this.entries.set(tile, entry);
        this.layer.addChildAt(sprite, this.layer.children.length);
      }

      // Keep the native mesh in its indexed primary group, but do not leave
      // a second, fog-lit copy underneath the LOS-clipped interface image.
      mesh.renderable = false;
      const sprite = entry.sprite;
      sprite.texture = mesh.texture;

      for (const property of ["position", "scale", "pivot", "skew", "anchor"]) {
        sprite[property].copyFrom(mesh[property]);
      }

      sprite.rotation = mesh.rotation;
      sprite.alpha = mesh.alpha;
      sprite.tint = mesh.tint;
      sprite.visible = entry.renderable && this._canDisplay(tile);
    }

    const ordered = [...this.entries.keys()].sort((left, right) => {
      for (const property of ["elevation", "sortLayer", "sort", "zIndex"]) {
        const difference =
          (left.mesh[property] ?? 0) - (right.mesh[property] ?? 0);

        if (difference) {
          return difference;
        }
      }

      return (
        this.canvas.primary.getChildIndex(left.mesh) -
        this.canvas.primary.getChildIndex(right.mesh)
      );
    });

    for (const tile of ordered) {
      this.layer.addChildAt(
        this.entries.get(tile).sprite,
        this.layer.children.length - 1,
      );
    }
  }

  _canDisplay(tile) {
    const { document, mesh } = tile;

    return (
      !tile.destroyed &&
      !tile.isPreview &&
      tile.visible &&
      tile.isVisible &&
      document.parent === this.canvas.scene &&
      document.includedInLevel(this.canvas.level) &&
      mesh &&
      !mesh.destroyed &&
      mesh.visible &&
      mesh.alpha > 0 &&
      mesh.parent === this.canvas.primary &&
      !tile.occluded &&
      (!document.hidden || this.game.user.isGM)
    );
  }

  contains(point) {
    return (
      this.unrestricted ||
      this.sources?.some((source) => source.los.contains(point.x, point.y))
    );
  }

  remove(tile) {
    const entry = this.entries.get(tile);
    if (!entry) {
      return;
    }

    if (!entry.mesh.destroyed) {
      entry.mesh.renderable = entry.renderable;
    }

    if (!entry.sprite.destroyed) {
      entry.sprite.parent?.removeChild(entry.sprite);
      entry.sprite.destroy({ texture: false, baseTexture: false });
    }

    this.entries.delete(tile);
  }

  destroy() {
    for (const tile of this.entries.keys()) {
      this.remove(tile);
    }

    this.layer.mask = null;

    for (const object of [this.layer, this.clip]) {
      if (!object.destroyed) {
        object.parent?.removeChild(object);
        object.destroy();
      }
    }
  }
}
