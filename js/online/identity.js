/* ============================================================
   Who you are, remembered in localStorage.

   The name / avatar / colour are cosmetics. The `token` is what
   lets the server recognise you again: it is handed out by the
   server once and never shown to other players.
   ============================================================ */

const STORAGE_KEY = "rps-online-identity";

export const AVATAR_KEYS = ["bolt", "star", "crown", "flame", "shield", "diamond", "moon", "leaf"];

export const COLOR_KEYS = ["coral", "teal", "amber", "plum", "moss", "slate"];

const DEFAULT_IDENTITY = {
  token: null,
  name: "",
  avatar: AVATAR_KEYS[0],
  color: COLOR_KEYS[0]
};

export function loadIdentity() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_IDENTITY, name: suggestName() };
    }
    const parsed = JSON.parse(raw);
    return {
      token: typeof parsed.token === "string" ? parsed.token : null,
      name: typeof parsed.name === "string" ? parsed.name : suggestName(),
      avatar: AVATAR_KEYS.includes(parsed.avatar) ? parsed.avatar : AVATAR_KEYS[0],
      color: COLOR_KEYS.includes(parsed.color) ? parsed.color : COLOR_KEYS[0]
    };
  } catch {
    return { ...DEFAULT_IDENTITY, name: suggestName() };
  }
}

export function saveIdentity(identity) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch {
    /* private mode: the session still works, it just is not remembered */
  }
}

export function suggestName() {
  const adjectives = ["Swift", "Quiet", "Lucky", "Bold", "Sharp", "Calm"];
  const nouns = ["Falcon", "Otter", "Tiger", "Comet", "Panda", "Raven"];
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return adjective + " " + noun;
}
