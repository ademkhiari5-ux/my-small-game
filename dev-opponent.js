/* Temporary helper: a bot opponent used to check the online UI by hand.
   Delete this file when the check is done. */

"use strict";

const { WebSocket } = require("ws");

const URL = "ws://127.0.0.1:3000/ws";
const PICK = process.argv[2] || "scissors";
const DELAY_MS = Number(process.argv[3]) || 700;

const socket = new WebSocket(URL);

socket.on("open", () => {
  socket.send(JSON.stringify({
    type: "hello",
    token: null,
    name: "Bot Faucon",
    avatar: "bolt",
    color: "moss"
  }));
  socket.send(JSON.stringify({ type: "queue:join" }));
});

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());

  if (message.type === "match:round") {
    console.log("round " + message.roundNumber + " open, picking " + PICK);
    setTimeout(() => {
      socket.send(JSON.stringify({
        type: "match:choice",
        roundId: message.roundId,
        choice: PICK
      }));
    }, DELAY_MS);
  }

  if (message.type === "match:end") {
    console.log("match over: " + (message.youWon ? "bot won" : "bot lost") + " " +
      message.scores.you + "-" + message.scores.opponent);
    socket.close();
  }

  if (message.type === "room:update" || message.type === "match:start") {
    console.log(message.type);
  }
});

socket.on("close", () => process.exit(0));
