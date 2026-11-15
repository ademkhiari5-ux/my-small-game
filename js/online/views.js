/* ============================================================
   DOM helpers for the online mode.

   Everything here only *draws*. Deciding what to draw happens in
   app.js after the server tells us what is true.
   ============================================================ */

import { createAvatar, createHandIcon } from "./art.js";

const screens = {};

export function cacheScreens() {
  screens.lobby = document.getElementById("screen-lobby");
  screens.searching = document.getElementById("screen-searching");
  screens.room = document.getElementById("screen-room");
  screens.match = document.getElementById("screen-match");
}

export function showScreen(name) {
  for (const [key, element] of Object.entries(screens)) {
    if (!element) {
      continue;
    }
    element.hidden = key !== name;
  }
  document.body.dataset.onlineScreen = name;
}

/* ---------- player cards ---------- */

/**
 * Fill a card container with avatar, name, score and status.
 * @param {HTMLElement} container
 * @param {{name:string, avatar:string, color:string, score:number}} player
 * @param {{goal:number, isYou:boolean}} options
 */
export function renderPlayerCard(container, player, options) {
  container.innerHTML = "";
  container.dataset.side = options.isYou ? "you" : "opponent";

  const avatarWrap = document.createElement("div");
  avatarWrap.className = "pcard__avatar";
  avatarWrap.appendChild(createAvatar(player.avatar, player.color));
  container.appendChild(avatarWrap);

  const meta = document.createElement("div");
  meta.className = "pcard__meta";

  const name = document.createElement("span");
  name.className = "pcard__name";
  name.textContent = player.name || "Player";
  meta.appendChild(name);

  const status = document.createElement("span");
  status.className = "pcard__status";
  status.dataset.role = "status";
  status.textContent = options.isYou ? "You" : "Opponent";
  meta.appendChild(status);

  container.appendChild(meta);

  const score = document.createElement("span");
  score.className = "pcard__score";
  score.dataset.role = "score";
  score.textContent = String(player.score || 0);
  container.appendChild(score);

  const pips = document.createElement("div");
  pips.className = "pips";
  pips.dataset.role = "pips";
  renderPips(pips, player.score || 0, options.goal);
  container.appendChild(pips);
}

export function renderPips(container, score, goal) {
  container.innerHTML = "";
  for (let index = 0; index < goal; index += 1) {
    const pip = document.createElement("span");
    pip.className = "pip" + (index < score ? " pip--on" : "");
    container.appendChild(pip);
  }
}

/** Update just the score number and the pips (used after a round). */
export function updateScore(card, score, goal) {
  const scoreNode = card.querySelector('[data-role="score"]');
  const pipsNode = card.querySelector('[data-role="pips"]');
  if (scoreNode) {
    if (scoreNode.textContent !== String(score)) {
      scoreNode.textContent = String(score);
      restartAnimation(scoreNode, "score-bump");
    }
  }
  if (pipsNode) {
    renderPips(pipsNode, score, goal);
  }
}

export function setCardStatus(card, text, tone) {
  const status = card.querySelector('[data-role="status"]');
  if (!status) {
    return;
  }
  status.textContent = text;
  status.dataset.tone = tone || "idle";
}

export function setCardActive(card, isActive) {
  card.classList.toggle("pcard--active", Boolean(isActive));
}

/* ---------- arena ---------- */

export function setSlot(slot, choice) {
  slot.innerHTML = "";
  if (!choice) {
    const placeholder = document.createElement("span");
    placeholder.className = "hand__placeholder";
    placeholder.textContent = "?";
    slot.appendChild(placeholder);
    return;
  }
  const icon = createHandIcon(choice);
  if (icon) {
    slot.appendChild(icon);
  }
}

export function shakeArena(arena, animate) {
  arena.classList.toggle("is-revealing", Boolean(animate));
}

/* ---------- messages ---------- */

export function setMessage(element, text, tone) {
  element.textContent = text;
  element.className = "message online-message" + (tone ? " message--" + tone : "");
  restartAnimation(element, "is-new");
}

export function flashError(element, text) {
  element.textContent = text;
  element.hidden = false;
  restartAnimation(element, "is-new");
}

export function hideError(element) {
  element.hidden = true;
  element.textContent = "";
}

/* ---------- misc ---------- */

export function restartAnimation(element, className) {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes + ":" + String(seconds).padStart(2, "0");
}

export function formatReason(reason) {
  switch (reason) {
    case "score":
      return "First to five wins";
    case "left":
      return "Your opponent left the match";
    case "disconnect":
      return "Your opponent lost connection";
    case "timeout":
      return "Time ran out";
    case "forfeit":
      return "Match ended early";
    default:
      return "Match over";
  }
}

export function setConnectionStatus(pill, status) {
  const labels = {
    idle: "Offline",
    connecting: "Connecting…",
    reconnecting: "Reconnecting…",
    open: "Live",
    offline: "Connection lost",
    closed: "Offline"
  };
  pill.textContent = labels[status] || "Offline";
  pill.dataset.state = status;
}
