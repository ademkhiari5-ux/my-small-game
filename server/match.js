/* ============================================================
   The match engine.

   A Match is a little state machine that owns everything about
   one 1v1 game: the 3-2-1 countdown, each round's timer, which
   hand each player locked in, the score, the winner, and rematch
   voting.

   It never trusts the browser for anything that matters:
   a client can only ever say "I pick rock", never "I have 4
   points" or "I won". Every decision is made here.
   ============================================================ */

"use strict";

const { MATCH_GOAL, TIMINGS, compareHands, isHand, makeRoundId } = require("./protocol");

const PHASE = {
  idle: "idle",
  countdown: "countdown",
  open: "open",
  reveal: "reveal",
  finished: "finished"
};

class Match {
  /**
   * @param {object} options
   * @param {string} options.id            unique match id
   * @param {"quick"|"private"} options.mode
   * @param {string} [options.roomCode]
   * @param {Array<{id:string,name:string,avatar:string,color:string}>} options.players exactly two
   * @param {object} [options.timings]     overrides for protocol TIMINGS
   * @param {(playerId:string, type:string, payload:object)=>void} options.sendTo
   * @param {(summary:object)=>Array} options.onFinish called once per finished game,
   *        returns the updated player stats to attach to the end message
   */
  constructor(options) {
    this.id = options.id;
    this.mode = options.mode;
    this.roomCode = options.roomCode || null;
    this.timings = { ...TIMINGS, ...(options.timings || {}) };
    this.sendTo = options.sendTo;
    this.onFinish = options.onFinish;

    this.players = options.players.map((player) => ({
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      color: player.color
    }));

    this.goal = MATCH_GOAL;
    this.scores = new Map(this.players.map((player) => [player.id, 0]));
    this.phase = PHASE.idle;
    this.matchNumber = 1;
    this.roundNumber = 0;
    this.roundId = null;
    this.roundDeadline = 0;
    this.choices = new Map();
    this.lockedBy = new Set();
    this.rematchVotes = new Set();
    this.roundHistory = [];
    this.timers = new Set();
    this.startedAt = 0;
    this.endedAt = 0;
    this.destroyed = false;
  }

  /* ---------- public API ---------- */

  isPlayer(playerId) {
    return this.players.some((player) => player.id === playerId);
  }

  opponentOf(playerId) {
    return this.players.find((player) => player.id !== playerId) || null;
  }

  isFinished() {
    return this.phase === PHASE.finished;
  }

