/* ============================================================
   Icons used by the online mode.

   Avatars are drawn here as small stroke SVGs so they match the
   look of the existing hand illustrations in main.html. The hand
   icons are not duplicated: they are read straight out of the
   solo-mode buttons that already exist on the page.
   ============================================================ */

export const AVATAR_PATHS = {
  bolt: '<path d="M27 6 12 27h9l-2 15 15-21h-9z"/>',
  star: '<path d="M24 7.5l5.1 10.4 11.5 1.7-8.3 8.1 2 11.5L24 33.8l-10.3 5.4 2-11.5-8.3-8.1 11.5-1.7z"/>',
  crown: '<path d="M9 16l9 8 6-12 6 12 9-8-3 20H12z"/><path d="M12 36h24"/>',
  flame: '<path d="M24 6c6 8 10 11 10 18a10 10 0 0 1-20 0c0-4 2-7 4-10 1 3 2 4 3 4 1-5 1-8 3-12z"/>',
  shield: '<path d="M24 6l14 5v11c0 9-6 16-14 20-8-4-14-11-14-20V11z"/><path d="M17 24l5 5 9-11"/>',
  diamond: '<path d="M24 6l14 12-14 24L10 18z"/><path d="M10 18h28M24 6l-6 12 6 24 6-24-6-12"/>',
  moon: '<path d="M30 8a16 16 0 1 0 6 22A17 17 0 0 1 30 8z"/>',
  leaf: '<path d="M38 10C22 10 12 18 12 30a8 8 0 0 0 8 8c12 0 18-12 18-28z"/><path d="M12 38 30 20"/>'
};

export const AVATAR_COLORS = {
  coral: "#d4491f",
  teal: "#16655c",
  amber: "#b8831c",
  plum: "#6f3f6d",
  moss: "#4f6b36",
  slate: "#46536b"
};

export const AVATAR_LABELS = {
  bolt: "Bolt",
  star: "Star",
  crown: "Crown",
  flame: "Flame",
  shield: "Shield",
  diamond: "Diamond",
  moon: "Moon",
  leaf: "Leaf"
};

/**
 * Build an avatar as an <svg> element (never a string, so the
 * markup stays in one place and can be inserted safely).
 */
export function createAvatar(avatarKey, colorKey, extraClass) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 48 48");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "avatar" + (extraClass ? " " + extraClass : ""));
  svg.style.color = AVATAR_COLORS[colorKey] || AVATAR_COLORS.coral;
  svg.innerHTML = AVATAR_PATHS[avatarKey] || AVATAR_PATHS.star;
  return svg;
}

/** The hand illustrations already drawn in main.html, cloned. */
export function createHandIcon(choice) {
  const source = document.querySelector('.choice[data-choice="' + choice + '"] svg');
  if (!source) {
    return null;
  }
  return source.cloneNode(true);
}
