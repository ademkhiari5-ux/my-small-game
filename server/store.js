/* ============================================================
   Persistent storage.

   A tiny JSON "database": player profiles (wins / losses) and a
   capped match history. Writes are debounced and atomic (write to
   a temp file, then rename) so a crash mid-write cannot corrupt
   the file.
   ============================================================ */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { LIMITS } = require("./protocol");

const DEFAULT_DATA = {
  version: 1,
  tokens: {},    /* secret token  -> playerId */
  players: {},   /* playerId     -> profile  */
  matches: []    /* newest first            */
};

const WRITE_DEBOUNCE_MS = 250;

class Store {
  /**
   * @param {string} filePath absolute path of the JSON file
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this.#read();
    this.writeTimer = null;
    this.dirty = false;
  }

  /* ---------- file handling ---------- */

  #read() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        version: 1,
        tokens: parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : {},
        players: parsed.players && typeof parsed.players === "object" ? parsed.players : {},
        matches: Array.isArray(parsed.matches) ? parsed.matches.slice(0, LIMITS.maxMatchesKept) : []
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn("[store] could not read " + this.filePath + " (" + error.message + "), starting fresh");
      }
      return structuredClone(DEFAULT_DATA);
    }
  }

  #scheduleWrite() {
    this.dirty = true;
    if (this.writeTimer) {
      return;
    }
    this.writeTimer = setTimeout(() => this.flush(), WRITE_DEBOUNCE_MS);
    this.writeTimer.unref?.();
  }

  /** Force the pending data to disk right now. Safe to call anytime. */
  flush() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.dirty) {
      return;
    }
    this.dirty = false;

    const directory = path.dirname(this.filePath);
    const tempPath = this.filePath + ".tmp";
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), "utf8");
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      console.warn("[store] could not save (" + error.message + ")");
    }
  }

  /* ---------- players ---------- */

  /**
   * Look a player up by their secret token, or create a new one.
   * The token is the only thing that identifies a returning player,
   * so nobody can claim another player's record.
   */
  identify(token, profile) {
    const knownId = typeof token === "string" ? this.data.tokens[token] : undefined;
    if (knownId && this.data.players[knownId]) {
      const player = this.data.players[knownId];
      /* Keep the latest display choices, but never touch the record. */
      player.name = profile.name;
      player.avatar = profile.avatar;
      player.color = profile.color;
      player.lastSeenAt = Date.now();
      this.#scheduleWrite();
      return { token: token, player: player };
    }

    const newToken = crypto.randomBytes(24).toString("hex");
    const newId = crypto.randomUUID();
    const created = {
      id: newId,
      name: profile.name,
      avatar: profile.avatar,
      color: profile.color,
      wins: 0,
      losses: 0,
      matches: 0,
      createdAt: Date.now(),
      lastSeenAt: Date.now()
    };

    this.data.players[newId] = created;
    this.data.tokens[newToken] = newId;
    this.#scheduleWrite();

    return { token: newToken, player: created };
  }

  getPlayer(playerId) {
    return this.data.players[playerId] || null;
  }

  /** Public shape sent to the browser (never includes the token). */
  publicProfile(playerId) {
    const player = this.getPlayer(playerId);
    if (!player) {
      return null;
    }
    return {
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      color: player.color,
      wins: player.wins,
      losses: player.losses,
      matches: player.matches
    };
  }

  /* ---------- matches ---------- */

  /**
   * Save a finished match and update both players' records.
   * Only called by the server's match engine, never by a client.
   */
  recordMatch(summary) {
    this.data.matches.unshift({
      id: summary.matchId,
      mode: summary.mode,
      goal: summary.goal,
      winnerId: summary.winnerId,
      reason: summary.reason,
      rounds: summary.rounds,
      players: summary.players.map((player) => ({
        id: player.id,
        name: player.name,
        score: player.score
      })),
      endedAt: summary.endedAt
    });

    if (this.data.matches.length > LIMITS.maxMatchesKept) {
      this.data.matches.length = LIMITS.maxMatchesKept;
    }

    for (const entry of summary.players) {
      const player = this.data.players[entry.id];
      if (!player) {
        continue;
      }
      player.matches += 1;
      if (summary.winnerId === entry.id) {
        player.wins += 1;
      } else if (summary.winnerId) {
        player.losses += 1;
      }
    }

    this.#scheduleWrite();
    return summary.players
      .map((entry) => ({ playerId: entry.id, profile: this.publicProfile(entry.id) }))
      .filter((row) => row.profile);
  }

  /** Best players first, for the lobby leaderboard. */
  getLeaderboard(limit = 8) {
    return Object.values(this.data.players)
      .filter((player) => player.matches > 0)
      .sort((first, second) => {
        if (second.wins !== first.wins) {
          return second.wins - first.wins;
        }
        return second.matches - first.matches;
      })
      .slice(0, limit)
      .map((player) => ({
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        color: player.color,
        wins: player.wins,
        losses: player.losses,
        matches: player.matches
      }));
  }

  getRecentMatches(limit = 10) {
    return this.data.matches.slice(0, limit);
  }
}

module.exports = { Store };
