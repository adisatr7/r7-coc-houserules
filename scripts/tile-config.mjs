import { MODULE_ID, HOVER_FLAG } from "./tile-hover.mjs";

export function addTileHoverOption(application, html) {
  const name = `flags.${MODULE_ID}.${HOVER_FLAG}`;
  const appearance = html.querySelector('.tab[data-tab="appearance"]');
  if (!appearance || html.querySelector(`input[name="${name}"]`)) {
    return;
  }

  const element = (tag, className, translation) => {
    const node = document.createElement(tag);
    node.className = className;
    if (translation) {
      node.textContent = game.i18n.localize(
        `${MODULE_ID}.tileHover.${translation}`,
      );
    }
    return node;
  };

  const fieldset = element("fieldset", "");
  fieldset.append(element("legend", "", "legend"));
  const group = element("div", "form-group");
  const label = element("label", "", "label");
  const fields = element("div", "form-fields");
  const input = element("input", "");
  input.type = "checkbox";
  input.name = name;
  input.id = `${application.id}-${HOVER_FLAG}`;
  input.checked = application.document.getFlag(MODULE_ID, HOVER_FLAG) === true;
  label.htmlFor = input.id;
  fields.append(input);
  group.append(label, fields);
  fieldset.append(group);
  appearance.append(fieldset);
}
