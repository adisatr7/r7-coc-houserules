import assert from "node:assert/strict";
import { test } from "node:test";
import { AmmoError } from "../scripts/ammo/model.mjs";
import {
  StreamlinedAttacks,
  announceMagazineReload,
  confirmMagazineReload,
  installAttackAdapter,
  isStreamlinedWeapon,
  promptAttackModifier,
  rollWeaponSkill,
} from "../scripts/ammo/attacks.mjs";

function fixture() {
  const events = [];

  const actor = {
    uuid: "Actor.a",
    isOwner: true,
    runRoll: async () => ({ result: 42 }),
    items: { filter: () => [] },
  };

  const weapon = {
    uuid: "Actor.a.Item.gun",
    type: "weapon",
    parent: actor,
    getFlag: () => ({ enabled: true, streamlinedAttacks: true }),
    system: {
      ammo: 1,
      properties: { rngd: true },
      skillMain: { id: "firearms", type: "skill", system: { value: 55 } },
    },
  };

  const message = { id: "result" };

  const rollCheck = async () => {
    events.push(["roll", weapon.system.skillMain.id], ["message"]);
    return message;
  };

  const request = async (item, operation) => {
    assert.equal(item, weapon);
    events.push([operation]);
  };

  const attacks = new StreamlinedAttacks(request, rollCheck, {
    chooseModifier: async () => 0,
  });

  return { actor, weapon, message, rollCheck, events, request, attacks };
}

test("streamlined attack charges once, makes a native primary-skill check and never auto-reloads", async () => {
  const context = fixture();

  assert.equal(
    await context.attacks.attack(context.actor, context.weapon),
    context.message,
  );

  assert.deepEqual(context.events, [
    ["attack"],
    ["roll", "firearms"],
    ["message"],
  ]);
});

test("dismissing the dice prompt spends no ammo and makes no roll", async () => {
  const context = fixture();

  for (const answer of [null, undefined]) {
    const attacks = new StreamlinedAttacks(context.request, context.rollCheck, {
      chooseModifier: async () => answer,
    });

    assert.equal(await attacks.attack(context.actor, context.weapon), null);
    assert.deepEqual(context.events, []);
    assert.equal(attacks._active.size, 0);
  }
});

test("dice selection is confirmed before charging ammo and its signed modifier reaches the roll", async () => {
  const context = fixture();

  const attacks = new StreamlinedAttacks(
    context.request,
    async (actor, weapon, modifier) => {
      assert.equal(actor, context.actor);
      assert.equal(weapon, context.weapon);
      assert.equal(modifier, -2);
      context.events.push(["roll"]);
    },
    {
      chooseModifier: async () => {
        context.events.push(["choose"]);
        return -2;
      },
    },
  );

  await attacks.attack(context.actor, context.weapon);
  assert.deepEqual(context.events, [["choose"], ["attack"], ["roll"]]);
});

test("invalid dice modifiers cannot spend ammo", async () => {
  const context = fixture();

  for (const modifier of [-3, 3, 0.5, "1", NaN]) {
    const attacks = new StreamlinedAttacks(context.request, context.rollCheck, {
      chooseModifier: async () => modifier,
    });

    await assert.rejects(attacks.attack(context.actor, context.weapon), {
      code: "invalidCount",
    });
  }

  assert.deepEqual(context.events, []);
});

test("attack prompt contains only the signed dice slider and the Roll action", async () => {
  let configuration;

  globalThis.game = { i18n: { localize: (key) => key } };
  globalThis.foundry = {
    applications: {
      api: {
        DialogV2: {
          prompt: async (options) => {
            configuration = options;
            return 2;
          },
        },
      },
    },
  };

  assert.equal(await promptAttackModifier({ name: "Thompson" }), 2);
  assert.equal(configuration.window.title, "Thompson");
  assert.equal(configuration.rejectClose, false);
  assert.equal(
    configuration.ok.label,
    "r7-coc-houserules.ammo.attackDialog.roll",
  );
  assert.equal(
    configuration.ok.callback(null, {
      form: { elements: { poolModifier: { value: "-1" } } },
    }),
    -1,
  );
  assert.equal((configuration.content.match(/<input\b/g) ?? []).length, 1);
  assert.match(configuration.content, /type="range"/);

  const slider = configuration.content.match(/<input\b[^>]*>/)?.[0];
  for (const attribute of ['min="-2"', 'max="2"', 'step="1"', 'value="0"']) {
    assert.ok(slider?.includes(attribute), `slider is missing ${attribute}`);
  }
});

