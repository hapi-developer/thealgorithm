/* Checkpoint Command — Gridfront Skirmish (skill-based + smarter bot) */

const STORAGE_KEY = "checkpoint_command_state_v1";
const CHECKPOINT_POINTS = 1000;
const POINTS_PER_WIN = 100;
const POINTS_PER_LOSS = -100;

const GRID_SIZE = 6;
const UNIT_HP = 2;
const CONTROL_TARGET = 6;
const MAX_TURNS = 16;

const BOT_DELAY = 650;
const ACTIONS_PER_TURN = 2;

const FORTIFY_SHIELD = 1;
const SNIPER_RANGE = 2;

const TARGET_WINRATE = 0.58;

let appInitialized = false;

const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) console.warn(`Missing element: ${id}`);
  return el;
};

const setText = (el, value) => {
  if (el) el.textContent = value;
};

const Utils = {
  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  },
  formatNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
  },
  percentage(value) {
    const n = Number(value);
    const safe = Number.isFinite(n) ? n : 0;
    return `${Math.round(safe * 100)}%`;
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
  targetWinRate: TARGET_WINRATE,
  difficultyBias: 0,
});

const Storage = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return getDefaultState();
      return { ...getDefaultState(), ...JSON.parse(raw) };
    } catch {
      return getDefaultState();
    }
  },
  save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore
    }
  },
  reset() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    return getDefaultState();
  },
};

const getCheckpointInfo = (points) => {
  const p = Math.max(0, Number(points) || 0);
  const current = Math.floor(p / CHECKPOINT_POINTS);
  const checkpointBase = current * CHECKPOINT_POINTS;
  const nextValue = (current + 1) * CHECKPOINT_POINTS;
  const progress = (p - checkpointBase) / CHECKPOINT_POINTS;
  return { current, checkpointBase, nextValue, progress };
};

const getWinRate = (state) => {
  if (!state || state.totalGames === 0) return 0.5;
  return state.wins / state.totalGames;
};

/**
 * Adaptive director:
 * - computes difficulty scalar in [0.15..0.95]
 * - maps to aggression/pressure/randomness + depth
 * - nudges difficultyBias toward target winrate over time (fair, no cheating)
 */
const calculateAdaptiveChallenge = (state) => {
  const winRate = getWinRate(state);
  const target = state.targetWinRate ?? TARGET_WINRATE;

  const gap = Utils.clamp(winRate - target, -0.5, 0.5);
  const emaDrift = Utils.clamp(state.winRateEma - target, -0.35, 0.35);
  const volatility = Utils.clamp(state.volatility, 0.12, 0.45);
  const bias = Utils.clamp(state.difficultyBias ?? 0, -0.25, 0.25);

  const difficulty = Utils.clamp(
    0.5 + gap * 0.9 + emaDrift * 0.6 - (volatility - 0.25) * 0.35 + bias,
    0.15,
    0.95
  );

  const aggression = Utils.clamp(0.25 + difficulty * 0.75, 0.25, 0.95);
  const pressure = Utils.clamp(0.25 + difficulty * 0.70, 0.25, 0.90);

  // Higher difficulty = less randomness
  const randomness = Utils.clamp(0.65 - difficulty * 0.55, 0.08, 0.65);

  // Depth-2 lookahead kicks in past mid difficulty
  const depth = difficulty >= 0.58 ? 2 : 1;

  return { winRate, target, difficulty, aggression, pressure, randomness, depth };
};

