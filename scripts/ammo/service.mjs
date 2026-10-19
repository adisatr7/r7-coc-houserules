import {
  AMMO_PATH,
  MODULE_ID,
  AmmoError,
  ammoData,
  availableMagazines,
  availableRounds,
  compatible,
  getPath,
  integer,
  isInternalWeapon,
  isRole,
  isWeapon,
  linkedMagazine,
  requireAmmo,
  roundTemplate,
  typeKey,
  weaponContainer,
} from "./model.mjs";

const INTERNAL = { r7Ammo: true };
const flagUpdate = (item, data) => ({
  _id: item.id,
  ...Object.fromEntries(
    Object.entries(data).map(([key, value]) => [`${AMMO_PATH}.${key}`, value]),
  ),
});

/**
 * Executes ammo requests in per-Actor queues, checking authority and permissions
 * before each request. The caller supplies the authority check via isAuthority
 */
export class AmmoService {
  constructor({
    notify = () => {},
    warn = console.warn,
    isAuthority = () => true,
  } = {}) {
    Object.assign(this, { notify, warn, isAuthority });
    this._queues = new Map();
  }

  execute(actor, request, user) {
    const previous = this._queues.get(actor.uuid) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        requireAmmo(this.isAuthority(), "noGM");
        requireAmmo(
          user?.active &&
            (user.isGM || actor.testUserPermission(user, "OWNER")),
          "permission",
        );
        requireAmmo(!actor.getFlag(MODULE_ID, "ammoBlocked"), "blocked");
        const item = actor.items.get(request.itemId);
        requireAmmo(!!item, "missingItem");
        switch (request.operation) {
          case "configure":
            return this._configure(actor, item, request.config);
          case "load":
            return this._load(
              actor,
              item,
              actor.items.get(request.sourceId),
              request.count,
            );
          case "unload":
            return this._unload(actor, item, request.count);
          case "insert":
            return this._insert(actor, item, actor.items.get(request.sourceId));
          case "eject":
            return this._eject(actor, item);
          case "reload":
            return this._reload(actor, item, request.onlyEmpty === true);
          case "consume":
            return this._consume(actor, item, request.count);
          case "attack":
            return this._attack(actor, item);
          case "finish":
            return this._finish(actor, item);
          default:
            throw new AmmoError("invalidOperation");
        }
      });
    this._queues.set(actor.uuid, operation);
    operation
      .finally(() => {
        if (this._queues.get(actor.uuid) === operation) {
          this._queues.delete(actor.uuid);
        }
      })
      .catch(() => {});
    return operation;
  }

  /**
   * Applies and verifies Item updates. On failure, restores the touched fields and
   * throws. If restoration fails, blocks further ammo operations for the Actor
   */
  async _commit(actor, updates) {
    requireAmmo(this.isAuthority(), "noGM");

    // A batch can fail partway through, so retain each field's previous value
    const before = updates.map((update) => {
      const item = actor.items.get(update._id);
      requireAmmo(!!item, "missingItem");
      return Object.fromEntries(
        Object.keys(update).map((path) => [
          path,
          path === "_id"
            ? item.id
            : structuredClone(getPath(item, path) ?? null),
        ]),
      );
    });

    try {
      await actor.updateEmbeddedDocuments("Item", updates, INTERNAL);
      for (const update of updates) {
        const item = actor.items.get(update._id);
        requireAmmo(
          !!item &&
            Object.entries(update).every(
              ([path, value]) =>
                path === "_id" ||
                JSON.stringify(getPath(item, path)) === JSON.stringify(value),
            ),
          "writeFailed",
        );
      }
    } catch (error) {
      try {
        await actor.updateEmbeddedDocuments("Item", before, INTERNAL);
        for (const snapshot of before) {
          const item = actor.items.get(snapshot._id);
          requireAmmo(
            !!item &&
              Object.entries(snapshot).every(
                ([path, value]) =>
                  path === "_id" ||
                  JSON.stringify(getPath(item, path) ?? null) ===
                    JSON.stringify(value),
              ),
            "writeFailed",
          );
        }
      } catch (rollbackError) {
        await actor.setFlag(MODULE_ID, "ammoBlocked", true);
        this.warn(
          `${MODULE_ID} | R7 Ammo rollback failed`,
          error,
          rollbackError,
        );
        throw new AmmoError("blocked");
      }
      throw new AmmoError("writeFailed");
    }
  }

  async _deleteZeroStack(actor, stack) {
    if (stack.system.quantity !== 0) {
      return;
    }

    try {
      await actor.deleteEmbeddedDocuments("Item", [stack.id], INTERNAL);
    } catch (error) {
      // Cleanup failure must not undo the committed round counts
      this.warn(
        `${MODULE_ID} | Zero-quantity ammunition cleanup failed`,
        error,
      );
      this.notify(actor, "cleanupFailed", {});
    }
  }

  async _configure(actor, item, config) {
    requireAmmo(["weapon", "item"].includes(item.type), "invalidRole");
    requireAmmo(
      config && typeof config.enabled === "boolean",
      "invalidConfiguration",
    );

    const old = ammoData(item);

    requireAmmo(!old.magazineId && !old.insertedIn, "ejectFirst");
    requireAmmo(
      !(
        (isRole(item, "magazine") || isInternalWeapon(item)) &&
        old.roundCount > 0
      ),
      "unloadFirst",
    );

    const next = { enabled: config.enabled };

    if (config.enabled) {
      if (item.type === "weapon") {
        requireAmmo(item.system.properties.rngd === true, "rangedOnly");
        requireAmmo(item.system.ammo === 0, "emptyNativeFirst");
        const reloadType = config.reloadType ?? "detachable";
        requireAmmo(
          ["detachable", "internal"].includes(reloadType),
          "invalidConfiguration",
        );

        Object.assign(next, {
          reloadType,
          magazineId: "",
          pendingReload: false,
          magazineType:
            reloadType === "detachable" ? typeKey(config.magazineType) : null,
          streamlinedAttacks: config.streamlinedAttacks === true,
          roundsPerAttack: integer(config.roundsPerAttack ?? 1, 1),
          nativeCapacity:
            old.enabled && old.nativeCapacity !== undefined
              ? old.nativeCapacity
              : item.system.bullets,
        });

        if (reloadType === "internal") {
          Object.assign(next, {
            cartridgeType: typeKey(config.cartridgeType),
            capacity: integer(config.capacity, 1),
            roundCount: 0,
            roundTemplate: null,
          });
        } else if (isInternalWeapon(item)) {
          Object.assign(next, {
            cartridgeType: null,
            capacity: null,
            roundCount: 0,
            roundTemplate: null,
          });
        }
      } else {
        requireAmmo(
          item.type === "item" && ["magazine", "rounds"].includes(config.role),
          "invalidRole",
        );
        next.cartridgeType = typeKey(config.cartridgeType);
        next.role = config.role;

        if (next.role === "magazine") {
          requireAmmo(item.system.quantity === 1, "singleMagazine");
          Object.assign(next, {
            magazineType: typeKey(config.magazineType),
            capacity: integer(config.capacity, 1),
            roundCount: 0,
            insertedIn: "",
            roundTemplate: null,
          });
        } else {
          integer(item.system.quantity);
        }
      }
    }
    const update = flagUpdate(item, next);
    if (
      config.enabled &&
      item.type === "weapon" &&
      (next.reloadType === "internal" || isInternalWeapon(item))
    ) {
      update["system.bullets"] =
        next.reloadType === "internal" ? next.capacity : next.nativeCapacity;
    }

    if (
      !config.enabled &&
      old.enabled &&
      item.type === "weapon" &&
      old.nativeCapacity !== undefined
    ) {
      update["system.bullets"] = old.nativeCapacity;
    }

    await this._commit(actor, [update]);

    return true;
  }

  _validateMagazine(actor, magazine) {
    requireAmmo(
      isRole(magazine, "magazine") && magazine.system.quantity === 1,
      "invalidMagazine",
    );

    const data = ammoData(magazine);
    integer(data.capacity, 1);
    integer(data.roundCount);
    requireAmmo(data.roundCount <= data.capacity, "invalidMagazine");

    const users = actor.items.filter(
      (item) => isWeapon(item) && ammoData(item).magazineId === magazine.id,
    );

    if (data.insertedIn) {
      const weapon = actor.items.get(data.insertedIn);
      requireAmmo(users.length === 1 && users[0] === weapon, "brokenLink");
      linkedMagazine(actor, weapon);
      return weapon;
    }

    requireAmmo(users.length === 0, "brokenLink");
    return null;
  }

  _validateContainer(actor, container) {
    if (isInternalWeapon(container)) {
      weaponContainer(actor, container);
      return container;
    }

    return this._validateMagazine(actor, container);
  }

  _roundUpdates(container, weapon, count, extra = {}) {
    const updates = [flagUpdate(container, { roundCount: count, ...extra })];

    if (weapon === container) {
      Object.assign(updates[0], flagUpdate(weapon, { pendingReload: false }), {
        "system.ammo": count,
      });
      return updates;
    }

    if (weapon) {
      updates.push({
        ...flagUpdate(weapon, { pendingReload: false }),
        "system.ammo": count,
      });
    }

    return updates;
  }

  async _load(actor, container, rounds, count) {
    return this._loadRounds(actor, container, [{ rounds, count }]);
  }

  async _loadRounds(actor, container, transfers) {
    const weapon = this._validateContainer(actor, container);
    const data = ammoData(container);

    let total = 0;
    const sources = new Set();

    for (const { rounds, count } of transfers) {
      integer(count, 1);
      requireAmmo(
        isRole(rounds, "rounds") &&
          ammoData(rounds).cartridgeType === data.cartridgeType,
        "incompatibleRounds",
      );
      requireAmmo(!sources.has(rounds.id), "invalidOperation");
      sources.add(rounds.id);
      integer(rounds.system.quantity);
      requireAmmo(count <= rounds.system.quantity, "notEnoughSpaceOrRounds");
      total = integer(total + count, 1);
    }

    requireAmmo(
      total > 0 && data.roundCount + total <= data.capacity,
      "notEnoughSpaceOrRounds",
    );

    const updates = this._roundUpdates(
      container,
      weapon,
      data.roundCount + total,
      {
        roundTemplate: data.roundCount
          ? data.roundTemplate
          : roundTemplate(transfers[0].rounds),
      },
    );

    for (const { rounds, count } of transfers) {
      updates.push({
        _id: rounds.id,
        "system.quantity": rounds.system.quantity - count,
      });
    }

    await this._commit(actor, updates);

    for (const { rounds } of transfers) {
      await this._deleteZeroStack(actor, rounds);
    }

    return true;
  }

  async _unload(actor, container, count) {
    const weapon = this._validateContainer(actor, container);
    const data = ammoData(container);

    integer(count, 1);
    requireAmmo(count <= data.roundCount, "notEnoughRounds");

    let stack = actor.items.find(
      (item) =>
        isRole(item, "rounds") &&
        ammoData(item).cartridgeType === data.cartridgeType,
    );

    let created = false;

    if (!stack) {
      requireAmmo(data.roundTemplate?.type === "item", "missingTemplate");
      [stack] = await actor.createEmbeddedDocuments(
        "Item",
        [structuredClone(data.roundTemplate)],
        INTERNAL,
      );
      requireAmmo(!!stack && stack.system.quantity === 0, "writeFailed");
      created = true;
    }

    integer(stack.system.quantity);
    const updates = this._roundUpdates(
      container,
      weapon,
      data.roundCount - count,
    );
    updates.push({
      _id: stack.id,
      "system.quantity": integer(stack.system.quantity + count),
    });

    try {
      await this._commit(actor, updates);
    } catch (error) {
      if (created && stack.system.quantity === 0) {
        await this._deleteZeroStack(actor, stack);
      }
      throw error;
    }

    return true;
  }

  async _insert(actor, weapon, magazine) {
    requireAmmo(
      isWeapon(weapon) && compatible(weapon, magazine),
      "incompatibleMagazine",
    );
    linkedMagazine(actor, weapon);
    requireAmmo(!this._validateMagazine(actor, magazine), "alreadyInserted");
    const previous = actor.items.get(ammoData(weapon).magazineId);
    const data = ammoData(magazine);
    const updates = [
      {
        ...flagUpdate(weapon, {
          magazineId: magazine.id,
          pendingReload: false,
        }),
        "system.ammo": data.roundCount,
        "system.bullets": data.capacity,
      },
      flagUpdate(magazine, { insertedIn: weapon.id }),
    ];
    if (previous) {
      updates.push(flagUpdate(previous, { insertedIn: "" }));
    }
    await this._commit(actor, updates);
    return {
      magazine: magazine.name,
      count: data.roundCount,
      capacity: data.capacity,
    };
  }

  async _eject(actor, weapon) {
    requireAmmo(isWeapon(weapon), "notManaged");
    if (isInternalWeapon(weapon)) {
      weaponContainer(actor, weapon);
      const count = ammoData(weapon).roundCount;
      return count ? this._unload(actor, weapon, count) : true;
    }

    const magazine = linkedMagazine(actor, weapon);
    const updates = [
      {
        ...flagUpdate(weapon, { magazineId: "", pendingReload: false }),
        "system.ammo": 0,
      },
    ];

    if (magazine) {
      updates.push(flagUpdate(magazine, { insertedIn: "" }));
    }

    await this._commit(actor, updates);
    return true;
  }

  async _reload(actor, weapon, onlyEmpty = false) {
    requireAmmo(isWeapon(weapon), "notManaged");
    const container = weaponContainer(actor, weapon);

    if (onlyEmpty && weapon.system.ammo !== 0) {
      return false;
    }

    if (isInternalWeapon(weapon)) {
      return this._reloadInternal(actor, container);
    }

    const next = availableMagazines(actor, weapon)[0];
    if (!next) {
      this.notify(actor, "noMagazine", { weapon: weapon.name });
      return false;
    }

    const result = await this._insert(actor, weapon, next);
    this.notify(actor, "reloaded", { weapon: weapon.name, ...result });

    return true;
  }

  async _reloadInternal(actor, weapon) {
    const data = ammoData(weapon);

    let space = data.capacity - data.roundCount;
    if (space === 0) {
      return false;
    }

    const transfers = [];

    for (const rounds of availableRounds(actor, weapon)) {
      const count = Math.min(space, rounds.system.quantity);
      transfers.push({ rounds, count });
      space -= count;

      if (space === 0) {
        break;
      }
    }

    if (!transfers.length) {
      this.notify(actor, "noRounds", { weapon: weapon.name });
      return false;
    }

    await this._loadRounds(actor, weapon, transfers);
    this.notify(actor, "reloadedInternal", {
      weapon: weapon.name,
      count: ammoData(weapon).roundCount,
      capacity: data.capacity,
    });

    return true;
  }

  async _consume(actor, weapon, count) {
    requireAmmo(isWeapon(weapon), "notManaged");
    integer(count);

    if (count === 0) {
      return true;
    }

    const container = weaponContainer(actor, weapon);
    requireAmmo(!!container, "noInsertedMagazine");
    const data = ammoData(container);
    requireAmmo(count <= data.roundCount, "notEnoughRounds");

    const remaining = data.roundCount - count;
    const updates = this._roundUpdates(container, weapon, remaining);
    const weaponUpdate = updates.find((update) => update._id === weapon.id);

    weaponUpdate[`${AMMO_PATH}.pendingReload`] =
      remaining === 0 && ammoData(weapon).streamlinedAttacks !== true;

    await this._commit(actor, updates);

    return true;
  }

  async _attack(actor, weapon) {
    requireAmmo(
      isWeapon(weapon) && ammoData(weapon).streamlinedAttacks === true,
      "invalidOperation",
    );

    const cost = integer(ammoData(weapon).roundsPerAttack ?? 1, 1);
    const container = weaponContainer(actor, weapon);

    requireAmmo(!!container, "noInsertedMagazine");
    const remaining = ammoData(container).roundCount;
    requireAmmo(remaining > 0, "notEnoughRounds");

    return this._consume(actor, weapon, Math.min(cost, remaining));
  }

  async _finish(actor, weapon) {
    if (
      !isWeapon(weapon) ||
      ammoData(weapon).streamlinedAttacks === true ||
      !ammoData(weapon).pendingReload ||
      weapon.system.ammo !== 0
    ) {
      return false;
    }
    weaponContainer(actor, weapon);
    await this._commit(actor, [flagUpdate(weapon, { pendingReload: false })]);

    return this._reload(actor, weapon);
  }
}