test("unowned weapons and missing primary skills are rejected before spending or rolling", async () => {
  const context = fixture();
  context.actor.isOwner = false;

  await assert.rejects(context.attacks.attack(context.actor, context.weapon), {
    code: "permission",
  });

  context.actor.isOwner = true;
  context.weapon.system.skillMain = undefined;

  await assert.rejects(context.attacks.attack(context.actor, context.weapon), {
    code: "missingWeaponSkill",
  });

  assert.deepEqual(context.events, []);
});

test("missing system adapter and refused ammo charges never roll or finalize an attack", async () => {
  const context = fixture();
  const runRoll = context.actor.runRoll;
  delete context.actor.runRoll;

  await assert.rejects(context.attacks.attack(context.actor, context.weapon), {
    code: "unsupportedAttack",
  });

  context.actor.runRoll = runRoll;
  const refused = new StreamlinedAttacks(
    async () => {
      throw new AmmoError("notEnoughRounds");
    },
    context.rollCheck,
    { chooseModifier: async () => 0 },
  );

  await assert.rejects(refused.attack(context.actor, context.weapon), {
    code: "notEnoughRounds",
  });
  assert.deepEqual(context.events, []);
});

test("repeat clicks during an active attack are rejected without a second ammo request", async () => {
  const context = fixture();
  let release;

  const waiting = new Promise((resolve) => {
    release = resolve;
  });

  const attacks = new StreamlinedAttacks(
    async (item, operation) => {
      await context.request(item, operation);
      if (operation === "attack") {
        await waiting;
      }
    },
    context.rollCheck,
    { chooseModifier: async () => 0 },
  );

  const first = attacks.attack(context.actor, context.weapon);
  await assert.rejects(attacks.attack(context.actor, context.weapon), {
    code: "attackInProgress",
  });

  release();
  await first;

  assert.equal(
    context.events.filter(([event]) => event === "attack").length,
    1,
  );

  await attacks.attack(context.actor, context.weapon);
  assert.equal(
    context.events.filter(([event]) => event === "attack").length,
    2,
  );
});

test("failed result publication keeps spent ammo and never reloads or retries the roll", async (testContext) => {
  const context = fixture();
  testContext.mock.method(console, "error", () => {});

  const attacks = new StreamlinedAttacks(
    context.request,
    async () => {
      context.events.push(["roll", "firearms"]);
      throw new Error("Chat unavailable");
    },
    { chooseModifier: async () => 0 },
  );

  await assert.rejects(attacks.attack(context.actor, context.weapon), {
    code: "attackResultFailed",
  });
  assert.deepEqual(context.events, [["attack"], ["roll", "firearms"]]);
  assert.equal(attacks._active.size, 0);
});

test("a failed ammo request does not leave the client attack lock stuck", async () => {
  const context = fixture();

  const attacks = new StreamlinedAttacks(
    async (item, operation) => {
      await context.request(item, operation);
      throw new AmmoError("noGM");
    },
    context.rollCheck,
    { chooseModifier: async () => 0 },
  );

  await assert.rejects(attacks.attack(context.actor, context.weapon), {
    code: "noGM",
  });
  assert.equal(attacks._active.size, 0);
});

function emptyWeaponFixture({
  answer = true,
  spare = true,
  reloaded = true,
  internal = false,
} = {}) {
  const context = fixture();

  const magazine = {
    id: "spare",
    type: "item",
    system: { quantity: internal ? (spare ? 10 : 0) : 1 },
    getFlag: () => ({
      enabled: true,
      role: internal ? "rounds" : "magazine",
      cartridgeType: "rifle-round",
      magazineType: "smg",
      capacity: 30,
      roundCount: spare ? 10 : 0,
    }),
  };

  context.weapon.system.ammo = 0;
  context.weapon.getFlag = () => ({
    enabled: true,
    streamlinedAttacks: true,
    magazineType: "smg",
    reloadType: internal ? "internal" : "detachable",
    cartridgeType: "rifle-round",
    magazineId: internal ? "" : "current",
  });
  context.actor.items.filter = (predicate) => [magazine].filter(predicate);

  const request = async (_weapon, operation, data) => {
    context.events.push([operation, data]);
    if (operation === "attack") {
      throw new AmmoError("notEnoughRounds");
    }
    return reloaded;
  };

  const attacks = new StreamlinedAttacks(request, context.rollCheck, {
    chooseModifier: async () => {
      throw new Error("Empty weapons must skip the dice prompt");
    },
    confirmReload: async () => {
      context.events.push(["confirm"]);
      return answer;
    },
    announceReload: async (actor, weapon) => {
      assert.equal(actor, context.actor);
      assert.equal(weapon, context.weapon);
      context.events.push(["announce"]);
    },
  });

  return { ...context, attacks };
}

