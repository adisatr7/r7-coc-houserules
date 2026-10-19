import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  MODULE_ID,
  ammoData,
  getPath,
  isInternalWeapon,
  isRole,
  isWeapon,
} from "../scripts/ammo/model.mjs";
import { AmmoService } from "../scripts/ammo/service.mjs";
import { StreamlinedAttacks } from "../scripts/ammo/attacks.mjs";
import {
  AmmoRuntime,
  completedAttack,
  installWeaponAdapter,
  protectAmmoDelete,
  protectAmmoUpdate,
} from "../scripts/ammo/integration.mjs";

class Items extends Map {
  filter(predicate) {
    return [...this.values()].filter(predicate);
  }
  find(predicate) {
    return [...this.values()].find(predicate);
  }
  some(predicate) {
    return [...this.values()].some(predicate);
  }
}

function setPath(object, path, value) {
  const keys = path.split(".");
  const leaf = keys.pop();
  let target = object;

  for (const key of keys) {
    target[key] ??= {};
    target = target[key];
  }

  // Match Foundry's flag merging, replacing objects would hide stale fields
  if (value && typeof value === "object" && !Array.isArray(value)) {
    target[leaf] ??= {};

    for (const [key, child] of Object.entries(value)) {
      setPath(target[leaf], key, child);
    }
  } else {
    target[leaf] = structuredClone(value);
  }
}

function fixture() {
  const notices = [];
  const warnings = [];

  const user = {
    id: "player",
    active: true,
    isGM: false,
  };

  const gm = {
    id: "gm",
    active: true,
    isGM: true,
  };

  let nextId = 0;
  const actor = {
    documentName: "Actor",
    uuid: "Actor.investigator",
    id: "investigator",
    items: new Items(),
    flags: {},
    writes: 0,
    failAfter: null,
    failRollback: false,
    failed: false,
    testUserPermission: (who, permission) =>
      who.id === "player" && permission === "OWNER",
    getFlag(scope, key) {
      return getPath(this.flags[scope] ?? {}, key);
    },
    async setFlag(scope, key, value) {
      setPath(this.flags, `${scope}.${key}`, value);
    },
    async updateEmbeddedDocuments(type, updates, options) {
      assert.equal(type, "Item");
      assert.equal(options.r7Ammo, true);

      this.writes++;

      if (this.failed && this.failRollback) {
        throw new Error("Simulated rollback failure");
      }

      for (const [index, update] of updates.entries()) {
        if (index === this.failAfter) {
          this.failAfter = null;
          this.failed = true;
          throw new Error("Simulated partial batch failure");
        }
        const item = this.items.get(update._id);

        for (const [path, value] of Object.entries(update)) {
          if (path !== "_id") {
            setPath(item, path, value);
          }
        }
      }

      return updates.map((update) => this.items.get(update._id));
    },

    async createEmbeddedDocuments(type, documents) {
      assert.equal(type, "Item");
      return documents.map((data) =>
        add({ ...structuredClone(data), id: `recovered-${++nextId}` }),
      );
    },

    async deleteEmbeddedDocuments(type, ids) {
      assert.equal(type, "Item");
      if (this.failDelete) {
        throw new Error("Simulated deletion failure");
      }
      for (const id of ids) {
        this.items.delete(id);
      }
    },
  };

  function add(data) {
    const item = {
      documentName: "Item",
      name: data.id,
      img: "icons/svg/item-bag.svg",
      flags: {},
      ...data,
      parent: actor,
      getFlag(scope, key) {
        return getPath(this.flags[scope] ?? {}, key);
      },
    };
    item.uuid = `${actor.uuid}.Item.${item.id}`;
    actor.items.set(item.id, item);
    return item;
  }

  function weapon(id = "weapon", enabled = true) {
    return add({
      id,
      type: "weapon",
      system: { ammo: 0, bullets: 8, properties: { rngd: true } },
      flags: {
        [MODULE_ID]: {
          ammo: { enabled, magazineType: "pistol-8", magazineId: "" },
        },
      },
    });
  }

  function magazine(id = "magazine", capacity = 8) {
    return add({
      id,
      type: "item",
      system: { quantity: 1 },
      flags: {
        [MODULE_ID]: {
          ammo: {
            enabled: true,
            role: "magazine",
            magazineType: "pistol-8",
            cartridgeType: "9x19",
            capacity,
            roundCount: 0,
            insertedIn: "",
            roundTemplate: null,
          },
        },
      },
    });
  }

  function rounds(id = "rounds", quantity = 20) {
    return add({
      id,
      type: "item",
      name: "9mm ammunition",
      system: {
        quantity,
        weight: 0.01,
        description: { value: "Campaign ammunition", keeper: "" },
      },
      flags: {
        [MODULE_ID]: {
          ammo: { enabled: true, role: "rounds", cartridgeType: "9x19" },
        },
      },
    });
  }

  const service = new AmmoService({
    notify: (_actor, key, data) => notices.push({ key, data }),
    warn: (...args) => warnings.push(args),
  });

  const run = (item, operation, data = {}, who = user) =>
    service.execute(actor, { operation, itemId: item.id, ...data }, who);

  const internalWeapon = async (
    id = "rifle",
    capacity = 5,
    streamlinedAttacks = true,
  ) => {
    const item = weapon(id, false);
    await run(item, "configure", {
      config: {
        enabled: true,
        reloadType: "internal",
        cartridgeType: "9x19",
        capacity,
        streamlinedAttacks,
        roundsPerAttack: 3,
      },
    });
    return item;
  };

  const total = () =>
    actor.items
      .filter((item) => isRole(item, "rounds"))
      .reduce((sum, item) => sum + item.system.quantity, 0) +
    actor.items
      .filter((item) => isRole(item, "magazine") || isInternalWeapon(item))
      .reduce((sum, item) => sum + ammoData(item).roundCount, 0);

  return {
    actor,
    user,
    gm,
    service,
    add,
    weapon,
    internalWeapon,
    magazine,
    rounds,
    run,
    notices,
    warnings,
    total,
  };
}

const rejects = (operation, code) =>
  assert.rejects(operation, (error) => error.code === code);

