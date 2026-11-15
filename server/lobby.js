/* ============================================================
   The lobby: sockets, matchmaking queue, private rooms, matches.
   ============================================================ */

"use strict";

const crypto = require("node:crypto");

const { Match } = require("./match");
const {
  AVATARS,
  COLORS,
  TIMINGS,
  MATCH_GOAL,
  sanitizeName,
  sanitizeKey,
  isRoomCode,
  isHand
} = require("./protocol");

/* Every message the browser is allowed to send. Anything else is dropped. */
const CLIENT_MESSAGES = new Set([
  "hello",
  "profile:update",
  "queue:join",
  "queue:leave",
  "room:create",
  "room:join",
  "room:leave",
  "match:choice",
  "match:rematch",
  "match:leave",
  "ping"
]);

/* No 0/O, 1/I/L — codes people can read out loud. */
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_MAX_AGE_MS = 30 * 60 * 1000;

class Lobby {
  constructor(options) {
    this.store = options.store;
    this.timings = options.timings || null;

    this.sessions = new Map();   /* connectionId -> session */
    this.byPlayer = new Map();   /* playerId     -> session */
    this.queue = [];             /* connectionIds waiting, oldest first */
    this.rooms = new Map();      /* roomCode     -> room */
    this.matches = new Map();    /* matchId      -> Match */

    this.sweepTimer = setInterval(() => this.#sweep(), 60 * 1000);
    this.sweepTimer.unref?.();
  }

  /* ---------- socket lifecycle ---------- */

  connect(connectionId, emit) {
    const session = {
      connectionId,
      emit,
      playerId: null,
      token: null,
      name: "",
      avatar: AVATARS[0],
      color: COLORS[0],
      queuedAt: 0,
      roomCode: null,
      matchId: null,
      superseded: false,
      connectedAt: Date.now()
    };
    this.sessions.set(connectionId, session);
    return session;
  }

  disconnect(connectionId) {
    const session = this.sessions.get(connectionId);
    if (!session) {
      return;
    }
    this.sessions.delete(connectionId);

    if (session.superseded) {
      return;
    }

    this.#removeFromQueue(session);

    if (session.roomCode) {
      const room = this.rooms.get(session.roomCode);
      if (room && !room.matchId) {
        this.rooms.delete(session.roomCode);
        this.#notifyRoom(room, "room:closed", { code: room.code, reason: "host-left" });
      }
    }

    if (session.matchId) {
      const match = this.matches.get(session.matchId);
      if (match && !match.isFinished()) {
        match.forfeit(session.playerId, "disconnect");
      }
    }

    if (session.playerId && this.byPlayer.get(session.playerId) === session) {
      this.byPlayer.delete(session.playerId);
    }
  }
/* ---------- message routing ---------- */

  handleMessage(connectionId, message) {
    const session = this.sessions.get(connectionId);
    if (!session || !message || typeof message !== "object") {
      return;
    }
    const type = message.type;
    if (typeof type !== "string" || !CLIENT_MESSAGES.has(type)) {
      this.#send(session, "error", { code: "bad-message", message: "Unknown message." });
      return;
    }

    /* Everything except "hello" and "ping" needs an identified player. */
    if (!session.playerId && type !== "hello" && type !== "ping") {
      this.#send(session, "error", { code: "not-ready", message: "Say hello first." });
      return;
    }

    switch (type) {
      case "hello":
        this.#handleHello(session, message);
        break;
      case "profile:update":
        this.#handleProfileUpdate(session, message);
        break;
      case "queue:join":
        this.#joinQueue(session);
        break;
      case "queue:leave":
        this.#removeFromQueue(session, true);
        break;
      case "room:create":
        this.#createRoom(session);
        break;
      case "room:join":
        this.#joinRoom(session, message);
        break;
      case "room:leave":
        this.#leaveRoom(session);
        break;
      case "match:choice":
        this.#handleChoice(session, message);
        break;
      case "match:rematch":
        this.#handleRematch(session);
        break;
      case "match:leave":
        this.#leaveMatch(session);
        break;
      case "ping":
        this.#send(session, "pong", {
          t: typeof message.t === "number" ? message.t : null,
          serverTime: Date.now()
        });
        break;
      default:
        break;
    }
  }

  statsFor(playerId) {
    return this.store.publicProfile(playerId);
  }

  /* ---------- identity ---------- */

  #handleHello(session, message) {
    const name = sanitizeName(message.name, "Player " + (this.byPlayer.size + 1));
    const avatar = sanitizeKey(message.avatar, AVATARS, AVATARS[0]);
    const color = sanitizeKey(message.color, COLORS, COLORS[0]);
    const token = typeof message.token === "string" ? message.token : null;

    const identity = this.store.identify(token, { name, avatar, color });
    const player = identity.player;

    /* Same player opening a second tab: the newest socket wins. */
    const previous = this.byPlayer.get(player.id);
    if (previous && previous !== session) {
      previous.superseded = true;
      previous.emit("session:replaced", { message: "This game was opened in another tab." });
      this.#removeFromQueue(previous);
      if (previous.matchId) {
        session.matchId = previous.matchId;
        previous.matchId = null;
      }
      previous.playerId = null;
    }

    session.playerId = player.id;
    session.token = identity.token;
    session.name = name;
    session.avatar = avatar;
    session.color = color;
    this.byPlayer.set(player.id, session);

    this.#send(session, "welcome", {
      token: identity.token,
      profile: this.store.publicProfile(player.id),
      serverTime: Date.now(),
      limits: { roundMs: TIMINGS.roundMs, goal: MATCH_GOAL }
    });

    /* Reconnected into a live match? Restore the view. */
    if (session.matchId) {
      const match = this.matches.get(session.matchId);
      if (match) {
        this.#send(session, "match:resync", { ...match.snapshot(), serverTime: Date.now() });
      }
    }

    this.#sendQueueState(session);

    if (session.roomCode) {
      const room = this.rooms.get(session.roomCode);
      if (room) {
        this.#sendRoomState(room);
      }
    }
  }

  #handleProfileUpdate(session, message) {
    if (session.matchId) {
      const match = this.matches.get(session.matchId);
      if (match && !match.isFinished()) {
        this.#send(session, "error", { code: "in-match", message: "Finish the match first." });
        return;
      }
    }

    session.name = sanitizeName(message.name, session.name);
    session.avatar = sanitizeKey(message.avatar, AVATARS, session.avatar);
    session.color = sanitizeKey(message.color, COLORS, session.color);

    const identity = this.store.identify(session.token, {
      name: session.name,
      avatar: session.avatar,
      color: session.color
    });

    if (identity.player.id !== session.playerId) {
      session.playerId = identity.player.id;
      this.byPlayer.set(identity.player.id, session);
    }

    this.#send(session, "welcome", {
      token: identity.token,
      profile: this.store.publicProfile(session.playerId),
      serverTime: Date.now(),
      limits: { roundMs: TIMINGS.roundMs, goal: MATCH_GOAL }
    });

    if (session.roomCode) {
      const room = this.rooms.get(session.roomCode);
      if (room) {
        this.#sendRoomState(room);
      }
    }
  }
