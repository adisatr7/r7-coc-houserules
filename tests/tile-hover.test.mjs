import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  DOOR_HOVER_STYLE,
  HOVER_FLAG,
  MODULE_ID,
  TileHoverController,
} from "../scripts/tile-hover.mjs";
import { addTileHoverOption } from "../scripts/tile-config.mjs";

class Container {
  constructor() {
    this.children = [];
    this.destroyed = false;
  }

  addChildAt(child, index) {
    child.parent?.removeChild(child);
    this.children.splice(index, 0, child);
    child.parent = this;
    return child;
  }

  removeChild(child) {
    this.children.splice(this.getChildIndex(child), 1);
    child.parent = null;
  }

  destroy() {
    this.destroyed = true;
  }

  getChildIndex(child) {
    const index = this.children.indexOf(child);
    assert.notEqual(index, -1);
    return index;
  }
}

class Graphics extends Container {
  constructor() {
    super();
    this.commands = [];
    this.position = { set: (x, y) => Object.assign(this, { x, y }) };
  }

  clear() {
    this.commands = [];
    return this;
  }

  beginFill(...values) {
    this.commands.push(["fill", ...values]);
    return this;
  }

  lineStyle(...values) {
    this.commands.push(["line", ...values]);
    return this;
  }

  drawPolygon(points) {
    this.commands.push(["polygon", ...points]);
    return this;
  }

  drawRoundedRect(...values) {
    this.commands.push(["rectangle", ...values]);
    return this;
  }

  endFill() {
    return this;
  }

  destroy() {
    assert.equal(this.destroyed, false);
    this.destroyed = true;
  }
}

function vector(x = 0, y = 0) {
  return {
    x,
    y,
    copyFrom(other) {
      Object.assign(this, { x: other.x, y: other.y });
    },
  };
}

class Sprite extends Container {
  constructor(texture) {
    super();
    this.texture = texture;

    for (const property of ["position", "scale", "pivot", "skew", "anchor"]) {
      this[property] = vector();
    }
  }

  destroy(options) {
    assert.deepEqual(options, { texture: false, baseTexture: false });
    super.destroy();
  }
}

function hoverBorders(context) {
  return context.controls.children
    .flatMap((child) => child.children)
    .filter(
      (child) =>
        child instanceof Graphics &&
        child.commands.some((command) => command[0] === "line"),
    );
}

