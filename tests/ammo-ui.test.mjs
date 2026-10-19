import assert from "node:assert/strict";
import { test } from "node:test";
import { MODULE_ID } from "../scripts/ammo/model.mjs";
import { renderAmmoItem, wireActorAmmo } from "../scripts/ammo/ui.mjs";

class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.value = "";
    this.disabled = false;
  }

  append(...children) {
    for (const child of children) {
      child.remove();
      this.children.push(child);
      child.parentElement = this;
      if (this.tagName === "SELECT" && this.children.length === 1) {
        this.value = child.value;
      }
    }
  }

  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
  }

  removeAttribute(name) {
    delete this[name];
  }

  matches(selector) {
    if (selector.startsWith(".")) {
      return this.className?.split(" ").includes(selector.slice(1));
    }
    return this.tagName === selector.toUpperCase();
  }

  closest(selector) {
    return this.matches(selector)
      ? this
      : this.parentElement?.closest(selector);
  }

  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(selector.split(", ").some((part) => child.matches(part))
        ? [child]
        : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function fixture(type = "item", data = {}) {
  globalThis.document = {
    createElement: (tag) => new Element(tag),
  };

  globalThis.game = {
    i18n: {
      format: (key) => key,
    },
  };

  const notices = [];

  globalThis.ui = {
    notifications: {
      error: (error) => notices.push(error),
    },
  };

  const html = new Element("form");
  const calls = [];

  const item = {
    id: "test",
    type,
    system: { quantity: 20 },
    getFlag: () => data,
  };

  const application = { document: item, isEditable: true, render: () => {} };
  const request = async (...args) => calls.push(args);

  const button = (name) =>
    html
      .querySelectorAll("button")
      .find((node) => node.textContent === `${MODULE_ID}.ammo.actions.${name}`);

  const click = async (name) => {
    button(name).dispatchEvent(new Event("click", { cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
  };

  const control = (key) => {
    const label = html
      .querySelectorAll("label")
      .find((node) => node.textContent === `${MODULE_ID}.ammo.fields.${key}`);

    return html
      .querySelectorAll("input, select")
      .find((node) => node.id === label?.htmlFor);
  };

  return {
    item,
    application,
    html,
    calls,
    notices,
    request,
    button,
    click,
    control,
  };
}

test("generic Item has its own unchecked opt-in; saving explicitly designates loose rounds", async () => {
  const context = fixture();
  renderAmmoItem(context.application, context.html, context.request);
  const inputs = context.html.querySelectorAll("input");

  assert.equal(inputs[0].checked, false);
  assert.equal(context.calls.length, 0);
  assert.equal(context.html.querySelector("details").open, true);

  inputs[0].checked = true;
  context.html.querySelector("select").value = "rounds";
  inputs.find((node) => node.type === "text" && node !== inputs[1]).value =
    "9X19";
  await context.click("save");

  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0][1], "configure");
  assert.equal(context.calls[0][2].config.enabled, true);
  assert.equal(context.calls[0][2].config.role, "rounds");
  assert.equal(context.calls[0][2].config.cartridgeType, "9x19");

  for (const input of inputs) {
    assert.equal(
      input.name,
      undefined,
      "R7 inputs must not be submitted through CoC7's native form",
    );
  }
});

test("weapon gets checkbox and compatible magazine actions; rendering does not opt it in", async () => {
  const data = {
    enabled: true,
    magazineType: "pistol-8",
    magazineId: "",
  };

  const context = fixture("weapon", data);

  const magazine = {
    id: "mag",
    name: "Magazine",
    type: "item",
    system: { quantity: 1 },
    getFlag: () => ({
      enabled: true,
      role: "magazine",
      magazineType: "pistol-8",
      cartridgeType: "9x19",
      capacity: 8,
      roundCount: 5,
    }),
  };

  const actor = {
    documentName: "Actor",
    items: {
      get: () => undefined,
      filter: (predicate) => [magazine].filter(predicate),
    },
  };

  context.item.parent = actor;
  renderAmmoItem(context.application, context.html, context.request);

  assert.equal(context.html.querySelector("input").checked, true);
  assert.equal(context.button("insert").disabled, false);
  assert.equal(context.calls.length, 0);

  const configuration = context.html.querySelector("details");
  assert.equal(configuration.open, false);
  assert.equal(
    configuration.querySelector("summary").textContent,
    `${MODULE_ID}.ammo.configuration`,
  );
  assert.equal(context.button("save").closest("details"), configuration);

  for (const name of ["reload", "insert", "eject"]) {
    assert.equal(context.button(name).closest("details"), undefined);
  }
  await context.click("insert");

  assert.equal(context.calls[0][1], "insert");
  assert.equal(context.calls[0][2].sourceId, "mag");
  assert.equal(
    context.html
      .querySelectorAll("input")
      .filter(
        (node) => node.type === "text" && !node.closest(".form-group").hidden,
      ).length,
    1,
  );

  await context.click("save");
  assert.equal(context.calls[1][1], "configure");
  assert.equal(
    Object.hasOwn(context.calls[1][2].config, "cartridgeType"),
    false,
  );
  assert.equal(context.calls[1][2].config.streamlinedAttacks, false);
  assert.equal(context.calls[1][2].config.roundsPerAttack, 1);

  const streamlined = context.html
    .querySelectorAll("input")
    .filter((node) => node.type === "checkbox")[1];
  const cost = context.control("roundsPerAttack");
  assert.equal(cost.closest(".form-group").hidden, true);

  streamlined.checked = true;
  streamlined.dispatchEvent(new Event("change"));
  assert.equal(cost.closest(".form-group").hidden, false);

  cost.value = "3";
  await context.click("save");
  assert.equal(context.calls[2][2].config.streamlinedAttacks, true);
  assert.equal(context.calls[2][2].config.roundsPerAttack, 3);

  renderAmmoItem(context.application, context.html, context.request);
  assert.equal(context.html.querySelectorAll(".r7-ammo").length, 1);
});

test("internal weapon configuration replaces magazine type with cartridge type/capacity and shares round controls", async () => {
  const context = fixture("weapon", {
    enabled: true,
    reloadType: "internal",
    cartridgeType: "rifle-round",
    capacity: 5,
    roundCount: 2,
  });

  const rounds = {
    id: "stack",
    type: "item",
    name: "Rifle rounds",
    system: { quantity: 20 },
    getFlag: () => ({
      enabled: true,
      role: "rounds",
      cartridgeType: "rifle-round",
    }),
  };

  context.item.parent = {
    documentName: "Actor",
    items: {
      filter: (predicate) => [rounds].filter(predicate),
      get: () => rounds,
    },
  };

  renderAmmoItem(context.application, context.html, context.request);
  assert.equal(
    context.control("magazineType").closest(".form-group").hidden,
    true,
  );
  assert.equal(
    context.control("cartridgeType").closest(".form-group").hidden,
    false,
  );
  assert.equal(
    context.control("capacity").closest(".form-group").hidden,
    false,
  );
  assert.equal(context.button("insert"), undefined);
  assert.equal(context.button("eject"), undefined);

  for (const name of ["load", "fill", "unload"]) {
    assert.equal(context.button(name).closest("details"), undefined);
  }
  await context.click("fill");

  assert.deepEqual(context.calls[0].slice(1), [
    "load",
    { sourceId: "stack", count: 3 },
  ]);

  const amount = context.control("amount");
  amount.value = "1";
  await context.click("unload");
  assert.deepEqual(context.calls[1].slice(1), ["unload", { count: 1 }]);

  await context.click("save");
  const config = context.calls[2][2].config;
  assert.equal(config.reloadType, "internal");
  assert.equal(config.cartridgeType, "rifle-round");
  assert.equal(config.capacity, 5);
  assert.equal(Object.hasOwn(config, "magazineType"), false);

  context.control("reloadType").value = "detachable";
  context.control("reloadType").dispatchEvent(new Event("change"));
  assert.equal(
    context.control("magazineType").closest(".form-group").hidden,
    false,
  );
  assert.equal(
    context.control("cartridgeType").closest(".form-group").hidden,
    true,
  );
  assert.equal(context.control("capacity").closest(".form-group").hidden, true);
});

test("magazine UI can fill from a selected stack or eject a chosen round count", async () => {
  const context = fixture("item", {
    enabled: true,
    role: "magazine",
    magazineType: "pistol-8",
    cartridgeType: "9x19",
    capacity: 8,
    roundCount: 3,
  });

  const rounds = {
    id: "stack",
    name: "9mm",
    type: "item",
    system: { quantity: 20 },
    getFlag: () => ({ enabled: true, role: "rounds", cartridgeType: "9x19" }),
  };

  context.item.parent = {
    documentName: "Actor",
    items: {
      filter: (predicate) => [rounds].filter(predicate),
      get: () => rounds,
    },
  };

  renderAmmoItem(context.application, context.html, context.request);
  assert.equal(context.html.querySelector("details").open, false);

  for (const name of ["load", "fill", "unload"]) {
    assert.equal(context.button(name).closest("details"), undefined);
  }

  await context.click("fill");
  assert.deepEqual(context.calls[0].slice(1), [
    "load",
    { sourceId: "stack", count: 5 },
  ]);

  const amount = context.html
    .querySelectorAll("input")
    .filter((node) => node.type === "number")
    .at(-1);
  amount.value = "2";
  await context.click("unload");
  assert.deepEqual(context.calls[1].slice(1), ["unload", { count: 2 }]);
});

test("read-only sheets cannot enable or operate R7 items", () => {
  const context = fixture();
  context.application.isEditable = false;
  renderAmmoItem(context.application, context.html, context.request);

  for (const control of context.html.querySelectorAll(
    "input, select, button",
  )) {
    assert.equal(control.disabled, true);
  }
});

test("actor reload capture intercepts only managed weapons and leaves native weapons alone", async () => {
  const context = fixture();

  const managed = {
    uuid: "Actor.a.Item.managed",
    type: "weapon",
    getFlag: () => ({ enabled: true }),
  };

  const native = {
    uuid: "Actor.a.Item.native",
    type: "weapon",
    getFlag: () => undefined,
  };

  context.application.document.items = {
    find: (predicate) => [managed, native].find(predicate),
  };

  const row = new Element("div");
  row.className = "item";
  row.dataset.itemUuid = native.uuid;

  const reload = new Element("button");
  reload.className = "reload-weapon";
  reload.dataset.tooltip = "Native ammo instructions";
  reload.title = "Native ammo instructions";

  row.append(reload);
  context.html.append(row);

  wireActorAmmo(context.application, context.html, context.request);
  assert.equal(reload.dataset.tooltip, "Native ammo instructions");
  assert.equal(reload.title, "Native ammo instructions");

  const dispatch = (type) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, "target", { value: reload });
    context.html.dispatchEvent(event);
    return event;
  };

  assert.equal(dispatch("click").defaultPrevented, false);
  assert.equal(context.calls.length, 0);

  row.dataset.itemUuid = managed.uuid;
  wireActorAmmo(context.application, context.html, context.request);

  assert.equal(reload.dataset.tooltip, `${MODULE_ID}.ammo.reloadTooltip`);
  assert.equal(
    reload.title,
    undefined,
    "remove native title to avoid contradictory browser tooltips",
  );
  assert.equal(dispatch("click").defaultPrevented, true);
  assert.equal(context.calls.at(-1)[1], "reload");

  wireActorAmmo(context.application, context.html, context.request);

  assert.equal(dispatch("contextmenu").defaultPrevented, true);
  assert.equal(context.calls.at(-1)[1], "eject");
  assert.equal(
    context.calls.length,
    2,
    "rerender must not accumulate capture listeners",
  );

  managed.getFlag = () => ({ enabled: true, reloadType: "internal" });
  wireActorAmmo(context.application, context.html, context.request);

  assert.equal(
    reload.dataset.tooltip,
    `${MODULE_ID}.ammo.internalReloadTooltip`,
  );
  assert.equal(dispatch("contextmenu").defaultPrevented, true);
  assert.equal(
    context.calls.at(-1)[1],
    "eject",
    "internal eject recovers all rounds through the same service operation",
  );
});
