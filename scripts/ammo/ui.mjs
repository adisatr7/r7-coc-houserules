import {
  MODULE_ID,
  ammoData,
  availableMagazines,
  availableRounds,
  isInternalWeapon,
  isWeapon,
} from "./model.mjs";

const text = (key, data) =>
  game.i18n.format(`${MODULE_ID}.ammo.${key}`, data ?? {});

let fieldSerial = 0;

function element(tag, className = "", value = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;

  return node;
}

function errorNotice(error) {
  ui.notifications.error(text(`errors.${error.code ?? "unexpected"}`));
  console.error(`${MODULE_ID} | R7 Ammo`, error);
}

function field(parent, key, input) {
  const group = element("div", "form-group");
  const label = element("label", "", text(`fields.${key}`));
  const controls = element("div", "form-fields");

  input.id = `r7-ammo-field-${++fieldSerial}`;
  label.htmlFor = input.id;
  controls.append(input);
  group.append(label, controls);
  parent.append(group);

  return input;
}

function input(type, value) {
  const node = element("input");
  node.type = type;
  if (type === "checkbox") {
    node.checked = value === true;
  } else {
    node.value = value ?? "";
  }

  if (type === "number") {
    node.min = "1";
    node.step = "1";
  }

  return node;
}

function select(options, selected) {
  const node = element("select");

  for (const [value, label] of options) {
    const option = element("option", "", label);
    option.value = value;
    node.append(option);
  }

  if (selected !== undefined) {
    node.value = selected;
  }

  return node;
}

function button(parent, label, action) {
  const node = element("button", "", text(`actions.${label}`));
  node.type = "button";

  node.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    node.disabled = true;

    try {
      await action();
    } catch (error) {
      errorNotice(error);
    } finally {
      node.disabled = false;
    }
  });

  parent.append(node);
  return node;
}

export function renderAmmoItem(application, html, request) {
  const item = application.document;
  if (!["weapon", "item"].includes(item.type)) {
    return;
  }
  html.querySelector(".r7-ammo")?.remove();

  const host =
    html.querySelector('.tab[data-tab="details"]') ??
    html.querySelector('.tab[data-tab="description"]') ??
    html;

  const section = element("fieldset", "r7-ammo");
  section.append(element("legend", "", text("title")));

  // Leave inputs unnamed so CoC7's submit-on-change cannot bypass the GM queue
  section.addEventListener("change", (event) => event.stopPropagation());

  const data = ammoData(item);
  const configuration = element("details", "r7-ammo-configuration");
  configuration.open = data.enabled !== true;
  configuration.append(element("summary", "", text("configuration")));

  const enabled = field(
    configuration,
    "enabled",
    input("checkbox", data.enabled),
  );

  const settings = element("div");
  const weapon = item.type === "weapon";

  const role = weapon
    ? null
    : field(
        settings,
        "role",
        select(
          [
            ["magazine", text("roles.magazine")],
            ["rounds", text("roles.rounds")],
          ],
          data.role ?? "magazine",
        ),
      );

  const reloadType = weapon
    ? field(
        settings,
        "reloadType",
        select(
          [
            ["detachable", text("reloadTypes.detachable")],
            ["internal", text("reloadTypes.internal")],
          ],
          data.reloadType ?? "detachable",
        ),
      )
    : null;

  const magazineType = field(
    settings,
    "magazineType",
    input("text", data.magazineType),
  );

  const cartridgeType = field(
    settings,
    "cartridgeType",
    input("text", data.cartridgeType),
  );

  const capacity = field(
    settings,
    "capacity",
    input("number", data.capacity ?? 1),
  );

  const streamlinedAttacks = weapon
    ? field(
        settings,
        "streamlinedAttacks",
        input("checkbox", data.streamlinedAttacks),
      )
    : null;

  const roundsPerAttack = weapon
    ? field(
        settings,
        "roundsPerAttack",
        input("number", data.roundsPerAttack ?? 1),
      )
    : null;

  const refreshFields = () => {
    settings.hidden = !enabled.checked;
    const internal = weapon && reloadType.value === "internal";
    magazineType.closest(".form-group").hidden = weapon
      ? internal
      : role.value === "rounds";
    cartridgeType.closest(".form-group").hidden = weapon && !internal;
    capacity.closest(".form-group").hidden = weapon
      ? !internal
      : role.value !== "magazine";
    if (roundsPerAttack) {
      roundsPerAttack.closest(".form-group").hidden =
        !streamlinedAttacks.checked;
    }
  };

  enabled.addEventListener("change", refreshFields);
  role?.addEventListener("change", refreshFields);
  reloadType?.addEventListener("change", refreshFields);
  streamlinedAttacks?.addEventListener("change", refreshFields);

  refreshFields();
  configuration.append(settings);

  button(configuration, "save", async () => {
    await request(item, "configure", {
      config: {
        enabled: enabled.checked,
        role: role?.value,
        ...(!weapon || reloadType.value === "detachable"
          ? { magazineType: magazineType.value.trim().toLowerCase() }
          : {}),
        ...(!weapon || reloadType.value === "internal"
          ? {
              cartridgeType: cartridgeType.value.trim().toLowerCase(),
              capacity: Number(capacity.value),
            }
          : {}),
        ...(weapon ? { reloadType: reloadType.value } : {}),
        ...(weapon
          ? {
              streamlinedAttacks: streamlinedAttacks.checked,
              roundsPerAttack: Number(roundsPerAttack.value),
            }
          : {}),
      },
    });
    application.render({ force: true });
  });
  section.append(configuration);

  const actor = item.parent?.documentName === "Actor" ? item.parent : null;
  if (data.enabled && actor) {
    const actions = element("div");

    const run = async (operation, payload) => {
      await request(item, operation, payload);
      application.render({ force: true });
    };

    if (weapon && !isInternalWeapon(item)) {
      renderWeaponActions(actions, item, actor, run);
    } else if (isInternalWeapon(item) || data.role === "magazine") {
      renderRoundActions(actions, item, actor, run);
    }

    section.append(actions);
  }

  if (!application.isEditable) {
    for (const control of section.querySelectorAll("input, select, button")) {
      control.disabled = true;
    }
  }

  host.append(section);
}

