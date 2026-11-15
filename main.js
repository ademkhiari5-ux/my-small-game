/* ============================================================
   ROCK PAPER SCISSORS — main.js
   Read this file from top to bottom:
   1. find the HTML elements, 2. game state, 3. helpers,
   4. one round, 5. end of match, 6. restart, 7. listeners.
   ============================================================ */

/* ---------- 1. Find the HTML elements we need ---------- */
const playerScoreBox = document.getElementById("player-score");
const computerScoreBox = document.getElementById("computer-score");
const bestStreakBox = document.getElementById("best-streak");

const arena = document.getElementById("arena");          /* the box that shakes */
const playerSlot = document.getElementById("player-slot");
const computerSlot = document.getElementById("computer-slot");
const playerName = document.getElementById("player-name");
const computerName = document.getElementById("computer-name");

const messageBox = document.getElementById("message");
const choiceButtons = document.querySelectorAll(".choice");
const restartButton = document.getElementById("restart");

/* ---------- 2. Rules, state and saved score ---------- */
const HANDS = ["rock", "paper", "scissors"];

/* Which hand each hand beats: rock -> scissors, paper -> rock, scissors -> paper */
const BEATS = {
  rock: "scissors",
  paper: "rock",
  scissors: "paper"
};

const WINNING_SCORE = 5;              /* points needed to win the match */
const STORAGE_KEY = "rps-best-streak"; /* name used in localStorage */

let playerScore = 0;
let computerScore = 0;
let streak = 0;                       /* your wins in a row */

/* Read the saved best streak. If nothing is saved, "null" becomes 0. */
let bestStreak = Number(localStorage.getItem(STORAGE_KEY)) || 0;

let isRoundRunning = false;           /* true during the 0.5s animation */
let isMatchOver = false;

/* ---------- 3. Remember the SVG icon of every button ---------- */
/* We only write each SVG once (in main.html) and copy it into the arena. */
const ICONS = {};

choiceButtons.forEach(function (button) {
  const hand = button.dataset.choice;            /* "rock", "paper" or "scissors" */
  ICONS[hand] = button.querySelector("svg").outerHTML;
});

/* ---------- 4. Small helper functions ---------- */

/* Pick a random hand for the computer */
function randomHand() {
  const index = Math.floor(Math.random() * HANDS.length);
  return HANDS[index];
}

/* "rock" -> "Rock" (for nicer messages) */
function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* Save the best streak so it is still there after a page reload */
function saveBestStreak() {
  localStorage.setItem(STORAGE_KEY, bestStreak);
}

/* Put an icon and a name inside one of the two arena boxes */
function drawHand(slotElement, nameElement, hand) {
  slotElement.innerHTML = ICONS[hand];
  nameElement.textContent = capitalize(hand);
}

/* Show a message under the arena. "type" is "", "win", "lose" or "tie". */
function showMessage(text, type) {
  messageBox.textContent = text;
  messageBox.className = "message";              /* clear old classes */

  if (type !== "") {
    messageBox.classList.add("message--" + type);
  }

  /* Remove then add the class so the pop animation plays again */
  messageBox.classList.remove("is-new");
  void messageBox.offsetWidth;                   /* forces the browser to notice */
  messageBox.classList.add("is-new");
}

/* Make a number jump a little when it changes */
function bump(element) {
  element.classList.remove("bump");
  void element.offsetWidth;
  element.classList.add("bump");

  window.setTimeout(function () {
    element.classList.remove("bump");
  }, 340);
}

/* Write the three numbers on the score board */
function updateScores() {
  playerScoreBox.textContent = playerScore;
  computerScoreBox.textContent = computerScore;
  bestStreakBox.textContent = bestStreak;
}

/* Turn the three choice buttons on or off */
function setButtonsEnabled(enabled) {
  choiceButtons.forEach(function (button) {
    button.disabled = !enabled;
  });
}

/* ---------- 5. Who wins a round? ---------- */
/* Returns "player", "computer" or "tie" */
function whoWins(playerHand, computerHand) {
  if (playerHand === computerHand) {
    return "tie";
  }
  if (BEATS[playerHand] === computerHand) {
    return "player";
  }
  return "computer";
}

/* ---------- 6. Play one round ---------- */
function playRound(playerHand) {
  if (isMatchOver || isRoundRunning) {
    return;                               /* ignore clicks during a round */
  }

  isRoundRunning = true;
  setButtonsEnabled(false);
  arena.classList.add("is-rolling");      /* small shake animation */
  showMessage("Rock... paper... scissors...", "");

  /* Wait 500 ms, then reveal both hands */
  window.setTimeout(function () {
    arena.classList.remove("is-rolling");
    finishRound(playerHand);
  }, 500);
}

function finishRound(playerHand) {
  const computerHand = randomHand();

  drawHand(playerSlot, playerName, playerHand);
  drawHand(computerSlot, computerName, computerHand);

  const result = whoWins(playerHand, computerHand);

  if (result === "player") {
    playerScore = playerScore + 1;
    streak = streak + 1;
    bump(playerScoreBox);
    showMessage("You win the round — " + playerHand + " beats " + computerHand + ".", "win");

    /* New record? Save it. */
    if (streak > bestStreak) {
      bestStreak = streak;
      saveBestStreak();
      bump(bestStreakBox);
    }
  } else if (result === "computer") {
    computerScore = computerScore + 1;
    streak = 0;                           /* a loss breaks the streak */
    bump(computerScoreBox);
    showMessage("Computer wins the round — " + computerHand + " beats " + playerHand + ".", "lose");
  } else {
    showMessage("Tie! You both picked " + playerHand + ".", "tie");
  }

  updateScores();
  isRoundRunning = false;
  checkMatchEnd();
}

/* ---------- 7. Is the match finished? ---------- */
function checkMatchEnd() {
  if (playerScore >= WINNING_SCORE) {
    isMatchOver = true;
    setButtonsEnabled(false);
    showMessage("You win the match " + playerScore + " – " + computerScore + "! Best streak: " + bestStreak + ".", "win");
    messageBox.classList.add("message--end");
    return;
  }

  if (computerScore >= WINNING_SCORE) {
    isMatchOver = true;
    setButtonsEnabled(false);
    showMessage("Game over — the computer won " + computerScore + " – " + playerScore + ". Press Restart and try again!", "lose");
    messageBox.classList.add("message--end");
    return;
  }

  setButtonsEnabled(true);                /* match continues */
}

/* ---------- 8. Restart the match ---------- */
function restartGame() {
  playerScore = 0;
  computerScore = 0;
  streak = 0;
  isRoundRunning = false;
  isMatchOver = false;

  updateScores();

  /* Put the "?" placeholders back in the arena */
  const placeholder = '<span class="hand__placeholder">?</span>';
  playerSlot.innerHTML = placeholder;
  computerSlot.innerHTML = placeholder;
  playerName.textContent = "Your pick";
  computerName.textContent = "Computer";

  arena.classList.remove("is-rolling");
  setButtonsEnabled(true);
  showMessage("New match — pick a hand to start.", "");
}

/* ---------- 9. Connect the buttons ---------- */
choiceButtons.forEach(function (button) {
  button.addEventListener("click", function () {
    playRound(button.dataset.choice);
  });
});

restartButton.addEventListener("click", restartGame);

/* ---------- 10. When the page opens ---------- */
updateScores();                            /* shows the saved best streak */
