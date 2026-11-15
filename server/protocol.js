/* ============================================================
   Shared protocol constants and validation helpers.

   Everything that decides a winner lives on this side of the
   wire. The browser only ever *sends* a hand ("rock"), never a
   score, never a round result — those are computed here.
   ============================================================ */

"use strict";

/* The three legal hands. Anything else is rejected by the server. */
const HANDS = ["rock", "paper", "scissors"];

/* Which hand each hand beats. */
const BEATS = {
  rock: "scissors",
  paper: "rock",
  scissors: "paper"
};

/* Points needed to win a 1v1 match. */
const MATCH_GOAL = 5;

/* Timings in milliseconds. Tests override these to run fast. */
const TIMINGS = {
  countdownMs: 3400,       /* total time from match start to round 1 */
  countTickMs: 1000,       /* spacing of the 3 / 2 / 1 / GO ticks */
  roundMs: 7000,           /* how long a player has to pick a hand */
  revealMs: 2400,          /* how long the round result stays on screen */
  lockResolveMs: 300       /* pause after both players locked in */
};

/* Avatar artwork keys the client is allowed to ask for. */
const AVATARS = ["bolt", "star", "crown", "flame", "shield", "diamond", "moon", "leaf"];

/* Avatar colours. Solid tones that fit the existing cream/orange design. */
const COLORS = ["coral", "teal", "amber", "plum", "moss", "slate"];

/* Hard limits that protect the server from abusive sockets. */
const LIMITS = {
  maxMessageBytes: 2048,
  maxMessagesPerSecond: 40,
  maxNameLength: 16,
  maxMatchesKept: 200
};

/* ---------- rules ---------- */

/**
 * Compare two hands.
 * @returns {"a"|"b"|"tie"} which side wins the round
 */
function compareHands(handA, handB) {
  if (handA === handB) {
    return "tie";
  }
  return BEATS[handA] === handB ? "a" : "b";
}

/* ---------- sanitising ---------- */

/**
 * Make a display name safe: no control characters, no markup
 * characters that would need escaping later, sane length.
 */
function sanitizeName(rawName, fallback) {
  const base = typeof rawName === "string" ? rawName : "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITS.maxNameLength);

  return cleaned.length > 0 ? cleaned : fallback;
}

function sanitizeKey(rawValue, allowed, fallback) {
  return allowed.includes(rawValue) ? rawValue : fallback;
}

/** Uppercase, unambiguous room code check (no 0/O, 1/I/L). */
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

function isRoomCode(value) {
  return typeof value === "string" && ROOM_CODE_PATTERN.test(value);
}

function isHand(value) {
  return HANDS.includes(value);
}

/**
 * Round ids look like "abc123:2:1" (match id : rematch number : round number)
 * so a stale or forged round id can never touch the current round.
 */
function makeRoundId(matchId, matchNumber, roundNumber) {
  return matchId + ":" + matchNumber + ":" + roundNumber;
}

module.exports = {
  HANDS,
  BEATS,
  MATCH_GOAL,
  TIMINGS,
  AVATARS,
  COLORS,
  LIMITS,
  compareHands,
  sanitizeName,
  sanitizeKey,
  isRoomCode,
  isHand,
  makeRoundId
};
