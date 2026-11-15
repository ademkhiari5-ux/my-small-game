"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { Store } = require("../server/store");
const { LIMITS } = require("../server/protocol");

function tempFile() {
  return path.join(os.tmpdir(), "rps-store-" + crypto.randomUUID() + ".json");
}

function cleanUp(filePath, store) {
  if (store) {
    store.flush();
  }
  fs.rmSync(filePath, { force: true });
  fs.rmSync(filePath + ".tmp", { force: true });
}

const PROFILE = { name: "Ada", avatar: "star", color: "teal" };

test("identify creates a new player with an empty record", (t) => {
  const filePath = tempFile();
  const store = new Store(filePath);
  t.after(() => cleanUp(filePath, store));

  const identity = store.identify(null, PROFILE);

  assert.equal(typeof identity.token, "string");
  assert.ok(identity.token.length >= 32, "tokens must be long enough to guess-proof");
  assert.equal(identity.player.name, "Ada");
  assert.equal(identity.player.wins, 0);
  assert.equal(identity.player.losses, 0);
  assert.equal(identity.player.matches, 0);
});

test("the same token always resolves to the same player", (t) => {
  const filePath = tempFile();
  const store = new Store(filePath);
  t.after(() => cleanUp(filePath, store));

  const first = store.identify(null, PROFILE);
  const second = store.identify(first.token, { name: "Ada L", avatar: "crown", color: "plum" });

  assert.equal(second.player.id, first.player.id);
  assert.equal(second.token, first.token);
  assert.equal(second.player.name, "Ada L");
  assert.equal(second.player.avatar, "crown");
});

test("a made-up token cannot claim somebody else's player", (t) => {
  const filePath = tempFile();
  const store = new Store(filePath);
  t.after(() => cleanUp(filePath, store));

  const real = store.identify(null, PROFILE);
  const forged = store.identify("deadbeef", PROFILE);

  assert.notEqual(forged.player.id, real.player.id);
  assert.notEqual(forged.token, "deadbeef");
});

test("publicProfile never leaks the token", (t) => {
  const filePath = tempFile();
  const store = new Store(filePath);
  t.after(() => cleanUp(filePath, store));

  const identity = store.identify(null, PROFILE);
  const profile = store.publicProfile(identity.player.id);

  assert.deepEqual(Object.keys(profile).sort(), [
    "avatar", "color", "id", "losses", "matches", "name", "wins"
  ]);
  assert.equal(JSON.stringify(profile).includes(identity.token), false);
});

test("recordMatch updates wins, losses and the match count", (t) => {
  const filePath = tempFile();
  const store = new Store(filePath);
  t.after(() => cleanUp(filePath, store));

  const winner = store.identify(null, { name: "Winner", avatar: "bolt", color: "coral" });
  const loser = store.identify(null, { name: "Loser", avatar: "moon", color: "slate" });

  const stats = store.recordMatch({
    matchId: "m1",
    mode: "quick",
    goal: 5,
    winnerId: winner.player.id,
    reason: "score",
    rounds: 7,
    endedAt: Date.now(),
    players: [
      { id: winner.player.id, name: "Winner", score: 5 },
      { id: loser.player.id, name: "Loser", score: 3 }
    ]
  });

  assert.equal(stats.length, 2);
  assert.equal(stats[0].profile.wins, 1);
  assert.equal(stats[0].profile.matches, 1);
  assert.equal(stats[1].profile.losses, 1);
  assert.equal(stats[1].profile.matches, 1);

  assert.equal(store.getPlayer(winner.player.id).wins, 1);
  assert.equal(store.getPlayer(loser.player.id).losses, 1);
});

test("a player changing their name keeps their record", (t) => {
  const filePath = tempFile();
  const store = new Store(filePath);
  t.after(() => cleanUp(filePath, store));

  const player = store.identify(null, PROFILE);
  store.recordMatch({
    matchId: "m1",
    mode: "quick",
    goal: 5,
    winnerId: player.player.id,
    reason: "score",
    rounds: 5,
    endedAt: Date.now(),
    players: [
      { id: player.player.id, name: "Ada", score: 5 },
      { id: "someone-else", name: "Ghost", score: 1 }
    ]
  });

  const renamed = store.identify(player.token, { name: "Countess", avatar: "leaf", color: "moss" });

  assert.equal(renamed.player.name, "Countess");
  assert.equal(renamed.player.wins, 1);
});

test("the leaderboard ranks by wins and hides players with no matches", (t) => {
  const filePath = tempFile();
  const store = new Store(filePath);
  t.after(() => cleanUp(filePath, store));

  const ana = store.identify(null, { name: "Ana", avatar: "star", color: "teal" });
  const ben = store.identify(null, { name: "Ben", avatar: "star", color: "teal" });
  store.identify(null, { name: "Never played", avatar: "star", color: "teal" });

  for (const [winnerId, loserId] of [[ana.player.id, ben.player.id], [ana.player.id, ben.player.id], [ben.player.id, ana.player.id]]) {
    store.recordMatch({
      matchId: crypto.randomUUID(),
      mode: "quick",
      goal: 5,
      winnerId,
      reason: "score",
      rounds: 5,
      endedAt: Date.now(),
      players: [
        { id: winnerId, name: "w", score: 5 },
        { id: loserId, name: "l", score: 2 }
      ]
    });
  }

  const board = store.getLeaderboard(8);
  assert.equal(board.length, 2);
  assert.equal(board[0].name, "Ana");
  assert.equal(board[0].wins, 2);
  assert.equal(board[1].name, "Ben");
  assert.equal(board[1].wins, 1);
});

test("data survives a restart", (t) => {
  const filePath = tempFile();
  const store = new Store(filePath);
  t.after(() => cleanUp(filePath, null));

  const player = store.identify(null, PROFILE);
  store.recordMatch({
    matchId: "m1",
    mode: "private",
    roomCode: "ABC234",
    goal: 5,
    winnerId: player.player.id,
    reason: "score",
    rounds: 6,
    endedAt: Date.now(),
    players: [
      { id: player.player.id, name: "Ada", score: 5 },
      { id: "other", name: "Other", score: 4 }
    ]
  });
  store.flush();

  const reopened = new Store(filePath);
  const again = reopened.identify(player.token, PROFILE);

  assert.equal(again.player.id, player.player.id);
  assert.equal(again.player.wins, 1);
  assert.equal(reopened.getRecentMatches(5).length, 1);
  assert.equal(reopened.getRecentMatches(5)[0].mode, "private");
});

test("a corrupt data file does not stop the server", (t) => {
  const filePath = tempFile();
  fs.writeFileSync(filePath, "{ this is not json", "utf8");
  const store = new Store(filePath);
  t.after(() => cleanUp(filePath, store));

  const identity = store.identify(null, PROFILE);
  assert.equal(identity.player.wins, 0);
});

test("the history is capped", (t) => {
  const filePath = tempFile();
  const store = new Store(filePath);
  t.after(() => cleanUp(filePath, store));

  for (let index = 0; index < LIMITS.maxMatchesKept + 12; index += 1) {
    store.recordMatch({
      matchId: "m" + index,
      mode: "quick",
      goal: 5,
      winnerId: "a",
      reason: "score",
      rounds: 5,
      endedAt: Date.now(),
      players: [
        { id: "a", name: "A", score: 5 },
        { id: "b", name: "B", score: 0 }
      ]
    });
  }

  assert.equal(store.data.matches.length, LIMITS.maxMatchesKept);
  assert.equal(store.getRecentMatches(1)[0].id, "m" + (LIMITS.maxMatchesKept + 11));
});
