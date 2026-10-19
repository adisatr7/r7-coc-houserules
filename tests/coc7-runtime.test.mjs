import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { rollWeaponSkill } from "../scripts/ammo/attacks.mjs";

test("installed CoC7 bundle's actual Actor/normalizer/check APIs publish the streamlined skill result", async (testContext) => {
  let bundle;
  try {
    bundle = await readFile(
      new URL("../../../systems/CoC7/system.js", import.meta.url),
      "utf8",
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      testContext.skip("CoC7 is not installed beside this module");
      return;
    }
    throw error;
  }

  const encoded = bundle.match(
    /sourceMappingURL=data:application\/json[^,]*,([^\s]+)/,
  )?.[1];

  if (!encoded) {
    testContext.skip("Installed CoC7 bundle has no embedded source map");
    return;
  }

  const sourceMap = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const source = (path) => {
    const index = sourceMap.sources.findIndex((name) =>
      name.endsWith(`/coc7/${path}`),
    );
    assert.notEqual(index, -1, `Release source map is missing ${path}`);
    return sourceMap.sourcesContent[index]
      .replace(/^import .*\r?\n/gm, "")
      .replace("export default class", "class");
  };

  const callbacks = new Map();

  const hooks = {
    on: (_name, callback) => {
      callbacks.set(callback, true);
      return callback;
    },
    off: (_name, callback) => callbacks.delete(callback),
  };

  globalThis.Hooks = hooks;
  globalThis.foundry = { utils: { randomID: () => "real-release-attack" } };

  const messages = [];
  const pools = [];
  let actor;

  const skill = {
    id: "firearms",
    uuid: "Actor.a.Item.firearms",
    name: "Firearms (SMG)",
    type: "skill",
    flags: {},
    system: { value: 55, bonusDice: 1, properties: { push: false } },
  };

  const weapon = {
    uuid: "Actor.a.Item.weapon",
    system: {
      skillMain: skill,
    },
  };

  const context = vm.createContext({
    Actor: class {},
    TokenDocument: class {},
    FOLDER_ID: "CoC7",
    CHAT_MESSAGE_MODE: {
      PUBLIC: "publicroll",
      GM: "gmroll",
      BLIND: "blindroll",
      SELF: "selfroll",
    },
    game: {
      user: { isGM: false },
      settings: {
        get: (_scope, key) => (key === "rollMode" ? "publicroll" : false),
      },
      i18n: { localize: (key) => key, format: (key) => key },
    },
    foundry: {
      applications: {
        handlebars: { renderTemplate: async () => "native result" },
      },
    },
    fromUuid: async (uuid) =>
      uuid === actor.uuid ? actor : uuid === skill.uuid ? skill : weapon,
    CoC7Utilities: { isCtrlKey: () => false },
    CoC7DicePool: {
      difficultyLevel: { regular: 1, unknown: 0 },
      maxDicePenalty: 2,
      maxDiceBonus: 2,
      difficultyString: () => "Regular",
      newPool: (options) => {
        const pool = {
          ...options,
          newRolls: [],
          total: 42,
          successLevel: 1,
          isSuccess: true,
          successLevels: {
            1: ["regular", 55],
            2: ["hard", 27],
            3: ["extreme", 11],
          },
          roll: async () => {},
          toObject: () => ({ threshold: pool.threshold }),
        };
        pools.push(pool);
        return pool;
      },
    },
    ChatMessage: {
      getSpeaker: () => ({ actor: "a" }),
      applyRollMode: () => {},
      create: async (data) => {
        const message = {
          id: "native-result",
          ...data,
          getFlag: (scope, key) => data.flags[scope]?.[key],
        };
        messages.push(message);
        for (const callback of callbacks.keys()) {
          callback(message);
        }
        return message;
      },
    },
  });

  // The release bundles these classes; its source map lets us test them without booting Foundry
  const classes = vm.runInContext(
    [
      source("apps/roll-normalize.js"),
      source("apps/check.js"),
      source("models/actor/document-class.js"),
      "({ ActorClass: CoC7ModelsActorDocumentClass, Check: CoC7Check })",
    ].join("\n"),
    context,
  );

  actor = new classes.ActorClass();
  Object.assign(actor, {
    uuid: "Actor.a",
    name: "Investigator",
    items: new Map([[skill.id, skill]]),
    system: { infos: {} },
  });

  // Stub template context, not serialization, to exercise the real chat payload
  classes.Check.prototype.getTemplateData = async () => ({
    actorUuid: actor.uuid,
  });
  const result = await rollWeaponSkill(actor, weapon, -1);
  assert.equal(result.id, "native-result");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].flags.CoC7.load.type, "skill");
  assert.equal(messages[0].flags.CoC7.load.key, skill.uuid);
  assert.equal(messages[0].flags.CoC7.load.allowPush, false);
  assert.equal(pools[0].threshold, 55);
  assert.equal(pools[0].difficulty, 1);
  assert.equal(
    pools[0].poolModifier,
    0,
    "one additional penalty cancels the native skill bonus",
  );
  assert.equal(callbacks.size, 0);
});