test("internal weapon loads, tops up without replacing rounds, fires and recovers ammunition through shared transfers", async () => {
  const context = fixture();
  const weapon = await context.internalWeapon();
  const rounds = context.rounds();
  assert.equal(weapon.system.bullets, 5);

  await context.run(weapon, "load", { sourceId: rounds.id, count: 2 });
  assert.equal(weapon.system.ammo, 2);
  assert.equal(ammoData(weapon).roundCount, 2);

  await context.run(weapon, "reload");
  assert.equal(weapon.system.ammo, 5);
  assert.equal(rounds.system.quantity, 15);
  assert.equal(
    context.actor.items.size,
    2,
    "no separate magazine item is created",
  );

  await context.run(weapon, "attack");
  assert.equal(weapon.system.ammo, 2);

  await context.run(weapon, "unload", { count: 1 });
  assert.equal(weapon.system.ammo, 1);
  assert.equal(rounds.system.quantity, 16);

  await context.run(weapon, "eject");
  assert.equal(weapon.system.ammo, 0);
  assert.equal(ammoData(weapon).roundCount, 0);
  assert.equal(rounds.system.quantity, 17);
  assert.equal(context.total(), 17);
});

test("internal reload fills from multiple compatible stacks in one batch and never exceeds capacity", async () => {
  const context = fixture();
  const weapon = await context.internalWeapon();

  const first = context.rounds("a", 1);
  const second = context.rounds("b", 2);
  const third = context.rounds("c", 10);

  const writes = context.actor.writes;
  await context.run(weapon, "reload");

  assert.equal(context.actor.writes, writes + 1);
  assert.equal(weapon.system.ammo, 5);
  assert.equal(ammoData(weapon).roundCount, 5);
  assert.equal(context.actor.items.has(first.id), false);
  assert.equal(context.actor.items.has(second.id), false);
  assert.equal(third.system.quantity, 8);
  assert.equal(context.total(), 13);
  assert.equal(await context.run(weapon, "reload"), false);
  assert.equal(third.system.quantity, 8);
  assert.equal(context.notices[0].key, "reloadedInternal");
});

test("internal reload rolls back all touched counters if a multi-stack write partially fails", async () => {
  const context = fixture();
  const weapon = await context.internalWeapon();

  const first = context.rounds("a", 2);
  const second = context.rounds("b", 3);

  context.actor.failAfter = 2;
  await rejects(context.run(weapon, "reload"), "writeFailed");

  assert.equal(weapon.system.ammo, 0);
  assert.equal(ammoData(weapon).roundCount, 0);
  assert.equal(first.system.quantity, 2);
  assert.equal(second.system.quantity, 3);
  assert.equal(context.total(), 5);
});

test("internal unloading recreates exhausted loose stock with its original metadata", async () => {
  const context = fixture();
  const weapon = await context.internalWeapon();

  const rounds = context.rounds("original", 5);
  await context.run(weapon, "reload");
  assert.equal(context.actor.items.has(rounds.id), false);

  await context.run(weapon, "unload", { count: 2 });
  const recovered = context.actor.items.find((item) => isRole(item, "rounds"));
  assert.equal(recovered.system.quantity, 2);
  assert.equal(recovered.name, "9mm ammunition");
  assert.equal(recovered.system.description.value, "Campaign ammunition");
  assert.equal(weapon.system.ammo, 3);
  assert.equal(context.total(), 5);
});

test("internal weapons reject wrong ammunition, detachable insertion and over-capacity loads", async () => {
  const context = fixture();
  const weapon = await context.internalWeapon();
  const wrong = context.rounds("wrong", 10);

  ammoData(wrong).cartridgeType = "wrong";

  await rejects(
    context.run(weapon, "load", { sourceId: wrong.id, count: 1 }),
    "incompatibleRounds",
  );

  await rejects(
    context.run(weapon, "insert", { sourceId: context.magazine().id }),
    "incompatibleMagazine",
  );

  assert.equal(await context.run(weapon, "reload"), false);
  assert.equal(context.notices.at(-1).key, "noRounds");

  const right = context.rounds("right", 10);
  await rejects(
    context.run(weapon, "load", { sourceId: right.id, count: 6 }),
    "notEnoughSpaceOrRounds",
  );

  assert.equal(weapon.system.ammo, 0);
  assert.equal(right.system.quantity, 10);
});

test("internal weapons require unloading before reconfiguration or disable and restore original native capacity", async () => {
  const context = fixture();
  const weapon = await context.internalWeapon();
  context.rounds();

  await context.run(weapon, "reload");

  await rejects(
    context.run(weapon, "configure", { config: { enabled: false } }),
    "unloadFirst",
  );
  await rejects(
    context.run(weapon, "configure", {
      config: {
        enabled: true,
        reloadType: "detachable",
        magazineType: "pistol-8",
      },
    }),
    "unloadFirst",
  );

  await context.run(weapon, "eject");
  await context.run(weapon, "configure", {
    config: {
      enabled: true,
      reloadType: "detachable",
      magazineType: "pistol-8",
    },
  });

  assert.equal(isInternalWeapon(weapon), false);
  assert.equal(weapon.system.bullets, 8);

  await context.run(weapon, "configure", { config: { enabled: false } });
  assert.equal(weapon.system.bullets, 8);
  assert.equal(weapon.system.ammo, 0);
});

test("internal streamlined final attacks consume only what remains, stay empty and permit only-empty reload once", async () => {
  const context = fixture();
  const weapon = await context.internalWeapon();
  context.rounds("rounds", 7);

  await context.run(weapon, "reload");
  await context.run(weapon, "attack");

  assert.equal(weapon.system.ammo, 2);
  assert.equal(await context.run(weapon, "reload", { onlyEmpty: true }), false);

  await context.run(weapon, "attack");
  assert.equal(weapon.system.ammo, 0);

  await context.run(weapon, "finish");
  assert.equal(weapon.system.ammo, 0);

  await rejects(context.run(weapon, "attack"), "notEnoughRounds");
  assert.equal(await context.run(weapon, "reload", { onlyEmpty: true }), true);
  assert.equal(weapon.system.ammo, 2);
  assert.equal(await context.run(weapon, "reload", { onlyEmpty: true }), false);

  await context.run(weapon, "attack");
  assert.equal(weapon.system.ammo, 0);
  assert.equal(context.total(), 0);
});

