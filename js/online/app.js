/* ============================================================
   Controller for the 1v1 mode.

   It connects the socket to the screens: the server says what
   happened, this file decides what to show. It never decides a
   score, a winner or whether a pick counts — those come from the
   server, which is why the game cannot be cheated from here.
   ============================================================ */

import { loadIdentity, saveIdentity } from "./identity.js";
import { createSocket } from "./socket.js";
import { cacheScreens, setConnectionStatus, showScreen } from "./views.js";
import { createLobbyView } from "./lobby-view.js";
import { createMatchView } from "./match-view.js";

const state = {
  identity: loadIdentity(),
  profile: null,
  viewerId: null,
  matchId: null,
  mode: "quick",
  phase: "idle",
  roundId: null,
  locked: false,
  opponent: { id: null, name: "Opponent" },
  online: false,
  healthTimer: null
};

let socket = null;
let lobbyView = null;
let matchView = null;

const dom = {};

/* ---------- boot ---------- */

function init() {
  cacheScreens();

  dom.viewSolo = document.getElementById("view-solo");
  dom.viewOnline = document.getElementById("view-online");
  dom.tabSolo = document.getElementById("tab-solo");
  dom.tabOnline = document.getElementById("tab-online");
  dom.connection = document.getElementById("net-status");
  dom.lobbyError = document.getElementById("lobby-error");
  dom.roomError = document.getElementById("room-error");
  dom.roomCodeInput = document.getElementById("room-code-input");
  dom.copyButton = document.getElementById("copy-code");
  dom.banner = document.getElementById("conn-banner");

  lobbyView = createLobbyView({
    identity: state.identity,
    onIdentityChange: updateIdentity
  });

  matchView = createMatchView({
    serverNow: () => (socket ? socket.serverNow() : Date.now())
  });

  lobbyView.renderProfile(state.identity);
  lobbyView.setRecord(null);
  wireTabs();
  wireLobbyActions();
  wireMatchActions();

  setMode("solo");
}

/* ---------- mode switching ---------- */

function setMode(mode) {
  const isOnline = mode === "online";
  dom.viewSolo.hidden = isOnline;
  dom.viewOnline.hidden = !isOnline;
  dom.tabSolo.classList.toggle("mode-tab--on", !isOnline);
  dom.tabOnline.classList.toggle("mode-tab--on", isOnline);
  dom.tabSolo.setAttribute("aria-selected", String(!isOnline));
  dom.tabOnline.setAttribute("aria-selected", String(isOnline));
  document.body.dataset.mode = mode;

  if (isOnline) {
    ensureConnected();
    showScreen("lobby");
    refreshHealth();
    refreshLeaderboard();
    if (state.healthTimer) {
      clearInterval(state.healthTimer);
    }
    state.healthTimer = setInterval(refreshHealth, 20000);
    if (!state.identity.name) {
      lobbyView.el.nameInput.focus();
    }
  } else if (state.healthTimer) {
    clearInterval(state.healthTimer);
    state.healthTimer = null;
  }
}

function wireTabs() {
  dom.tabSolo.addEventListener("click", () => setMode("solo"));
  dom.tabOnline.addEventListener("click", () => setMode("online"));
}

/* ---------- identity ---------- */

function updateIdentity(patch) {
  state.identity = { ...state.identity, ...patch };
  saveIdentity(state.identity);
  lobbyView.renderProfile(state.identity);
  if (socket && socket.isOpen) {
    socket.send("profile:update", {
      name: state.identity.name,
      avatar: state.identity.avatar,
      color: state.identity.color
    });
  }
}

/* ---------- connection ---------- */

function ensureConnected() {
  if (socket) {
    if (!socket.isOpen) {
      socket.connect();
    }
    return;
  }

  socket = createSocket({
    onMessage: handleMessage,
    onStatus: (status) => {
      setConnectionStatus(dom.connection, status);
      state.online = status === "open";
      if (status === "open") {
        dom.banner.hidden = true;
        sendHello();
      } else if (status === "offline" || status === "reconnecting") {
        showBanner("Connection lost — trying to reconnect…");
      }
    }
  });
  socket.connect();
}