function fixture() {
  globalThis.PIXI = { Graphics, Container, Sprite };
  const frames = new Map();
  const primary = new Container();
  const controls = new Container();
  const scene = { tokenVision: true };
  const game = { user: { isGM: false }, paused: false };
  const canvas = {
    ready: true,
    scene,
    primary,
    controls,
    tokens: {},
    level: { id: "laboratory" },
    app: { view: { style: { cursor: "crosshair" } } },
    dimensions: { uiScale: 1 },
    canvasCoordinatesFromClient: (point) => point,
    effects: { visionSources: new Map() },
    visibility: {
      testVisibility: (points, options) => {
        assert.ok(Array.isArray(points));
        assert.equal(options.tolerance, 0);
        return true;
      },
    },
  };

  canvas.activeLayer = canvas.tokens;

  canvas.effects.visionSources.set("listener", {
    active: true,
    level: canvas.level,
    los: { points: [0, 0, 500, 0, 500, 500, 0, 500], contains: () => true },
  });

  let serial = 0;

  const controller = new TileHoverController(canvas, game, {
    requestFrame: (callback) => {
      frames.set(++serial, callback);
      return serial;
    },
    cancelFrame: (frame) => frames.delete(frame),
  });

  function addTile(id = "switch", enabled = true) {
    const shape = {
      x: 100,
      y: 100,
      width: 40,
      height: 40,
      anchorX: 0.5,
      anchorY: 0.5,
      rotation: 0,
      testPoint(point) {
        const radians = (-this.rotation * Math.PI) / 180;
        const deltaX = point.x - this.x;
        const deltaY = point.y - this.y;
        const localX = Math.cos(radians) * deltaX - Math.sin(radians) * deltaY;
        const localY = Math.sin(radians) * deltaX + Math.cos(radians) * deltaY;
        return (
          localX >= -this.width * this.anchorX &&
          localX <= this.width * (1 - this.anchorX) &&
          localY >= -this.height * this.anchorY &&
          localY <= this.height * (1 - this.anchorY)
        );
      },
    };

    const mesh = {
      renderable: true,
      texture: {},
      position: vector(100, 100),
      scale: vector(1, 1),
      pivot: vector(),
      skew: vector(),
      anchor: vector(0.5, 0.5),
      rotation: 0,
      tint: 0xffffff,
      alpha: 1,
      visible: true,
      elevation: 0,
      sortLayer: 500,
      sort: 0,
      zIndex: 0,
    };

    primary.addChildAt(mesh, primary.children.length);
    const document = {
      parent: scene,
      shape,
      enabled,
      hidden: false,
      includedInLevel: (level) => level.id === "laboratory",
      getFlag(scope, flag) {
        assert.equal(scope, MODULE_ID);
        assert.equal(flag, HOVER_FLAG);
        return this.enabled;
      },
    };

    const tile = {
      id,
      document,
      mesh,
      visible: true,
      isVisible: true,
      occluded: false,
    };
    controller.addTile(tile);

    return tile;
  }

  function flush() {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) {
      callback();
    }
  }

  function move(x = 100, y = 100, extra = {}) {
    controller.handlePointerMove({
      target: canvas.app.view,
      clientX: x,
      clientY: y,
      buttons: 0,
      ...extra,
    });
    flush();
  }

  return {
    canvas,
    game,
    primary,
    controls,
    frames,
    controller,
    addTile,
    flush,
    move,
  };
}

test("uses exact native door constants, with black behind the unlit artwork", () => {
  const context = fixture();
  const tile = context.addTile();
  context.move();

  assert.deepEqual(DOOR_HOVER_STYLE, {
    background: 0,
    backgroundAlpha: 0.25,
    border: 0xff5500,
    borderAlpha: 0.8,
    borderWidth: 1,
    padding: 2,
    radius: 5,
  });

  const [background, sprite, border] = context.controller._ui.layer.children;
  const mesh = context.primary.children[0];

  assert.equal(sprite.texture, mesh.texture);
  assert.equal(mesh.renderable, false);
  assert.equal(mesh, tile.mesh);
  assert.deepEqual(background.commands, [
    ["fill", 0, 0.25],
    ["rectangle", -22, -22, 44, 44, 5],
  ]);
  assert.deepEqual(border.commands, [
    ["line", 1, 0xff5500, 0.8],
    ["rectangle", -22, -22, 44, 44, 5],
  ]);
  assert.equal(background.eventMode, "none");
  assert.equal(border.eventMode, "none");
  assert.equal(mesh.alpha, 1);
  assert.equal(context.canvas.app.view.style.cursor, "pointer");
  assert.equal(context.frames.size, 0);
});

test("an unset or disabled checkbox creates no graphics and requires no Monk's module", () => {
  const context = fixture();
  context.addTile("disabled", false);

  const unset = context.addTile("unset", true);
  unset.document.enabled = undefined;

  context.controller.addTile(unset);
  context.move();

  assert.equal(hoverBorders(context).length, 0);
  assert.equal(context.primary.children.length, 2);
  assert.equal(context.controller.tiles.size, 0);
  assert.equal(context.canvas.app.view.style.cursor, "crosshair");
});

