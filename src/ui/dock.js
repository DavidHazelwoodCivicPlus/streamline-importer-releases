'use strict';
// Adds "D10 Importer" to the CMS dock as a real dock item: an icon that shows when the dock is collapsed
// and a label that shows when it expands. Rather than guess the dock's markup and CSS, it copies an
// existing item (Support, or another plain item), swaps the icon and the label, and inserts the copy above
// the original, so the size, colours and collapse behaviour are the dock's own.

// Outline icon in the dock's style: a page with an arrow coming in from the left (an import).
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M9 9V3h7l5 5v13H9v-6"/><path d="M16 3v5h5"/><path d="M2 12h11"/><path d="M10 9l3 3-3 3"/><path d="M15 17h3"/></svg>';

// Items worth copying, in order of preference. Content and Sign Out are avoided: they are often
// highlighted (the current page, or a hover colour), and Sign Out's link must never be copied by mistake.
const TEMPLATES = ['Support', 'Preferences', 'Users', 'Engage', 'Menus', 'Compliance', 'Accessibility'];
const ICON_SELECTOR = 'svg, img, i, [class*="icon" i]';
const ACTIVE_CLASS = /^(active|selected|current|is-active|router-link-active|router-link-exact-active)$/i;

// The text node whose whole text is `label`, inside `root`.
function findText(root, label) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.trim() === label) return n;
  return null;
}

// From a label, climbs to the element that is one whole dock item: the smallest ancestor holding an icon
// too, then up through single-child wrappers (li > a > …) while staying inside the menu.
function itemFor(textNode, menu) {
  let el = textNode.parentElement;
  while (el && el !== menu && !el.querySelector(ICON_SELECTOR)) el = el.parentElement;
  if (!el || el === menu) return null;
  while (el.parentElement && el.parentElement !== menu && el.parentElement.children.length === 1) el = el.parentElement;
  return el;
}

function findTemplate(menu) {
  for (const label of TEMPLATES) {
    const t = findText(menu, label);
    const item = t && itemFor(t, menu);
    if (item) return { item, label };
  }
  return null;
}

// Copies the template item and turns it into the importer's item. Returns null when the dock does not look
// the way this expects, so the caller can fall back to a plain button.
function makeDockItem(menu, onOpen) {
  const tpl = findTemplate(menu);
  if (!tpl) return null;
  const oldIcon = tpl.item.querySelector(ICON_SELECTOR);
  const box = oldIcon.getBoundingClientRect();
  const iconColor = getComputedStyle(oldIcon).color;
  const copy = tpl.item.cloneNode(true);

  // Label.
  const text = findText(copy, tpl.label);
  if (!text) return null;
  text.nodeValue = text.nodeValue.replace(tpl.label, 'D10 Importer');

  // Icon: same class (so the dock's CSS sizes it), same size, the dock's icon colour.
  const icon = copy.querySelector(ICON_SELECTOR);
  const holder = document.createElement('span');
  holder.innerHTML = ICON_SVG;
  const svg = holder.firstChild;
  if (icon.getAttribute('class')) svg.setAttribute('class', icon.getAttribute('class'));
  if (box.width && box.height) { svg.style.width = box.width + 'px'; svg.style.height = box.height + 'px'; }
  svg.style.color = iconColor;
  svg.style.flexShrink = '0';
  icon.replaceWith(svg);

  // Nothing of the template's behaviour comes along: no link, no ids, no active state.
  for (const el of [copy, ...copy.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) {
      if (a.name === 'id' || a.name === 'href' || a.name === 'aria-current' || /routerlink|ng-reflect|data-testid/i.test(a.name)) el.removeAttribute(a.name);
    }
    if (el.classList) [...el.classList].filter(c => ACTIVE_CLASS.test(c)).forEach(c => el.classList.remove(c));
  }
  copy.id = 'si-open';
  copy.dataset.siTemplate = tpl.label;
  copy.setAttribute('role', 'button');
  copy.setAttribute('tabindex', '0');
  copy.setAttribute('title', 'D10 Importer');
  copy.style.cursor = 'pointer';
  // Capture phase, so the dock's own click handling (routing) never sees the click.
  const open = e => { e.preventDefault(); e.stopPropagation(); onOpen(); };
  copy.addEventListener('click', open, true);
  copy.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') open(e); }, true);

  tpl.item.parentElement.insertBefore(copy, tpl.item);
  return copy;
}

module.exports = { makeDockItem, findTemplate, ICON_SVG };