test("internal configuration validates its type/capacity and preserves a nullable native capacity on disable", async () => {
  const context = fixture();
  const weapon = context.weapon("rifle", false);
  weapon.system.bullets = null;

  const config = {
    enabled: true,
    reloadType: "internal",
    cartridgeType: "9x19",
    capacity: 5,
  };

  for (const capacity of [0, -1, 1.5, "5", NaN]) {
    await rejects(
      context.run(weapon, "configure", { config: { ...config, capacity } }),
      "invalidCount",
    );
  }

  await rejects(
    context.run(weapon, "configure", {
      config: { ...config, cartridgeType: "" },
    }),
    "invalidType",
  );

  await rejects(
    context.run(weapon, "configure", {
      config: { ...config, reloadType: "unknown" },
    }),
    "invalidConfiguration",
  );
  assert.equal(context.actor.writes, 0);

  await context.run(weapon, "configure", { config });
  assert.equal(ammoData(weapon).nativeCapacity, null);
  assert.equal(weapon.system.bullets, 5);

  await context.run(weapon, "configure", { config: { enabled: false } });
  assert.equal(weapon.system.bullets, null);
});

test("internal ammo mirror corruption fails closed and concurrent loads cannot exceed capacity", async () => {
  const context = fixture();
  const weapon = await context.internalWeapon();
  const rounds = context.rounds();
  weapon.system.ammo = 1;

  await rejects(
    context.run(weapon, "load", { sourceId: rounds.id, count: 1 }),
    "brokenLink",
  );
  assert.equal(rounds.system.quantity, 20);

  weapon.system.ammo = 0;
  const results = await Promise.allSettled([
    context.run(weapon, "load", { sourceId: rounds.id, count: 3 }),
    context.run(weapon, "load", { sourceId: rounds.id, count: 3 }),
  ]);

  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].reason.code, "notEnoughSpaceOrRounds");
  assert.equal(weapon.system.ammo, 3);
  assert.equal(rounds.system.quantity, 17);
  assert.equal(context.total(), 20);
});

test("native internal-magazine consumption stays strict and completion refills from loose rounds", async () => {
  const context = fixture();
  const weapon = await context.internalWeapon("rifle", 5, false);
  const rounds = context.rounds("stock", 10);
  await context.run(weapon, "reload");

  await rejects(
    context.run(weapon, "consume", { count: 6 }),
    "notEnoughRounds",
  );
  await context.run(weapon, "consume", { count: 5 });
  assert.equal(weapon.system.ammo, 0);
  assert.equal(rounds.system.quantity, 5);

  await context.run(weapon, "finish");
  assert.equal(weapon.system.ammo, 5);
  assert.equal(context.actor.items.has(rounds.id), false);
  assert.equal(context.total(), 5);
});

test("streamlined configuration persists its opt-in and positive whole-number attack cost", async () => {
  const context = fixture();
  const weapon = context.weapon();

  const config = {
    enabled: true,
    magazineType: "pistol-8",
    streamlinedAttacks: true,
    roundsPerAttack: 3,
  };

  await context.run(weapon, "configure", { config });
  assert.equal(ammoData(weapon).streamlinedAttacks, true);
  assert.equal(ammoData(weapon).roundsPerAttack, 3);

  for (const roundsPerAttack of [0, -1, 1.5, "3", NaN]) {
    await rejects(
      context.run(weapon, "configure", {
        config: { ...config, roundsPerAttack },
      }),
      "invalidCount",
    );

    assert.equal(ammoData(weapon).roundsPerAttack, 3);
  }
});

test("streamlined attacks use the stored cost, never split across magazines and stay empty after finishing", async () => {
  const context = fixture();
  const weapon = context.weapon();
  const current = context.magazine("current");
  const spare = context.magazine("spare");
  const rounds = context.rounds();

  await context.run(weapon, "configure", {
    config: {
      enabled: true,
      magazineType: "pistol-8",
      streamlinedAttacks: true,
      roundsPerAttack: 3,
    },
  });
  await context.run(current, "load", { sourceId: rounds.id, count: 6 });
  await context.run(spare, "load", { sourceId: rounds.id, count: 8 });
  await context.run(weapon, "insert", { sourceId: current.id });
  await context.run(weapon, "attack", { count: 1 });

  assert.equal(
    weapon.system.ammo,
    3,
    "client count must not override configured cost",
  );

  await context.run(weapon, "finish");
  assert.equal(ammoData(weapon).magazineId, current.id);

  await context.run(weapon, "attack");
  assert.equal(weapon.system.ammo, 0);
  assert.equal(ammoData(weapon).magazineId, current.id);

  await context.run(weapon, "finish");
  assert.equal(weapon.system.ammo, 0);
  assert.equal(ammoData(weapon).magazineId, current.id);
  assert.equal(ammoData(weapon).pendingReload, false);

  await context.run(weapon, "reload", { onlyEmpty: true });
  assert.equal(ammoData(weapon).magazineId, spare.id);
  assert.equal(weapon.system.ammo, 8);
  assert.equal(context.actor.items.has(current.id), true);

  await context.run(weapon, "attack");
  await context.run(weapon, "attack");
  assert.equal(weapon.system.ammo, 2);

  await context.run(weapon, "attack");
  assert.equal(weapon.system.ammo, 0);
  assert.equal(ammoData(spare).roundCount, 0);
  assert.equal(context.total(), 6);

  await rejects(context.run(weapon, "attack"), "notEnoughRounds");
  await context.run(weapon, "finish");
  assert.equal(weapon.system.ammo, 0);
});

test("a partial final attack spends only remaining rounds and concurrent attacks cannot fire empty", async () => {
  const context = fixture();
  const weapon = context.weapon();
  const current = context.magazine("current");
  const reserve = context.magazine("reserve");
  const rounds = context.rounds();
  await context.run(weapon, "configure", {
    config: {
      enabled: true,
      magazineType: "pistol-8",
      streamlinedAttacks: true,
      roundsPerAttack: 3,
    },
  });
  await context.run(current, "load", { sourceId: rounds.id, count: 1 });
  await context.run(reserve, "load", { sourceId: rounds.id, count: 8 });
  await context.run(weapon, "insert", { sourceId: current.id });
  const results = await Promise.allSettled([
    context.run(weapon, "attack"),
    context.run(weapon, "attack"),
  ]);

  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.code, "notEnoughRounds");
  assert.equal(weapon.system.ammo, 0);
  assert.equal(ammoData(current).roundCount, 0);
  assert.equal(
    ammoData(reserve).roundCount,
    8,
    "do not draw the shortfall from a reserve magazine",
  );
  assert.equal(context.total(), 19);

  await context.run(weapon, "finish");
  assert.equal(weapon.system.ammo, 0);

  await context.run(weapon, "reload", { onlyEmpty: true });
  assert.equal(ammoData(weapon).magazineId, reserve.id);
  assert.equal(weapon.system.ammo, 8);
  assert.equal(context.actor.items.has(current.id), true);
});

