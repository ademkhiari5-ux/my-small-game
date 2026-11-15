/* ============================================================
   Server entry point.

   One Node process does three jobs:
     1. serves the game files (main.html, css, js)
     2. answers a few small JSON endpoints
     3. runs the realtime WebSocket that carries the 1v1 game

   Start it with:  npm start
   Then open:      http://localhost:3000
   ============================================================ */

"use strict";

const http = require("node:http");
const path = require("node:path");

const { WebSocketServer } = require("ws");

const { Lobby } = require("./lobby");
const { Store } = require("./store");
const { LIMITS } = require("./protocol");
const { serveFile, sendJson } = require("./static");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_DATA_FILE = path.join(ROOT_DIR, "data", "game-data.json");
const DEFAULT_PORT = Number(process.env.PORT) || 3000;

const WS_PATH = "/ws";
const HEARTBEAT_MS = 30000;

/**
 * Build the whole server without starting it, so tests can listen on
 * port 0 and use their own throwaway data file.
 */
function createServer(options = {}) {
  const rootDir = options.rootDir || ROOT_DIR;
  const store = options.store || new Store(options.dataFile || DEFAULT_DATA_FILE);
  const lobby = new Lobby({ store, timings: options.timings });

  const httpServer = http.createServer((request, response) => {
    handleHttp(request, response, { rootDir, store, lobby });
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.maxMessageBytes,
    clientTracking: true
  });

  /* ---------- HTTP upgrade → WebSocket ---------- */

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname !== WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  /* ---------- WebSocket connections ---------- */

  let connectionsSeen = 0;

  wss.on("connection", (socket) => {
    connectionsSeen += 1;
    const connectionId = "c" + connectionsSeen + "-" + Date.now().toString(36);
    socket.isAlive = true;
    socket.messageBudget = LIMITS.maxMessagesPerSecond;
    socket.budgetResetAt = Date.now() + 1000;

    const emit = (type, payload) => {
      if (socket.readyState !== socket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({ type, ...(payload || {}) }));
    };

    lobby.connect(connectionId, emit);

    socket.on("pong", () => {
      socket.isAlive = true;
    });

    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        return;
      }

      /* Flood guard: at most N messages per second per socket. */
      const now = Date.now();
      if (now > socket.budgetResetAt) {
        socket.messageBudget = LIMITS.maxMessagesPerSecond;
        socket.budgetResetAt = now + 1000;
      }
      socket.messageBudget -= 1;
      if (socket.messageBudget < 0) {
        emit("error", { code: "rate-limited", message: "Slow down a little." });
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        emit("error", { code: "bad-json", message: "Messages must be JSON." });
        return;
      }

      try {
        lobby.handleMessage(connectionId, parsed);
      } catch (error) {
        console.error("[ws] handler crashed:", error);
        emit("error", { code: "server-error", message: "Something went wrong." });
      }
    });

    socket.on("close", () => {
      try {
        lobby.disconnect(connectionId);
      } catch (error) {
        console.error("[ws] disconnect crashed:", error);
      }
    });

    socket.on("error", () => {
      /* The close handler does the cleanup. */
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  async function close() {
    clearInterval(heartbeat);
    for (const socket of wss.clients) {
      socket.close(1001, "Server shutting down");
    }
    wss.close();
    lobby.shutdown();
    await new Promise((resolve) => httpServer.close(() => resolve()));
  }

  return { httpServer, wss, store, lobby, close };
}
/* ---------- plain HTTP ---------- */

function handleHttp(request, response, context) {
  const { rootDir, store, lobby } = context;
  const url = new URL(request.url || "/", "http://localhost");

  if (url.pathname === "/api/health") {
    const activeMatches = [...lobby.matches.values()].filter((match) => !match.isFinished()).length;
    sendJson(response, 200, {
      ok: true,
      online: lobby.sessions.size,
      waiting: lobby.queue.length,
      activeMatches,
      uptimeSeconds: Math.round(process.uptime())
    });
    return;
  }

  if (url.pathname === "/api/leaderboard") {
    sendJson(response, 200, { players: store.getLeaderboard(8) });
    return;
  }

  if (url.pathname === "/api/history") {
    sendJson(response, 200, { matches: store.getRecentMatches(8) });
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  serveFile(rootDir, response, url.pathname);
}

/* ---------- run directly (npm start) ---------- */

if (require.main === module) {
  const { httpServer, store } = createServer();

  httpServer.listen(DEFAULT_PORT, () => {
    console.log("");
    console.log("  Rock · Paper · Scissors — 1v1 server");
    console.log("  ───────────────────────────────────");
    console.log("  Play at   http://localhost:" + DEFAULT_PORT);
    console.log("  Sockets   ws://localhost:" + DEFAULT_PORT + WS_PATH);
    console.log("  Data      data/game-data.json");
    console.log("");
  });

  const shutdown = () => {
    console.log("\n  Saving data and closing…");
    store.flush();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { createServer };