test("opted-in artwork appears without hovering and ignores illumination checks", () => {
  const context = fixture();

  context.canvas.visibility.testVisibility = () => {
    throw new Error("Lighting-dependent visibility must not be used");
  };
  const tile = context.addTile();
  context.flush();
  const ui = context.controller._ui;
  const sprite = ui.entries.get(tile).sprite;

  assert.equal(ui.layer.visible, true);
  assert.equal(sprite.visible, true);
  assert.equal(sprite.texture, tile.mesh.texture);
  assert.equal(tile.mesh.renderable, false);
  assert.equal(context.frames.size, 0);

  context.move();
  assert.equal(context.controller._highlight.tile, tile);
  assert.equal(ui.layer.mask, ui.clip);
  assert.deepEqual(ui.clip.commands[1], [
    "polygon",
    0,
    0,
    500,
    0,
    500,
    500,
    0,
    500,
  ]);
});

test("the entire artwork and highlight share an LOS mask, not a center-point check", () => {
  const context = fixture();
  const tile = context.addTile();
  const source = context.canvas.effects.visionSources.get("listener");

  source.los = {
    points: [0, 0, 100, 0, 100, 500, 0, 500],
    contains: (x) => x < 100,
  };
  context.move(90, 100);

  const ui = context.controller._ui;
  assert.equal(ui.entries.get(tile).sprite.parent, ui.layer);
  assert.equal(context.controller._highlight.border.parent, ui.layer);
  assert.equal(context.controller._highlight.background.parent, ui.layer);
  assert.equal(ui.layer.mask, ui.clip);

  context.move(110, 100);
  assert.equal(context.controller._highlight, null);

  source.active = false;
  context.controller.requestRefresh();
  context.flush();
  assert.equal(ui.layer.visible, false);
  assert.equal(tile.mesh.renderable, false);
});

test("only active, non-preview, non-blinded vision sources on this level reveal artwork", () => {
  const excludedSourceStates = [
    { active: false },
    { isPreview: true },
    { isBlinded: true },
    { level: {} },
  ];

  for (const change of excludedSourceStates) {
    const context = fixture();
    context.addTile();
    Object.assign(context.canvas.effects.visionSources.get("listener"), change);
    context.move();
    assert.equal(context.controller._ui.layer.visible, false);
    assert.equal(context.controller._highlight, null);
  }
});

test("GM overview and scenes without token vision are unrestricted, but blinded GM vision is not", () => {
  const context = fixture();

  context.addTile();
  context.game.user.isGM = true;
  context.canvas.effects.visionSources.clear();
  context.move();

  assert.equal(context.controller._ui.layer.mask, null);
  assert.equal(context.controller._ui.clip.renderable, false);
  assert.ok(context.controller._highlight);

  context.canvas.effects.visionSources.set("blind", {
    active: true,
    level: context.canvas.level,
    isBlinded: true,
  });
  context.controller.requestRefresh();
  context.flush();

  assert.equal(context.controller._ui.layer.visible, false);
  assert.equal(context.controller._highlight, null);

  context.game.user.isGM = false;
  context.canvas.scene.tokenVision = false;
  context.controller.requestRefresh();
  context.flush();

  assert.equal(context.controller._ui.layer.mask, null);
  assert.ok(context.controller._highlight);
});

test("texture transforms follow the native mesh and opting out restores native rendering", () => {
  const context = fixture();
  const tile = context.addTile();

  tile.mesh.scale = vector(-2, 3);
  tile.mesh.rotation = 0.75;
  tile.mesh.tint = 0x123456;

  context.flush();
  const sprite = context.controller._ui.entries.get(tile).sprite;

  assert.equal(sprite.scale.x, -2);
  assert.equal(sprite.scale.y, 3);
  assert.equal(sprite.rotation, 0.75);
  assert.equal(sprite.tint, 0x123456);

  tile.mesh.texture = { replacement: true };
  context.controller.addTile(tile);
  context.flush();
  assert.equal(sprite.texture, tile.mesh.texture);

  tile.document.enabled = false;
  context.controller.addTile(tile);
  assert.equal(tile.mesh.renderable, true);
  assert.equal(sprite.destroyed, true);
  assert.equal(tile.mesh.texture.replacement, true);

  context.controller.destroy();
});