test("streamlined ammo charge is unavailable unless the weapon explicitly opts in", async () => {
  const context = fixture();
  await rejects(context.run(context.weapon(), "attack"), "invalidOperation");
});

test("GM only-empty reload rechecks the weapon so stale confirmations cannot swap a loaded magazine", async () => {
  const context = fixture();
  const weapon = context.weapon();

  const first = context.magazine("first");
  const second = context.magazine("second");

  const rounds = context.rounds();
  await context.run(first, "load", { sourceId: rounds.id, count: 8 });
  await context.run(second, "load", { sourceId: rounds.id, count: 8 });
  assert.equal(await context.run(weapon, "reload", { onlyEmpty: true }), true);

  const inserted = ammoData(weapon).magazineId;
  const writes = context.actor.writes;
  assert.equal(await context.run(weapon, "reload", { onlyEmpty: true }), false);
  assert.equal(ammoData(weapon).magazineId, inserted);
  assert.equal(weapon.system.ammo, 8);
  assert.equal(context.actor.writes, writes);
});

test("20 rounds -> load 8 -> fire 3 -> recover 5 conserves all 17 unspent rounds", async () => {
  const context = fixture();
  const weapon = context.weapon();
  const magazine = context.magazine();
  const rounds = context.rounds();

  await context.run(magazine, "load", { sourceId: rounds.id, count: 8 });
  await context.run(weapon, "insert", { sourceId: magazine.id });
  assert.equal(weapon.system.ammo, 8);

  await context.run(weapon, "consume", { count: 3 });
  assert.equal(ammoData(magazine).roundCount, 5);
  assert.equal(weapon.system.ammo, 5);

  await context.run(weapon, "eject");
  await context.run(magazine, "unload", { count: 5 });
  assert.equal(rounds.system.quantity, 17);
  assert.equal(ammoData(magazine).roundCount, 0);
  assert.equal(weapon.system.ammo, 0);
  assert.equal(ammoData(weapon).magazineId, "");
  assert.equal(context.total(), 17);
});

test("a depleted loose stack is deleted; ejected rounds recreate the original ammunition", async () => {
  const context = fixture();
  const magazine = context.magazine();

  const rounds = context.rounds("last-rounds", 8);
  await context.run(magazine, "load", { sourceId: rounds.id, count: 8 });
  assert.equal(context.actor.items.has(rounds.id), false);
  assert.equal(context.total(), 8);

  await context.run(magazine, "unload", { count: 8 });
  const recovered = context.actor.items.find((item) => isRole(item, "rounds"));
  assert.equal(recovered.name, rounds.name);
  assert.equal(recovered.system.quantity, 8);
  assert.equal(recovered.system.weight, rounds.system.weight);
  assert.equal(
    recovered.system.description.value,
    rounds.system.description.value,
  );
  assert.equal(ammoData(recovered).cartridgeType, "9x19");
  assert.equal(context.actor.items.has(magazine.id), true);
  assert.equal(context.total(), 8);
});

test("a magazine accepts individual round items without requiring them to be stacked first", async () => {
  const context = fixture();
  const magazine = context.magazine();

  for (const id of ["single-a", "single-b"]) {
    const round = context.rounds(id, 1);
    await context.run(magazine, "load", { sourceId: round.id, count: 1 });
    assert.equal(context.actor.items.has(id), false);
  }

  assert.equal(ammoData(magazine).roundCount, 2);
  assert.equal(context.total(), 2);
});

test("normal loose-round quantity increases allow combining stacks before magazine loading", async () => {
  const context = fixture();
  installGlobals(context);

  const magazine = context.magazine();
  const target = context.rounds("single-a", 1);
  const source = context.rounds("single-b", 1);

  const quantity = target.system.quantity + source.system.quantity;
  const changes = { system: { quantity } };
  assert.equal(protectAmmoUpdate(target, changes), undefined);

  setPath(target, "system.quantity", quantity);
  await context.actor.deleteEmbeddedDocuments("Item", [source.id]);
  assert.equal(context.total(), 2);

  await context.run(magazine, "load", { sourceId: target.id, count: 2 });
  assert.equal(ammoData(magazine).roundCount, 2);
  assert.equal(context.total(), 2);
});

test("magazines enforce cartridge compatibility; weapons enforce only magazine family", async () => {
  const context = fixture();
  const weapon = context.weapon();
  const magazine = context.magazine();
  const rounds = context.rounds();

  ammoData(rounds).cartridgeType = "45acp";

  await rejects(
    context.run(magazine, "load", { sourceId: rounds.id, count: 1 }),
    "incompatibleRounds",
  );

  await rejects(
    context.run(magazine, "load", { sourceId: "foreign", count: 1 }),
    "incompatibleRounds",
  );

  ammoData(magazine).magazineType = "other-pistol";

  await rejects(
    context.run(weapon, "insert", { sourceId: magazine.id }),
    "incompatibleMagazine",
  );
  assert.equal(context.actor.writes, 0);

  ammoData(magazine).magazineType = "pistol-8";
  ammoData(magazine).cartridgeType = "45acp";
  await context.run(magazine, "load", { sourceId: rounds.id, count: 1 });
  await context.run(weapon, "insert", { sourceId: magazine.id });

  assert.equal(weapon.system.ammo, 1);
  assert.equal(Object.hasOwn(ammoData(weapon), "cartridgeType"), false);
});

test("partial filling/ejecting works and overflowing/negative/fractional counts cannot write", async () => {
  const context = fixture();
  const magazine = context.magazine();
  const rounds = context.rounds();

  for (const count of [-1, 0, 0.5, NaN, Infinity, "2"]) {
    await rejects(
      context.run(magazine, "load", { sourceId: rounds.id, count }),
      "invalidCount",
    );
  }

  await rejects(
    context.run(magazine, "load", { sourceId: rounds.id, count: 9 }),
    "notEnoughSpaceOrRounds",
  );

  await context.run(magazine, "load", { sourceId: rounds.id, count: 3 });
  await context.run(magazine, "unload", { count: 1 });
  assert.equal(ammoData(magazine).roundCount, 2);
  assert.equal(rounds.system.quantity, 18);

  await rejects(
    context.run(magazine, "unload", { count: 3 }),
    "notEnoughRounds",
  );
  assert.equal(context.total(), 20);
});