function sendHello() {
  socket.send("hello", {
    token: state.identity.token,
    name: state.identity.name || "Player",
    avatar: state.identity.avatar,
    color: state.identity.color
  });
}

function showBanner(text) {
  if (!dom.banner) {
    return;
  }
  dom.banner.textContent = text;
  dom.banner.hidden = false;
}

/* ---------- lobby actions ---------- */

function wireLobbyActions() {
  const nameInput = lobbyView.el.nameInput;
  if (nameInput) {
    let nameTimer = null;
    nameInput.addEventListener("input", () => {
      clearTimeout(nameTimer);
      nameTimer = setTimeout(() => {
        const value = nameInput.value.trim();
        if (value.length === 0) {
          return;
        }
        updateIdentity({ name: value });
      }, 350);
    });
  }

  document.getElementById("find-match").addEventListener("click", () => {
    lobbyView.hideError(dom.lobbyError);
    ensureConnected();
    socket.send("queue:join");
  });

  document.getElementById("create-room").addEventListener("click", () => {
    lobbyView.hideError(dom.lobbyError);
    ensureConnected();
    socket.send("room:create");
  });

  document.getElementById("join-room").addEventListener("click", joinRoom);
  dom.roomCodeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      joinRoom();
    }
  });
  dom.roomCodeInput.addEventListener("input", () => {
    dom.roomCodeInput.value = dom.roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });

  document.getElementById("cancel-search").addEventListener("click", () => {
    lobbyView.stopSearching();
    socket.send("queue:leave");
    showScreen("lobby");
    state.phase = "idle";
  });

  document.getElementById("cancel-room").addEventListener("click", () => {
    socket.send("room:leave");
    showScreen("lobby");
    state.phase = "idle";
  });

  if (dom.copyButton) {
    dom.copyButton.addEventListener("click", async () => {
      const code = document.getElementById("room-code").textContent;
      try {
        await navigator.clipboard.writeText(code);
        dom.copyButton.textContent = "Copied";
      } catch {
        dom.copyButton.textContent = code;
      }
      setTimeout(() => {
        dom.copyButton.textContent = "Copy";
      }, 1600);
    });
  }
}

function joinRoom() {
  const code = dom.roomCodeInput.value.trim().toUpperCase();
  lobbyView.hideError(dom.lobbyError);
  if (code.length !== 6) {
    lobbyView.showError(dom.lobbyError, "A room code has 6 characters.");
    return;
  }
  ensureConnected();
  socket.send("room:join", { code });
}
/* ---------- match actions ---------- */

function wireMatchActions() {
  matchView.el.choices.querySelectorAll(".choice").forEach((button) => {
    button.addEventListener("click", () => sendChoice(button.dataset.choice));
  });

  matchView.el.leave.addEventListener("click", leaveMatch);
  matchView.el.leaveResult.addEventListener("click", leaveMatch);

  matchView.el.rematch.addEventListener("click", () => {
    if (!socket || !socket.isOpen) {
      return;
    }
    socket.send("match:rematch");
    matchView.setRematchState(true, false);
  });
}

function sendChoice(choice) {
  if (!socket || !socket.isOpen || state.phase !== "round" || state.locked) {
    return;
  }
  state.locked = true;
  matchView.setMessage("Locking in " + choice + "…", "");
  matchView.el.choices.querySelectorAll(".choice").forEach((button) => {
    button.disabled = true;
    button.classList.toggle("choice--picked", button.dataset.choice === choice);
  });

  const sent = socket.send("match:choice", { roundId: state.roundId, choice });
  if (!sent) {
    state.locked = false;
    matchView.setMessage("Not connected — try again.", "lose");
  }
}

function leaveMatch() {
  if (socket && socket.isOpen) {
    socket.send("match:leave");
  }
  resetToLobby();
  refreshLeaderboard();
}

function resetToLobby() {
  state.phase = "idle";
  state.matchId = null;
  state.roundId = null;
  state.locked = false;
  matchView.reset();
  showScreen("lobby");
}

/* ---------- server messages ---------- */

