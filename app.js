const STORAGE_KEY = "checkpoint_command_state_v1";
const CHECKPOINT_POINTS = 1000;
const POINTS_PER_WIN = 100;
const POINTS_PER_LOSS = -100;
const TRACK_SEGMENTS = 10;
const GRID_SIZE = 5;
const MAX_MATCH_TURNS = 16;

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`Missing element: ${id}`);
  }
  return el;
};

const setText = (el, value) => {
  if (el) {
    el.textContent = value;
  }
};

const Utils = {
  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  },
  formatNumber(value) {
    return value.toLocaleString("en-US");
  },
  percentage(value) {
    return `${Math.round(value * 100)}%`;
  },
  ease(value) {
    return 1 - Math.cos((value * Math.PI) / 2);
  },
};

const getDefaultState = () => ({
  points: 0,
  wins: 0,
  losses: 0,
  totalGames: 0,
  winRateEma: 0.5,
  volatility: 0.25,
});

const Storage = {
  load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultState();
    try {
      return { ...getDefaultState(), ...JSON.parse(raw) };
    } catch (error) {
      return getDefaultState();
    }
  },
  save(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  },
  reset() {
    localStorage.removeItem(STORAGE_KEY);
    return getDefaultState();
  },
};

const getCheckpointInfo = (points) => {
  const current = Math.floor(points / CHECKPOINT_POINTS);
  const checkpointBase = current * CHECKPOINT_POINTS;
  const nextValue = (current + 1) * CHECKPOINT_POINTS;
  const progress = (points - checkpointBase) / CHECKPOINT_POINTS;

  return {
    current,
    checkpointBase,
    nextValue,
    progress,
  };
};

const getDifficultyLabel = (points) => {
  const level = Math.floor(points / CHECKPOINT_POINTS);
  if (level >= 12) return "Apex";
  if (level >= 8) return "Expert";
  if (level >= 5) return "Advanced";
  if (level >= 2) return "Focused";
  return "Calibrating";
};

const getWinRate = (state) => {
  if (state.totalGames === 0) return 0.5;
  return state.wins / state.totalGames;
};

const calculateAdaptiveChance = (state) => {
  const empiricalWinRate = getWinRate(state);
  const ema = state.winRateEma;
  const level = Math.floor(state.points / CHECKPOINT_POINTS);
  const { progress } = getCheckpointInfo(state.points);
  const oneWinAway = progress >= 0.9 && progress < 1;

  const logisticBias = 1 / (1 + Math.exp(-3 * (0.5 - ema)));
  const correction = (logisticBias - 0.5) * 0.35;
  const skillPressure = Math.min(level * 0.018 + progress * 0.08, 0.24);
  const checkpointPenalty = oneWinAway ? 0.14 : 0;
  const volatilityPenalty = (state.volatility - 0.15) * 0.08;

  const winChance = Utils.clamp(
    0.5 + correction - skillPressure - checkpointPenalty - volatilityPenalty,
    0.18,
    0.78
  );

  return {
    winChance,
    oneWinAway,
    empiricalWinRate,
  };
};

const updateAdaptiveState = (state, playerWon) => {
  const reward = playerWon ? 1 : 0;
  const alpha = 0.08;
  state.winRateEma = state.winRateEma + alpha * (reward - state.winRateEma);
  const error = reward - state.winRateEma;
  state.volatility = Utils.clamp(state.volatility * 0.9 + Math.abs(error) * 0.1, 0.12, 0.45);
};

const createGrid = (container, onCellClick) => {
  container.innerHTML = "";
  const cells = [];
  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let col = 0; col < GRID_SIZE; col += 1) {
      const cell = document.createElement("button");
      cell.className = "grid-cell";
      cell.dataset.index = String(row * GRID_SIZE + col);
      cell.setAttribute("role", "gridcell");
      cell.addEventListener("click", () => onCellClick(cell));
      container.appendChild(cell);
      cells.push(cell);
    }
  }
  return cells;
};

const updateTrack = (state) => {
  const { current, nextValue, progress } = getCheckpointInfo(state.points);
  const trackFill = $("trackFill");
  const dotsContainer = $("checkpointDots");

  if (!trackFill || !dotsContainer) {
    return;
  }

  trackFill.style.width = `${Utils.clamp(progress, 0, 1) * 100}%`;
  dotsContainer.innerHTML = "";

  const dotsToShow = 6;
  for (let index = 0; index < dotsToShow; index += 1) {
    const dotLevel = current + index;
    const dot = document.createElement("div");
    dot.className = "track-dot";
    dot.textContent = `${dotLevel}`;

    if (dotLevel < current) {
      dot.classList.add("reached");
    }
    if (dotLevel === current) {
      dot.classList.add("current");
    }

    dotsContainer.appendChild(dot);
  }

  setText($("checkpointValue"), `${current}`);
  setText($("nextCheckpoint"), `${Utils.formatNumber(nextValue)} pts`);
  setText($("difficultyValue"), getDifficultyLabel(state.points));

  const { winChance, oneWinAway } = calculateAdaptiveChance(state);
  setText($("fairnessValue"), `Target ${Utils.percentage(winChance)}`);
  setText($("pressureValue"), oneWinAway ? "Active" : "Inactive");
  setText($("winRateValue"), Utils.percentage(getWinRate(state)));
};

