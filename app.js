const SETTINGS_KEY = "qqd-settings";

const elements = {
  board: document.getElementById("board"),
  boardWrap: document.getElementById("boardWrap"),
  token: document.getElementById("token"),
  movePreview: document.getElementById("movePreview"),
  turnStatus: document.getElementById("turnStatus"),
  lastMove: document.getElementById("lastMove"),
  boardSize: document.getElementById("boardSize"),
  roundLabel: document.getElementById("roundLabel"),
  roundCount: document.getElementById("roundCount"),
  playerScore: document.getElementById("playerScore"),
  botScore: document.getElementById("botScore"),
  directorNote: document.getElementById("directorNote"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayText: document.getElementById("overlayText"),
  continueBtn: document.getElementById("continueBtn"),
  undoBtn: document.getElementById("undoBtn"),
  insightTip: document.getElementById("insightTip"),
  soundBtn: document.getElementById("soundBtn"),
  contrastBtn: document.getElementById("contrastBtn"),
  resetBtn: document.getElementById("resetBtn"),
  modeLabel: document.getElementById("modeLabel"),
};

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "practice" ? "practice" : "match";

const settings = loadSettings();
applySettings(settings);

BotEngine.initBot({
  minN: 8,
  maxN: 20,
  defaultN: 12,
  thinkTimeRange: [250, 900],
});

const gameState = {
  phase: "bot_turn",
  N: 10,
  pos: { x: 0, y: 0 },
  roundIndex: 1,
  score: { player: 0, bot: 0 },
  botGoesFirst: true,
  grundyData: BotEngine.buildGrundy(10),
  playerModel: { skill: 0.5 },
  directorState: { skill: 0.5 },
  ui: {
    selected: true,
    legalMoves: new Set(),
    lastMoveText: "—",
    misclicks: 0,
    turnStart: Date.now(),
  },
  history: [],
};

const audio = {
  context: null,
};

function loadSettings() {
  const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  return {
    sound: stored.sound ?? true,
    reducedMotion: stored.reducedMotion ?? false,
    highContrast: stored.highContrast ?? false,
  };
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function applySettings(next) {
  document.body.classList.toggle("high-contrast", next.highContrast);
  document.body.classList.toggle("reduced-motion", next.reducedMotion);
  elements.soundBtn.textContent = next.sound ? "🔊" : "🔈";
}

function playTone(freq, duration = 0.08) {
  if (!settings.sound) return;
  if (!audio.context) audio.context = new (window.AudioContext || window.webkitAudioContext)();
  const ctx = audio.context;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  gain.gain.value = 0.04;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}

function startRound() {
  const round = BotEngine.chooseStartState(gameState.directorState);
  gameState.N = round.N;
  gameState.pos = { x: round.startX, y: round.startY };
  gameState.botGoesFirst = round.botGoesFirst;
  gameState.grundyData = round.grundyData;
  gameState.phase = round.botGoesFirst ? "bot_turn" : "player_turn";
  gameState.ui.turnStart = Date.now();
  gameState.ui.misclicks = 0;
  gameState.history = [];

  buildBoard();
  updateLegalMoves();
  updateHud();
  positionToken(false);

  if (gameState.phase === "bot_turn") {
    setTimeout(runBotTurn, 150);
  }
}

function buildBoard() {
  const { N } = gameState;
  elements.board.innerHTML = "";
  elements.board.style.gridTemplateColumns = `repeat(${N + 1}, 1fr)`;
  elements.board.style.gridTemplateRows = `repeat(${N + 1}, 1fr)`;

  for (let y = N; y >= 0; y -= 1) {
    for (let x = 0; x <= N; x += 1) {
      const cell = document.createElement("button");
      cell.className = "cell";
      cell.dataset.x = x;
      cell.dataset.y = y;
      if (x === 0 && y === 0) cell.classList.add("origin");
      cell.textContent = x === 0 && y === 0 ? "(0,0)" : "";
      cell.addEventListener("click", onCellClick);
      cell.addEventListener("mouseenter", onCellEnter);
      cell.addEventListener("mouseleave", onCellLeave);
      elements.board.appendChild(cell);
    }
  }
}

function updateLegalMoves() {
  gameState.ui.legalMoves.clear();
  const { x, y } = gameState.pos;

  const moves = [];
  for (let k = 1; k <= x; k += 1) moves.push({ toX: x - k, toY: y });
  for (let k = 1; k <= y; k += 1) moves.push({ toX: x, toY: y - k });
  const diag = Math.min(x, y);
  for (let k = 1; k <= diag; k += 1) moves.push({ toX: x - k, toY: y - k });

  moves.forEach((move) => {
    gameState.ui.legalMoves.add(`${move.toX},${move.toY}`);
  });

  for (const cell of elements.board.children) {
    const key = `${cell.dataset.x},${cell.dataset.y}`;
    cell.classList.toggle("legal", gameState.phase === "player_turn" && gameState.ui.legalMoves.has(key));
  }

  elements.insightTip.textContent = "";
  if (mode === "practice" && gameState.phase === "player_turn") {
    elements.insightTip.textContent = "Practice: Undo enabled. Cold positions highlight after your move.";
  }
}

function updateHud() {
  elements.lastMove.textContent = gameState.ui.lastMoveText;
  elements.roundLabel.textContent = `Round ${gameState.roundIndex}`;
  elements.roundCount.textContent = mode === "match" ? `${gameState.roundIndex} / 5` : `Practice`;
  elements.playerScore.textContent = gameState.score.player;
  elements.botScore.textContent = gameState.score.bot;
  elements.boardSize.textContent = `${gameState.N}×${gameState.N}`;
  elements.turnStatus.textContent = gameState.phase === "player_turn" ? "Your Turn" : gameState.phase === "bot_turn" ? "Bot Thinking…" : "Round Over";
  elements.modeLabel.textContent = mode === "practice" ? "Practice" : "Match";
  elements.undoBtn.disabled = mode !== "practice" || gameState.history.length === 0 || gameState.phase !== "player_turn";
  updateDirectorNote();
}

function updateDirectorNote() {
  const skill = gameState.directorState.skill ?? 0.5;
  if (skill < 0.35) {
    elements.directorNote.textContent = "Training + strong hints";
  } else if (skill < 0.7) {
    elements.directorNote.textContent = "Balanced duel";
  } else {
    elements.directorNote.textContent = "High-stakes mind game";
  }

  const hintIntensity = skill < 0.35 ? 0.26 : skill < 0.7 ? 0.18 : 0.1;
  document.documentElement.style.setProperty("--hint-alpha", hintIntensity.toString());
}

function positionToken(animate, isBot = false) {
  const rect = elements.board.getBoundingClientRect();
  const wrapRect = elements.boardWrap.getBoundingClientRect();
  const cellSize = rect.width / (gameState.N + 1);
  const x = gameState.pos.x;
  const y = gameState.pos.y;
  const left = rect.left + x * cellSize;
  const top = rect.top + (gameState.N - y) * cellSize;

  const tokenSize = cellSize * 0.7;
  elements.token.style.width = `${tokenSize}px`;
  elements.token.style.height = `${tokenSize}px`;
  elements.token.classList.toggle("bot", isBot);

  const offsetX = left + cellSize / 2 - tokenSize / 2 - wrapRect.left;
  const offsetY = top + cellSize / 2 - tokenSize / 2 - wrapRect.top;

  if (!animate) {
    elements.token.style.transition = settings.reducedMotion ? "none" : "transform 320ms ease";
  }

  elements.token.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
}

function onCellClick(event) {
  if (gameState.phase !== "player_turn") return;
  const target = event.currentTarget;
  const toX = Number(target.dataset.x);
  const toY = Number(target.dataset.y);
  const key = `${toX},${toY}`;

  if (!gameState.ui.legalMoves.has(key)) {
    target.classList.add("illegal");
    setTimeout(() => target.classList.remove("illegal"), 250);
    gameState.ui.misclicks += 1;
    playTone(220, 0.08);
    return;
  }

  commitMove("player", toX, toY);
}

function onCellEnter(event) {
  const target = event.currentTarget;
  const key = `${target.dataset.x},${target.dataset.y}`;
  if (!gameState.ui.legalMoves.has(key)) return;
  const toX = Number(target.dataset.x);
  const toY = Number(target.dataset.y);
  showMovePreview(toX, toY);
}

function onCellLeave() {
  hideMovePreview();
}

function showMovePreview(toX, toY) {
  const rect = elements.board.getBoundingClientRect();
  const wrapRect = elements.boardWrap.getBoundingClientRect();
  const cellSize = rect.width / (gameState.N + 1);
  const fromX = gameState.pos.x;
  const fromY = gameState.pos.y;
  const fromCx = fromX * cellSize + cellSize / 2 + (rect.left - wrapRect.left);
  const fromCy = (gameState.N - fromY) * cellSize + cellSize / 2 + (rect.top - wrapRect.top);
  const toCx = toX * cellSize + cellSize / 2 + (rect.left - wrapRect.left);
  const toCy = (gameState.N - toY) * cellSize + cellSize / 2 + (rect.top - wrapRect.top);
  const dx = toCx - fromCx;
  const dy = toCy - fromCy;
  const length = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);

  elements.movePreview.style.width = `${length}px`;
  elements.movePreview.style.transform = `translate(${fromCx}px, ${fromCy}px) rotate(${angle}deg)`;
  elements.movePreview.classList.add("active");
}

function hideMovePreview() {
  elements.movePreview.classList.remove("active");
}

function commitMove(actor, toX, toY) {
  gameState.history.push({ ...gameState.pos });
  const prev = { ...gameState.pos };
  gameState.pos = { x: toX, y: toY };

  gameState.ui.lastMoveText = `${actor === "player" ? "You" : "Bot"}: (${prev.x},${prev.y}) → (${toX},${toY})`;
  positionToken(true, actor === "bot");
  playTone(actor === "bot" ? 360 : 520, 0.1);

  const reachedOrigin = toX === 0 && toY === 0;
  if (reachedOrigin) {
    endRound(actor);
    return;
  }

  if (actor === "player") {
    const decisionTime = Date.now() - gameState.ui.turnStart;
    gameState.playerModel = BotEngine.updatePlayerModel(gameState.playerModel, {
      toX,
      toY,
      grundyData: gameState.grundyData,
      decisionTime,
      misclicks: gameState.ui.misclicks,
    });
    gameState.directorState.skill = gameState.playerModel.skill;

    if (mode === "practice") {
      const g = gameState.grundyData.grundy[toX][toY];
      elements.insightTip.textContent = g === 0 ? "Cold position!" : `Hot position (g=${g}).`;
    }

    gameState.phase = "bot_turn";
    gameState.ui.turnStart = Date.now();
    gameState.ui.misclicks = 0;
    updateLegalMoves();
    updateHud();
    runBotTurn();
  } else {
    gameState.phase = "player_turn";
    gameState.ui.turnStart = Date.now();
    updateLegalMoves();
    updateHud();
  }
}

function runBotTurn() {
  if (gameState.phase !== "bot_turn") return;
  elements.boardWrap.style.pointerEvents = "none";

  const skill = gameState.playerModel.skill ?? 0.5;
  const minDelay = skill < 0.35 ? 700 : skill < 0.7 ? 420 : 250;
  const maxDelay = skill < 0.35 ? 1200 : skill < 0.7 ? 820 : 520;
  const delay = Math.floor(minDelay + Math.random() * (maxDelay - minDelay));

  setTimeout(() => {
    const move = BotEngine.getBotMove({
      N: gameState.N,
      x: gameState.pos.x,
      y: gameState.pos.y,
      grundy: gameState.grundyData.grundy,
      playerModel: gameState.playerModel,
      roundIndex: gameState.roundIndex,
    });

    if (move) {
      commitMove("bot", move.toX, move.toY);
    }

    elements.boardWrap.style.pointerEvents = "auto";
  }, delay);
}

function endRound(winner) {
  gameState.phase = "round_over";
  if (winner === "player") {
    gameState.score.player += 1;
  } else {
    gameState.score.bot += 1;
  }

  elements.overlayTitle.textContent = winner === "player" ? "You Win" : "Bot Wins";
  elements.overlayText.textContent = winner === "player" ? "You cracked the pattern." : "The queen reaches the origin.";
  elements.overlay.classList.add("visible");
  updateHud();
}

function nextRound() {
  elements.overlay.classList.remove("visible");
  if (mode === "match" && gameState.roundIndex >= 5) {
    resetMatch();
    return;
  }

  gameState.roundIndex += 1;
  startRound();
}

function resetMatch() {
  gameState.roundIndex = 1;
  gameState.score = { player: 0, bot: 0 };
  gameState.playerModel = { skill: 0.5 };
  gameState.directorState = { skill: 0.5 };
  elements.overlayTitle.textContent = "Match Reset";
  elements.overlayText.textContent = "New duel. Bot still goes first.";
  elements.overlay.classList.remove("visible");
  startRound();
}

function undoMove() {
  if (mode !== "practice" || gameState.history.length === 0 || gameState.phase !== "player_turn") return;
  const prev = gameState.history.pop();
  gameState.pos = { ...prev };
  gameState.ui.lastMoveText = "Undo: position restored.";
  positionToken(true);
  updateLegalMoves();
  updateHud();
}

function onResize() {
  positionToken(false);
}

elements.undoBtn.addEventListener("click", undoMove);

window.addEventListener("resize", onResize);

elements.continueBtn.addEventListener("click", nextRound);

elements.soundBtn.addEventListener("click", () => {
  settings.sound = !settings.sound;
  applySettings(settings);
  saveSettings();
});

elements.contrastBtn.addEventListener("click", () => {
  settings.highContrast = !settings.highContrast;
  applySettings(settings);
  saveSettings();
});

elements.resetBtn.addEventListener("click", resetMatch);

startRound();
