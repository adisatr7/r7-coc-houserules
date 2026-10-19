import {
  AMMO_PATH,
  MODULE_ID,
  AmmoError,
  ammoData,
  getPath,
  isRole,
  isWeapon,
} from "./model.mjs";
import { AmmoService } from "./service.mjs";
import { renderAmmoItem, wireActorAmmo } from "./ui.mjs";
import { StreamlinedAttacks, installAttackAdapter } from "./attacks.mjs";

const CHANNEL = `module.${MODULE_ID}`;
const WRAPPED = Symbol.for(`${MODULE_ID}.ammo`);
const REQUESTS = new Set([
  "configure",
  "load",
  "unload",
  "insert",
  "eject",
  "reload",
  "consume",
  "attack",
  "finish",
]);

export function reportAmmoError(error) {
  const key = `${MODULE_ID}.ammo.errors.${error.code ?? "unexpected"}`;
  ui.notifications.error(game.i18n.localize(key));
  console.error(`${MODULE_ID} | R7 Ammo`, error);
}

/**
 * Routes opted-in weapon ammo operations through request; other weapons keep
 * CoC7's native methods. Validates the model before installing any wrappers
 */
export function installWeaponAdapter(prototype, request, checkAmmoSetting) {
  const operations = {
    shootAmmunition: (item, count) => {
      checkAmmoSetting();
      return request(item, "consume", { count });
    },
    reload: (item) => request(item, "reload"),
    addAmmunition: (item) => request(item, "reload"),
    setBullets: (item, count) => {
      if (count === 0) {
        return request(item, "eject");
      }
      throw new AmmoError("managedCounter");
    },
    reloadUpdates: () => {
      throw new AmmoError("managedCounter");
    },
    setBulletsUpdates: () => {
      throw new AmmoError("managedCounter");
    },
  };

  for (const name of Object.keys(operations)) {
    if (typeof prototype?.[name] !== "function") {
      throw new AmmoError("unsupportedSystem");
    }
  }

  for (const [name, managed] of Object.entries(operations)) {
    const native = prototype[name];
    if (native[WRAPPED]) {
      continue;
    }

    function wrapped(...args) {
      if (!isWeapon(this.parent)) {
        return native.apply(this, args);
      }

      return Promise.resolve()
        .then(() => managed(this.parent, ...args))
        .catch((error) => {
          reportAmmoError(error);
          throw error;
        });
    }

    Object.defineProperty(wrapped, WRAPPED, { value: true });
    prototype[name] = wrapped;
  }
}

/**
 * Returns whether an update affects a path, its descendants, or replaces
 * an ancestor. Accepts both nested objects and dotted update keys
 */
function touches(changes, target, prefix = "") {
  return Object.entries(changes).some(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (path === target || path.startsWith(`${target}.`)) {
      return true;
    }

    if (!target.startsWith(`${path}.`)) {
      return false;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      return touches(value, target, path);
    }

    return true;
  });
}

export function protectAmmoUpdate(item, changes, options = {}) {
  if (options.r7Ammo) {
    return;
  }
  const protectedPaths = [AMMO_PATH];

  if (isWeapon(item)) {
    protectedPaths.push("system.ammo", "system.bullets");
  }

  if (
    (isRole(item, "magazine") || isRole(item, "rounds")) &&
    touches(changes, "system.quantity")
  ) {
    const value = getPath(changes, "system.quantity");
    const quantity = Number(value);

    if (
      !["number", "string"].includes(typeof value) ||
      (typeof value === "string" && !value.trim()) ||
      !Number.isSafeInteger(quantity) ||
      quantity < 0
    ) {
      reportAmmoError(new AmmoError("invalidCount"));

      return false;
    }

    if (isRole(item, "magazine") && quantity !== 1) {
      reportAmmoError(new AmmoError("singleMagazine"));

      return false;
    }
  }

  if (
    protectedPaths.some((path) => {
      if (!touches(changes, path)) {
        return false;
      }
      const value = getPath(changes, path);
      const current = getPath(item, path);

      if (
        typeof current === "number" &&
        value !== null &&
        value !== "" &&
        value !== undefined
      ) {
        return Number(value) !== current;
      }
      return (
        value === undefined || JSON.stringify(value) !== JSON.stringify(current)
      );
    })
  ) {
    reportAmmoError(new AmmoError("managedCounter"));

    return false;
  }
}