const updateScoreboard = (state) => {
  setText($("pointsValue"), Utils.formatNumber(state.points));
  setText($("recordValue"), `${state.wins}W - ${state.losses}L`);
};

const updateResultBanner = (banner, outcome) => {
  banner.classList.remove("win", "loss");
  if (!outcome) {
    banner.textContent = "Start a match to see the outcome.";
    return;
  }

  banner.classList.add(outcome === "win" ? "win" : "loss");
  banner.textContent = outcome === "win"
    ? "Victory. +100 points locked in at your checkpoint."
    : "Defeat. -100 points, but checkpoints prevent further drops.";
};

const initApp = () => {
  let state = Storage.load();

  const checkpointScreen = $("checkpointScreen");
  const gameScreen = $("gameScreen");
  const playBtn = $("playBtn");
  const backBtn = $("backBtn");
  const startMatchBtn = $("startMatchBtn");
  const resetRunBtn = $("resetRunBtn");
  const grid = $("grid");
  const resultBanner = $("resultBanner");
  const turnValue = $("turnValue");
  const matchStatus = $("matchStatus");
  const matchScore = $("matchScore");

  if (!checkpointScreen || !gameScreen || !playBtn || !backBtn || !startMatchBtn || !resetRunBtn || !grid || !resultBanner || !turnValue || !matchStatus || !matchScore) {
    return;
  }

  let cells = [];
  let playerTurn = true;
  let matchActive = false;
  let playerWins = true;
  let playerScore = 0;
  let botScore = 0;
  let totalMoves = 0;

  const switchScreen = (target) => {
    if (target === "game") {
      checkpointScreen.classList.remove("active");
      gameScreen.classList.add("active");
    } else {
      gameScreen.classList.remove("active");
      checkpointScreen.classList.add("active");
    }
  };

  const resetGrid = () => {
    cells.forEach((cell) => {
      cell.classList.remove("player", "bot");
      cell.textContent = "";
      cell.disabled = false;
    });
    playerScore = 0;
    botScore = 0;
    totalMoves = 0;
    playerTurn = true;
    matchActive = false;
    turnValue.textContent = "Player";
    matchStatus.textContent = "Ready";
    matchScore.textContent = "0 - 0";
    updateResultBanner(resultBanner, null);
  };

  const lockGrid = () => {
    cells.forEach((cell) => {
      cell.disabled = true;
    });
  };

  const updateMatchScore = () => {
    matchScore.textContent = `${playerScore} - ${botScore}`;
  };

  const resolveMatch = () => {
    matchActive = false;
    lockGrid();

    if (playerWins && playerScore <= botScore) {
      playerScore = botScore + 1;
      updateMatchScore();
    }

    if (!playerWins && botScore <= playerScore) {
      botScore = playerScore + 1;
      updateMatchScore();
    }

    if (playerWins) {
      state.points += POINTS_PER_WIN;
      state.wins += 1;
    } else {
      const { checkpointBase } = getCheckpointInfo(state.points);
      state.points = Math.max(state.points + POINTS_PER_LOSS, checkpointBase);
      state.losses += 1;
    }

    state.totalGames += 1;
    updateAdaptiveState(state, playerWins);
    Storage.save(state);

    updateScoreboard(state);
    updateTrack(state);
    updateResultBanner(resultBanner, playerWins ? "win" : "loss");
    matchStatus.textContent = "Match complete";
    turnValue.textContent = "-";
    startMatchBtn.disabled = false;
  };

  const botMove = () => {
    if (!matchActive) return;

    const available = cells.filter((cell) => !cell.classList.contains("player") && !cell.classList.contains("bot"));
    if (!available.length) {
      resolveMatch();
      return;
    }

    const choice = available[Math.floor(Math.random() * available.length)];
    choice.classList.add("bot");
    choice.textContent = "B";
    botScore += 1;
    totalMoves += 1;
    updateMatchScore();

    if (totalMoves >= MAX_MATCH_TURNS) {
      resolveMatch();
      return;
    }

    playerTurn = true;
    turnValue.textContent = "Player";
  };

  const handleCellClick = (cell) => {
    if (!matchActive || !playerTurn) return;
    if (cell.classList.contains("player") || cell.classList.contains("bot")) return;

    cell.classList.add("player");
    cell.textContent = "P";
    playerScore += 1;
    totalMoves += 1;
    updateMatchScore();

    if (totalMoves >= MAX_MATCH_TURNS) {
      resolveMatch();
      return;
    }

    playerTurn = false;
    turnValue.textContent = "Bot";
    setTimeout(botMove, 450);
  };

  const startMatch = () => {
    resetGrid();
    matchActive = true;
    startMatchBtn.disabled = true;
    matchStatus.textContent = "In progress";

    const { winChance } = calculateAdaptiveChance(state);
    playerWins = Math.random() < winChance;
    updateTrack(state);
  };

  playBtn.addEventListener("click", () => {
    switchScreen("game");
    startMatch();
  });

  backBtn.addEventListener("click", () => {
    switchScreen("checkpoint");
  });

  startMatchBtn.addEventListener("click", startMatch);

  resetRunBtn.addEventListener("click", () => {
    state = Storage.reset();
    Storage.save(state);
    updateScoreboard(state);
    updateTrack(state);
    resetGrid();
  });

  cells = createGrid(grid, handleCellClick);
  updateScoreboard(state);
  updateTrack(state);
  resetGrid();
};

document.addEventListener("DOMContentLoaded", initApp);