test("one physical magazine cannot be inserted into two weapons", async () => {
  const context = fixture();

  const first = context.weapon("first");
  const second = context.weapon("second");

  const magazine = context.magazine();
  await context.run(first, "insert", { sourceId: magazine.id });

  await rejects(
    context.run(second, "insert", { sourceId: magazine.id }),
    "alreadyInserted",
  );
  assert.equal(ammoData(magazine).insertedIn, first.id);
  assert.equal(ammoData(second).magazineId, "");
});

test("manual reload preserves the partially loaded old magazine and chooses fullest available", async () => {
  const context = fixture();
  const weapon = context.weapon();

  const current = context.magazine("current");
  const reserve = context.magazine("reserve", 12);
  const partial = context.magazine("partial");
  const rounds = context.rounds("rounds", 30);

  for (const [magazine, count] of [
    [current, 5],
    [reserve, 10],
    [partial, 3],
  ]) {
    await context.run(magazine, "load", { sourceId: rounds.id, count });
  }

  await context.run(weapon, "insert", { sourceId: current.id });
  await context.run(weapon, "reload");

  assert.equal(ammoData(current).roundCount, 5);
  assert.equal(ammoData(current).insertedIn, "");
  assert.equal(ammoData(weapon).magazineId, reserve.id);
  assert.equal(weapon.system.ammo, 10);
  assert.equal(weapon.system.bullets, 12);
  assert.equal(context.total(), 30);
});

test("automatic reload waits until the whole multi-volley attack finishes; empty magazines survive", async () => {
  const context = fixture();
  const weapon = context.weapon();

  const current = context.magazine("current");
  const reserve = context.magazine("reserve");
  const rounds = context.rounds();

  await context.run(current, "load", { sourceId: rounds.id, count: 8 });
  await context.run(reserve, "load", { sourceId: rounds.id, count: 8 });
  await context.run(weapon, "insert", { sourceId: current.id });

  for (const count of [3, 3, 2]) {
    await context.run(weapon, "consume", { count });
    assert.equal(ammoData(weapon).magazineId, current.id);
  }

  assert.equal(context.notices.length, 0);
  assert.equal(weapon.system.ammo, 0);

  await context.run(weapon, "finish");
  assert.equal(ammoData(weapon).magazineId, reserve.id);
  assert.equal(weapon.system.ammo, 8);
  assert.equal(ammoData(current).roundCount, 0);
  assert.equal(ammoData(current).insertedIn, "");
  assert.equal(context.actor.items.has(current.id), true);
  assert.equal(context.notices[0].key, "reloaded");

  await context.run(weapon, "finish");
  assert.equal(context.notices.length, 1);
  assert.equal(context.total(), 12);
});

test("no reserve emits one warning; empty weapon cannot consume or manufacture rounds", async () => {
  const context = fixture();

  const weapon = context.weapon();
  const magazine = context.magazine();
  const rounds = context.rounds("rounds", 1);

  await context.run(magazine, "load", { sourceId: rounds.id, count: 1 });
  await context.run(weapon, "insert", { sourceId: magazine.id });
  await context.run(weapon, "consume", { count: 1 });
  await context.run(weapon, "finish");
  await context.run(weapon, "finish");

  assert.deepEqual(
    context.notices.map((notice) => notice.key),
    ["noMagazine"],
  );

  await rejects(
    context.run(weapon, "consume", { count: 1 }),
    "notEnoughRounds",
  );

  assert.equal(context.total(), 0);
});

