/* ============================================================
   The WebSocket to the game server.

   Two jobs beyond "send and receive":
     • reconnect on its own when the connection drops
     • keep a clock offset so countdowns and round timers line up
       with the server's clock, not the player's
   ============================================================ */

const RECONNECT_DELAYS = [400, 800, 1600, 3200, 6400];
const PING_INTERVAL_MS = 8000;

export function createSocket(options) {
  const path = options.path || "/ws";
  const onMessage = options.onMessage || (() => {});
  const onStatus = options.onStatus || (() => {});

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = protocol + "//" + window.location.host + path;

  let socket = null;
  let closedByPlayer = false;
  let attempt = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let clockSamples = [];
  let status = "idle";

  function setStatus(next) {
    status = next;
    onStatus(next);
  }

  /* ---------- clock sync ---------- */

  function recordSample(serverTime, sentAt, receivedAt) {
    if (typeof serverTime !== "number") {
      return;
    }
    const roundTrip = receivedAt - sentAt;
    const offset = serverTime - (sentAt + roundTrip / 2);
    clockSamples.push({ offset, roundTrip });
    if (clockSamples.length > 7) {
      clockSamples.shift();
    }
  }

  function bestOffset() {
    if (clockSamples.length === 0) {
      return 0;
    }
    /* The sample with the shortest round trip is the least distorted. */
    let best = clockSamples[0];
    for (const sample of clockSamples) {
      if (sample.roundTrip < best.roundTrip) {
        best = sample;
      }
    }
    return best.offset;
  }

  /** Current time as the server would see it. */
  function serverNow() {
    return Date.now() + bestOffset();
  }

  /* ---------- connection ---------- */

  function connect() {
    closedByPlayer = false;
    setStatus(attempt === 0 ? "connecting" : "reconnecting");

    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }

    socket.addEventListener("open", () => {
      attempt = 0;
      setStatus("open");
      startPinging();
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === "pong") {
        recordSample(message.serverTime, message.t, Date.now());
        return;
      }
      onMessage(message);
    });

    socket.addEventListener("close", () => {
      stopPinging();
      if (closedByPlayer) {
        setStatus("closed");
        return;
      }
      setStatus("offline");
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      /* the close event that follows handles the retry */
    });
  }

  function scheduleReconnect() {
    if (closedByPlayer) {
      return;
    }
    const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
    attempt += 1;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  function startPinging() {
    stopPinging();
    const ping = () => send("ping", { t: Date.now() });
    ping();
    pingTimer = setInterval(ping, PING_INTERVAL_MS);
  }

  function stopPinging() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function send(type, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify({ type, ...(payload || {}) }));
    return true;
  }

  function close() {
    closedByPlayer = true;
    clearTimeout(reconnectTimer);
    stopPinging();
    if (socket) {
      socket.close(1000, "bye");
    }
    setStatus("closed");
  }

  return {
    connect,
    send,
    close,
    serverNow,
    getStatus: () => status,
    get isOpen() {
      return socket !== null && socket.readyState === WebSocket.OPEN;
    }
  };
}