/* ---------- matchmaking queue ---------- */

  #joinQueue(session) {
    if (session.matchId) {
      this.#send(session, "error", { code: "in-match", message: "You are already in a match." });
      return;
    }
    if (session.roomCode) {
      this.#send(session, "error", { code: "in-room", message: "Leave your private room first." });
      return;
    }
    if (this.queue.includes(session.connectionId)) {
      this.#sendQueueState(session);
      return;
    }

    session.queuedAt = Date.now();
    this.queue.push(session.connectionId);
    this.#broadcastQueue();

    this.#tryPair();
  }

  #removeFromQueue(session, notify = false) {
    const index = this.queue.indexOf(session.connectionId);
    if (index !== -1) {
      this.queue.splice(index, 1);
      session.queuedAt = 0;
      this.#broadcastQueue();
    }
    if (notify) {
      this.#send(session, "queue:update", { state: "idle", waitingCount: this.queue.length });
    }
  }

  /** Pair the two oldest waiting players, as many times as possible. */
  #tryPair() {
    let paired = true;
    while (paired) {
      paired = false;
      const firstId = this.queue[0];
      const secondId = this.queue[1];
      if (!firstId || !secondId) {
        return;
      }

      const first = this.sessions.get(firstId);
      const second = this.sessions.get(secondId);

      this.queue.splice(0, 2);

      if (!first || !second || !first.playerId || !second.playerId || first.playerId === second.playerId) {
        continue;
      }

      first.queuedAt = 0;
      second.queuedAt = 0;
      this.#startMatch("quick", [first, second], null);
      paired = true;
    }
  }

  #broadcastQueue() {
    for (const connectionId of this.queue) {
      const session = this.sessions.get(connectionId);
      if (session) {
        this.#sendQueueState(session);
      }
    }
  }

  #sendQueueState(session) {
    const waiting = this.queue.includes(session.connectionId);
    this.#send(session, "queue:update", {
      state: waiting ? "searching" : "idle",
      since: waiting ? session.queuedAt : 0,
      waitingCount: this.queue.length,
      serverTime: Date.now()
    });
  }

  /* ---------- private rooms ---------- */

  #createRoom(session) {
    if (session.matchId) {
      this.#send(session, "error", { code: "in-match", message: "You are already in a match." });
      return;
    }
    this.#removeFromQueue(session);

    if (session.roomCode) {
      this.#leaveRoom(session);
    }

    const code = this.#generateRoomCode();
    const room = {
      code,
      hostId: session.playerId,
      guestId: null,
      matchId: null,
      createdAt: Date.now()
    };

    this.rooms.set(code, room);
    session.roomCode = code;
    this.#sendRoomState(room);
  }

  #joinRoom(session, message) {
    if (session.matchId) {
      this.#send(session, "error", { code: "in-match", message: "You are already in a match." });
      return;
    }

    const code = typeof message.code === "string" ? message.code.trim().toUpperCase() : "";
    if (!isRoomCode(code)) {
      this.#send(session, "room:error", { code: "bad-code", message: "Room codes look like ABC123." });
      return;
    }

    const room = this.rooms.get(code);
    if (!room) {
      this.#send(session, "room:error", { code: "no-room", message: "No room with that code." });
      return;
    }
    if (room.matchId) {
      this.#send(session, "room:error", { code: "room-full", message: "That match has already started." });
      return;
    }
    if (room.hostId === session.playerId) {
      this.#send(session, "room:error", { code: "own-room", message: "That is your own room code." });
      return;
    }
    if (room.guestId) {
      this.#send(session, "room:error", { code: "room-full", message: "That room is already full." });
      return;
    }

    const host = this.#sessionForPlayer(room.hostId);
    if (!host) {
      this.rooms.delete(code);
      this.#send(session, "room:error", { code: "no-host", message: "The host has left." });
      return;
    }

    this.#removeFromQueue(session);
    room.guestId = session.playerId;
    session.roomCode = code;
    host.roomCode = code;

    this.#sendRoomState(room, "room:ready");
    this.#startMatch("private", [host, session], room);
  }

  #leaveRoom(session) {
    const code = session.roomCode;
    if (!code) {
      this.#send(session, "room:update", { state: "none" });
      return;
    }

    const room = this.rooms.get(code);
    session.roomCode = null;

    if (!room) {
      this.#send(session, "room:update", { state: "none" });
      return;
    }

    if (room.matchId) {
      /* The room is hosting a match: leaving it means leaving the match. */
      this.#leaveMatch(session);
      return;
    }

    const other = room.hostId === session.playerId ? room.guestId : room.hostId;
    this.rooms.delete(code);

    if (other) {
      const otherSession = this.#sessionForPlayer(other);
      if (otherSession) {
        otherSession.roomCode = null;
        this.#send(otherSession, "room:closed", { code, reason: "left" });
      }
    }

    this.#send(session, "room:update", { state: "none" });
  }

  #sendRoomState(room, type = "room:update") {
    const host = this.#sessionForPlayer(room.hostId);
    const guest = room.guestId ? this.#sessionForPlayer(room.guestId) : null;
    const players = [host, guest].filter(Boolean).map((session) => this.#playerSummary(session));

    for (const session of [host, guest]) {
      if (!session) {
        continue;
      }
      this.#send(session, type, {
        code: room.code,
        hostId: room.hostId,
        youId: session.playerId,
        players,
        state: room.matchId ? "playing" : "waiting",
        serverTime: Date.now()
      });
    }
  }

  #notifyRoom(room, type, payload) {
    for (const playerId of [room.hostId, room.guestId]) {
      if (playerId) {
        this.#sendToPlayer(playerId, type, payload);
      }
    }
  }

  #generateRoomCode() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const bytes = crypto.randomBytes(6);
      let code = "";
      for (let index = 0; index < 6; index += 1) {
        code += ROOM_CODE_ALPHABET[bytes[index] % ROOM_CODE_ALPHABET.length];
      }
      if (!this.rooms.has(code)) {
        return code;
      }
    }
    throw new Error("Could not allocate a room code");
  }