test("concurrent loads and shots serialize; no stack/weapon can be overspent", async () => {
  const context = fixture();
  const first = context.magazine("first");
  const second = context.magazine("second");
  const rounds = context.rounds("rounds", 8);

  const loads = await Promise.allSettled([
    context.run(first, "load", { sourceId: rounds.id, count: 8 }),
    context.run(second, "load", { sourceId: rounds.id, count: 8 }),
  ]);

  assert.equal(
    loads.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const weapon = context.weapon();
  await context.run(weapon, "insert", { sourceId: first.id });

  const shots = await Promise.allSettled([
    context.run(weapon, "consume", { count: 5 }),
    context.run(weapon, "consume", { count: 5 }),
  ]);

  assert.equal(
    shots.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(context.total(), 3);
  assert.equal(weapon.system.ammo, 3);
});

test("failed partial writes restore counters; failed recovery persistently blocks this actor", async () => {
  for (const failRollback of [false, true]) {
    const context = fixture();
    const magazine = context.magazine();
    const rounds = context.rounds();

    context.actor.failAfter = 1;
    context.actor.failRollback = failRollback;

    await rejects(
      context.run(magazine, "load", { sourceId: rounds.id, count: 8 }),
      failRollback ? "blocked" : "writeFailed",
    );

    if (failRollback) {
      assert.equal(context.actor.getFlag(MODULE_ID, "ammoBlocked"), true);
      await rejects(
        context.run(magazine, "load", { sourceId: rounds.id, count: 1 }),
        "blocked",
      );
    } else {
      assert.equal(ammoData(magazine).roundCount, 0);
      assert.equal(rounds.system.quantity, 20);
      assert.equal(context.total(), 20);
    }
  }
});

test("failed zero-stack cleanup does not retry or duplicate an already committed transfer", async () => {
  const context = fixture();
  const magazine = context.magazine();
  const rounds = context.rounds("rounds", 8);

  context.actor.failDelete = true;
  await context.run(magazine, "load", { sourceId: rounds.id, count: 8 });

  assert.equal(rounds.system.quantity, 0);
  assert.equal(ammoData(magazine).roundCount, 8);
  assert.equal(context.notices[0].key, "cleanupFailed");
  assert.equal(context.total(), 8);
});

test("failed recovery into a newly created stack removes its empty staging item", async () => {
  const context = fixture();
  const magazine = context.magazine();
  const rounds = context.rounds("rounds", 8);
  await context.run(magazine, "load", { sourceId: rounds.id, count: 8 });
  context.actor.failAfter = 1;
  await rejects(context.run(magazine, "unload", { count: 8 }), "writeFailed");

  assert.equal(ammoData(magazine).roundCount, 8);
  assert.equal(
    context.actor.items.filter((item) => isRole(item, "rounds")).length,
    0,
  );
  assert.equal(context.total(), 8);
});

test("loaded magazine round transfers update the native weapon mirror too", async () => {
  const context = fixture();
  const weapon = context.weapon();
  const magazine = context.magazine();
  const rounds = context.rounds();

  await context.run(weapon, "insert", { sourceId: magazine.id });
  await context.run(magazine, "load", { sourceId: rounds.id, count: 4 });
  assert.equal(weapon.system.ammo, 4);

  await context.run(magazine, "unload", { count: 2 });
  assert.equal(weapon.system.ammo, 2);
  assert.equal(context.total(), 20);
});

test("configuration is opt-in, validates existing native ammo and requires ejection before disable", async () => {
  const context = fixture();

  const weapon = context.weapon("native", false);
  const config = { enabled: true, magazineType: "pistol-8" };
  weapon.system.ammo = 3;

  await rejects(
    context.run(weapon, "configure", { config }),
    "emptyNativeFirst",
  );

  weapon.system.ammo = 0;
  await context.run(weapon, "configure", { config });
  assert.equal(isWeapon(weapon), true);
  assert.equal(Object.hasOwn(ammoData(weapon), "cartridgeType"), false);

  const magazine = context.magazine();
  await context.run(weapon, "insert", { sourceId: magazine.id });

  await rejects(
    context.run(weapon, "configure", { config: { enabled: false } }),
    "ejectFirst",
  );

  await context.run(weapon, "eject");
  await context.run(weapon, "configure", { config: { enabled: false } });
  assert.equal(isWeapon(weapon), false);
});

test("magazine configuration rejects stacked magazines; nonempty magazines cannot be retyped", async () => {
  const context = fixture();
  const magazine = context.magazine();

  const config = {
    enabled: true,
    role: "magazine",
    magazineType: "pistol-8",
    cartridgeType: "9x19",
    capacity: 8,
  };

  magazine.system.quantity = 2;

  await rejects(
    context.run(magazine, "configure", { config }),
    "singleMagazine",
  );

  magazine.system.quantity = 1;
  await context.run(magazine, "configure", { config });
  const rounds = context.rounds();
  await context.run(magazine, "load", { sourceId: rounds.id, count: 1 });

  await rejects(
    context.run(magazine, "configure", { config: { ...config, capacity: 16 } }),
    "unloadFirst",
  );
});

test("broken mirrors and deleted/mismatched linked magazines fail closed", async () => {
  const context = fixture();

  const weapon = context.weapon();
  const magazine = context.magazine();
  await context.run(weapon, "insert", { sourceId: magazine.id });

  weapon.system.ammo = 5;
  await rejects(context.run(weapon, "consume", { count: 1 }), "brokenLink");

  weapon.system.ammo = 0;
  context.actor.items.delete(magazine.id);
  await rejects(context.run(weapon, "reload"), "brokenLink");
});

test("requests require ownership, an active user and an opted-in weapon", async () => {
  const context = fixture();
  const weapon = context.weapon("native", false);

  await rejects(context.run(weapon, "reload"), "notManaged");
  await rejects(
    context.run(weapon, "reload", {}, { id: "stranger", active: true }),
    "permission",
  );
  await rejects(
    context.run(weapon, "reload", {}, { ...context.user, active: false }),
    "permission",
  );

  assert.equal(context.actor.writes, 0);
});

function installGlobals(context) {
  const users = [context.user, context.gm];
  users.activeGM = context.gm;
  users.get = (id) => users.find((user) => user.id === id);

  globalThis.ui = {
    notifications: {
      error: () => {},
      info: () => {},
    },
  };

  globalThis.game = {
    users,
    user: context.gm,
    i18n: { localize: (key) => key, format: (key) => key },
    settings: { get: () => false },
    socket: { emit: () => {}, on: () => {}, off: () => {} },
  };

  globalThis.fromUuid = async (uuid) =>
    uuid === context.actor.uuid
      ? context.actor
      : context.actor.items.find((item) => item.uuid === uuid);

  globalThis.foundry = { utils: { randomID: () => "request-id" } };
}

test("native-method adapter delegates untouched weapons exactly and spends managed ammo only once", async () => {
  const context = fixture();
  installGlobals(context);
  const nativeCalls = [];
  const requests = [];
  class Model {}

  for (const name of [
    "shootAmmunition",
    "reload",
    "addAmmunition",
    "setBullets",
    "reloadUpdates",
    "setBulletsUpdates",
  ]) {
    Model.prototype[name] = function (...args) {
      const result = { name, args, receiver: this };
      nativeCalls.push(result);
      return result;
    };
  }

  installWeaponAdapter(
    Model.prototype,
    async (item, operation, data) => {
      requests.push({ item, operation, data });
      return true;
    },
    () => {},
  );

  const model = new Model();
  model.parent = context.weapon("native", false);

  for (const name of [
    "shootAmmunition",
    "reload",
    "addAmmunition",
    "setBullets",
    "reloadUpdates",
    "setBulletsUpdates",
  ]) {
    const result = model[name](3);
    assert.equal(result, nativeCalls.at(-1));
    assert.deepEqual(result.args, [3]);
  }
  assert.equal(requests.length, 0);

  ammoData(model.parent).enabled = true;
  await model.shootAmmunition(3);
  await model.reload();
  await model.addAmmunition();
  await model.setBullets(0);

  assert.deepEqual(
    requests.map((request) => request.operation),
    ["consume", "reload", "reload", "eject"],
  );
  assert.equal(requests[0].data.count, 3);
  assert.equal(nativeCalls.length, 6);

  const savedConsole = console.error;
  console.error = () => {};

  try {
    await rejects(model.setBullets(100), "managedCounter");
    await rejects(model.reloadUpdates(), "managedCounter");
    await rejects(model.setBulletsUpdates(100), "managedCounter");
  } finally {
    console.error = savedConsole;
  }
});

test("chat completion detects the actual roll transition, not damage edits or an unfinished volley", () => {
  let load = {
    as: "CoC7ChatCombatRanged",
    weaponRolled: false,
    itemUuid: "Actor.test.Item.gun",
  };
  const message = { getFlag: () => load };
  assert.equal(completedAttack(message), null);

  load.weaponRolled = true;
  assert.equal(
    completedAttack(message, {
      flags: { CoC7: { load: { weaponRolled: true } } },
    }),
    load.itemUuid,
  );

  assert.equal(
    completedAttack(message, { "flags.CoC7.load.weaponRolled": true }),
    load.itemUuid,
  );

  assert.equal(
    completedAttack(message, {
      flags: { CoC7: { load: { damageRolled: true } } },
    }),
    null,
  );

  load = { ...load, as: "OtherCard" };
  assert.equal(completedAttack(message), null);
});

test("native direct edits and deletion of linked items are blocked only for managed items", () => {
  const context = fixture();
  installGlobals(context);

  const native = context.weapon("native", false);
  const managed = context.weapon("managed");

  const savedConsole = console.error;
  console.error = () => {};

  try {
    assert.equal(protectAmmoUpdate(native, { system: { ammo: 5 } }), undefined);
    assert.equal(protectAmmoUpdate(managed, { system: { ammo: 5 } }), false);
    assert.equal(protectAmmoUpdate(managed, { "system.ammo": 5 }), false);
    assert.equal(
      protectAmmoUpdate(managed, {
        name: "Renamed",
        system: { ammo: "0", bullets: "8" },
      }),
      undefined,
    );
    assert.equal(
      protectAmmoUpdate(managed, { "system.ammo": 5 }, { r7Ammo: true }),
      undefined,
    );
    assert.equal(
      protectAmmoUpdate(managed, {
        [`flags.${MODULE_ID}.ammo.enabled`]: false,
      }),
      false,
    );
    assert.equal(protectAmmoDelete(native), undefined);

    ammoData(managed).magazineId = "magazine";
    assert.equal(protectAmmoDelete(managed), false);
    assert.equal(protectAmmoDelete(managed, { r7Ammo: true }), undefined);
  } finally {
    console.error = savedConsole;
  }
});

test("loose-round quantity edits accept whole counts but magazines remain individual items", () => {
  const context = fixture();
  installGlobals(context);

  const rounds = context.rounds();
  const magazine = context.magazine();

  for (const quantity of [0, 1, 50, "12"]) {
    assert.equal(
      protectAmmoUpdate(rounds, { system: { quantity } }),
      undefined,
    );
    assert.equal(
      protectAmmoUpdate(rounds, { "system.quantity": quantity }),
      undefined,
    );
  }
  assert.equal(
    protectAmmoUpdate(magazine, { "system.quantity": "1" }),
    undefined,
  );

  const savedConsole = console.error;
  console.error = () => {};

  try {
    for (const quantity of [
      -1,
      0.5,
      NaN,
      Infinity,
      "bad",
      "",
      " ",
      null,
      true,
    ]) {
      assert.equal(
        protectAmmoUpdate(rounds, { "system.quantity": quantity }),
        false,
      );
    }

    for (const quantity of [0, 2, "12"]) {
      assert.equal(
        protectAmmoUpdate(magazine, { "system.quantity": quantity }),
        false,
      );
    }
  } finally {
    console.error = savedConsole;
  }
});

test("GM socket deduplicates a request; a non-owner cannot mutate another actor", async () => {
  const context = fixture();
  installGlobals(context);

  const magazine = context.magazine();
  const rounds = context.rounds();

  const responses = [];
  game.socket.emit = (_channel, response) => responses.push(response);

  const runtime = new AmmoRuntime();
  const request = {
    kind: "request",
    id: "one-load",
    userId: "player",
    gmId: "gm",
    targetUuid: context.actor.uuid,
    itemId: magazine.id,
    operation: "load",
    sourceId: rounds.id,
    count: 3,
  };
  await Promise.all([runtime._receive(request), runtime._receive(request)]);

  assert.equal(ammoData(magazine).roundCount, 3);
  assert.equal(rounds.system.quantity, 17);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].result, true);

  game.users.push({ id: "stranger", active: true, isGM: false });
  await runtime._receive({
    ...request,
    id: "unauthorized",
    userId: "stranger",
  });
  assert.equal(responses.at(-1).error, "permission");
  assert.equal(ammoData(magazine).roundCount, 3);
});