export function protectAmmoDelete(item, options = {}) {
  if (options.r7Ammo) {
    return;
  }

  const data = ammoData(item);

  if (data.enabled && (data.magazineId || data.insertedIn)) {
    reportAmmoError(new AmmoError("ejectFirst"));
    return false;
  }
}

export function completedAttack(message, changes = null) {
  const data = message.getFlag("CoC7", "load");
  if (data?.as !== "CoC7ChatCombatRanged" || data.weaponRolled !== true) {
    return null;
  }

  if (changes && getPath(changes, "flags.CoC7.load.weaponRolled") !== true) {
    return null;
  }

  return data.itemUuid;
}

function templateContainer(item) {
  // Reuse the Actor operation queue for world-directory Item configuration
  return {
    uuid: item.uuid,
    items: new Map([[item.id, item]]),
    getFlag: (...args) => item.getFlag(...args),
    setFlag: (...args) => item.setFlag(...args),
    testUserPermission: (...args) => item.testUserPermission(...args),
    updateEmbeddedDocuments: async (_type, updates, options) => {
      for (const update of updates) {
        const { _id, ...data } = update;
        await item.update(data, options);
      }
    },
  };
}

export class AmmoRuntime {
  constructor() {
    this._pending = new Map();
    this._received = new Map();
    this._onSocket = (message) => this._receive(message).catch(reportAmmoError);
    this.service = new AmmoService({
      notify: (actor, key, data) => this._notify(actor, key, data),
      isAuthority: () => game.users.activeGM?.id === game.user.id,
    });
  }

  start() {
    game.socket.on(CHANNEL, this._onSocket);
  }

