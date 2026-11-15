/* ============================================================
   The match screen.

   Owns the two player cards, the arena, the round timer bar,
   the big 3-2-1 countdown and the result panel. app.js calls
   these methods when the server sends an event.
   ============================================================ */

import {
  formatReason,
  renderPlayerCard,
  setCardActive,
  setCardStatus,
  setMessage,
  setSlot,
  showScreen,
  updateScore
} from "./views.js";

export function createMatchView(options) {
  const serverNow = options.serverNow;

  const el = {
    cardYou: document.getElementById("card-you"),
    cardOpponent: document.getElementById("card-opponent"),
    goalText: document.getElementById("goal-text"),
    roundLabel: document.getElementById("round-label"),
    timerFill: document.getElementById("round-timer-fill"),
    timerText: document.getElementById("round-timer-text"),
    arena: document.getElementById("online-arena"),
    slotYou: document.getElementById("arena-you-slot"),
    slotOpponent: document.getElementById("arena-opponent-slot"),
    nameYou: document.getElementById("arena-you-name"),
    nameOpponent: document.getElementById("arena-opponent-name"),
    message: document.getElementById("online-message"),
    choices: document.getElementById("online-choices"),
    leave: document.getElementById("leave-match"),
    countdownOverlay: document.getElementById("countdown-overlay"),
    countdownValue: document.getElementById("countdown-value"),
    resultOverlay: document.getElementById("result-overlay"),
    resultEyebrow: document.getElementById("result-eyebrow"),
    resultTitle: document.getElementById("result-title"),
    resultScore: document.getElementById("result-score"),
    resultPlayers: document.getElementById("result-players"),
    resultNote: document.getElementById("result-note"),
    rematch: document.getElementById("rematch"),
    leaveResult: document.getElementById("leave-result"),
    rematchHint: document.getElementById("rematch-hint")
  };

  let goal = 5;
  let roundEndsAt = 0;
  let roundDurationMs = 1;
  let timerFrame = null;
  let countdownTimer = null;
  let youId = null;
  let opponentId = null;
  let opponentName = "Opponent";

  /* ---------- match start ---------- */

  function enter(payload, viewerId) {
    goal = payload.goal || 5;
    const you = payload.players.find((player) => player.id === viewerId) || payload.players[0];
    const opponent = payload.players.find((player) => player.id !== you.id) || payload.players[1];

    youId = you.id;
    opponentId = opponent.id;
    opponentName = opponent.name || "Opponent";

    renderPlayerCard(el.cardYou, you, { goal, isYou: true });
    renderPlayerCard(el.cardOpponent, opponent, { goal, isYou: false });
    el.goalText.textContent = "First to " + goal;
    el.nameYou.textContent = you.name;
    el.nameOpponent.textContent = opponent.name;

    setSlot(el.slotYou, null);
    setSlot(el.slotOpponent, null);
    setCardStatus(el.cardYou, "Ready", "idle");
    setCardStatus(el.cardOpponent, "Ready", "idle");
    setCardActive(el.cardYou, false);
    setCardActive(el.cardOpponent, false);
    el.roundLabel.textContent = "Get ready";
    stopTimer();
    setTimerBar(1);

    el.resultOverlay.hidden = true;
    el.choices.hidden = false;
    el.leave.hidden = false;
    disableChoices(true);
    setMessage(el.message, "Get ready…", "");

    showScreen("match");
    return { you, opponent };
  }

  /* ---------- countdown ---------- */

  function showCountdown(value) {
    el.countdownOverlay.hidden = false;
    el.countdownValue.textContent = value === 0 ? "GO!" : String(value);
    el.countdownOverlay.dataset.value = String(value);
    el.countdownValue.classList.remove("countdown-pop");
    void el.countdownValue.offsetWidth;
    el.countdownValue.classList.add("countdown-pop");

    clearTimeout(countdownTimer);
    countdownTimer = setTimeout(() => {
      el.countdownOverlay.hidden = true;
    }, value === 0 ? 900 : 850);
  }

  function hideCountdown() {
    clearTimeout(countdownTimer);
    el.countdownOverlay.hidden = true;
  }

  /* ---------- one round ---------- */

  function startRound(payload) {
    hideCountdown();
    roundEndsAt = payload.endsAt;
    roundDurationMs = payload.durationMs || 7000;

    el.roundLabel.textContent = "Round " + payload.roundNumber;
    setSlot(el.slotYou, null);
    setSlot(el.slotOpponent, null);
    setCardStatus(el.cardYou, "Choosing…", "active");
    setCardStatus(el.cardOpponent, "Choosing…", "active");
    setCardActive(el.cardYou, true);
    setCardActive(el.cardOpponent, false);
    setMessage(el.message, "Pick your hand.", "");

    disableChoices(false);
    clearChoiceMark();
    el.choices.hidden = false;

    startTimer();
  }

  function setYouLocked(choice) {
    markChoice(choice);
    disableChoices(true);
    setCardStatus(el.cardYou, "Locked in", "locked");
    setCardActive(el.cardYou, false);
    setMessage(el.message, "Locked in — waiting for your opponent.", "");
  }

  function setOpponentLocked(youLocked) {
    setCardStatus(el.cardOpponent, "Locked in", "locked");
    setMessage(
      el.message,
      youLocked ? "Both locked in — revealing…" : opponentName + " is ready — your pick.",
      ""
    );
  }

  function setOpponentChoosing() {
    setCardStatus(el.cardOpponent, "Choosing…", "active");
  }

  /* ---------- reveal ---------- */

  function revealRound(payload) {
    stopTimer();
    setTimerBar(0);
    disableChoices(true);
    setCardActive(el.cardYou, false);
    setCardActive(el.cardOpponent, false);

    setSlot(el.slotYou, payload.choices.you);
    setSlot(el.slotOpponent, payload.choices.opponent);
    el.slotYou.classList.remove("slot-pop");
    el.slotOpponent.classList.remove("slot-pop");
    void el.slotYou.offsetWidth;
    el.slotYou.classList.add("slot-pop");
    el.slotOpponent.classList.add("slot-pop");

    updateScore(el.cardYou, payload.scores[youId] || 0, goal);
    updateScore(el.cardOpponent, payload.scores[opponentId] || 0, goal);

    const youChoice = payload.choices.you;
    const opponentChoice = payload.choices.opponent;

    if (!youChoice && !opponentChoice) {
      setMessage(el.message, "Nobody picked in time — no point.", "tie");
    } else if (!youChoice) {
      setMessage(el.message, "You did not pick in time — point to " + opponentName + ".", "lose");
    } else if (!opponentChoice) {
      setMessage(el.message, opponentName + " did not pick in time — point to you.", "win");
    } else if (payload.result === "win") {
      setMessage(el.message, "You take the round — " + youChoice + " beats " + opponentChoice + ".", "win");
    } else if (payload.result === "lose") {
      setMessage(el.message, opponentName + " takes the round — " + opponentChoice + " beats " + youChoice + ".", "lose");
    } else {
      setMessage(el.message, "Tie — you both picked " + youChoice + ".", "tie");
    }

    setCardStatus(el.cardYou, payload.result === "win" ? "Round won" : payload.result === "lose" ? "Round lost" : "Tie", payload.result);
    setCardStatus(el.cardOpponent, payload.result === "win" ? "Round lost" : payload.result === "lose" ? "Round won" : "Tie", "idle");
    el.choices.hidden = true;
  }

  /* ---------- timer ---------- */

  function startTimer() {
    stopTimer();
    const step = () => {
      const remaining = roundEndsAt - serverNow();
      const ratio = Math.max(0, Math.min(1, remaining / roundDurationMs));
      setTimerBar(ratio);
      el.timerText.textContent = (Math.max(0, remaining) / 1000).toFixed(1) + "s";
      if (remaining <= 0) {
        stopTimer();
        el.timerText.textContent = "0.0s";
        return;
      }
      timerFrame = requestAnimationFrame(step);
    };
    step();
  }

  function stopTimer() {
    if (timerFrame !== null) {
      cancelAnimationFrame(timerFrame);
      timerFrame = null;
    }
  }

  function setTimerBar(ratio) {
    if (el.timerFill) {
      el.timerFill.style.transform = "scaleX(" + Math.max(0, Math.min(1, ratio)) + ")";
      el.timerFill.dataset.low = ratio < 0.3 ? "true" : "false";
    }
  }

  /* ---------- choices ---------- */

  function disableChoices(disabled) {
    el.choices.querySelectorAll(".choice").forEach((button) => {
      button.disabled = disabled;
    });
  }

  function markChoice(choice) {
    el.choices.querySelectorAll(".choice").forEach((button) => {
      button.classList.toggle("choice--picked", button.dataset.choice === choice);
    });
  }

  function clearChoiceMark() {
    el.choices.querySelectorAll(".choice").forEach((button) => {
      button.classList.remove("choice--picked");
    });
  }

  /* ---------- end of match ---------- */

  function showResult(payload, opponentName) {
    stopTimer();
    hideCountdown();
    el.resultOverlay.hidden = false;
    el.resultEyebrow.textContent = payload.reason === "score" ? "Final score" : formatReason(payload.reason);
    el.resultTitle.textContent = payload.youWon ? "You win!" : "You lose";
    el.resultTitle.dataset.tone = payload.youWon ? "win" : "lose";
    el.resultScore.textContent = payload.scores.you + " – " + payload.scores.opponent;
    el.resultNote.textContent = payload.youWon
      ? "You reached " + goal + " points first."
      : (opponentName || "Your opponent") + " reached " + goal + " points first.";

    el.resultPlayers.innerHTML = "";
    for (const player of payload.players) {
      const row = document.createElement("div");
      row.className = "result__row" + (player.id === payload.winnerId ? " result__row--winner" : "");

      const name = document.createElement("span");
      name.className = "result__row-name";
      name.textContent = player.name;
      row.appendChild(name);

      const score = document.createElement("span");
      score.className = "result__row-score";
      score.textContent = String(player.score);
      row.appendChild(score);

      el.resultPlayers.appendChild(row);
    }

    setRematchState(false, false);
  }

  function setRematchState(youAsked, opponentAsked) {
    el.rematch.disabled = Boolean(youAsked);
    el.rematch.textContent = youAsked ? "Waiting for opponent…" : "Rematch";
    if (opponentAsked && !youAsked) {
      el.rematchHint.textContent = "Your opponent wants a rematch.";
    } else if (youAsked && !opponentAsked) {
      el.rematchHint.textContent = "Invite sent — waiting for them to accept.";
    } else if (youAsked && opponentAsked) {
      el.rematchHint.textContent = "Starting rematch…";
    } else {
      el.rematchHint.textContent = "";
    }
  }

  function setRematchUnavailable(text) {
    el.rematch.disabled = true;
    el.rematch.textContent = "Rematch";
    el.rematchHint.textContent = text;
  }

  function hideResult() {
    el.resultOverlay.hidden = true;
    el.rematch.disabled = false;
    el.rematch.textContent = "Rematch";
    el.rematchHint.textContent = "";
  }

  function reset() {
    stopTimer();
    hideCountdown();
    hideResult();
    clearChoiceMark();
    setCardStatus(el.cardYou, "Ready", "idle");
    setCardStatus(el.cardOpponent, "Ready", "idle");
    setCardActive(el.cardYou, false);
    setCardActive(el.cardOpponent, false);
    setSlot(el.slotYou, null);
    setSlot(el.slotOpponent, null);
    setTimerBar(1);
    el.timerText.textContent = "—";
    el.roundLabel.textContent = "Get ready";
  }

  return {
    el,
    enter,
    showCountdown,
    hideCountdown,
    startRound,
    setYouLocked,
    setOpponentLocked,
    setOpponentChoosing,
    revealRound,
    showResult,
    setRematchState,
    setRematchUnavailable,
    hideResult,
    reset,
    setMessage: (text, tone) => setMessage(el.message, text, tone)
  };
}
