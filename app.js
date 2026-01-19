const STORAGE_KEY = "checkpoint_command_state_v1";
const CHECKPOINT_POINTS = 1000;
const POINTS_PER_WIN = 100;
const POINTS_PER_LOSS = -100;
const GRID_SIZE = 6;
const UNIT_HP = 2;
const CONTROL_TARGET = 6;
const MAX_TURNS = 16;
const BOT_DELAY = 650;

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
  shuffle(list) {
    const result = [...list];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  },
};

const getDefaultState = () => ({
  points: 0,
  wins: 0,
  losses: 0,
  totalGames: 0,
  winRateEma: 0.5,
  volatility: 0.25,
  recoveryGames: 0,
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

const getWinRate = (state) => {
  if (state.totalGames === 0) return 0.5;
  return state.wins / state.totalGames;
};

const calculateAdaptiveChallenge = (state) => {
  const winRate = getWinRate(state);
  const emaDrift = Utils.clamp(state.winRateEma - 0.5, -0.25, 0.25);
  const volatilityLift = Utils.clamp((0.3 - state.volatility) * 0.6, -0.12, 0.18);
  const levelPressure = Math.min(Math.floor(state.points / CHECKPOINT_POINTS) * 0.015, 0.2);
  const baseWidth = 0.24 - emaDrift * 0.18 + volatilityLift - levelPressure;
  const zoneWidth = Utils.clamp(baseWidth, 0.12, 0.32);

  const speed = Utils.clamp(
    0.38 + levelPressure * 0.55 + Math.abs(emaDrift) * 0.25,
    0.28,
    0.82
  );

  return {
    zoneWidth,
    speed,
    winRate,
  };
};

const updateAdaptiveState = (state, playerWon) => {
  const reward = playerWon ? 1 : 0;
  const alpha = 0.08;
  state.winRateEma = state.winRateEma + alpha * (reward - state.winRateEma);
  const error = reward - state.winRateEma;
  state.volatility = Utils.clamp(state.volatility * 0.9 + Math.abs(error) * 0.1, 0.12, 0.45);
};

const isOneWinFromCheckpoint = (points) => {
  const { nextValue } = getCheckpointInfo(points);
  return nextValue - points <= POINTS_PER_WIN;
};

const updateDirectorState = (state, playerWon, pointsBefore) => {
  if (!playerWon && isOneWinFromCheckpoint(pointsBefore)) {
    state.recoveryGames = 2;
    return;
  }
  if (state.recoveryGames > 0) {
    state.recoveryGames = Math.max(state.recoveryGames - 1, 0);
  }
};

const CONTROL_NODES = [
  { row: 1, col: 2 },
  { row: 4, col: 2 },
  { row: 2, col: 4 },
];

const updateTrack = (state, previousLevel = null) => {
  const { current, nextValue, progress } = getCheckpointInfo(state.points);
  const trackFill = $("trackFill");
  const dotsContainer = $("checkpointDots");
  const trackPanel = document.querySelector(".track-panel");

  if (!trackFill || !dotsContainer) {
    return;
  }

  trackFill.style.width = `${Utils.clamp(progress, 0, 1) * 100}%`;
  dotsContainer.innerHTML = "";

  const dotsToShow = 7;
  const startLevel = Math.max(current - 3, 0);
  for (let index = 0; index < dotsToShow; index += 1) {
    const dotLevel = startLevel + index;
    const dot = document.createElement("div");
    dot.className = "track-dot";
    dot.textContent = `${dotLevel}`;

    const label = document.createElement("span");
    label.className = "track-dot-label";
    label.textContent = `L${dotLevel}`;
    dot.appendChild(label);

    if (dotLevel < current) {
      dot.classList.add("reached");
    }
    if (dotLevel === current) {
      dot.classList.add("current");
    }
    if (dotLevel === current + 1) {
      dot.classList.add("next");
    }

    dotsContainer.appendChild(dot);
  }

  setText($("checkpointValue"), `${current}`);
  setText($("nextCheckpoint"), `${Utils.formatNumber(nextValue)} pts`);

  if (trackPanel && previousLevel !== null && current > previousLevel) {
    trackPanel.classList.remove("celebrate");
    void trackPanel.offsetWidth;
    trackPanel.classList.add("celebrate");
  }
};

const updateScoreboard = (state) => {
  setText($("pointsValue"), Utils.formatNumber(state.points));
  setText($("winRateValue"), Utils.percentage(getWinRate(state)));
};

let appInitialized = false;

const showAppError = (message) => {
  const errorEl = $("appError");
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.hidden = false;
};

const initApp = () => {
  if (appInitialized) return;
  appInitialized = true;
  let state = Storage.load();

  const checkpointScreen = $("checkpointScreen");
  const gameScreen = $("gameScreen");
  const playBtn = $("playBtn");
  const backBtn = $("backBtn");
  const startMatchBtn = $("startMatchBtn");
  const endTurnBtn = $("endTurnBtn");
  const resetRunBtn = $("resetRunBtn");
  const gameBoard = $("gameBoard");
  const turnBanner = $("turnBanner");
  const turnOwner = $("turnOwner");
  const turnValue = $("turnValue");
  const playerControlEl = $("playerControl");
  const botControlEl = $("botControl");
  const selectedUnitEl = $("selectedUnit");

  const missingCritical = [
    ["checkpointScreen", checkpointScreen],
    ["gameScreen", gameScreen],
    ["playBtn", playBtn],
    ["backBtn", backBtn],
    ["startMatchBtn", startMatchBtn],
    ["endTurnBtn", endTurnBtn],
    ["resetRunBtn", resetRunBtn],
    ["gameBoard", gameBoard],
    ["turnBanner", turnBanner],
  ].filter(([, el]) => !el).map(([name]) => name);

  if (missingCritical.length > 0) {
    showAppError(`Missing critical UI elements: ${missingCritical.join(", ")}.`);
    return;
  }

  let matchActive = false;
  let activeSide = "player";
  let turnCount = 1;
  let playerControl = 0;
  let botControl = 0;
  let selectedUnitId = null;
  let actionTaken = false;
  let units = [];
  let lastPlayerAction = null;
  let botTimeout = null;

  const switchScreen = (target) => {
    if (target === "game") {
      checkpointScreen.classList.remove("active");
      gameScreen.classList.add("active");
    } else {
      gameScreen.classList.remove("active");
      checkpointScreen.classList.add("active");
    }
  };

  const getUnitAt = (row, col) => units.find((unit) => unit.row === row && unit.col === col);

  const setBanner = (message, outcome) => {
    turnBanner.classList.remove("win", "loss");
    if (outcome) {
      turnBanner.classList.add(outcome);
    }
    turnBanner.textContent = message;
  };

  const updateMeta = () => {
    setText(turnOwner, activeSide === "player" ? "Player" : "Bot");
    setText(turnValue, `${turnCount}`);
    setText(playerControlEl, `${playerControl}`);
    setText(botControlEl, `${botControl}`);
    const selectedUnit = units.find((unit) => unit.id === selectedUnitId);
    setText(selectedUnitEl, selectedUnit ? selectedUnit.label : "None");
  };

  const createUnits = () => {
    const playerStarts = [
      { row: 5, col: 1 },
      { row: 5, col: 3 },
      { row: 5, col: 5 },
    ];
    const botStarts = [
      { row: 0, col: 0 },
      { row: 0, col: 2 },
      { row: 0, col: 4 },
    ];

    const playerUnits = playerStarts.map((pos, index) => ({
      id: `p${index + 1}`,
      side: "player",
      row: pos.row,
      col: pos.col,
      hp: UNIT_HP,
      label: `P-${index + 1}`,
    }));

    const botUnits = botStarts.map((pos, index) => ({
      id: `b${index + 1}`,
      side: "bot",
      row: pos.row,
      col: pos.col,
      hp: UNIT_HP,
      label: `B-${index + 1}`,
    }));

    units = [...playerUnits, ...botUnits];
  };

  const isControlNode = (row, col) => CONTROL_NODES.some((node) => node.row === row && node.col === col);

  const getAdjacentTiles = (row, col) => [
    { row: row - 1, col },
    { row: row + 1, col },
    { row, col: col - 1 },
    { row, col: col + 1 },
  ].filter((tile) => tile.row >= 0 && tile.row < GRID_SIZE && tile.col >= 0 && tile.col < GRID_SIZE);

  const getValidActions = (unit) => {
    const actions = [];
    getAdjacentTiles(unit.row, unit.col).forEach((tile) => {
      const occupant = getUnitAt(tile.row, tile.col);
      if (!occupant) {
        actions.push({ type: "move", unit, to: tile });
      } else if (occupant.side !== unit.side) {
        actions.push({ type: "attack", unit, target: occupant, to: tile });
      }
    });
    return actions;
  };

  const highlightTiles = () => {
    const tiles = gameBoard.querySelectorAll(".grid-tile");
    tiles.forEach((tile) => {
      tile.classList.remove("highlight", "attack");
    });

    if (!selectedUnitId) return;
    const selectedUnit = units.find((unit) => unit.id === selectedUnitId);
    if (!selectedUnit) return;

    getValidActions(selectedUnit).forEach((action) => {
      const tile = gameBoard.querySelector(`[data-row='${action.to.row}'][data-col='${action.to.col}']`);
      if (!tile) return;
      tile.classList.add(action.type === "attack" ? "attack" : "highlight");
    });
  };

  const renderBoard = () => {
    gameBoard.innerHTML = "";
    for (let row = 0; row < GRID_SIZE; row += 1) {
      for (let col = 0; col < GRID_SIZE; col += 1) {
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = "grid-tile";
        tile.dataset.row = `${row}`;
        tile.dataset.col = `${col}`;

        if (isControlNode(row, col)) {
          tile.classList.add("control-node");
        }

        const occupant = getUnitAt(row, col);
        if (occupant) {
          const unitEl = document.createElement("div");
          unitEl.className = `unit ${occupant.side}`;

          const label = document.createElement("div");
          label.className = "unit-label";
          label.textContent = occupant.label;

          const hpWrap = document.createElement("div");
          hpWrap.className = "unit-hp";
          for (let hp = 0; hp < occupant.hp; hp += 1) {
            const dot = document.createElement("span");
            dot.className = "hp-dot";
            hpWrap.appendChild(dot);
          }

          unitEl.appendChild(label);
          unitEl.appendChild(hpWrap);
          tile.appendChild(unitEl);
        } else if (isControlNode(row, col)) {
          tile.textContent = "Node";
        }

        tile.addEventListener("click", () => handleTileClick(row, col));
        gameBoard.appendChild(tile);
      }
    }

    highlightTiles();
  };

  const countControl = (side) => CONTROL_NODES.filter((node) => {
    const occupant = getUnitAt(node.row, node.col);
    return occupant && occupant.side === side;
  }).length;

  const checkWin = () => {
    const playerUnits = units.filter((unit) => unit.side === "player");
    const botUnits = units.filter((unit) => unit.side === "bot");

    if (playerControl >= CONTROL_TARGET || botUnits.length === 0) {
      return "player";
    }
    if (botControl >= CONTROL_TARGET || playerUnits.length === 0) {
      return "bot";
    }
    if (turnCount > MAX_TURNS) {
      if (playerControl !== botControl) {
        return playerControl > botControl ? "player" : "bot";
      }
      return playerUnits.length >= botUnits.length ? "player" : "bot";
    }

    return null;
  };

  const resolveMatch = (winner) => {
    matchActive = false;
    activeSide = "player";
    selectedUnitId = null;
    actionTaken = false;
    startMatchBtn.disabled = false;
    endTurnBtn.disabled = true;

    if (botTimeout) {
      clearTimeout(botTimeout);
      botTimeout = null;
    }

    const pointsBefore = state.points;
    const previousLevel = getCheckpointInfo(state.points).current;
    const playerWon = winner === "player";

    if (playerWon) {
      state.points += POINTS_PER_WIN;
      state.wins += 1;
    } else {
      const { checkpointBase } = getCheckpointInfo(state.points);
      state.points = Math.max(state.points + POINTS_PER_LOSS, checkpointBase);
      state.losses += 1;
    }

    state.totalGames += 1;
    updateDirectorState(state, playerWon, pointsBefore);
    updateAdaptiveState(state, playerWon);
    Storage.save(state);

    updateScoreboard(state);
    updateTrack(state, previousLevel);

    setBanner(
      playerWon
        ? "Victory secured. Checkpoint points locked in."
        : "Defeat logged. Checkpoints hold the line.",
      playerWon ? "win" : "loss"
    );
  };

  const applyAction = (action) => {
    if (action.type === "move") {
      action.unit.row = action.to.row;
      action.unit.col = action.to.col;
    } else if (action.type === "attack") {
      action.target.hp -= 1;
      if (action.target.hp <= 0) {
        units = units.filter((unit) => unit.id !== action.target.id);
      }
    }
  };

  const handleTileClick = (row, col) => {
    if (!matchActive || activeSide !== "player") return;

    const clickedUnit = getUnitAt(row, col);
    if (clickedUnit && clickedUnit.side === "player" && !actionTaken) {
      selectedUnitId = clickedUnit.id;
      updateMeta();
      highlightTiles();
      return;
    }

    if (!selectedUnitId || actionTaken) return;

    const selectedUnit = units.find((unit) => unit.id === selectedUnitId);
    if (!selectedUnit) return;

    const action = getValidActions(selectedUnit).find(
      (candidate) => candidate.to.row === row && candidate.to.col === col
    );

    if (!action) return;

    applyAction(action);
    actionTaken = true;
    selectedUnitId = null;
    lastPlayerAction = {
      type: action.type,
      targetId: action.type === "attack" ? action.target.id : null,
      targetPosition: action.to,
    };

    setBanner(
      action.type === "attack" ? "Strike landed. Pressure the bot." : "Unit repositioned. Control the lanes.",
      null
    );

    renderBoard();
    const winner = checkWin();
    if (winner) {
      resolveMatch(winner);
      return;
    }

    endTurnBtn.disabled = false;
  };

  const updateEndTurnAvailability = () => {
    if (!matchActive || activeSide !== "player") {
      endTurnBtn.disabled = true;
      return;
    }
    if (actionTaken) {
      endTurnBtn.disabled = false;
      return;
    }
    const hasActions = units
      .filter((unit) => unit.side === "player")
      .some((unit) => getValidActions(unit).length > 0);
    endTurnBtn.disabled = hasActions;
  };

  const endTurn = () => {
    if (!matchActive || activeSide !== "player") return;

    playerControl += countControl("player");
    actionTaken = false;
    selectedUnitId = null;
    const winner = checkWin();

    if (winner) {
      renderBoard();
      resolveMatch(winner);
      return;
    }

    activeSide = "bot";
    setBanner("Bot is calculating a response...", null);
    updateMeta();
    renderBoard();
    endTurnBtn.disabled = true;

    botTimeout = setTimeout(() => {
      botTurn();
    }, BOT_DELAY);
  };

  const scoreAction = (action, aggression, pressure) => {
    let score = 0;
    if (action.type === "attack") {
      score += 4 + aggression * 4;
      if (action.target.hp === 1) {
        score += 4;
      }
      if (isControlNode(action.target.row, action.target.col)) {
        score += 2 + pressure * 2;
      }
      if (lastPlayerAction && lastPlayerAction.targetId === action.target.id) {
        score += 2.5;
      }
    } else {
      score += 1 + pressure * 2;
      if (isControlNode(action.to.row, action.to.col)) {
        score += 3 + pressure * 2.5;
      }
      const nearbyEnemy = getAdjacentTiles(action.to.row, action.to.col).some((tile) => {
        const occupant = getUnitAt(tile.row, tile.col);
        return occupant && occupant.side === "player";
      });
      if (nearbyEnemy) {
        score += aggression * 2.5;
      }
      if (lastPlayerAction && lastPlayerAction.targetPosition) {
        const distance = Math.abs(lastPlayerAction.targetPosition.row - action.to.row)
          + Math.abs(lastPlayerAction.targetPosition.col - action.to.col);
        if (distance <= 2) {
          score += 1.5;
        }
      }
    }
    return score;
  };

  const botTurn = () => {
    if (!matchActive || activeSide !== "bot") return;

    const challenge = calculateAdaptiveChallenge(state);
    const brinkBoost = isOneWinFromCheckpoint(state.points) ? 0.12 : 0;
    const recoveryEase = state.recoveryGames > 0 ? -0.18 : 0;
    const aggression = Utils.clamp(
      0.45 + (challenge.winRate - 0.5) * 1.2 + brinkBoost + recoveryEase,
      0.22,
      0.9
    );
    const pressure = Utils.clamp(
      0.35 + state.winRateEma + brinkBoost + recoveryEase,
      0.25,
      0.88
    );

    const possibleActions = units
      .filter((unit) => unit.side === "bot")
      .flatMap((unit) => getValidActions(unit));

    if (possibleActions.length === 0) {
      botControl += countControl("bot");
      activeSide = "player";
      turnCount += 1;
      setBanner("Bot holds position. Your move.", null);
      updateMeta();
      renderBoard();
      updateEndTurnAvailability();
      return;
    }

    const scoredActions = possibleActions.map((action) => ({
      action,
      score: scoreAction(action, aggression, pressure),
    }));

    scoredActions.sort((a, b) => b.score - a.score);
    const bestScore = scoredActions[0].score;
    const bestChoices = scoredActions.filter((entry) => entry.score >= bestScore - 0.5);
    const selected = Utils.shuffle(bestChoices)[0].action;

    applyAction(selected);

    botControl += countControl("bot");

    const winner = checkWin();
    if (winner) {
      renderBoard();
      resolveMatch(winner);
      return;
    }

    activeSide = "player";
    turnCount += 1;
    setBanner(selected.type === "attack" ? "Bot strikes back. Your turn." : "Bot repositions. Your move.", null);
    updateMeta();
    renderBoard();
    updateEndTurnAvailability();
  };

  const startMatch = () => {
    matchActive = true;
    activeSide = "player";
    turnCount = 1;
    playerControl = 0;
    botControl = 0;
    selectedUnitId = null;
    actionTaken = false;
    lastPlayerAction = null;
    createUnits();
    setBanner("Your turn. Select a unit to act.", null);
    updateMeta();
    renderBoard();
    updateEndTurnAvailability();
    startMatchBtn.disabled = true;
  };

  playBtn.addEventListener("click", () => {
    switchScreen("game");
    startMatch();
  });

  backBtn.addEventListener("click", () => {
    switchScreen("checkpoint");
  });

  startMatchBtn.addEventListener("click", startMatch);
  endTurnBtn.addEventListener("click", endTurn);

  resetRunBtn.addEventListener("click", () => {
    state = Storage.reset();
    Storage.save(state);
    updateScoreboard(state);
    updateTrack(state);
    matchActive = false;
    startMatchBtn.disabled = false;
    endTurnBtn.disabled = true;
    setBanner("Deploy units to begin the skirmish.", null);
    if (botTimeout) {
      clearTimeout(botTimeout);
      botTimeout = null;
    }
  });

  updateScoreboard(state);
  updateTrack(state);
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp, { once: true });
} else {
  initApp();
}
