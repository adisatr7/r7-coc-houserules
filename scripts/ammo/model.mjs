export const MODULE_ID = "r7-coc-houserules";
export const AMMO_PATH = `flags.${MODULE_ID}.ammo`;

export class AmmoError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function requireAmmo(condition, code) {
  if (!condition) {
    throw new AmmoError(code);
  }
}

export function ammoData(item) {
  return item?.getFlag(MODULE_ID, "ammo") ?? {};
}

export function isWeapon(item) {
  return item?.type === "weapon" && ammoData(item).enabled === true;
}

export function isInternalWeapon(item) {
  return isWeapon(item) && ammoData(item).reloadType === "internal";
}

export function isRole(item, role) {
  const data = ammoData(item);

  return item?.type === "item" && data.enabled === true && data.role === role;
}

export function integer(value, minimum = 0) {
  requireAmmo(Number.isSafeInteger(value) && value >= minimum, "invalidCount");

  return value;
}

export function typeKey(value) {
  requireAmmo(
    typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value),
    "invalidType",
  );

  return value;
}

export function compatible(weapon, magazine) {
  const gun = ammoData(weapon);
  const container = ammoData(magazine);

  return (
    isWeapon(weapon) &&
    !isInternalWeapon(weapon) &&
    isRole(magazine, "magazine") &&
    !!gun.magazineType &&
    gun.magazineType === container.magazineType
  );
}

export function linkedMagazine(actor, weapon) {
  requireAmmo(!isInternalWeapon(weapon), "invalidOperation");

  const gun = ammoData(weapon);
  if (!gun.magazineId) {
    requireAmmo(Number(weapon.system.ammo) === 0, "brokenLink");
    return null;
  }

  const magazine = actor.items.get(gun.magazineId);
  requireAmmo(
    compatible(weapon, magazine) && ammoData(magazine).insertedIn === weapon.id,
    "brokenLink",
  );

  const data = ammoData(magazine);
  integer(data.roundCount);
  integer(data.capacity, 1);

  requireAmmo(
    data.roundCount <= data.capacity &&
      weapon.system.ammo === data.roundCount &&
      weapon.system.bullets === data.capacity,
    "brokenLink",
  );

  requireAmmo(
    !actor.items.some(
      (other) =>
        other.id !== weapon.id &&
        isWeapon(other) &&
        ammoData(other).magazineId === magazine.id,
    ),
    "brokenLink",
  );

  return magazine;
}

/**
 * Returns an internal-magazine weapon or its linked detachable magazine after
 * validating the native ammo/capacity mirrors. Returns null for an unlinked
 * detachable weapon; throws AmmoError if the stored counts or links disagree
 */
export function weaponContainer(actor, weapon) {
  requireAmmo(isWeapon(weapon), "notManaged");

  if (!isInternalWeapon(weapon)) {
    return linkedMagazine(actor, weapon);
  }

  const data = ammoData(weapon);
  integer(data.capacity, 1);
  integer(data.roundCount);
  typeKey(data.cartridgeType);

  requireAmmo(
    !data.magazineId &&
      !data.insertedIn &&
      data.roundCount <= data.capacity &&
      weapon.system.ammo === data.roundCount &&
      weapon.system.bullets === data.capacity,
    "brokenLink",
  );

  return weapon;
}

export function availableRounds(actor, container) {
  return actor.items
    .filter(
      (item) =>
        isRole(item, "rounds") &&
        ammoData(item).cartridgeType === ammoData(container).cartridgeType &&
        Number.isSafeInteger(item.system.quantity) &&
        item.system.quantity > 0,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function availableReloadSources(actor, weapon) {
  return isInternalWeapon(weapon)
    ? availableRounds(actor, weapon)
    : availableMagazines(actor, weapon);
}

export function availableMagazines(actor, weapon) {
  return actor.items
    .filter(
      (item) =>
        compatible(weapon, item) &&
        !ammoData(item).insertedIn &&
        item.system.quantity === 1 &&
        Number.isSafeInteger(ammoData(item).capacity) &&
        ammoData(item).capacity > 0 &&
        Number.isSafeInteger(ammoData(item).roundCount) &&
        ammoData(item).roundCount > 0 &&
        ammoData(item).roundCount <= ammoData(item).capacity,
    )
    .sort(
      (left, right) =>
        ammoData(right).roundCount - ammoData(left).roundCount ||
        left.id.localeCompare(right.id),
    );
}

export function getPath(object, path) {
  if (Object.hasOwn(object, path)) {
    return object[path];
  }

  return path.split(".").reduce((value, key) => value?.[key], object);
}

export function roundTemplate(item) {
  return structuredClone({
    name: item.name,
    type: "item",
    img: item.img,
    system: {
      quantity: 0,
      weight: item.system.weight ?? 0,
      description: item.system.description ?? {},
    },
    flags: {
      [MODULE_ID]: {
        ammo: {
          enabled: true,
          role: "rounds",
          cartridgeType: ammoData(item).cartridgeType,
        },
      },
    },
  });
}
