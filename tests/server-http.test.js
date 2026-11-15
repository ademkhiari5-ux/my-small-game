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
  return path.join(os.tmpdir(), "rps-server-" + crypto.randomUUID() + ".json");
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

async function fetchText(url) {
  const response = await fetch(url);
  const body = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    body
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}
test("the game page is served at the root", async (t) => {
  const { origin } = await startServer(t);

  const { status, contentType, body } = await fetchText(origin + "/");

  assert.equal(status, 200);
  assert.match(contentType, /text\/html/);
  assert.match(body, /Rock/);
  assert.match(body, /view-online/);
  assert.match(body, /js\/online\/app\.js/);
});

test("stylesheets and modules are served with the right types", async (t) => {
  const { origin } = await startServer(t);

  const css = await fetchText(origin + "/online.css");
  assert.equal(css.status, 200);
  assert.match(css.contentType, /text\/css/);
  assert.match(css.body, /\.pcard/);
  assert.match(css.body, /\.result__card/);
  assert.match(css.body, /\.countdown__value/);

  const module = await fetchText(origin + "/js/online/app.js");
  assert.equal(module.status, 200);
  assert.match(module.contentType, /javascript/);
});

test("missing files are a 404, not a crash", async (t) => {
  const { origin } = await startServer(t);

  const missing = await fetch(origin + "/does-not-exist.js");
  assert.equal(missing.status, 404);

  const directory = await fetch(origin + "/js/online");
  assert.equal(directory.status, 404);
});

test("server files and the saved database are never served", async (t) => {
  const { origin } = await startServer(t);

  const privatePaths = [
    "/package.json",
    "/package-lock.json",
    "/server/store.js",
    "/server/index.js",
    "/data/game-data.json",
    "/tests/store.test.js"
  ];

  for (const urlPath of privatePaths) {
    const response = await fetch(origin + urlPath);
    assert.equal(response.status, 403, urlPath + " must not be served");
  }
});

test("paths that try to climb out of the project are refused", async (t) => {
  const { origin } = await startServer(t);

  const encoded = await fetch(origin + "/%2e%2e/%2e%2e/windows/win.ini");
  assert.notEqual(encoded.status, 200);

  const unencoded = await fetch(origin + "/../package.json");
  assert.notEqual(unencoded.status, 200);
});

test("only GET and HEAD are allowed for static files", async (t) => {
  const { origin } = await startServer(t);

  const response = await fetch(origin + "/online.css", { method: "POST" });
  assert.equal(response.status, 405);
});

test("the health endpoint reports an empty lobby", async (t) => {
  const { origin } = await startServer(t);

  const { status, body } = await fetchJson(origin + "/api/health");

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.online, 0);
  assert.equal(body.waiting, 0);
  assert.equal(body.activeMatches, 0);
  assert.equal(typeof body.uptimeSeconds, "number");
});

test("the leaderboard and history start empty", async (t) => {
  const { origin } = await startServer(t);

  const board = await fetchJson(origin + "/api/leaderboard");
  assert.equal(board.status, 200);
  assert.deepEqual(board.body.players, []);

  const history = await fetchJson(origin + "/api/history");
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.matches, []);
});