test("pointer movement reuses the LOS mask and does not refresh every tile image", () => {
  const context = fixture();
  context.addTile();
  context.flush();
  context.controller._ui.refresh = () => {
    throw new Error(
      "Pointer movement must not rebuild tile artwork or LOS polygons",
    );
  };
  context.move();
  context.move(101);
  context.controller.clear();

  assert.equal(context.controller._ui.layer.visible, true);
  assert.equal(context.frames.size, 0);
});

test("a previously non-renderable mesh stays suppressed after opting out", () => {
  const context = fixture();
  const tile = context.addTile();

  tile.mesh.renderable = false;
  context.move();

  assert.equal(context.controller._ui.entries.get(tile).sprite.visible, false);
  assert.equal(context.controller._highlight, null);

  tile.document.enabled = false;
  context.controller.addTile(tile);
  assert.equal(tile.mesh.renderable, false);
});

test("replacing a native mesh releases the old sprite and teardown restores the new mesh", () => {
  const context = fixture();
  const tile = context.addTile();
  context.flush();
  const original = tile.mesh;
  const oldSprite = context.controller._ui.entries.get(tile).sprite;

  tile.mesh = {
    ...original,
    parent: null,
    renderable: true,
    texture: { redrawn: true },
  };
  context.primary.removeChild(original);
  context.primary.addChildAt(tile.mesh, 0);
  context.controller.addTile(tile);
  context.flush();

  assert.equal(original.renderable, true);
  assert.equal(oldSprite.destroyed, true);
  assert.equal(tile.mesh.renderable, false);

  context.controller.destroy();
  assert.equal(tile.mesh.renderable, true);
  assert.equal(context.controls.children.length, 0);
});

test("hover updates are coalesced, idle does not schedule further frames, and graphics are reused", () => {
  const context = fixture();
  context.addTile();

  const event = {
    target: context.canvas.app.view,
    clientX: 100,
    clientY: 100,
    buttons: 0,
  };

  for (let index = 0; index < 25; index++) {
    context.controller.handlePointerMove(event);
  }
  assert.equal(context.frames.size, 1);

  context.flush();
  assert.equal(context.frames.size, 0);

  const border = hoverBorders(context)[0];
  context.move(101);
  assert.equal(hoverBorders(context)[0], border);
  assert.equal(context.primary.children.length, 1);
});

test("rotation, anchors and UI scale affect both the hit test and frame geometry", () => {
  const context = fixture();
  const tile = context.addTile();

  Object.assign(tile.document.shape, {
    width: 80,
    height: 20,
    anchorX: 0,
    anchorY: 0,
    rotation: 90,
  });

  context.canvas.dimensions.uiScale = 2;
  context.move(90, 170);

  const border = hoverBorders(context)[0];
  assert.equal(border.angle, 90);
  assert.deepEqual([border.x, border.y], [100, 100]);
  assert.deepEqual(border.commands, [
    ["line", 2, 0xff5500, 0.8],
    ["rectangle", -4, -4, 88, 28, 10],
  ]);

  context.move(170, 110);
  assert.equal(hoverBorders(context).length, 0);
});

test("pan/zoom recalculates canvas coordinates even when the pointer is stationary", () => {
  const context = fixture();
  context.addTile();
  context.canvas.canvasCoordinatesFromClient = ({ x, y }) => ({
    x: x / 2,
    y: y / 2,
  });

  context.move(200, 200);
  assert.equal(hoverBorders(context).length, 1);

  context.canvas.canvasCoordinatesFromClient = (point) => point;
  context.controller.requestRefresh();
  context.flush();
  assert.equal(hoverBorders(context).length, 0);
});

