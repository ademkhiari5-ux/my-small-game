"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { Match, PHASE } = require("../server/match");

const PLAYER_A = { id: "p-a", name: "Ana", avatar: "bolt", color: "coral" };
const PLAYER_B = { id: "p-b", name: "Ben", avatar: "moon", color: "slate" };

/* Fast timings so a whole match runs in a few hundred milliseconds. */
const FAST = {
  countdownMs: 120,
  countTickMs: 40,
  roundMs: 400,
  revealMs: 40,
  lockResolveMs: 10
};

const WAIT_MS = 3000;

/**
 * Build a Match with a fake socket layer: every message the engine sends
 * is buffered per player and can be awaited by type.
 */
function harness(options = {}) {
  const buffer = [];
  const waiters = [];
  const finished = [];

  const match = new Match({
    id: options.id || "match-1",
    mode: options.mode || "quick",
    roomCode: options.roomCode || null,
    players: [PLAYER_A, PLAYER_B],
    timings: options.timings || FAST,
    sendTo: (playerId, type, payload) => deliver({ playerId, type, payload }),
    onFinish: (summary) => {
      finished.push(summary);
      return options.stats || [];
    }
  });

  function deliver(message) {
    const waiterIndex = waiters.findIndex(
      (waiter) => waiter.playerId === message.playerId && waiter.type === message.type
    );
    if (waiterIndex !== -1) {
      const waiter = waiters.splice(waiterIndex, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message.payload);
      return;
    }
    buffer.push(message);
  }

  function next(playerId, type, timeoutMs = WAIT_MS) {
    const index = buffer.findIndex(
      (message) => message.playerId === playerId && message.type === type
    );
    if (index !== -1) {
      return Promise.resolve(buffer.splice(index, 1)[0].payload);
    }
    return new Promise((resolve, reject) => {
      const waiter = { playerId, type, resolve };
      waiter.timer = setTimeout(() => {
        const pending = waiters.indexOf(waiter);
        if (pending !== -1) {
          waiters.splice(pending, 1);
        }
        reject(new Error("timed out waiting for " + type + " for " + playerId));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  return { match, next, finished, buffer };
}

test("a started match announces both players and the goal", async (t) => {
  const { match, next } = harness();
  t.after(() => match.destroy());

  match.start();

  const forA = await next(PLAYER_A.id, "match:start");
  const forB = await next(PLAYER_B.id, "match:start");

  assert.equal(forA.goal, 5);
  assert.equal(forA.matchId, "match-1");
  assert.equal(forA.players.length, 2);
  assert.deepEqual(
    forA.players.map((player) => player.name).sort(),
    ["Ana", "Ben"]
  );
  assert.equal(forB.players.length, 2);
  assert.equal(match.phase, PHASE.countdown);
});

test("the countdown counts down and then the round opens", async (t) => {
  const { match, next } = harness();
  t.after(() => match.destroy());

  match.start();

  const firstTick = await next(PLAYER_A.id, "match:countdown");
  const goTick = await next(PLAYER_A.id, "match:countdown");

  assert.ok(firstTick.value >= 1, "the countdown starts at a number");
  assert.equal(goTick.value, 0, "GO comes after the number");

  const round = await next(PLAYER_A.id, "match:round");
  assert.equal(round.roundNumber, 1);
  assert.equal(typeof round.roundId, "string");
  assert.equal(round.durationMs, FAST.roundMs);
  assert.equal(round.scores[PLAYER_A.id], 0);
  assert.equal(match.phase, PHASE.open);
});

test("a full round scores the winning hand", async (t) => {
  const { match, next } = harness();
  t.after(() => match.destroy());

  match.start();
  const round = await next(PLAYER_A.id, "match:round");

  match.submitChoice(PLAYER_A.id, round.roundId, "rock");
  match.submitChoice(PLAYER_B.id, round.roundId, "scissors");

  const ack = await next(PLAYER_A.id, "match:choice-ack");
  assert.equal(ack.choice, "rock");

  const resultForA = await next(PLAYER_A.id, "match:round-result");
  const resultForB = await next(PLAYER_B.id, "match:round-result");

  assert.equal(resultForA.result, "win");
  assert.equal(resultForB.result, "lose");
  assert.equal(resultForA.choices.you, "rock");
  assert.equal(resultForA.choices.opponent, "scissors");
  assert.equal(resultForA.scores[PLAYER_A.id], 1);
  assert.equal(resultForB.scores[PLAYER_B.id], 0);
});

test("a tie gives nobody a point", async (t) => {
  const { match, next } = harness();
  t.after(() => match.destroy());

  match.start();
  const round = await next(PLAYER_A.id, "match:round");

  match.submitChoice(PLAYER_A.id, round.roundId, "paper");
  match.submitChoice(PLAYER_B.id, round.roundId, "paper");

  const result = await next(PLAYER_A.id, "match:round-result");
  assert.equal(result.result, "tie");
  assert.equal(result.scores[PLAYER_A.id], 0);
  assert.equal(result.scores[PLAYER_B.id], 0);
});

test("the opponent is told when the other player locks in", async (t) => {
  const { match, next } = harness();
  t.after(() => match.destroy());

  match.start();
  const round = await next(PLAYER_B.id, "match:round");

  match.submitChoice(PLAYER_A.id, round.roundId, "rock");

  const notice = await next(PLAYER_B.id, "match:opponent-locked");
  assert.equal(notice.roundId, round.roundId);
});

test("picking twice in one round is rejected", async (t) => {
  const { match, next } = harness();
  t.after(() => match.destroy());

  match.start();
  const round = await next(PLAYER_A.id, "match:round");

  assert.deepEqual(match.submitChoice(PLAYER_A.id, round.roundId, "rock"), { ok: true });
  const second = match.submitChoice(PLAYER_A.id, round.roundId, "paper");

  assert.equal(second.ok, false);
  assert.equal(second.code, "already-locked");
});

test("a forged round id or hand is rejected", async (t) => {
  const { match, next } = harness();
  t.after(() => match.destroy());

  match.start();
  const round = await next(PLAYER_A.id, "match:round");

  const stale = match.submitChoice(PLAYER_A.id, "made-up:1:1", "rock");
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale-round");

  const badHand = match.submitChoice(PLAYER_A.id, round.roundId, "banana");
  assert.equal(badHand.ok, false);
  assert.equal(badHand.code, "bad-choice");

  const outsider = match.submitChoice("intruder", round.roundId, "rock");
  assert.equal(outsider.ok, false);
  assert.equal(outsider.code, "not-in-match");

  assert.equal(match.scores.get(PLAYER_A.id), 0);
});

test("a choice made before the round opens does not count", async (t) => {
  const { match } = harness();
  t.after(() => match.destroy());

  match.start();

  const early = match.submitChoice(PLAYER_A.id, "match-1:1:1", "rock");
  assert.equal(early.ok, false);
  assert.equal(early.code, "round-closed");
});

test("whoever picks before the deadline takes the point when the other waits", async (t) => {
  const { match, next } = harness({
    timings: { ...FAST, roundMs: 80 }
  });
  t.after(() => match.destroy());

  match.start();
  const round = await next(PLAYER_A.id, "match:round");
  match.submitChoice(PLAYER_A.id, round.roundId, "paper");

  const result = await next(PLAYER_A.id, "match:round-result");
  assert.equal(result.reason, "timeout");
  assert.equal(result.result, "win");
  assert.equal(result.choices.opponent, null);
  assert.equal(result.scores[PLAYER_A.id], 1);
});

test("nobody picking means no point and no winner", async (t) => {
  const { match, next } = harness({
    timings: { ...FAST, roundMs: 70 }
  });
  t.after(() => match.destroy());

  match.start();
  await next(PLAYER_A.id, "match:round");

  const result = await next(PLAYER_A.id, "match:round-result");
  assert.equal(result.result, "tie");
  assert.equal(result.winnerId, null);
  assert.equal(result.scores[PLAYER_A.id], 0);
});
test("the first player to five points wins the match", async (t) => {
  const { match, next, finished } = harness({
    stats: [
      { playerId: PLAYER_A.id, profile: { id: PLAYER_A.id, wins: 1, losses: 0, matches: 1 } },
      { playerId: PLAYER_B.id, profile: { id: PLAYER_B.id, wins: 0, losses: 1, matches: 1 } }
    ]
  });
  t.after(() => match.destroy());

  match.start();

  for (let roundNumber = 1; roundNumber <= 5; roundNumber += 1) {
    const round = await next(PLAYER_A.id, "match:round");
    match.submitChoice(PLAYER_A.id, round.roundId, "rock");
    match.submitChoice(PLAYER_B.id, round.roundId, "scissors");
    const result = await next(PLAYER_A.id, "match:round-result");
    assert.equal(result.scores[PLAYER_A.id], roundNumber);
  }

  const endForA = await next(PLAYER_A.id, "match:end");
  const endForB = await next(PLAYER_B.id, "match:end");

  assert.equal(endForA.youWon, true);
  assert.equal(endForA.reason, "score");
  assert.equal(endForA.scores.you, 5);
  assert.equal(endForA.scores.opponent, 0);
  assert.equal(endForA.you.wins, 1);
  assert.equal(endForB.youWon, false);
  assert.equal(endForB.reason, "score");

  assert.equal(finished.length, 1);
  assert.equal(finished[0].winnerId, PLAYER_A.id);
  assert.equal(finished[0].rounds, 5);
  assert.equal(match.isFinished(), true);
});

test("leaving mid-match hands the win to the opponent", async (t) => {
  const { match, next } = harness();
  t.after(() => match.destroy());

  match.start();
  await next(PLAYER_A.id, "match:round");

  match.forfeit(PLAYER_A.id, "left");

  const end = await next(PLAYER_B.id, "match:end");
  assert.equal(end.youWon, true);
  assert.equal(end.reason, "left");
  assert.equal(end.winnerId, PLAYER_B.id);
});

test("a disconnect is reported as its own reason", async (t) => {
  const { match, next } = harness();
  t.after(() => match.destroy());

  match.start();
  await next(PLAYER_A.id, "match:round");

  match.forfeit(PLAYER_B.id, "disconnect");

  const end = await next(PLAYER_A.id, "match:end");
  assert.equal(end.reason, "disconnect");
  assert.equal(end.youWon, true);
});

test("a finished match cannot be scored again", async (t) => {
  const { match, next } = harness();
  t.after(() => match.destroy());

  match.start();
  const round = await next(PLAYER_A.id, "match:round");
  match.forfeit(PLAYER_A.id, "left");
  await next(PLAYER_B.id, "match:end");

  const late = match.submitChoice(PLAYER_B.id, round.roundId, "rock");
  assert.equal(late.ok, false);
});

test("a rematch needs both players to agree", async (t) => {
  const { match, next } = harness();
  t.after(() => match.destroy());

  match.start();
  await next(PLAYER_A.id, "match:start");
  await next(PLAYER_B.id, "match:start");
  await next(PLAYER_A.id, "match:round");
  match.forfeit(PLAYER_A.id, "left");
  await next(PLAYER_B.id, "match:end");

  match.requestRematch(PLAYER_A.id);
  const update = await next(PLAYER_B.id, "match:rematch-update");
  assert.equal(update.you, false);
  assert.equal(update.opponent, true);
  assert.equal(match.matchNumber, 1, "one vote does not restart anything");

  match.requestRematch(PLAYER_B.id);

  const restarted = await next(PLAYER_B.id, "match:start");
  assert.equal(restarted.matchNumber, 2);
  assert.equal(restarted.players[0].score, 0);
  assert.equal(restarted.players[1].score, 0);
  assert.equal(match.matchNumber, 2);
  assert.equal(match.scores.get(PLAYER_A.id), 0);
});

test("destroy stops the match and tells both players", async (t) => {
  const { match, next } = harness();
  t.after(() => match.destroy());

  match.start();
  await next(PLAYER_A.id, "match:round");

  match.destroy("closed");

  const closed = await next(PLAYER_A.id, "match:closed");
  assert.equal(closed.reason, "closed");
  assert.equal(match.isFinished(), true);

  const late = match.submitChoice(PLAYER_A.id, match.roundId, "rock");
  assert.equal(late.ok, false);
});

test("the snapshot only exposes what the browser is allowed to see", async (t) => {
  const { match } = harness();
  t.after(() => match.destroy());

  match.start();

  const snapshot = match.snapshot();
  assert.equal(snapshot.matchId, "match-1");
  assert.equal(snapshot.players.length, 2);
  assert.equal(snapshot.players[0].score, 0);
  assert.equal("choices" in snapshot, false);
  assert.equal("timers" in snapshot, false);
});

test("a rematch round id never collides with the first match", async (t) => {
  const { match, next } = harness();
  t.after(() => match.destroy());

  match.start();
  await next(PLAYER_A.id, "match:start");
  await next(PLAYER_B.id, "match:start");
  const firstRound = await next(PLAYER_A.id, "match:round");

  match.forfeit(PLAYER_A.id, "left");
  await next(PLAYER_B.id, "match:end");
  match.requestRematch(PLAYER_A.id);
  match.requestRematch(PLAYER_B.id);

  const secondRound = await next(PLAYER_A.id, "match:round");
  assert.notEqual(secondRound.roundId, firstRound.roundId);
  assert.match(secondRound.roundId, /^match-1:2:1$/);
});
