/* ============================================================
   Lobby, searching and private-room screens.
   ============================================================ */

import { createAvatar } from "./art.js";
import { AVATAR_LABELS } from "./art.js";
import { AVATAR_KEYS, COLOR_KEYS } from "./identity.js";
import { formatDuration, restartAnimation } from "./views.js";

export function createLobbyView(options) {
  const onIdentityChange = options.onIdentityChange || (() => {});

  const el = {
    nameInput: document.getElementById("name-input"),
    avatarPicker: document.getElementById("avatar-picker"),
    colorPicker: document.getElementById("color-picker"),
    avatarPreview: document.getElementById("lobby-avatar"),
    previewName: document.getElementById("lobby-preview-name"),
    recordText: document.getElementById("record-text"),
    onlineCount: document.getElementById("online-count"),
    lobbyError: document.getElementById("lobby-error"),
    searchingTimer: document.getElementById("searching-timer"),
    searchingStatus: document.getElementById("searching-status"),
    roomCode: document.getElementById("room-code"),
    roomPlayers: document.getElementById("room-players"),
    roomHint: document.getElementById("room-hint"),
    roomError: document.getElementById("room-error"),
    leaderboardCard: document.getElementById("leaderboard-card"),
    leaderboardList: document.getElementById("leaderboard-list")
  };

  let identity = options.identity;
  let searchStartedAt = 0;
  let searchTicker = null;

  /* ---------- profile ---------- */

  function renderProfile(nextIdentity) {
    identity = nextIdentity;

    if (el.nameInput && document.activeElement !== el.nameInput) {
      el.nameInput.value = identity.name;
    }

    if (el.avatarPreview) {
      el.avatarPreview.innerHTML = "";
      el.avatarPreview.appendChild(createAvatar(identity.avatar, identity.color));
    }

    if (el.previewName) {
      el.previewName.textContent = identity.name || "Player";
    }

    renderPickers();
  }

  function renderPickers() {
    if (el.avatarPicker) {
      el.avatarPicker.innerHTML = "";
      for (const key of AVATAR_KEYS) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "swatch" + (identity.avatar === key ? " swatch--on" : "");
        button.title = AVATAR_LABELS[key] || key;
        button.setAttribute("aria-label", AVATAR_LABELS[key] || key);
        button.setAttribute("aria-pressed", String(identity.avatar === key));
        button.appendChild(createAvatar(key, identity.color));
        button.addEventListener("click", () => {
          onIdentityChange({ avatar: key });
        });
        el.avatarPicker.appendChild(button);
      }
    }

    if (el.colorPicker) {
      el.colorPicker.innerHTML = "";
      for (const key of COLOR_KEYS) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "color-dot" + (identity.color === key ? " color-dot--on" : "");
        button.dataset.color = key;
        button.setAttribute("aria-label", key + " avatar colour");
        button.setAttribute("aria-pressed", String(identity.color === key));
        button.addEventListener("click", () => {
          onIdentityChange({ color: key });
        });
        el.colorPicker.appendChild(button);
      }
    }
  }

  function setRecord(profile) {
    if (!el.recordText) {
      return;
    }
    if (!profile) {
      el.recordText.textContent = "New challenger";
      return;
    }
    el.recordText.textContent = profile.wins + "W · " + profile.losses + "L";
  }

  /* ---------- searching ---------- */

  function startSearching(since, waitingCount) {
    searchStartedAt = since || Date.now();
    if (el.searchingStatus) {
      el.searchingStatus.textContent = waitingCount > 1
        ? waitingCount + " players in the queue"
        : "Looking for someone to play…";
    }
    stopSearchTicker();
    const tick = () => {
      if (el.searchingTimer) {
        el.searchingTimer.textContent = formatDuration(Date.now() - searchStartedAt);
      }
    };
    tick();
    searchTicker = setInterval(tick, 250);
  }

  function stopSearching() {
    stopSearchTicker();
  }

  function stopSearchTicker() {
    if (searchTicker) {
      clearInterval(searchTicker);
      searchTicker = null;
    }
  }

  /* ---------- private room ---------- */

  function renderRoom(payload) {
    if (el.roomCode) {
      el.roomCode.textContent = payload.code;
    }
    if (el.roomPlayers) {
      el.roomPlayers.innerHTML = "";
      for (const player of payload.players) {
        const chip = document.createElement("div");
        chip.className = "room-chip" + (player.id === payload.youId ? " room-chip--you" : "");

        const avatar = document.createElement("div");
        avatar.className = "room-chip__avatar";
        avatar.appendChild(createAvatar(player.avatar, player.color));
        chip.appendChild(avatar);

        const name = document.createElement("span");
        name.className = "room-chip__name";
        name.textContent = player.name;
        chip.appendChild(name);

        const role = document.createElement("span");
        role.className = "room-chip__role";
        role.textContent = player.id === payload.hostId ? "Host" : "Guest";
        chip.appendChild(role);

        el.roomPlayers.appendChild(chip);
      }

      const waiting = document.createElement("div");
      waiting.className = "room-chip room-chip--empty";
      waiting.textContent = payload.players.length > 1 ? "Both players ready" : "Waiting for friend…";
      el.roomPlayers.appendChild(waiting);
    }

    if (el.roomHint) {
      el.roomHint.textContent = payload.players.length > 1
        ? "Both players are in — match starting…"
        : "Share this code with a friend";
    }
  }

  /* ---------- errors ---------- */

  function showError(element, text) {
    if (!element) {
      return;
    }
    element.textContent = text;
    element.hidden = false;
    restartAnimation(element, "is-new");
  }

  function hideError(element) {
    if (!element) {
      return;
    }
    element.hidden = true;
    element.textContent = "";
  }

  function setOnlineCount(count, waiting) {
    if (!el.onlineCount) {
      return;
    }
    el.onlineCount.textContent = count + " online" + (waiting ? " · " + waiting + " waiting" : "");
  }

  /* ---------- leaderboard ---------- */

  function renderLeaderboard(players) {
    if (!el.leaderboardCard || !el.leaderboardList) {
      return;
    }
    if (!players || players.length === 0) {
      el.leaderboardCard.hidden = true;
      return;
    }
    el.leaderboardCard.hidden = false;
    el.leaderboardList.innerHTML = "";

    players.forEach((player, index) => {
      const row = document.createElement("div");
      row.className = "leaderboard__row";

      const rank = document.createElement("span");
      rank.className = "leaderboard__rank";
      rank.textContent = String(index + 1);
      row.appendChild(rank);

      const avatar = document.createElement("span");
      avatar.className = "leaderboard__avatar";
      avatar.appendChild(createAvatar(player.avatar, player.color));
      row.appendChild(avatar);

      const name = document.createElement("span");
      name.className = "leaderboard__name";
      name.textContent = player.name;
      row.appendChild(name);

      const score = document.createElement("span");
      score.className = "leaderboard__score";
      score.textContent = player.wins + "W";
      row.appendChild(score);

      el.leaderboardList.appendChild(row);
    });
  }

  return {
    el,
    renderProfile,
    setRecord,
    startSearching,
    stopSearching,
    renderRoom,
    showError,
    hideError,
    setOnlineCount,
    renderLeaderboard
  };
}
