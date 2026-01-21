const SETTINGS_KEY = "qqd-settings";
const STREAK_KEY = "prism-streak";

const elements = {
  board: document.getElementById("board"),
  statusLabel: document.getElementById("statusLabel"),
  movesLabel: document.getElementById("movesLabel"),
  timeLabel: document.getElementById("timeLabel"),
  gridLabel: document.getElementById("gridLabel"),
  puzzleLabel: document.getElementById("puzzleLabel"),
  modeLabel: document.getElementById("modeLabel"),
  parLabel: document.getElementById("parLabel"),
  streakLabel: document.getElementById("streakLabel"),
  tipLabel: document.getElementById("tipLabel"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayText: document.getElementById("overlayText"),
  continueBtn: document.getElementById("continueBtn"),
  hintBtn: document.getElementById("hintBtn"),
  soundBtn: document.getElementById("soundBtn"),
  contrastBtn: document.getElementById("contrastBtn"),
  newBtn: document.getElementById("newBtn"),
  resetBtn: document.getElementById("resetBtn"),
};

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "zen" ? "zen" : "challenge";

const settings = loadSettings();
applySettings(settings);

const audio = {
  context: null,
};

const gameState = {
  gridSize: 5,
  grid: [],
  moves: 0,
  par: 0,
  puzzleIndex: 1,
  startTime: Date.now(),
  timerId: null,
  solved: false,
  hintActive: false,
  streak: Number(localStorage.getItem(STREAK_KEY) || 0),
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
  gain.gain.value = 0.05;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}

function setGridSize() {
  if (mode === "zen") {
    gameState.gridSize = 4;
    return;
  }
  const step = Math.floor((gameState.puzzleIndex - 1) / 2);
  gameState.gridSize = Math.min(7, 5 + step);
}

function createEmptyGrid() {
  const total = gameState.gridSize * gameState.gridSize;
  gameState.grid = Array.from({ length: total }, () => false);
}

function getIndex(row, col) {
  return row * gameState.gridSize + col;
}

function toggleCell(row, col) {
  if (row < 0 || col < 0 || row >= gameState.gridSize || col >= gameState.gridSize) return;
  const idx = getIndex(row, col);
  gameState.grid[idx] = !gameState.grid[idx];
}

function applyMove(row, col) {
  toggleCell(row, col);
  toggleCell(row - 1, col);
  toggleCell(row + 1, col);
  toggleCell(row, col - 1);
  toggleCell(row, col + 1);
}

function shuffleGrid() {
  const shuffleCount = gameState.gridSize * gameState.gridSize;
  for (let i = 0; i < shuffleCount; i += 1) {
    const row = Math.floor(Math.random() * gameState.gridSize);
    const col = Math.floor(Math.random() * gameState.gridSize);
    applyMove(row, col);
  }
  if (gameState.grid.every((cell) => !cell)) {
    applyMove(0, 0);
  }
}

function buildBoard() {
  elements.board.innerHTML = "";
  elements.board.style.gridTemplateColumns = `repeat(${gameState.gridSize}, 1fr)`;
  elements.board.style.gridTemplateRows = `repeat(${gameState.gridSize}, 1fr)`;

  for (let row = 0; row < gameState.gridSize; row += 1) {
    for (let col = 0; col < gameState.gridSize; col += 1) {
      const cell = document.createElement("button");
      cell.className = "cell";
      cell.dataset.row = row;
      cell.dataset.col = col;
      cell.setAttribute("aria-pressed", "false");
      cell.addEventListener("click", onCellClick);
      cell.addEventListener("mouseenter", onCellEnter);
      cell.addEventListener("mouseleave", onCellLeave);
      elements.board.appendChild(cell);
    }
  }
}

function updateBoard() {
  const cells = elements.board.children;
  gameState.grid.forEach((value, idx) => {
    const cell = cells[idx];
    cell.classList.toggle("on", value);
    cell.setAttribute("aria-pressed", value ? "true" : "false");
  });
}

function updateHud() {
  elements.movesLabel.textContent = gameState.moves.toString();
  elements.gridLabel.textContent = `${gameState.gridSize}×${gameState.gridSize}`;
  elements.puzzleLabel.textContent = `Puzzle ${gameState.puzzleIndex}`;
  elements.modeLabel.textContent = mode === "zen" ? "Zen" : "Challenge";
  elements.parLabel.textContent = gameState.par ? `${gameState.par} moves` : "—";
  elements.streakLabel.textContent = gameState.streak.toString();
  elements.statusLabel.textContent = gameState.solved ? "Solved" : "In Play";
  elements.hintBtn.classList.toggle("active", gameState.hintActive);
  elements.hintBtn.textContent = gameState.hintActive ? "Hide neighbors" : "Highlight neighbors";
}

function updateTimer() {
  const elapsed = Math.floor((Date.now() - gameState.startTime) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = (elapsed % 60).toString().padStart(2, "0");
  elements.timeLabel.textContent = `${minutes}:${seconds}`;
}

function startTimer() {
  clearInterval(gameState.timerId);
  gameState.startTime = Date.now();
  updateTimer();
  gameState.timerId = setInterval(updateTimer, 1000);
}

function setTip() {
  const tips = [
    "Corners only affect three tiles—try them early.",
    "Work from the edges toward the center.",
    "Look for symmetric patterns to reduce guesses.",
    "Try to keep the board balanced before big flips.",
  ];
  elements.tipLabel.textContent = tips[Math.floor(Math.random() * tips.length)];
}

function setupPuzzle({ incrementIndex = false } = {}) {
  if (incrementIndex) gameState.puzzleIndex += 1;
  gameState.moves = 0;
  gameState.solved = false;
  gameState.hintActive = false;
  setGridSize();
  createEmptyGrid();
  shuffleGrid();
  buildBoard();
  updateBoard();
  gameState.par = Math.round(gameState.gridSize * gameState.gridSize * 0.6);
  setTip();
  updateHud();
  startTimer();
  hideOverlay();
}

function toggleHints(active) {
  gameState.hintActive = active;
  updateHud();
}

function showOverlay() {
  elements.overlay.classList.add("visible");
  const timeText = elements.timeLabel.textContent;
  const parText = gameState.par ? `Par ${gameState.par}` : "";
  elements.overlayTitle.textContent = "Puzzle Solved";
  elements.overlayText.textContent = `Solved in ${gameState.moves} moves · ${timeText} · ${parText}`.trim();
}

function hideOverlay() {
  elements.overlay.classList.remove("visible");
}

function handleSolve() {
  gameState.solved = true;
  clearInterval(gameState.timerId);
  const parBeat = gameState.moves <= gameState.par;
  if (mode === "challenge" && parBeat) {
    gameState.streak += 1;
  } else if (mode === "challenge") {
    gameState.streak = 0;
  }
  localStorage.setItem(STREAK_KEY, gameState.streak.toString());
  updateHud();
  playTone(720, 0.2);
  showOverlay();
}

function onCellClick(event) {
  if (gameState.solved) return;
  const row = Number(event.currentTarget.dataset.row);
  const col = Number(event.currentTarget.dataset.col);
  applyMove(row, col);
  gameState.moves += 1;
  playTone(420, 0.05);
  updateBoard();
  updateHud();
  if (gameState.grid.every((cell) => !cell)) {
    handleSolve();
  }
}

function onCellEnter(event) {
  if (!gameState.hintActive || gameState.solved) return;
  const row = Number(event.currentTarget.dataset.row);
  const col = Number(event.currentTarget.dataset.col);
  highlightNeighbors(row, col, true);
}

function onCellLeave(event) {
  if (!gameState.hintActive || gameState.solved) return;
  const row = Number(event.currentTarget.dataset.row);
  const col = Number(event.currentTarget.dataset.col);
  highlightNeighbors(row, col, false);
}

function highlightNeighbors(row, col, active) {
  const offsets = [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  offsets.forEach(([dr, dc]) => {
    const targetRow = row + dr;
    const targetCol = col + dc;
    if (targetRow < 0 || targetCol < 0 || targetRow >= gameState.gridSize || targetCol >= gameState.gridSize) return;
    const idx = getIndex(targetRow, targetCol);
    const cell = elements.board.children[idx];
    cell.classList.toggle("preview", active);
  });
}

function handleReset() {
  setupPuzzle();
}

function handleNewPuzzle() {
  setupPuzzle({ incrementIndex: true });
}

function handleContinue() {
  setupPuzzle({ incrementIndex: mode === "challenge" });
}

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

elements.resetBtn.addEventListener("click", handleReset);

elements.newBtn.addEventListener("click", handleNewPuzzle);

elements.continueBtn.addEventListener("click", handleContinue);

elements.hintBtn.addEventListener("click", () => {
  toggleHints(!gameState.hintActive);
});

setupPuzzle();