/* ---------- matches ---------- */

  #startMatch(mode, sessions, room) {
    const matchId = crypto.randomUUID();
    const players = sessions.map((session) => this.#playerSummary(session));

    const match = new Match({
      id: matchId,
      mode,
      roomCode: room ? room.code : null,
      players,
      timings: this.timings || undefined,
      sendTo: (playerId, type, payload) => this.#sendToPlayer(playerId, type, payload),
      onFinish: (summary) => this.#recordFinishedMatch(summary)
    });

    this.matches.set(matchId, match);

    for (const session of sessions) {
      session.matchId = matchId;
      this.#send(session, "match:paired", {
        matchId,
        mode,
        roomCode: room ? room.code : null,
        serverTime: Date.now()
      });
    }

    if (room) {
      room.matchId = matchId;
      this.#sendRoomState(room);
    }

    match.start();
    return match;
  }

  #recordFinishedMatch(summary) {
    const stats = this.store.recordMatch(summary);

    if (summary.roomCode) {
      const room = this.rooms.get(summary.roomCode);
      if (room) {
        room.matchId = null;
      }
    }

    return stats;
  }

  #handleChoice(session, message) {
    if (!session.matchId) {
      this.#send(session, "error", { code: "no-match", message: "You are not in a match." });
      return;
    }
    const match = this.matches.get(session.matchId);
    if (!match) {
      this.#send(session, "error", { code: "no-match", message: "That match is gone." });
      return;
    }

    /* The server decides if this choice is legal and when it counts. */
    const result = match.submitChoice(session.playerId, message.roundId, message.choice);
    if (!result.ok) {
      this.#send(session, "match:rejected", {
        roundId: typeof message.roundId === "string" ? message.roundId : null,
        code: result.code,
        message: result.message,
        serverTime: Date.now()
      });
    }
  }

  #handleRematch(session) {
    if (!session.matchId) {
      return;
    }
    const match = this.matches.get(session.matchId);
    if (!match) {
      return;
    }
    match.requestRematch(session.playerId);
  }

  #leaveMatch(session) {
    const matchId = session.matchId;
    if (!matchId) {
      this.#send(session, "match:left", { serverTime: Date.now() });
      return;
    }

    const match = this.matches.get(matchId);
    session.matchId = null;

    if (match) {
      if (!match.isFinished()) {
        /* Leaving mid-match is a forfeit: the opponent wins. */
        match.forfeit(session.playerId, "left");
      }

      const opponentSession = this.#sessionForPlayer(
        match.opponentOf(session.playerId) ? match.opponentOf(session.playerId).id : ""
      );
      if (opponentSession) {
        this.#send(opponentSession, "match:opponent-left", {
          message: "Your opponent left the match.",
          serverTime: Date.now()
        });
      } else {
        match.destroy("left");
        this.matches.delete(matchId);
      }
    }

    this.#send(session, "match:left", { serverTime: Date.now() });
    this.#releaseRoom(session);
  }

  #releaseRoom(session) {
    if (!session.roomCode) {
      return;
    }
    const room = this.rooms.get(session.roomCode);
    session.roomCode = null;
    if (!room) {
      return;
    }

    const otherId = room.hostId === session.playerId ? room.guestId : room.hostId;
    const otherSession = otherId ? this.#sessionForPlayer(otherId) : null;
    this.rooms.delete(room.code);

    if (otherSession && otherSession.roomCode === room.code) {
      otherSession.roomCode = null;
      this.#send(otherSession, "room:closed", { code: room.code, reason: "left" });
    }
  }

  /* ---------- helpers ---------- */

  #send(session, type, payload) {
    if (!session || typeof session.emit !== "function") {
      return;
    }
    try {
      session.emit(type, payload);
    } catch (error) {
      console.warn("[lobby] send failed:", error.message);
    }
  }

  #sendToPlayer(playerId, type, payload) {
    const session = this.byPlayer.get(playerId);
    if (session) {
      this.#send(session, type, payload);
    }
  }

  #sessionForPlayer(playerId) {
    return this.byPlayer.get(playerId) || null;
  }

  #playerSummary(session) {
    return {
      id: session.playerId,
      name: session.name,
      avatar: session.avatar,
      color: session.color
    };
  }

  /** Drop empty rooms and finished matches nobody is looking at. */
  #sweep() {
    const now = Date.now();

    for (const [code, room] of this.rooms) {
      const host = this.#sessionForPlayer(room.hostId);
      const guest = room.guestId ? this.#sessionForPlayer(room.guestId) : null;
      const stale = now - room.createdAt > ROOM_MAX_AGE_MS;
      if ((!host && !guest) || (!room.matchId && stale)) {
        this.rooms.delete(code);
      }
    }

    for (const [matchId, match] of this.matches) {
      if (!match.isFinished()) {
        continue;
      }
      const busy = match.players.some((player) => {
        const session = this.#sessionForPlayer(player.id);
        return session && session.matchId === matchId;
      });
      if (!busy) {
        match.destroy("swept");
        this.matches.delete(matchId);
      }
    }
  }

  /** Close everything (used by tests and graceful shutdown). */
  shutdown() {
    clearInterval(this.sweepTimer);
    for (const match of this.matches.values()) {
      match.destroy("shutdown");
    }
    this.matches.clear();
    this.rooms.clear();
    this.queue.length = 0;
    this.sessions.clear();
    this.byPlayer.clear();
    this.store.flush();
  }
}

module.exports = { Lobby, ROOM_CODE_ALPHABET };