test("firing empty with a loaded spare offers reload and announces only after success, without firing", async () => {
  const context = emptyWeaponFixture();

  assert.equal(
    await context.attacks.attack(context.actor, context.weapon),
    null,
  );

  assert.deepEqual(context.events, [
    ["confirm"],
    ["reload", { onlyEmpty: true }],
    ["announce"],
  ]);
});

test("empty internal weapons offer reload from loose rounds without an inserted/spare magazine", async () => {
  const context = emptyWeaponFixture({ internal: true });

  assert.equal(
    await context.attacks.attack(context.actor, context.weapon),
    null,
  );

  assert.deepEqual(context.events, [
    ["confirm"],
    ["reload", { onlyEmpty: true }],
    ["announce"],
  ]);
});

test("empty internal weapons without compatible loose stock skip the reload dialog", async () => {
  const context = emptyWeaponFixture({ internal: true, spare: false });

  await assert.rejects(context.attacks.attack(context.actor, context.weapon), {
    code: "notEnoughRounds",
  });

  assert.deepEqual(context.events, []);
});

test("declining or dismissing the reload prompt leaves the weapon empty without chat or a roll", async () => {
  for (const answer of [false, null]) {
    const context = emptyWeaponFixture({ answer });

    assert.equal(
      await context.attacks.attack(context.actor, context.weapon),
      null,
    );
    assert.deepEqual(context.events, [["confirm"]]);
    assert.equal(context.attacks._active.size, 0);
  }
});

test("no loaded compatible spare means no reload dialog, chat message or attack roll", async () => {
  const context = emptyWeaponFixture({ spare: false });

  await assert.rejects(context.attacks.attack(context.actor, context.weapon), {
    code: "notEnoughRounds",
  });
  assert.deepEqual(context.events, []);
});

test("a stale prompt that cannot reload does not announce success", async () => {
  const context = emptyWeaponFixture({ reloaded: false });
  await context.attacks.attack(context.actor, context.weapon);

  assert.deepEqual(context.events, [
    ["confirm"],
    ["reload", { onlyEmpty: true }],
  ]);
});

test("reload confirmation uses DialogV2 with safe dismissal and localized text", async () => {
  let configuration;

  globalThis.game = { i18n: { localize: (key) => key } };

  globalThis.foundry = {
    applications: {
      api: {
        DialogV2: {
          confirm: async (options) => {
            configuration = options;
            return true;
          },
        },
      },
    },
  };

  assert.equal(await confirmMagazineReload(), true);
  assert.equal(configuration.rejectClose, false);
  assert.equal(
    configuration.window.title,
    "r7-coc-houserules.ammo.reloadDialog.title",
  );
  assert.equal(
    configuration.content,
    "<p>r7-coc-houserules.ammo.reloadDialog.content</p>",
  );

  const weapon = {
    type: "weapon",
    getFlag: () => ({ enabled: true, reloadType: "internal" }),
  };

  await confirmMagazineReload(weapon);
  assert.equal(
    configuration.content,
    "<p>r7-coc-houserules.ammo.reloadDialog.internalContent</p>",
  );
});

test("reload announcement posts text chat with the requesting user's name and actor speaker", async () => {
  const context = fixture();

  context.weapon.name = "Thompson";
  let paragraph;
  let chat;

  globalThis.document = {
    createElement: (tag) => {
      assert.equal(tag, "p");
      paragraph = { outerHTML: "safe paragraph" };
      return paragraph;
    },
  };

  globalThis.game = {
    user: { name: "Player" },
    i18n: {
      format: (key, data) => {
        assert.equal(key, "r7-coc-houserules.ammo.reloadedChat");
        return `${data.user} has reloaded ${data.weapon}.`;
      },
    },
  };

  globalThis.ChatMessage = {
    getSpeaker: ({ actor }) => {
      assert.equal(actor, context.actor);
      return { actor: "a" };
    },
    create: async (data) => {
      chat = data;
    },
  };

  await announceMagazineReload(context.actor, context.weapon);
  assert.equal(paragraph.textContent, "Player has reloaded Thompson.");
  assert.deepEqual(chat, {
    speaker: { actor: "a" },
    content: "safe paragraph",
  });
});