test("a player streamlined attack stays empty until a confirmed reload through the GM socket queue", async () => {
  const context = fixture();
  installGlobals(context);

  const weapon = context.weapon();
  const current = context.magazine("current");
  const reserve = context.magazine("reserve");
  const rounds = context.rounds();

  await context.run(weapon, "configure", {
    config: {
      enabled: true,
      magazineType: "pistol-8",
      streamlinedAttacks: true,
      roundsPerAttack: 3,
    },
  });
  await context.run(current, "load", { sourceId: rounds.id, count: 3 });
  await context.run(reserve, "load", { sourceId: rounds.id, count: 8 });
  await context.run(weapon, "insert", { sourceId: current.id });

  context.actor.isOwner = true;
  weapon.system.skillMain = {
    id: "firearms",
    type: "skill",
    system: { value: 50 },
  };
  context.actor.runRoll = async () => ({ result: 42 });

  const runtime = new AmmoRuntime();
  const requestIds = [];

  const request = async (item, operation, data) => {
    const id = `attack-${requestIds.length}`;
    requestIds.push(id);

    let response;
    game.socket.emit = (_channel, message) => {
      if (message.kind === "response") {
        response = message;
      }
    };

    await runtime._receive({
      kind: "request",
      id,
      userId: context.user.id,
      gmId: context.gm.id,
      targetUuid: context.actor.uuid,
      itemId: item.id,
      operation,
      ...data,
    });

    if (response.error) {
      const error = new Error(response.error);
      error.code = response.error;
      throw error;
    }

    return response.result;
  };

  const attacks = new StreamlinedAttacks(
    request,
    async () => {
      assert.equal(weapon.system.ammo, 0);
      assert.equal(ammoData(weapon).magazineId, current.id);
      return { id: "result" };
    },
    {
      confirmReload: async () => true,
      announceReload: async () => {},
      chooseModifier: async () => 0,
    },
  );

  await attacks.attack(context.actor, weapon);
  assert.equal(requestIds.length, 1);
  assert.equal(ammoData(current).roundCount, 0);
  assert.equal(ammoData(weapon).magazineId, current.id);
  assert.equal(weapon.system.ammo, 0);

  await attacks.attack(context.actor, weapon);
  assert.equal(requestIds.length, 2);
  assert.equal(ammoData(weapon).magazineId, reserve.id);
  assert.equal(weapon.system.ammo, 8);
});