const updateAdaptiveState = (state, playerWon) => {
  const reward = playerWon ? 1 : 0;
  const alpha = 0.08;

  state.winRateEma = state.winRateEma + alpha * (reward - state.winRateEma);

  const error = reward - state.winRateEma;
  state.volatility = Utils.clamp(state.volatility * 0.9 + Math.abs(error) * 0.1, 0.12, 0.45);

  // Learn difficulty bias toward target winrate
  const target = state.targetWinRate ?? TARGET_WINRATE;
  const gap = Utils.clamp(getWinRate(state) - target, -0.5, 0.5);
  state.difficultyBias = Utils.clamp((state.difficultyBias ?? 0) + gap * 0.03, -0.25, 0.25);
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

  if (!trackFill || !dotsContainer) return;

  trackFill.style.width = `${Utils.clamp(progress, 0, 1) * 100}%`;

  dotsContainer.innerHTML = "";
  const frag = document.createDocumentFragment();

  const dotsToShow = 7;
  const startLevel = Math.max(current - 3, 0);

  for (let i = 0; i < dotsToShow; i += 1) {
    const dotLevel = startLevel + i;
    const dot = document.createElement("div");
    dot.className = "track-dot";

    const label = document.createElement("span");
    label.className = "track-dot-label";
    label.textContent = `L${dotLevel}`;
    dot.appendChild(label);

    if (dotLevel < current) dot.classList.add("reached");
    if (dotLevel === current) dot.classList.add("current");
    if (dotLevel === current + 1) dot.classList.add("next");

    frag.appendChild(dot);
  }

  dotsContainer.appendChild(frag);

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

  if (!checkpointScreen || !gameScreen || !playBtn || !backBtn || !startMatchBtn || !endTurnBtn || !resetRunBtn || !gameBoard || !turnBanner) {
    return;
  }

  let matchActive = false;
  let activeSide = "player";
  let turnCount = 1;

  let playerControl = 0;
  let botControl = 0;

  let selectedUnitId = null;
  let actionsLeft = ACTIONS_PER_TURN;

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

  const getUnitAt = (row, col) => units.find((u) => u.row === row && u.col === col);

  const setBanner = (message, outcome) => {
    turnBanner.classList.remove("win", "loss");
    if (outcome) turnBanner.classList.add(outcome);
    turnBanner.textContent = message;
  };

  const updateMeta = () => {
    setText(turnOwner, activeSide === "player" ? "Player" : "Bot");
    setText(turnValue, `${turnCount}`);
    setText(playerControlEl, `${playerControl}`);
    setText(botControlEl, `${botControl}`);
    const selectedUnit = units.find((u) => u.id === selectedUnitId);
    setText(selectedUnitEl, selectedUnit ? selectedUnit.label : "None");
  };

  const isControlNode = (row, col) => CONTROL_NODES.some((n) => n.row === row && n.col === col);

  const createUnits = () => {
    // Player: 2 troopers + 1 sniper
    const playerStarts = [
      { row: 5, col: 1, type: "trooper" },
      { row: 5, col: 3, type: "trooper" },
      { row: 5, col: 5, type: "sniper" },
    ];

    // Bot: 2 troopers + 1 sniper
    const botStarts = [
      { row: 0, col: 0, type: "trooper" },
      { row: 0, col: 2, type: "trooper" },
      { row: 0, col: 4, type: "sniper" },
    ];

    const playerUnits = playerStarts.map((pos, i) => ({
      id: `p${i + 1}`,
      side: "player",
      type: pos.type,
      row: pos.row,
      col: pos.col,
      hp: UNIT_HP,
      shield: 0,
      label: pos.type === "sniper" ? `P-S` : `P-${i + 1}`,
    }));

    const botUnits = botStarts.map((pos, i) => ({
      id: `b${i + 1}`,
      side: "bot",
      type: pos.type,
      row: pos.row,
      col: pos.col,
      hp: UNIT_HP,
      shield: 0,
      label: pos.type === "sniper" ? `B-S` : `B-${i + 1}`,
    }));

    units = [...playerUnits, ...botUnits];
  };

  const getAdjacentTiles = (row, col) => [
    { row: row - 1, col },
    { row: row + 1, col },
    { row, col: col - 1 },
    { row, col: col + 1 },
  ].filter((t) => t.row >= 0 && t.row < GRID_SIZE && t.col >= 0 && t.col < GRID_SIZE);

  const canSeeInLine = (from, to, allUnits) => {
    // Straight line only, no diagonals
    if (from.row !== to.row && from.col !== to.col) return false;

    const dr = Math.sign(to.row - from.row);
    const dc = Math.sign(to.col - from.col);

    const dist = Math.abs(to.row - from.row) + Math.abs(to.col - from.col);
    if (dist < 1 || dist > SNIPER_RANGE) return false;

    // Check blockers between
    let r = from.row + dr;
    let c = from.col + dc;
    while (r !== to.row || c !== to.col) {
      const blocked = allUnits.some((u) => u.row === r && u.col === c);
      if (blocked) return false;
      r += dr;
      c += dc;
    }
    return true;
  };

  const getValidActions = (unit, allUnits = units) => {
    const actions = [];

    // Fortify always available (spends an action)
    actions.push({ type: "fortify", unitId: unit.id, to: { row: unit.row, col: unit.col } });

    // Adjacent moves/attacks (everyone)
    getAdjacentTiles(unit.row, unit.col).forEach((tile) => {
      const occ = allUnits.find((u) => u.row === tile.row && u.col === tile.col);
      if (!occ) actions.push({ type: "move", unitId: unit.id, to: tile });
      else if (occ.side !== unit.side) actions.push({ type: "attack", unitId: unit.id, targetId: occ.id, to: tile });
    });

    // Sniper line attacks (range 2)
    if (unit.type === "sniper") {
      const enemies = allUnits.filter((u) => u.side !== unit.side);
      enemies.forEach((enemy) => {
        if (canSeeInLine(unit, enemy, allUnits)) {
          actions.push({
            type: "attack",
            unitId: unit.id,
            targetId: enemy.id,
            to: { row: enemy.row, col: enemy.col },
            ranged: true,
          });
        }
      });
    }

    return actions;
  };

  const highlightTiles = () => {
    const tiles = gameBoard.querySelectorAll(".grid-tile");
    tiles.forEach((t) => t.classList.remove("highlight", "attack"));

    if (!selectedUnitId) return;

    const selectedUnit = units.find((u) => u.id === selectedUnitId);
    if (!selectedUnit) return;

    // highlight possible target tiles
    const actions = getValidActions(selectedUnit);
    actions.forEach((a) => {
      if (a.type === "fortify") return; // not a tile highlight
      const tile = gameBoard.querySelector(`[data-row='${a.to.row}'][data-col='${a.to.col}']`);
      if (!tile) return;
      tile.classList.add(a.type === "attack" ? "attack" : "highlight");
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

        if (isControlNode(row, col)) tile.classList.add("control-node");

        const occ = getUnitAt(row, col);
        if (occ) {
          const unitEl = document.createElement("div");
          unitEl.className = `unit ${occ.side}`;

          const label = document.createElement("div");
          label.className = "unit-label";
          label.textContent = occ.label;

          const hpWrap = document.createElement("div");
          hpWrap.className = "unit-hp";

          // HP dots
          for (let hp = 0; hp < occ.hp; hp += 1) {
            const dot = document.createElement("span");
            dot.className = "hp-dot";
            hpWrap.appendChild(dot);
          }

          // Shield dots (small squares)
          for (let sh = 0; sh < (occ.shield || 0); sh += 1) {
            const sdot = document.createElement("span");
            sdot.className = "shield-dot";
            hpWrap.appendChild(sdot);
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

  const countControl = (side) =>
    CONTROL_NODES.filter((n) => {
      const occ = getUnitAt(n.row, n.col);
      return occ && occ.side === side;
    }).length;

  const checkWin = () => {
    const playerUnits = units.filter((u) => u.side === "player");
    const botUnits = units.filter((u) => u.side === "bot");

    if (playerControl >= CONTROL_TARGET || botUnits.length === 0) return "player";
    if (botControl >= CONTROL_TARGET || playerUnits.length === 0) return "bot";

    if (turnCount > MAX_TURNS) {
      if (playerControl !== botControl) return playerControl > botControl ? "player" : "bot";
      // tiebreaker: total HP+shield
      const pPow = playerUnits.reduce((s, u) => s + u.hp + (u.shield || 0) * 0.6, 0);
      const bPow = botUnits.reduce((s, u) => s + u.hp + (u.shield || 0) * 0.6, 0);
      return pPow >= bPow ? "player" : "bot";
    }

    return null;
  };

  const resolveMatch = (winner) => {
    matchActive = false;
    activeSide = "player";
    selectedUnitId = null;
    actionsLeft = ACTIONS_PER_TURN;

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
      playerWon ? "Victory secured. Checkpoint points locked in." : "Defeat logged. Checkpoints hold the line.",
      playerWon ? "win" : "loss"
    );
  };

  const applyActionToUnits = (action, allUnits) => {
    const unit = allUnits.find((u) => u.id === action.unitId);
    if (!unit) return allUnits;

    if (action.type === "fortify") {
      unit.shield = (unit.shield || 0) + FORTIFY_SHIELD;
      return allUnits;
    }

    if (action.type === "move") {
      unit.row = action.to.row;
      unit.col = action.to.col;
      return allUnits;
    }

    if (action.type === "attack") {
      const target = allUnits.find((u) => u.id === action.targetId);
      if (!target) return allUnits;

      if (target.shield && target.shield > 0) {
        target.shield -= 1;
        return allUnits;
      }

      target.hp -= 1;
      if (target.hp <= 0) {
        return allUnits.filter((u) => u.id !== target.id);
      }
      return allUnits;
    }

    return allUnits;
  };

  const bannerActionsLeft = () => {
    if (!matchActive) return;
    if (activeSide === "player") {
      setBanner(`Your turn — ${actionsLeft} action(s) left.`, null);
    } else {
      setBanner("Bot is calculating a response...", null);
    }
  };

  const handleTileClick = (row, col) => {
    if (!matchActive || activeSide !== "player") return;
    if (actionsLeft <= 0) return;

    const clickedUnit = getUnitAt(row, col);

    // Select your unit
    if (clickedUnit && clickedUnit.side === "player") {
      if (selectedUnitId === clickedUnit.id) {
        // Clicking selected unit again => Fortify
        const fortAction = { type: "fortify", unitId: clickedUnit.id, to: { row, col } };
        units = applyActionToUnits(fortAction, units);
        actionsLeft = Math.max(actionsLeft - 1, 0);

        selectedUnitId = null;
        lastPlayerAction = { type: "fortify", targetId: null, targetPosition: { row, col } };

        renderBoard();
        updateMeta();
        bannerActionsLeft();

        const winner = checkWin();
        if (winner) return resolveMatch(winner);

        endTurnBtn.disabled = false;
        return;
      }

      // normal select
      selectedUnitId = clickedUnit.id;
      updateMeta();
      highlightTiles();
      return;
    }

    // Need a selected unit to act
    if (!selectedUnitId) return;

    const selectedUnit = units.find((u) => u.id === selectedUnitId);
    if (!selectedUnit) return;

    const actions = getValidActions(selectedUnit);
    const chosen = actions.find((a) => a.type !== "fortify" && a.to.row === row && a.to.col === col);
    if (!chosen) return;

    units = applyActionToUnits(chosen, units);
    actionsLeft = Math.max(actionsLeft - 1, 0);

    selectedUnitId = null;
    lastPlayerAction = {
      type: chosen.type,
      targetId: chosen.type === "attack" ? chosen.targetId : null,
      targetPosition: chosen.to,
    };

    renderBoard();
    updateMeta();

    const winner = checkWin();
    if (winner) return resolveMatch(winner);

    bannerActionsLeft();

    // End Turn always allowed once match started
    endTurnBtn.disabled = false;
  };

  const evaluateState = (allUnits, pControl, bControl) => {
    // Score from BOT perspective: higher is better for bot
    const botUnits = allUnits.filter((u) => u.side === "bot");
    const playerUnits = allUnits.filter((u) => u.side === "player");

    const botPower = botUnits.reduce((s, u) => s + u.hp + (u.shield || 0) * 0.6 + (u.type === "sniper" ? 0.35 : 0), 0);
    const playerPower = playerUnits.reduce((s, u) => s + u.hp + (u.shield || 0) * 0.6 + (u.type === "sniper" ? 0.35 : 0), 0);

    const controlDiff = (bControl - pControl) * 1.6;
    const powerDiff = (botPower - playerPower) * 1.35;

    // Node occupancy bonus
    const nodeDiff = CONTROL_NODES.reduce((acc, n) => {
      const occ = allUnits.find((u) => u.row === n.row && u.col === n.col);
      if (!occ) return acc;
      if (occ.side === "bot") return acc + 0.55;
      return acc - 0.55;
    }, 0);

    // Positional: distance to nodes
    const distToNodes = (unit) => CONTROL_NODES.reduce((best, n) => {
      const d = Math.abs(unit.row - n.row) + Math.abs(unit.col - n.col);
      return Math.min(best, d);
    }, 99);

    const botPos = botUnits.reduce((s, u) => s + (6 - distToNodes(u)) * 0.08, 0);
    const playerPos = playerUnits.reduce((s, u) => s + (6 - distToNodes(u)) * 0.08, 0);

    const posDiff = (botPos - playerPos) * 1.0;

    return controlDiff + powerDiff + nodeDiff + posDiff;
  };

  const enumerateActionsForSide = (side, allUnits) => {
    return allUnits
      .filter((u) => u.side === side)
      .flatMap((u) => getValidActions(u, allUnits));
  };

  const simulateAction = (action, allUnits) => {
    const cloned = allUnits.map((u) => ({ ...u }));
    const nextUnits = applyActionToUnits(action, cloned);
    return nextUnits;
  };

  const scoreImmediateAction = (action, allUnits, aggression, pressure) => {
    const unit = allUnits.find((u) => u.id === action.unitId);
    if (!unit) return 0;

    let score = 0;

    if (action.type === "fortify") {
      // Fortify is better when threatened
      const threatened = enumerateActionsForSide(unit.side === "bot" ? "player" : "bot", allUnits)
        .some((a) => a.type === "attack" && a.targetId === unit.id);
      score += threatened ? 2.2 + pressure * 1.4 : 0.6;
      return score;
    }

    if (action.type === "attack") {
      const target = allUnits.find((u) => u.id === action.targetId);
      if (!target) return 0;

      score += 3.2 + aggression * 3.5;

      // If target would die (no shield and hp==1)
      const effectiveHp = target.hp + (target.shield || 0);
      if (effectiveHp <= 1) score += 4.0;

      // Hitting units on nodes is juicy
      if (isControlNode(target.row, target.col)) score += 2.0 + pressure * 1.5;

      // Sniper shot bonus (safer)
      if (action.ranged) score += 0.9;

      return score;
    }

    if (action.type === "move") {
      // Prefer stepping onto nodes
      if (isControlNode(action.to.row, action.to.col)) {
        score += 3.5 + pressure * 2.2;
      } else {
        // Slightly prefer moving closer to nearest node
        const dist = CONTROL_NODES.reduce((best, n) => {
          const d = Math.abs(action.to.row - n.row) + Math.abs(action.to.col - n.col);
          return Math.min(best, d);
        }, 99);
        score += (6 - dist) * 0.22 + pressure * 0.35;
      }

      // Avoid moving into immediate attack range (roughly)
      const hypothetical = simulateAction(action, allUnits);
      const unitAfter = hypothetical.find((u) => u.id === action.unitId);
      const enemySide = unit.side === "bot" ? "player" : "bot";

      const danger = enumerateActionsForSide(enemySide, hypothetical)
        .some((a) => a.type === "attack" && a.targetId === unitAfter?.id);

      if (danger) score -= 1.2 - (pressure * 0.4);

      return score;
    }

    return score;
  };

  const pickBotAction = (allUnits, pControl, bControl, director) => {
    const botActions = enumerateActionsForSide("bot", allUnits);
    if (botActions.length === 0) return null;

    const depth = director.depth;
    const gamma = 0.7;

    // Evaluate each action with optional lookahead
    const scored = botActions.map((a) => {
      const immediate = scoreImmediateAction(a, allUnits, director.aggression, director.pressure);

      let future = 0;
      if (depth >= 2) {
        const afterBot = simulateAction(a, allUnits);

        // Player best reply (one action approximation)
        const playerActions = enumerateActionsForSide("player", afterBot);
        if (playerActions.length > 0) {
          let bestPlayer = -Infinity;
          playerActions.forEach((pa) => {
            const afterPlayer = simulateAction(pa, afterBot);
            const s = evaluateState(afterPlayer, pControl, bControl);
            // player wants LOW bot score
            if (s < bestPlayer) bestPlayer = s;
          });

          // Since evaluateState is bot-centric, the player's best reply minimizes it.
          // Convert that into a future estimate from bot perspective:
          future = evaluateState(afterBot, pControl, bControl) - (bestPlayer === -Infinity ? 0 : (bestPlayer - evaluateState(afterBot, pControl, bControl)));
          // Simplify: just use state after bot, but penalize if player can heavily reduce it.
          const afterBotScore = evaluateState(afterBot, pControl, bControl);
          future = afterBotScore - Math.max(0, afterBotScore - bestPlayer);
        } else {
          future = evaluateState(afterBot, pControl, bControl);
        }
      } else {
        const afterBot = simulateAction(a, allUnits);
        future = evaluateState(afterBot, pControl, bControl);
      }

      const total = immediate + future * gamma;
      return { action: a, score: total };
    });

    scored.sort((x, y) => y.score - x.score);

    // Adaptive randomness: sample among top-k within a margin
    const best = scored[0].score;
    const margin = Utils.clamp(0.8 + director.randomness * 1.4, 0.7, 1.8);
    const candidates = scored.filter((s) => s.score >= best - margin);

    // More randomness => larger candidate set
    const maxPick = Math.max(2, Math.round(2 + director.randomness * 5));
    const pool = candidates.slice(0, Math.min(maxPick, candidates.length));

    return Utils.shuffle(pool)[0].action;
  };

  const botTurn = () => {
    if (!matchActive || activeSide !== "bot") return;

    const director = calculateAdaptiveChallenge(state);

    let botActionsLeft = ACTIONS_PER_TURN;

    const actOnce = () => {
      if (!matchActive || activeSide !== "bot") return;

      const possible = enumerateActionsForSide("bot", units);
      if (possible.length === 0) {
        botActionsLeft = 0;
        return;
      }

      const chosen = pickBotAction(units, playerControl, botControl, director);
      if (!chosen) {
        botActionsLeft = 0;
        return;
      }

      units = applyActionToUnits(chosen, units);
      renderBoard();

      const winnerNow = checkWin();
      if (winnerNow) {
        resolveMatch(winnerNow);
        botActionsLeft = 0;
        return;
      }

      botActionsLeft -= 1;
    };

    // Bot performs up to 2 actions, with a little pacing
    const doBotSequence = () => {
      if (!matchActive || activeSide !== "bot") return;

      actOnce();
      if (!matchActive) return;

      if (botActionsLeft > 0) {
        botTimeout = setTimeout(() => {
          actOnce();
          finishBotTurn();
        }, Math.max(320, BOT_DELAY * 0.6));
      } else {
        finishBotTurn();
      }
    };

    const finishBotTurn = () => {
      if (!matchActive) return;

      botControl += countControl("bot");

      const winner = checkWin();
      if (winner) {
        renderBoard();
        resolveMatch(winner);
        return;
      }

      activeSide = "player";
      turnCount += 1;
      actionsLeft = ACTIONS_PER_TURN;

      selectedUnitId = null;
      updateMeta();
      renderBoard();

      setBanner(`Your turn — ${actionsLeft} action(s) left.`, null);
      endTurnBtn.disabled = false;
    };

    doBotSequence();
  };

  const endTurn = () => {
    if (!matchActive || activeSide !== "player") return;

    // Score node control at end of turn
    playerControl += countControl("player");

    const winner = checkWin();
    if (winner) {
      renderBoard();
      resolveMatch(winner);
      return;
    }

    activeSide = "bot";
    selectedUnitId = null;

    updateMeta();
    renderBoard();

    setBanner("Bot is calculating a response...", null);
    endTurnBtn.disabled = true;

    botTimeout = setTimeout(() => {
      botTurn();
    }, BOT_DELAY);
  };

  const startMatch = () => {
    matchActive = true;
    activeSide = "player";
    turnCount = 1;

    playerControl = 0;
    botControl = 0;

    selectedUnitId = null;
    actionsLeft = ACTIONS_PER_TURN;

    lastPlayerAction = null;

    createUnits();

    setBanner(`Your turn — ${actionsLeft} action(s) left. Select a unit.`, null);
    updateMeta();
    renderBoard();

    startMatchBtn.disabled = true;
    endTurnBtn.disabled = false;
  };

  // Buttons
  playBtn.addEventListener("click", () => {
    switchScreen("game");
    startMatch();
  });

  backBtn.addEventListener("click", () => {
    // Stop any ongoing match cleanly
    matchActive = false;
    activeSide = "player";
    selectedUnitId = null;
    actionsLeft = ACTIONS_PER_TURN;
    startMatchBtn.disabled = false;
    endTurnBtn.disabled = true;

    if (botTimeout) {
      clearTimeout(botTimeout);
      botTimeout = null;
    }

    switchScreen("checkpoint");
    setBanner("Deploy units to begin the skirmish.", null);
    updateMeta();
    renderBoard();
  });

  startMatchBtn.addEventListener("click", startMatch);
  endTurnBtn.addEventListener("click", endTurn);

  resetRunBtn.addEventListener("click", () => {
    state = Storage.reset();
    Storage.save(state);
    updateScoreboard(state);
    updateTrack(state);

    matchActive = false;
    activeSide = "player";
    selectedUnitId = null;
    actionsLeft = ACTIONS_PER_TURN;

    startMatchBtn.disabled = false;
    endTurnBtn.disabled = true;

    setBanner("Progress reset. Start a new match when ready.", null);

    if (botTimeout) {
      clearTimeout(botTimeout);
      botTimeout = null;
    }
  });

  // Init UI
  updateScoreboard(state);
  updateTrack(state);
  updateMeta();
  renderBoard();
};

// Boot
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp, { once: true });
} else {
  initApp();
}
