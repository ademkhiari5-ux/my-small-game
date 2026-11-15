/* ============================================================
   A small static file server.

   Serves the game straight out of the project folder with the
   right content types, a directory-traversal guard and no-cache
   headers so edits show up on refresh.
   ============================================================ */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/* Folders and files that are part of the server, never part of the game. */
const PRIVATE_SEGMENTS = new Set(["server", "data", "tests", "node_modules"]);
const PRIVATE_FILES = new Set(["package.json", "package-lock.json"]);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

/**
 * True for paths that must never reach the browser: the server sources,
 * the saved player database (it holds secret tokens), tests and tooling.
 */
function isPrivatePath(rootDir, absolute) {
  const relative = path.relative(rootDir, absolute);
  if (relative === "") {
    return false;
  }
  const segments = relative.split(path.sep);
  if (segments.some((segment) => segment.startsWith("."))) {
    return true;
  }
  if (PRIVATE_SEGMENTS.has(segments[0])) {
    return true;
  }
  return PRIVATE_FILES.has(segments[segments.length - 1]);
}

/**
 * @param {string} rootDir absolute path of the folder to serve
 * @param {import("node:http").ServerResponse} response
 * @param {string} urlPath the decoded URL path, e.g. "/js/online/app.js"
 */
function serveFile(rootDir, response, urlPath) {
  const cleanPath = urlPath.split("?")[0].split("#")[0];
  const relative = cleanPath === "/" ? "main.html" : cleanPath.replace(/^\/+/, "");
  const absolute = path.resolve(rootDir, relative);

  /* Never serve anything outside the project folder. */
  const rootWithSeparator = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
  if (absolute !== rootDir && !absolute.startsWith(rootWithSeparator)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  /* Never serve the server code, the player database or tooling files. */
  if (isPrivatePath(rootDir, absolute)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  fs.stat(absolute, (statError, stats) => {
    if (statError || !stats.isFile()) {
      sendText(response, 404, "Not found");
      return;
    }

    const extension = path.extname(absolute).toLowerCase();
    const contentType = CONTENT_TYPES[extension] || "application/octet-stream";

    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "X-Content-Type-Options": "nosniff"
    });

    const stream = fs.createReadStream(absolute);
    stream.on("error", () => {
      if (!response.headersSent) {
        sendText(response, 500, "Read error");
      } else {
        response.destroy();
      }
    });
    stream.pipe(response);
  });
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store"
  });
  response.end(text);
}

module.exports = { serveFile, sendJson, sendText };