  /** Kick off the countdown and then round 1. Also used for a rematch. */
  start() {
    if (this.destroyed) {
      return;
    }
    this.#clearTimers();
    this.phase = PHASE.countdown;
    this.roundNumber = 0;
    this.choices.clear();
    this.lockedBy.clear();
    this.rematchVotes.clear();
    this.startedAt = Date.now();

    const now = Date.now();
    this.#sendBoth("match:start", () => ({
      matchId: this.id,
      mode: this.mode,
      roomCode: this.roomCode,
      goal: this.goal,
      matchNumber: this.matchNumber,
      players: this.players.map((player) => this.#playerState(player.id)),
      countdownMs: this.timings.countdownMs,
      startedAt: now,
      serverTime: now
    }));

    /* Ticks: 3 → 2 → 1 … then GO */
    const tickCount = Math.max(1, Math.round((this.timings.countdownMs - 400) / this.timings.countTickMs));
    for (let index = 0; index < tickCount; index += 1) {
      const value = tickCount - index;
      this.#later(() => {
        this.#sendBoth("match:countdown", () => ({ value, serverTime: Date.now() }));
      }, index * this.timings.countTickMs);
    }
    this.#later(() => {
      this.#sendBoth("match:countdown", () => ({ value: 0, serverTime: Date.now() }));
    }, this.#goTickDelay(tickCount));

    this.#later(() => this.#openRound(), this.timings.countdownMs);
  }

  /**
   * A player picked a hand.
   * @returns {{ok:true}|{ok:false,code:string,message:string}}
   */
  submitChoice(playerId, roundId, choice) {
    if (this.destroyed || this.phase !== PHASE.open) {
      return fail("round-closed", "This round is not open.");
    }
    if (!this.isPlayer(playerId)) {
      return fail("not-in-match", "You are not in this match.");
    }
    if (roundId !== this.roundId) {
      return fail("stale-round", "That round has already finished.");
    }
    if (!isHand(choice)) {
      return fail("bad-choice", "Unknown hand.");
    }
    if (this.lockedBy.has(playerId)) {
      return fail("already-locked", "You already locked in this round.");
    }

    this.lockedBy.add(playerId);
    this.choices.set(playerId, choice);

    /* Confirm to the picker, tell the opponent "they are ready". */
    this.sendTo(playerId, "match:choice-ack", {
      roundId: this.roundId,
      choice,
      lockedAt: Date.now(),
      serverTime: Date.now()
    });
    const opponent = this.opponentOf(playerId);
    if (opponent) {
      this.sendTo(opponent.id, "match:opponent-locked", {
        roundId: this.roundId,
        serverTime: Date.now()
      });
    }

    if (this.lockedBy.size === 2) {
      this.#clearTimers();
      this.#later(() => this.#resolveRound("played"), this.timings.lockResolveMs);
    }

    return { ok: true };
  }

  /** A player closed the tab, lost connection, or pressed Leave. */
  forfeit(playerId, reason) {
    if (this.destroyed || this.phase === PHASE.finished) {
      return;
    }
    const opponent = this.opponentOf(playerId);
    if (!opponent) {
      return;
    }
    this.#finish(opponent.id, reason || "forfeit");
  }

  /**
   * After a finished game either player can ask for a rematch.
   * It starts as soon as both have asked.
   */
  requestRematch(playerId) {
    if (this.destroyed || this.phase !== PHASE.finished || !this.isPlayer(playerId)) {
      return;
    }
    this.rematchVotes.add(playerId);

    const votes = this.players.map((player) => player.id).filter((id) => this.rematchVotes.has(id));
    this.#sendBoth("match:rematch-update", (viewerId) => {
      const opponent = this.opponentOf(viewerId);
      return {
        requested: votes,
        you: this.rematchVotes.has(viewerId),
        opponent: opponent ? this.rematchVotes.has(opponent.id) : false,
        serverTime: Date.now()
      };
    });

    if (votes.length === this.players.length) {
      this.matchNumber += 1;
      this.roundHistory = [];
      for (const player of this.players) {
        this.scores.set(player.id, 0);
      }
      this.start();
    }
  }

  /** Tear the match down. */
  destroy(reason = "closed") {
    if (this.destroyed) {
      return;
    }
    this.#clearTimers();
    this.destroyed = true;
    this.phase = PHASE.finished;
    this.#sendBoth("match:closed", () => ({ reason, serverTime: Date.now() }));
  }

  /** Everything the browser is allowed to know about this match. */
  snapshot() {
    return {
      matchId: this.id,
      mode: this.mode,
      goal: this.goal,
      matchNumber: this.matchNumber,
      roundNumber: this.roundNumber,
      phase: this.phase,
      players: this.players.map((player) => this.#playerState(player.id))
    };
  }

  /* ---------- internals ---------- */

  /**
   * When "GO" is shown: after the last number, but never so late that
   * it lands on the same instant the first round opens.
   */
  #goTickDelay(tickCount) {
    const afterLastNumber = tickCount * this.timings.countTickMs;
    const margin = Math.min(250, Math.round(this.timings.countdownMs / 4));
    const latest = Math.max(0, this.timings.countdownMs - margin);
    return Math.min(afterLastNumber, latest);
  }

  #playerState(playerId) {
    const player = this.players.find((entry) => entry.id === playerId);
    return {
      id: playerId,
      name: player ? player.name : "Player",
      avatar: player ? player.avatar : "star",
      color: player ? player.color : "coral",
      score: this.scores.get(playerId) || 0
    };
  }

  #openRound() {
    if (this.destroyed || this.phase === PHASE.finished) {
      return;
    }
    this.roundNumber += 1;
    this.roundId = makeRoundId(this.id, this.matchNumber, this.roundNumber);
    this.phase = PHASE.open;
    this.choices.clear();
    this.lockedBy.clear();
    this.roundDeadline = Date.now() + this.timings.roundMs;

    this.#sendBoth("match:round", () => ({
      roundId: this.roundId,
      roundNumber: this.roundNumber,
      durationMs: this.timings.roundMs,
      endsAt: this.roundDeadline,
      scores: Object.fromEntries(this.scores),
      serverTime: Date.now()
    }));

    this.#later(() => this.#resolveRound("timeout"), this.timings.roundMs);
  }

  #resolveRound(reason) {
    if (this.destroyed || this.phase !== PHASE.open) {
      return;
    }
    this.#clearTimers();
    this.phase = PHASE.reveal;

    const [first, second] = this.players;
    const firstChoice = this.choices.get(first.id) || null;
    const secondChoice = this.choices.get(second.id) || null;

    let winnerId = null;

    if (firstChoice && secondChoice) {
      const result = compareHands(firstChoice, secondChoice);
      if (result === "a") {
        winnerId = first.id;
      } else if (result === "b") {
        winnerId = second.id;
      }
    } else if (firstChoice && !secondChoice) {
      /* You did not pick in time: the round goes to the player who did. */
      winnerId = first.id;
    } else if (!firstChoice && secondChoice) {
      winnerId = second.id;
    }

    if (winnerId) {
      this.scores.set(winnerId, (this.scores.get(winnerId) || 0) + 1);
    }

    this.roundHistory.push({
      roundId: this.roundId,
      roundNumber: this.roundNumber,
      choices: { [first.id]: firstChoice, [second.id]: secondChoice },
      winnerId,
      reason
    });

    const nextRoundInMs = this.timings.revealMs;
    const scoresNow = Object.fromEntries(this.scores);

    for (const player of this.players) {
      const opponent = this.opponentOf(player.id);
      let resultForPlayer = "tie";
      if (winnerId === player.id) {
        resultForPlayer = "win";
      } else if (opponent && winnerId === opponent.id) {
        resultForPlayer = "lose";
      }

      this.sendTo(player.id, "match:round-result", {
        roundId: this.roundId,
        roundNumber: this.roundNumber,
        choices: {
          you: this.choices.get(player.id) || null,
          opponent: this.choices.get(opponent.id) || null
        },
        result: resultForPlayer,
        reason,
        winnerId,
        scores: scoresNow,
        nextRoundInMs,
        serverTime: Date.now()
      });
    }

    const matchFinished = [...this.scores.values()].some((score) => score >= this.goal);
    this.#later(() => {
      if (this.destroyed) {
        return;
      }
      if (matchFinished) {
        const leader = [...this.scores.entries()].sort((a, b) => b[1] - a[1])[0];
        this.#finish(leader[0], "score");
      } else {
        this.#openRound();
      }
    }, nextRoundInMs);
  }

  #finish(winnerId, reason) {
    if (this.destroyed || this.phase === PHASE.finished) {
      return;
    }
    this.#clearTimers();
    this.phase = PHASE.finished;
    this.endedAt = Date.now();

    const summary = {
      matchId: this.id,
      mode: this.mode,
      roomCode: this.roomCode,
      goal: this.goal,
      matchNumber: this.matchNumber,
      winnerId,
      reason,
      rounds: this.roundHistory.length,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      players: this.players.map((player) => ({
        id: player.id,
        name: player.name,
        score: this.scores.get(player.id) || 0
      }))
    };

    let stats = [];
    try {
      stats = this.onFinish ? this.onFinish(summary) || [] : [];
    } catch (error) {
      console.error("[match] onFinish failed:", error);
    }

    const statsById = {};
    for (const row of stats) {
      statsById[row.playerId] = row.profile;
    }

    for (const player of this.players) {
      const opponent = this.opponentOf(player.id);
      this.sendTo(player.id, "match:end", {
        matchId: this.id,
        mode: this.mode,
        goal: this.goal,
        winnerId,
        youWon: winnerId === player.id,
        reason,
        scores: {
          you: this.scores.get(player.id) || 0,
          opponent: this.scores.get(opponent.id) || 0
        },
        players: this.players.map((entry) => ({
          id: entry.id,
          name: entry.name,
          avatar: entry.avatar,
          color: entry.color,
          score: this.scores.get(entry.id) || 0
        })),
        you: statsById[player.id] || null,
        opponentStats: statsById[opponent.id] || null,
        rematchOpen: true,
        serverTime: Date.now()
      });
    }
  }

  #sendBoth(type, payloadFactory) {
    for (const player of this.players) {
      this.sendTo(player.id, type, payloadFactory(player.id));
    }
  }

  #later(callback, ms) {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      try {
        callback();
      } catch (error) {
        console.error("[match] timer failed:", error);
      }
    }, ms);
    this.timers.add(handle);
    return handle;
  }

  #clearTimers() {
    for (const handle of this.timers) {
      clearTimeout(handle);
    }
    this.timers.clear();
  }
}

function fail(code, message) {
  return { ok: false, code, message };
}

module.exports = { Match, PHASE };