function renderWeaponActions(parent, weapon, actor, run) {
  const data = ammoData(weapon);
  const magazine = actor.items.get(data.magazineId);

  parent.append(
    element(
      "p",
      "",
      magazine
        ? text("loaded", {
            magazine: magazine.name,
            count: ammoData(magazine).roundCount,
            capacity: ammoData(magazine).capacity,
          })
        : text("noInserted"),
    ),
  );

  const options = availableMagazines(actor, weapon).map((item) => [
    item.id,
    `${item.name} (${ammoData(item).roundCount}/${ammoData(item).capacity})`,
  ]);

  const magazines = field(parent, "magazine", select(options));
  const actions = element("div", "form-fields");

  button(actions, "insert", () =>
    run("insert", { sourceId: magazines.value }),
  ).disabled = !options.length;
  button(actions, "reload", () => run("reload"));
  button(actions, "eject", () => run("eject")).disabled = !data.magazineId;

  parent.append(actions);
}

function renderRoundActions(parent, container, actor, run) {
  const data = ammoData(container);

  parent.append(
    element(
      "p",
      "",
      text("magazineCount", {
        count: data.roundCount,
        capacity: data.capacity,
      }),
    ),
  );

  if (data.insertedIn) {
    parent.append(
      element(
        "p",
        "",
        text("insertedIn", {
          weapon: actor.items.get(data.insertedIn)?.name ?? "?",
        }),
      ),
    );
  }

  const stacks = availableRounds(actor, container);
  const source = field(
    parent,
    "rounds",
    select(
      stacks.map((item) => [item.id, `${item.name} (${item.system.quantity})`]),
    ),
  );

  const amount = field(parent, "amount", input("number", 1));
  const actions = element("div", "form-fields");

  button(actions, "load", () =>
    run("load", { sourceId: source.value, count: Number(amount.value) }),
  ).disabled = !stacks.length || data.roundCount >= data.capacity;

  button(actions, "fill", () =>
    run("load", {
      sourceId: source.value,
      count: Math.min(
        data.capacity - data.roundCount,
        actor.items.get(source.value)?.system.quantity ?? 0,
      ),
    }),
  ).disabled = !stacks.length || data.roundCount >= data.capacity;

  button(actions, "unload", () =>
    run("unload", { count: Number(amount.value) }),
  ).disabled = !data.roundCount;

  parent.append(actions);
}

const actorListeners = new WeakMap();

export function wireActorAmmo(application, html, request) {
  actorListeners.get(html)?.abort();
  const listeners = new AbortController();
  actorListeners.set(html, listeners);

  for (const control of html.querySelectorAll(".reload-weapon")) {
    const uuid = control.closest(".item")?.dataset.itemUuid;
    const weapon = application.document.items.find(
      (item) => item.uuid === uuid,
    );

    if (isWeapon(weapon)) {
      control.dataset.tooltip = text(
        isInternalWeapon(weapon) ? "internalReloadTooltip" : "reloadTooltip",
      );
      control.removeAttribute("title");
    }
  }

  const handler = (event) => {
    const control = event.target.closest?.(".reload-weapon");
    if (!control) {
      return;
    }

    const uuid = control.closest(".item")?.dataset.itemUuid;
    const weapon = application.document.items.find(
      (item) => item.uuid === uuid,
    );

    if (!isWeapon(weapon)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    request(weapon, event.type === "contextmenu" ? "eject" : "reload").catch(
      errorNotice,
    );
  };

  html.addEventListener("click", handler, {
    capture: true,
    signal: listeners.signal,
  });

  html.addEventListener("contextmenu", handler, {
    capture: true,
    signal: listeners.signal,
  });
}