test("hidden, unseen, occluded, invisible, off-level and preview Tiles never expose a player highlight", () => {
  for (const configure of [
    ({ tile }) => {
      tile.document.hidden = true;
    },
    ({ canvas }) => {
      canvas.effects.visionSources.get("listener").los.contains = () => false;
    },
    ({ tile }) => {
      tile.occluded = true;
    },
    ({ tile }) => {
      tile.visible = false;
    },
    ({ tile }) => {
      tile.isVisible = false;
    },
    ({ tile }) => {
      tile.mesh.visible = false;
    },
    ({ tile }) => {
      tile.mesh.alpha = 0;
    },
    ({ tile }) => {
      tile.isPreview = true;
    },
    ({ canvas }) => {
      canvas.level.id = "hallway";
    },
    ({ tile }) => {
      tile.document.parent = {};
    },
  ]) {
    const context = fixture();
    const tile = context.addTile();
    configure({ ...context, tile });
    context.move();
    assert.equal(hoverBorders(context).length, 0);
  }
});

test("paused players and other active layers suppress hover; GM pause matches native doors", () => {
  const context = fixture();

  context.addTile();
  context.game.paused = true;
  context.move();
  assert.equal(hoverBorders(context).length, 0);

  context.game.user.isGM = true;
  context.move();
  assert.equal(hoverBorders(context).length, 1);

  context.canvas.activeLayer = {};
  context.controller.requestRefresh();
  context.flush();
  assert.equal(hoverBorders(context).length, 0);
});

test("only the topmost enabled Tile is framed, using Foundry's native sort tuple", () => {
  const context = fixture();
  const lower = context.addTile("lower");
  const upper = context.addTile("upper");

  upper.mesh.sort = 10;
  context.move();
  assert.equal(context.controller._highlight.tile, upper);

  lower.document.shape.rotation = 15;
  lower.mesh.elevation = 20;
  context.controller.requestRefresh();
  context.flush();
  assert.equal(hoverBorders(context)[0].angle, 15);
  assert.equal(hoverBorders(context).length, 1);
});

test("moving, resizing, sorting or disabling the hovered Tile updates without another pointer move", () => {
  const context = fixture();
  const tile = context.addTile();

  context.move();
  tile.document.shape.width = 60;
  tile.mesh.sort = 25;

  context.controller.addTile(tile);
  context.flush();
  assert.deepEqual(hoverBorders(context)[0].commands[1], [
    "rectangle",
    -32,
    -22,
    64,
    44,
    5,
  ]);
  assert.equal(context.controller._highlight.tile, tile);

  tile.document.shape.x = 500;
  context.controller.addTile(tile);
  context.flush();
  assert.equal(hoverBorders(context).length, 0);

  tile.document.shape.x = 100;
  context.controller.addTile(tile);
  context.flush();

  const border = hoverBorders(context)[0];
  tile.document.enabled = false;
  context.controller.addTile(tile);
  context.flush();
  assert.equal(hoverBorders(context).length, 0);
  assert.equal(border.destroyed, true);
});

test("leaving the canvas, hovering UI or dragging clears graphics without consuming events", () => {
  for (const extra of [{ target: {} }, { buttons: 1 }]) {
    const context = fixture();
    const tile = context.addTile();
    context.move();

    const border = hoverBorders(context)[0];
    context.move(100, 100, extra);

    assert.equal(border.destroyed, true);
    assert.deepEqual(context.primary.children, [tile.mesh]);
    assert.equal(hoverBorders(context).length, 0);
    assert.equal(context.canvas.app.view.style.cursor, "crosshair");
  }
});

test("deletion/teardown destroys only module graphics and cancels queued callbacks", () => {
  const context = fixture();
  const tile = context.addTile();

  context.move();
  context.controller.removeTile(tile);
  assert.equal(hoverBorders(context).length, 0);
  context.controller.destroy();

  assert.equal(context.controller.tiles.size, 0);
  assert.equal(context.frames.size, 0);
  assert.deepEqual(context.primary.children, [tile.mesh]);
  context.controller.destroy();
});

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
  }

  append(...children) {
    this.children.push(...children);
  }
}

