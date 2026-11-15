"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HANDS,
  MATCH_GOAL,
  compareHands,
  sanitizeName,
  sanitizeKey,
  isRoomCode,
  isHand,
  makeRoundId
} = require("../server/protocol");

test("compareHands follows the classic rules", () => {
  assert.equal(compareHands("rock", "scissors"), "a");
  assert.equal(compareHands("paper", "rock"), "a");
  assert.equal(compareHands("scissors", "paper"), "a");

  assert.equal(compareHands("scissors", "rock"), "b");
  assert.equal(compareHands("rock", "paper"), "b");
  assert.equal(compareHands("paper", "scissors"), "b");
});

test("compareHands calls identical hands a tie", () => {
  for (const hand of HANDS) {
    assert.equal(compareHands(hand, hand), "tie");
  }
});

test("compareHands never lets an unknown hand win", () => {
  /* "b" means the second hand wins, so an unknown hand loses either way. */
  assert.equal(compareHands("lizard", "rock"), "b");
  assert.equal(compareHands("rock", "spock"), "b");
  assert.equal(compareHands("lizard", "spock"), "b");
});

test("isHand only accepts the three real hands", () => {
  assert.equal(isHand("rock"), true);
  assert.equal(isHand("paper"), true);
  assert.equal(isHand("scissors"), true);
  assert.equal(isHand("ROCK"), false);
  assert.equal(isHand(" lizard "), false);
  assert.equal(isHand(null), false);
  assert.equal(isHand(3), false);
});

test("sanitizeName strips markup, control characters and extra space", () => {
  assert.equal(sanitizeName("  Ada   Lovelace  ", "Player"), "Ada Lovelace");
  assert.equal(sanitizeName("<b>Bob</b>", "Player"), "bBob/b");
  assert.equal(sanitizeName("a\u0000b\u001fc", "Player"), "abc");
  assert.equal(sanitizeName("", "Player 1"), "Player 1");
  assert.equal(sanitizeName("    ", "Player 1"), "Player 1");
  assert.equal(sanitizeName(null, "Player 1"), "Player 1");
});

test("sanitizeName caps the length at 16 characters", () => {
  const longName = "a".repeat(60);
  assert.equal(sanitizeName(longName, "Player").length, 16);
});

test("sanitizeKey falls back for anything not on the allow list", () => {
  assert.equal(sanitizeKey("teal", ["coral", "teal"], "coral"), "teal");
  assert.equal(sanitizeKey("neon", ["coral", "teal"], "coral"), "coral");
  assert.equal(sanitizeKey(undefined, ["coral"], "coral"), "coral");
  assert.equal(sanitizeKey("__proto__", ["coral"], "coral"), "coral");
});

test("isRoomCode accepts readable six-character codes only", () => {
  assert.equal(isRoomCode("ABC234"), true);
  assert.equal(isRoomCode("ZZZZZZ"), true);

  assert.equal(isRoomCode("ABC23"), false, "too short");
  assert.equal(isRoomCode("ABC2345"), false, "too long");
  assert.equal(isRoomCode("ABC230"), false, "0 is not in the alphabet");
  assert.equal(isRoomCode("ABC23O"), false, "O is not in the alphabet");
  assert.equal(isRoomCode("ABC23I"), false, "I is not in the alphabet");
  assert.equal(isRoomCode("abc234"), false, "lowercase is rejected");
  assert.equal(isRoomCode(null), false);
});

test("makeRoundId encodes match, rematch and round", () => {
  assert.equal(makeRoundId("m1", 2, 7), "m1:2:7");
  assert.notEqual(makeRoundId("m1", 1, 1), makeRoundId("m1", 2, 1));
});

test("the match goal is the documented five points", () => {
  assert.equal(MATCH_GOAL, 5);
});