test("actor adapter preserves native calls unless both R7 ammo and streamlined attacks are enabled", async () => {
  const context = fixture();
  const nativeCalls = [];
  const result = {};

  const prototype = {
    weaponRoll(...args) {
      nativeCalls.push([this, ...args]);
      return result;
    },
  };

  const managedCalls = [];
  const errors = [];

  const attack = async (...args) => {
    managedCalls.push(args);
    return "rolled";
  };

  installAttackAdapter(prototype, attack, (error) => errors.push(error));
  const installed = prototype.weaponRoll;
  installAttackAdapter(prototype, attack, (error) => errors.push(error));
  assert.equal(prototype.weaponRoll, installed);

  const native = {
    type: "weapon",
    getFlag: () => ({ enabled: false, streamlinedAttacks: true }),
  };
  const normalR7 = { type: "weapon", getFlag: () => ({ enabled: true }) };

  for (const weapon of [native, normalR7]) {
    assert.equal(
      prototype.weaponRoll.call(context.actor, weapon, "attackerUuid"),
      result,
    );
    assert.deepEqual(nativeCalls.at(-1), [
      context.actor,
      weapon,
      "attackerUuid",
    ]);
    assert.equal(isStreamlinedWeapon(weapon), false);
  }

  assert.equal(
    await prototype.weaponRoll.call(context.actor, context.weapon),
    "rolled",
  );
  assert.deepEqual(managedCalls, [[context.actor, context.weapon]]);
  assert.equal(errors.length, 0);
});

function installRollGlobals() {
  const callbacks = new Map();

  globalThis.Hooks = {
    on: (name, callback) => {
      callbacks.set(callback, name);
      return callback;
    },
    off: (name, callback) => {
      assert.equal(callbacks.get(callback), name);
      callbacks.delete(callback);
    },
  };

  globalThis.foundry = { utils: { randomID: () => "attack-id" } };
  const publish = (options, actor, weapon) => {
    const message = {
      getFlag: () => ({
        callbackContext: options.callbackContext,
        callbackUuid: weapon.uuid,
        actorUuid: actor.uuid,
      }),
    };

    for (const callback of callbacks.keys()) {
      callback(message);
    }

    return message;
  };

  return { callbacks, publish };
}

test("default adapter uses Actor.runRoll and waits for its correlated published card, with no source-file import", async () => {
  const context = fixture();
  const { callbacks, publish } = installRollGlobals();

  let finishPublication;
  let message;
  let options;

  context.actor.runRoll = async (request) => {
    options = request;
    publish(
      { callbackContext: { r7AttackId: "other" } },
      context.actor,
      context.weapon,
    );
    finishPublication = () => {
      message = publish(request, context.actor, context.weapon);
    };
    return { result: 42 };
  };

  let settled = false;
  const attack = rollWeaponSkill(context.actor, context.weapon).then(
    (result) => {
      settled = true;
      return result;
    },
  );

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(options.skillId, "firearms");
  assert.equal(options.fastForward, true);
  assert.equal(options.preventStandby, true);
  assert.equal(options.difficulty, 1);
  assert.equal(options.chatMessage, true);
  assert.equal(options.callbackUuid, context.weapon.uuid);
  finishPublication();
  assert.equal(await attack, message);
  assert.equal(callbacks.size, 0);
});

test("result tracker cleans up if CoC7 rejects the roll request", async () => {
  const context = fixture();
  const { callbacks } = installRollGlobals();

  context.actor.runRoll = async () => {
    throw new Error("Roll failed");
  };

  await assert.rejects(
    rollWeaponSkill(context.actor, context.weapon),
    /Roll failed/,
  );
  assert.equal(callbacks.size, 0);
});

test("missing result publication times out and removes its temporary listener", async (testContext) => {
  const context = fixture();
  const { callbacks } = installRollGlobals();

  testContext.mock.timers.enable({ apis: ["setTimeout"] });
  const assertion = assert.rejects(
    rollWeaponSkill(context.actor, context.weapon),
    { code: "attackResultFailed" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  testContext.mock.timers.tick(20000);
  await assertion;

  assert.equal(callbacks.size, 0);
});