function handleMessage(message) {
  switch (message.type) {
    case "welcome":
      state.identity.token = message.token;
      state.identity.name = message.profile.name;
      saveIdentity(state.identity);
      state.profile = message.profile;
      state.viewerId = message.profile.id;
      lobbyView.setRecord(message.profile);
      break;

    case "queue:update":
      if (message.state === "searching") {
        state.phase = "searching";
        showScreen("searching");
        lobbyView.startSearching(message.since, message.waitingCount);
      } else if (state.phase === "searching") {
        state.phase = "idle";
        lobbyView.stopSearching();
        showScreen("lobby");
      }
      break;

    case "room:update":
    case "room:ready":
      if (message.state === "none") {
        state.phase = "idle";
        showScreen("lobby");
        break;
      }
      state.phase = "room";
      showScreen("room");
      lobbyView.renderRoom(message);
      break;

    case "room:closed":
      state.phase = "idle";
      showScreen("lobby");
      lobbyView.showError(dom.lobbyError, "The room was closed.");
      break;

    case "room:error":
      lobbyView.showError(dom.lobbyError, message.message);
      break;

    case "match:paired":
      state.matchId = message.matchId;
      state.mode = message.mode;
      break;

    case "match:start": {
      state.matchId = message.matchId;
      state.mode = message.mode;
      state.phase = "countdown";
      state.locked = false;
      state.opponentLeft = false;
      const players = matchView.enter(message, state.viewerId);
      state.opponent = {
        id: players.opponent.id,
        name: players.opponent.name || "Opponent"
      };
      break;
    }

    case "match:countdown":
      matchView.showCountdown(message.value);
      break;

    case "match:round":
      state.phase = "round";
      state.roundId = message.roundId;
      state.locked = false;
      matchView.startRound(message);
      break;

    case "match:choice-ack":
      if (message.roundId !== state.roundId) {
        break;
      }
      state.locked = true;
      matchView.setYouLocked(message.choice);
      break;

    case "match:opponent-locked":
      if (message.roundId !== state.roundId) {
        break;
      }
      matchView.setOpponentLocked(state.locked);
      break;

    case "match:round-result":
      if (message.roundId !== state.roundId) {
        break;
      }
      state.phase = "reveal";
      matchView.revealRound(message);
      break;

    case "match:end":
      state.phase = "over";
      matchView.showResult(message, state.opponent.name);
      lobbyView.setRecord(message.you);
      refreshLeaderboard();
      break;

    case "match:rematch-update":
      matchView.setRematchState(Boolean(message.you), Boolean(message.opponent));
      break;

    case "match:opponent-left":
      matchView.setRematchUnavailable("Your opponent left — no rematch.");
      break;

    case "match:left":
    case "match:closed":
      resetToLobby();
      break;

    case "match:rejected":
      if (message.code === "stale-round" || message.code === "round-closed") {
        break;
      }
      state.locked = false;
      matchView.el.choices.querySelectorAll(".choice").forEach((button) => {
        button.disabled = false;
        button.classList.remove("choice--picked");
      });
      matchView.setMessage(message.message, "lose");
      break;

    case "match:resync": {
      if (!message.players || message.players.length < 2) {
        break;
      }
      state.matchId = message.matchId;
      state.phase = "match";
      const snapshot = matchView.enter(
        { goal: message.goal, players: message.players },
        state.viewerId
      );
      state.opponent = { id: snapshot.opponent.id, name: snapshot.opponent.name };
      matchView.setMessage("Reconnected — waiting for the next round.", "");
      break;
    }

    case "session:replaced":
      showBanner(message.message);
      break;

    case "error":
      lobbyView.showError(dom.lobbyError, message.message);
      break;

    default:
      break;
  }
}

/* ---------- server info ---------- */

async function refreshHealth() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();
    lobbyView.setOnlineCount(data.online || 0, data.waiting || 0);
  } catch {
    lobbyView.setOnlineCount(0, 0);
  }
}

async function refreshLeaderboard() {
  try {
    const response = await fetch("/api/leaderboard");
    const data = await response.json();
    lobbyView.renderLeaderboard(data.players || []);
  } catch {
    lobbyView.renderLeaderboard([]);
  }
}

/* ---------- go ---------- */

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