test("GM rejects streamlined attacks when CoC7 disregard-ammo is enabled", async () => {
  const context = fixture();
  installGlobals(context);

  const weapon = context.weapon();
  game.settings.get = () => true;

  const runtime = new AmmoRuntime();
  await rejects(runtime.request(weapon, "attack"), "disregardAmmo");
  assert.equal(context.actor.writes, 0);
});

test("without an active GM, managed operations fail rather than silently using native ammo", async () => {
  const context = fixture();
  installGlobals(context);

  game.users.activeGM = null;
  const runtime = new AmmoRuntime();
  await rejects(runtime.request(context.weapon(), "reload"), "noGM");
});

test("queued operations recheck GM authority before writing", async () => {
  const context = fixture();
  const magazine = context.magazine();
  const rounds = context.rounds();

  context.service.isAuthority = () => false;
  await rejects(
    context.run(magazine, "load", { sourceId: rounds.id, count: 1 }),
    "noGM",
  );
  assert.equal(context.actor.writes, 0);
});

test("disabling R7 restores the native capacity without changing physical magazine contents", async () => {
  const context = fixture();
  const weapon = context.weapon("weapon", false);

  await context.run(weapon, "configure", {
    config: { enabled: true, magazineType: "pistol-8" },
  });
  const magazine = context.magazine("large", 12);
  const rounds = context.rounds();
  await context.run(magazine, "load", { sourceId: rounds.id, count: 12 });
  await context.run(weapon, "insert", { sourceId: magazine.id });
  assert.equal(weapon.system.bullets, 12);

  await context.run(weapon, "eject");
  await context.run(weapon, "configure", { config: { enabled: false } });
  assert.equal(weapon.system.bullets, 8);
  assert.equal(ammoData(magazine).roundCount, 12);
  assert.equal(isWeapon(weapon), false);
});

test("world-directory templates can be configured but cannot be loaded or fired", async () => {
  const context = fixture();

  installGlobals(context);
  const weapon = context.weapon("world", false);
  weapon.parent = null;
  weapon.uuid = "Item.world";
  weapon.testUserPermission = () => false;
  weapon.setFlag = async (scope, key, value) =>
    setPath(weapon.flags, `${scope}.${key}`, value);
  weapon.update = async (updates) => {
    for (const [path, value] of Object.entries(updates)) {
      setPath(weapon, path, value);
    }
  };
  globalThis.fromUuid = async () => weapon;

  const runtime = new AmmoRuntime();
  await runtime.request(weapon, "configure", {
    config: {
      enabled: true,
      magazineType: "pistol-8",
    },
  });

  assert.equal(isWeapon(weapon), true);
  await rejects(runtime.request(weapon, "reload"), "inventoryOnly");
});

test("GM replies settle only the matching pending client request", async () => {
  const context = fixture();
  installGlobals(context);

  game.user = context.user;
  let sent;

  game.socket.emit = (_channel, request) => {
    sent = request;
  };

  const runtime = new AmmoRuntime();
  const operation = runtime.request(context.weapon(), "reload");
  assert.equal(sent.kind, "request");
  assert.equal(runtime._pending.size, 1);

  await runtime._receive({
    kind: "response",
    id: sent.id,
    gmId: "otherGM",
    userId: "player",
    result: true,
  });

  assert.equal(runtime._pending.size, 1);
  await runtime._receive({
    kind: "response",
    id: sent.id,
    gmId: "gm",
    userId: "player",
    result: true,
  });
  assert.equal(await operation, true);
  assert.equal(runtime._pending.size, 0);
});

test("GM observes native attack completion and reloads only that managed weapon", async () => {
  const context = fixture();
  installGlobals(context);

  const weapon = context.weapon();
  const current = context.magazine("current");
  const spare = context.magazine("spare");
  const rounds = context.rounds();

  await context.run(current, "load", { sourceId: rounds.id, count: 8 });
  await context.run(spare, "load", { sourceId: rounds.id, count: 8 });
  await context.run(weapon, "insert", { sourceId: current.id });

  const runtime = new AmmoRuntime();
  const message = {
    getFlag: () => ({
      as: "CoC7ChatCombatRanged",
      weaponRolled: true,
      itemUuid: weapon.uuid,
    }),
  };

  await runtime.service.execute(
    context.actor,
    { itemId: weapon.id, operation: "consume", count: 8 },
    context.gm,
  );

  await runtime.finishAttack(message, {
    flags: { CoC7: { load: { weaponRolled: true } } },
  });

  assert.equal(ammoData(weapon).magazineId, spare.id);
  assert.equal(weapon.system.ammo, 8);
});

function errorKeys(source) {
  // Stop at semicolons so a later RPC operation cannot be mistaken for an error key
  return [...source.matchAll(
    /\bnew AmmoError\(\s*["'](\w+)["']\s*,?\s*\)|\brequireAmmo\([^;]*?,\s*["'](\w+)["']\s*,?\s*\);/g,
  )].map((match) => match[1] ?? match[2]);
}

test("error-key scanning handles multiline calls without consuming unrelated operations", () => {
  const source = `
    requireAmmo(
      !actor.getFlag(MODULE_ID, "ammoBlocked"),
      "blocked",
    );
    requireAmmo(valid, errorCode);
    await request(weapon, "attack");
    throw new AmmoError(
      "invalidCount",
    );
    requireAmmo(check(value, "notAnError"), 'permission');
  `;
  assert.deepEqual(errorKeys(source), ["blocked", "invalidCount", "permission"]);
});

test("all model error keys and socket assets have English translations", async () => {
  const root = new URL("../", import.meta.url);
  const english = JSON.parse(
    await readFile(new URL("lang/en.json", root), "utf8"),
  );

  for (const path of [
    "scripts/ammo/model.mjs",
    "scripts/ammo/service.mjs",
    "scripts/ammo/integration.mjs",
    "scripts/ammo/attacks.mjs",
  ]) {
    const source = await readFile(new URL(path, root), "utf8");
    const keys = errorKeys(source);
    assert.ok(keys.length > 0, `${path}: no error keys were checked`);

    for (const key of keys) {
      assert.equal(
        typeof english[MODULE_ID].ammo.errors[key],
        "string",
        `${path}: ${key}`,
      );
    }
  }
});
