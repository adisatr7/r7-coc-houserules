import {
  MODULE_ID,
  AmmoError,
  ammoData,
  availableReloadSources,
  isInternalWeapon,
  isWeapon,
  requireAmmo,
} from "./model.mjs";

const WRAPPED = Symbol.for("r7-coc-houserules.streamlinedAttack");

export async function rollWeaponSkill(actor, weapon, modifier = 0) {
  const attackId = foundry.utils.randomID();
  let receiveMessage;

  const publication = new Promise((resolve) => {
    receiveMessage = resolve;
  });

  const hook = Hooks.on("createChatMessage", (message) => {
    const data = message.getFlag("CoC7", "load");
    if (
      data?.callbackContext?.r7AttackId === attackId &&
      data.callbackUuid === weapon.uuid &&
      data.actorUuid === actor.uuid
    ) {
      receiveMessage(message);
    }
  });

  let timer;

  try {
    const result = await actor.runRoll({
      skillId: weapon.system.skillMain.id,
      fastForward: true,
      difficulty: 1,
      // CoC7 substitutes the skill bonus for numeric 0; string "0" preserves cancellation.
      poolModifier: String(
        Math.max(
          -2,
          Math.min(
            2,
            Number(weapon.system.skillMain.system.bonusDice ?? 0) + modifier,
          ),
        ),
      ),
      preventStandby: true,
      chatMessage: true,
      callbackUuid: weapon.uuid,
      callbackContext: { r7AttackId: attackId },
    });

    requireAmmo(Number.isFinite(result?.result), "attackResultFailed");

    // CoC7 does not await chat creation, so the roll can finish before its result is posted
    return await Promise.race([
      publication,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AmmoError("attackResultFailed")),
          20000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    Hooks.off("createChatMessage", hook);
  }
}

export function isStreamlinedWeapon(item) {
  return isWeapon(item) && ammoData(item).streamlinedAttacks === true;
}

export function promptAttackModifier(weapon) {
  const localize = (key) =>
    game.i18n.localize(`${MODULE_ID}.ammo.attackDialog.${key}`);
  return foundry.applications.api.DialogV2.prompt({
    window: { title: weapon.name },
    content: `
      <div class="form-group">
        <label for="r7-attack-modifier">${localize("label")}</label>
        <div class="form-fields">
          <input
            id="r7-attack-modifier"
            name="poolModifier"
            type="range"
            min="-2"
            max="2"
            step="1"
            value="0"
            list="r7-attack-ticks"
          >
        </div>
      </div>
      <datalist id="r7-attack-ticks">
        <option value="-2"></option>
        <option value="-1"></option>
        <option value="0"></option>
        <option value="1"></option>
        <option value="2"></option>
      </datalist>
      <div style="display:flex;justify-content:space-between">
        <span>${localize("penalty")}</span>
        <span>0</span>
        <span>${localize("bonus")}</span>
      </div>
    `,
    ok: {
      label: localize("roll"),
      callback: (_event, button) =>
        Number(button.form.elements.poolModifier.value),
    },
    rejectClose: false,
  });
}

export function confirmMagazineReload(weapon) {
  return foundry.applications.api.DialogV2.confirm({
    window: {
      title: game.i18n.localize(`${MODULE_ID}.ammo.reloadDialog.title`),
    },
    content: `<p>${game.i18n.localize(`${MODULE_ID}.ammo.reloadDialog.${isInternalWeapon(weapon) ? "internalContent" : "content"}`)}</p>`,
    rejectClose: false,
  });
}

export async function announceMagazineReload(actor, weapon) {
  const paragraph = document.createElement("p");

  paragraph.textContent = game.i18n.format(`${MODULE_ID}.ammo.reloadedChat`, {
    user: game.user.name,
    weapon: weapon.name,
  });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: paragraph.outerHTML,
  });
}

export class StreamlinedAttacks {
  constructor(
    request,
    rollCheck = rollWeaponSkill,
    {
      confirmReload = confirmMagazineReload,
      announceReload = announceMagazineReload,
      chooseModifier = promptAttackModifier,
    } = {},
  ) {
    this._request = request;
    this._rollCheck = rollCheck;
    this._confirmReload = confirmReload;
    this._announceReload = announceReload;
    this._chooseModifier = chooseModifier;
    this._active = new Set();
  }

  async attack(actor, weapon) {
    requireAmmo(!this._active.has(weapon.uuid), "attackInProgress");
    this._active.add(weapon.uuid);

    let charged = false;
    try {
      requireAmmo(weapon.parent === actor && actor.isOwner, "permission");
      requireAmmo(weapon.system.properties.rngd === true, "rangedOnly");
      const skill = weapon.system.skillMain;
      requireAmmo(
        skill?.type === "skill" &&
          !!skill.id &&
          Number.isFinite(Number.parseInt(skill.system.value, 10)),
        "missingWeaponSkill",
      );
      requireAmmo(typeof actor.runRoll === "function", "unsupportedAttack");

      if (weapon.system.ammo === 0) {
        requireAmmo(
          isInternalWeapon(weapon) || !!ammoData(weapon).magazineId,
          "noInsertedMagazine",
        );
        return await this._offerReload(actor, weapon);
      }

      const modifier = await this._chooseModifier(weapon);
      if (modifier === null || modifier === undefined) {
        return null;
      }

      requireAmmo(
        Number.isInteger(modifier) && modifier >= -2 && modifier <= 2,
        "invalidCount",
      );

      await this._request(weapon, "attack");
      charged = true;

      return await this._rollCheck(actor, weapon, modifier);
    } catch (error) {
      if (charged) {
        console.error(
          `${MODULE_ID} | Attack failed after spending ammunition`,
          error,
        );
        throw new AmmoError("attackResultFailed");
      }

      if (
        error.code === "notEnoughRounds" &&
        availableReloadSources(actor, weapon).length > 0
      ) {
        return await this._offerReload(actor, weapon);
      }

      throw error;
    } finally {
      this._active.delete(weapon.uuid);
    }
  }

  async _offerReload(actor, weapon) {
    requireAmmo(
      availableReloadSources(actor, weapon).length > 0,
      "notEnoughRounds",
    );

    if ((await this._confirmReload(weapon)) !== true) {
      return null;
    }

    // Another client may have reloaded while the confirmation dialog was open
    const reloaded = await this._request(weapon, "reload", { onlyEmpty: true });
    if (reloaded) {
      await this._announceReload(actor, weapon);
    }

    return null;
  }
}

export function installAttackAdapter(prototype, attack, reportError) {
  // Hook this entry point so sheet clicks and weapon macros use the same flow.
  const native = prototype?.weaponRoll;
  requireAmmo(typeof native === "function", "unsupportedAttack");

  if (native[WRAPPED]) {
    return;
  }

  function wrapped(weapon, ...args) {
    if (!isStreamlinedWeapon(weapon)) {
      return native.call(this, weapon, ...args);
    }
    return attack(this, weapon).catch(reportError);
  }

  Object.defineProperty(wrapped, WRAPPED, { value: true });
  prototype.weaponRoll = wrapped;
}
