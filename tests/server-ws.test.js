"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { WebSocket } = require("ws");
const { createServer } = require("../server/index");

const FAST = {
  countdownMs: 120,
  countTickMs: 40,
  roundMs: 1500,
  revealMs: 40,
  lockResolveMs: 10
};

const WAIT_MS = 6000;

function tempDataFile() {
  return path.join(os.tmpdir(), "rps-ws-" + crypto.randomUUID() + ".json");
}

async function startServer(t) {
  const dataFile = tempDataFile();
  const app = createServer({ dataFile, timings: FAST });

  await new Promise((resolve) => app.httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = app.httpServer.address();

  t.after(async () => {
    await app.close();
    fs.rmSync(dataFile, { force: true });
    fs.rmSync(dataFile + ".tmp", { force: true });
  });

  return {
    app,
    origin: "http://127.0.0.1:" + port,
    wsUrl: "ws://127.0.0.1:" + port + "/ws"
  };
}

/** A minimal client: send JSON, await a message by type. */
function connectClient(url) {
  const socket = new WebSocket(url);
  const inbox = [];
  const waiters = [];

  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const index = waiters.findIndex((waiter) => waiter.type === message.type);
    if (index !== -1) {
      const waiter = waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    inbox.push(message);
  });

  function next(type, timeoutMs = WAIT_MS) {
    const index = inbox.findIndex((message) => message.type === type);
    if (index !== -1) {
      return Promise.resolve(inbox.splice(index, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve };
      waiter.timer = setTimeout(() => {
        const pending = waiters.indexOf(waiter);
        if (pending !== -1) {
          waiters.splice(pending, 1);
        }
        reject(new Error(
          "timed out waiting for " + type + "; buffered: [" +
          inbox.map((message) => message.type).join(", ") + "]"
        ));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  function send(type, payload) {
    socket.send(JSON.stringify({ type, ...(payload || {}) }));
  }

  async function close() {
    if (socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise((resolve) => {
      socket.once("close", resolve);
      socket.close();
    });
  }

  return { socket, opened, next, send, close };
}

async function joinGame(wsUrl, name, token = null) {
  const client = connectClient(wsUrl);
  await client.opened;
  client.send("hello", { token, name, avatar: "bolt", color: "coral" });
  const welcome = await client.next("welcome");
  return { client, welcome };
}
test("hello creates a player and returns a private token", async (t) => {
  const { wsUrl } = await startServer(t);

  const { client, welcome } = await joinGame(wsUrl, "Alice");
  t.after(() => client.close());

  assert.equal(typeof welcome.token, "string");
  assert.ok(welcome.token.length >= 32);
  assert.equal(welcome.profile.name, "Alice");
  assert.equal(welcome.profile.wins, 0);
  assert.equal(welcome.profile.losses, 0);
  assert.equal(welcome.limits.goal, 5);

  /* The token identifies the player but is never broadcast. */
  const asJson = JSON.stringify(welcome);
  assert.equal(asJson.includes("token\":\"" + welcome.profile.id), false);
});

test("a returning token restores the same player", async (t) => {
  const { wsUrl } = await startServer(t);

  const first = await joinGame(wsUrl, "Alice");
  t.after(() => first.client.close());
  await first.client.close();

  const second = await joinGame(wsUrl, "Alice Again", first.welcome.token);
  t.after(() => second.client.close());

  assert.equal(second.welcome.profile.id, first.welcome.profile.id);
  assert.equal(second.welcome.profile.name, "Alice Again");
});

test("talking before hello is refused", async (t) => {
  const { wsUrl } = await startServer(t);

  const client = connectClient(wsUrl);
  t.after(() => client.close());
  await client.opened;

  client.send("queue:join");

  const error = await client.next("error");
  assert.equal(error.code, "not-ready");
});

test("unknown message types are refused", async (t) => {
  const { wsUrl } = await startServer(t);

  const { client } = await joinGame(wsUrl, "Alice");
  t.after(() => client.close());

  client.send("match:cheat", { points: 999 });

  const error = await client.next("error");
  assert.equal(error.code, "bad-message");
});

test("ping is answered with the server clock", async (t) => {
  const { wsUrl } = await startServer(t);

  const { client } = await joinGame(wsUrl, "Alice");
  t.after(() => client.close());

  client.send("ping", { t: 1234 });

  const pong = await client.next("pong");
  assert.equal(pong.t, 1234);
  assert.ok(Math.abs(pong.serverTime - Date.now()) < 2000);
});

test("a second tab takes over the same player session", async (t) => {
  const { wsUrl } = await startServer(t);

  const first = await joinGame(wsUrl, "Alice");
  t.after(() => first.client.close());

  const second = await joinGame(wsUrl, "Alice", first.welcome.token);
  t.after(() => second.client.close());

  const replaced = await first.client.next("session:replaced");
  assert.match(replaced.message, /another tab/);
});

test("two players in the queue are matched and play to five", async (t) => {
  const { wsUrl, origin } = await startServer(t);

  const alice = await joinGame(wsUrl, "Alice");
  const bob = await joinGame(wsUrl, "Bob");
  t.after(() => alice.client.close());
  t.after(() => bob.client.close());

  alice.client.send("queue:join");
  bob.client.send("queue:join");

  const paired = await alice.client.next("match:paired");
  assert.equal(paired.mode, "quick");

  const startAlice = await alice.client.next("match:start");
  const startBob = await bob.client.next("match:start");

  assert.equal(startAlice.players.length, 2);
  assert.equal(startBob.goal, 5);

  const aliceId = alice.welcome.profile.id;

  for (let round = 1; round <= 5; round += 1) {
    const forAlice = await alice.client.next("match:round");
    const forBob = await bob.client.next("match:round");

    alice.client.send("match:choice", { roundId: forAlice.roundId, choice: "rock" });
    bob.client.send("match:choice", { roundId: forBob.roundId, choice: "scissors" });

    await alice.client.next("match:choice-ack");
    await bob.client.next("match:choice-ack");

    const result = await alice.client.next("match:round-result");
    await bob.client.next("match:round-result");

    assert.equal(result.result, "win");
    assert.equal(result.scores[aliceId], round);
  }

  const end = await alice.client.next("match:end");
  const endForBob = await bob.client.next("match:end");

  assert.equal(end.youWon, true);
  assert.equal(end.scores.you, 5);
  assert.equal(endForBob.youWon, false);

  /* The result is persisted, so the leaderboard and history know about it. */
  const boardResponse = await fetch(origin + "/api/leaderboard");
  const board = await boardResponse.json();
  assert.equal(board.players.length, 2);
  assert.equal(board.players[0].id, aliceId);
  assert.equal(board.players[0].wins, 1);
  assert.equal(board.players[0].losses, 0);
  assert.equal(board.players[1].wins, 0);
  assert.equal(board.players[1].losses, 1);

  const historyResponse = await fetch(origin + "/api/history");
  const history = await historyResponse.json();
  assert.equal(history.matches.length, 1);
  assert.equal(history.matches[0].winnerId, aliceId);
  assert.equal(history.matches[0].rounds, 5);
});

test("a forged round id is rejected and the round is not scored", async (t) => {
  const { wsUrl } = await startServer(t);

  const alice = await joinGame(wsUrl, "Alice");
  const bob = await joinGame(wsUrl, "Bob");
  t.after(() => alice.client.close());
  t.after(() => bob.client.close());

  alice.client.send("queue:join");
  bob.client.send("queue:join");

  const round = await alice.client.next("match:round");
  await bob.client.next("match:round");

  alice.client.send("match:choice", { roundId: "not-the-round:1:1", choice: "rock" });

  const rejected = await alice.client.next("match:rejected");
  assert.equal(rejected.code, "stale-round");

  /* The real round id still works. */
  alice.client.send("match:choice", { roundId: round.roundId, choice: "rock" });
  const ack = await alice.client.next("match:choice-ack");
  assert.equal(ack.choice, "rock");
});

test("a private room can be created and joined by code", async (t) => {
  const { wsUrl } = await startServer(t);

  const host = await joinGame(wsUrl, "Host");
  const guest = await joinGame(wsUrl, "Guest");
  t.after(() => host.client.close());
  t.after(() => guest.client.close());

  host.client.send("room:create");
  const room = await host.client.next("room:update");

  assert.match(room.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(room.hostId, host.welcome.profile.id);
  assert.equal(room.players.length, 1);

  guest.client.send("room:join", { code: room.code });

  await host.client.next("room:ready");
  const readyForGuest = await guest.client.next("room:ready");
  assert.equal(readyForGuest.players.length, 2);

  const startHost = await host.client.next("match:start");
  const startGuest = await guest.client.next("match:start");

  assert.equal(startHost.mode, "private");
  assert.equal(startHost.roomCode, room.code);
  assert.equal(startGuest.players.length, 2);
});

test("a wrong room code is refused", async (t) => {
  const { wsUrl } = await startServer(t);

  const guest = await joinGame(wsUrl, "Guest");
  t.after(() => guest.client.close());

  guest.client.send("room:join", { code: "ZZZZZZ" });

  const error = await guest.client.next("room:error");
  assert.equal(error.code, "no-room");
});

test("joining your own room is refused", async (t) => {
  const { wsUrl } = await startServer(t);

  const host = await joinGame(wsUrl, "Host");
  t.after(() => host.client.close());

  host.client.send("room:create");
  const room = await host.client.next("room:update");

  host.client.send("room:join", { code: room.code });

  const error = await host.client.next("room:error");
  assert.equal(error.code, "own-room");
});

test("leaving a match ends it for the opponent", async (t) => {
  const { wsUrl } = await startServer(t);

  const alice = await joinGame(wsUrl, "Alice");
  const bob = await joinGame(wsUrl, "Bob");
  t.after(() => alice.client.close());
  t.after(() => bob.client.close());

  alice.client.send("queue:join");
  bob.client.send("queue:join");

  await alice.client.next("match:start");
  await bob.client.next("match:start");

  alice.client.send("match:leave");

  const left = await alice.client.next("match:left");
  assert.ok(left);

  const endForBob = await bob.client.next("match:end");
  assert.equal(endForBob.youWon, true);
  assert.equal(endForBob.reason, "left");

  const notice = await bob.client.next("match:opponent-left");
  assert.match(notice.message, /left the match/);
});