  stop() {
    game.socket.off(CHANNEL, this._onSocket);
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new AmmoError("disconnected"));
    }
    this._pending.clear();
  }

  async request(item, operation, data = {}) {
    const gm = game.users.activeGM;
    if (!gm) {
      throw new AmmoError("noGM");
    }

    const actor = item.parent?.documentName === "Actor" ? item.parent : null;
    if (!actor && operation !== "configure") {
      throw new AmmoError("inventoryOnly");
    }

    const request = {
      ...data,
      kind: "request",
      id: foundry.utils.randomID(),
      userId: game.user.id,
      gmId: gm.id,
      targetUuid: actor?.uuid ?? item.uuid,
      itemId: item.id,
      operation,
    };

    if (gm.id === game.user.id) {
      return this._execute(request);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(request.id);
        reject(new AmmoError("timeout"));
      }, 20000);
      this._pending.set(request.id, { resolve, reject, timer, gmId: gm.id });
      game.socket.emit(CHANNEL, request);
    });
  }

  async _execute(request) {
    const target = await fromUuid(request.targetUuid);
    if (!target || !REQUESTS.has(request.operation)) {
      throw new AmmoError("invalidOperation");
    }

    if (
      (["consume", "attack"].includes(request.operation) ||
        (request.operation === "configure" &&
          request.config?.enabled &&
          target.items?.get(request.itemId)?.type === "weapon")) &&
      game.settings.get("CoC7", "disregardAmmo")
    ) {
      throw new AmmoError("disregardAmmo");

    }
    let actor = target;
    if (target.documentName !== "Actor") {
      if (
        target.documentName !== "Item" ||
        target.parent ||
        request.operation !== "configure" ||
        target.id !== request.itemId
      ) {
        throw new AmmoError("inventoryOnly");
      }
      actor = templateContainer(target);
    }

    return this.service.execute(actor, request, game.users.get(request.userId));
  }

  async _receive(message) {
    if (!message || typeof message !== "object") {
      return;
    }

    if (
      message.kind === "notice" &&
      message.recipients?.includes(game.user.id)
    ) {
      ui.notifications.info(
        game.i18n.format(
          `${MODULE_ID}.ammo.notices.${message.key}`,
          message.data,
        ),
      );
      return;
    }

    if (message.kind === "response" && message.userId === game.user.id) {
      const pending = this._pending.get(message.id);
      if (!pending || pending.gmId !== message.gmId) {
        return;
      }
      clearTimeout(pending.timer);
      this._pending.delete(message.id);
      if (message.error) {
        pending.reject(new AmmoError(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (
      message.kind !== "request" ||
      message.gmId !== game.user.id ||
      game.users.activeGM?.id !== game.user.id ||
      typeof message.id !== "string"
    ) {
      return;
    }

    const cacheKey = `${message.userId}:${message.id}`;
    if (!this._received.has(cacheKey)) {
      const operation = this._execute(message)
        .then((result) => ({ result }))
        .catch((error) => ({ error: error.code ?? "unexpected" }));
      this._received.set(cacheKey, operation);
    }

    const response = await this._received.get(cacheKey);

    game.socket.emit(CHANNEL, {
      kind: "response",
      id: message.id,
      gmId: game.user.id,
      userId: message.userId,
      ...response,
    });

    if (this._received.size > 512) {
      this._received.delete(this._received.keys().next().value);
    }
  }

  _notify(actor, key, data) {
    const recipients = game.users
      .filter(
        (user) =>
          user.active && (user.isGM || actor.testUserPermission(user, "OWNER")),
      )
      .map((user) => user.id);

    const message = { kind: "notice", recipients, key, data };
    game.socket.emit(CHANNEL, message);
    this._receive(message).catch(reportAmmoError);
  }

  async finishAttack(message, changes) {
    if (game.users.activeGM?.id !== game.user.id) {
      return;
    }

    const uuid = completedAttack(message, changes);
    if (!uuid) {
      return;
    }

    const weapon = await fromUuid(uuid);
    if (!isWeapon(weapon) || weapon.parent?.documentName !== "Actor") {
      return;
    }

    await this.service.execute(
      weapon.parent,
      { operation: "finish", itemId: weapon.id },
      game.user,
    );
  }
}

export function startAmmo() {
  if (game.system.id !== "CoC7") {
    return;
  }

  const runtime = new AmmoRuntime();

  try {
    installWeaponAdapter(
      CONFIG.Item.dataModels.weapon?.prototype,
      (item, operation, data) => runtime.request(item, operation, data),
      () => {
        if (game.settings.get("CoC7", "disregardAmmo")) {
          throw new AmmoError("disregardAmmo");
        }
      },
    );
  } catch (error) {
    reportAmmoError(error);
    return;
  }
  runtime.start();

  const request = (item, operation, data) =>
    runtime.request(item, operation, data);

  const attacks = new StreamlinedAttacks(request);

  try {
    installAttackAdapter(
      CONFIG.Actor.documentClass?.prototype,
      (actor, weapon) => attacks.attack(actor, weapon),
      reportAmmoError,
    );
  } catch (error) {
    reportAmmoError(error);
  }

  Hooks.on("renderItemSheetV2", (application, html) =>
    renderAmmoItem(application, html, request),
  );

  Hooks.on("renderActorSheetV2", (application, html) =>
    wireActorAmmo(application, html, request),
  );

  Hooks.on("preUpdateItem", protectAmmoUpdate);

  Hooks.on("preDeleteItem", protectAmmoDelete);

  Hooks.on("preCreateItem", (item) => {
    const data = ammoData(item);
    if (data.enabled && (data.magazineId || data.insertedIn)) {
      reportAmmoError(new AmmoError("ejectFirst"));
      return false;
    }
  });

  Hooks.on("updateChatMessage", (message, changes) =>
    runtime.finishAttack(message, changes).catch(reportAmmoError),
  );

  Hooks.on("createChatMessage", (message) =>
    runtime.finishAttack(message).catch(reportAmmoError),
  );

  window.addEventListener("pagehide", () => runtime.stop(), { once: true });
}