test("Tile configuration adds our own localized, opt-in flag exactly once", () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  const localized = [];

  globalThis.game = {
    i18n: {
      localize: (key) => {
        localized.push(key);
        return key;
      },
    },
  };

  const appearance = new Element("tab");
  const html = {
    querySelector: (selector) =>
      selector.startsWith(".tab") ? appearance : appearance.children[0],
  };
  let enabled;
  const application = {
    id: "tile-config-test",
    document: { getFlag: () => enabled },
  };

  addTileHoverOption(application, html);
  const group = appearance.children[0].children[1];
  const input = group.children[1].children[0];

  assert.equal(input.name, `flags.${MODULE_ID}.${HOVER_FLAG}`);
  assert.equal(input.checked, false);
  assert.equal(group.children[0].htmlFor, input.id);
  assert.equal(localized.length, 2);
  assert.equal(group.children.length, 2);

  addTileHoverOption(application, html);
  assert.equal(appearance.children.length, 1);
  appearance.children = [];
  enabled = true;
  addTileHoverOption(application, html);
  assert.equal(
    appearance.children[0].children[1].children[1].children[0].checked,
    true,
  );
});

test("manifest is standalone and every declared module asset exists", async () => {
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL("module.json", root), "utf8"),
  );
  assert.equal(manifest.id, MODULE_ID);
  assert.equal(manifest.authors[0].name, "reflection77");
  assert.equal(manifest.socket, true);
  assert.equal(manifest.relationships, undefined);

  for (const path of [
    ...manifest.esmodules,
    ...manifest.languages.map((language) => language.path),
  ]) {
    assert.ok((await readFile(new URL(path, root), "utf8")).length);
  }

  const translations = JSON.parse(
    await readFile(new URL("lang/en.json", root), "utf8"),
  );

  for (const key of ["legend", "label"]) {
    assert.equal(typeof translations[MODULE_ID].tileHover[key], "string");
  }
});

test("Foundry hooks wire pointer/visibility refresh and abort listeners across scenes", async () => {
  const context = fixture();
  const tile = context.addTile();
  context.controller.destroy();
  const callbacks = new Map();

  globalThis.Hooks = { on: (hook, callback) => callbacks.set(hook, callback) };
  globalThis.canvas = context.canvas;
  globalThis.game = context.game;
  globalThis.document = new EventTarget();
  globalThis.window = new EventTarget();

  const view = new EventTarget();
  view.style = { cursor: "" };
  context.canvas.app.view = view;
  context.canvas.tiles = { placeables: [tile] };

  globalThis.requestAnimationFrame = (callback) => {
    context.frames.set(1, callback);
    return 1;
  };
  globalThis.cancelAnimationFrame = (frame) => context.frames.delete(frame);

  await import("../scripts/main.mjs");
  const pointerMove = () => {
    const event = new Event("pointermove");
    Object.defineProperties(event, {
      target: { value: view },
      clientX: { value: 100 },
      clientY: { value: 100 },
      buttons: { value: 0 },
    });
    document.dispatchEvent(event);
    context.flush();
  };

  callbacks.get("canvasReady")();
  pointerMove();
  assert.equal(hoverBorders(context).length, 1);

  context.game.paused = true;
  callbacks.get("pauseGame")();
  context.flush();
  assert.equal(hoverBorders(context).length, 0);

  context.game.paused = false;
  callbacks.get("pauseGame")();
  context.flush();
  assert.equal(hoverBorders(context).length, 1);

  window.dispatchEvent(new Event("blur"));
  assert.equal(hoverBorders(context).length, 0);

  pointerMove();
  callbacks.get("canvasTearDown")();
  assert.deepEqual(context.primary.children, [tile.mesh]);
  assert.equal(hoverBorders(context).length, 0);

  pointerMove();
  assert.equal(context.frames.size, 0);
  assert.equal(hoverBorders(context).length, 0);

  callbacks.get("canvasReady")();
  pointerMove();
  assert.equal(hoverBorders(context).length, 1);

  view.dispatchEvent(new Event("pointerleave"));
  assert.equal(hoverBorders(context).length, 0);
  callbacks.get("canvasTearDown")();
});
