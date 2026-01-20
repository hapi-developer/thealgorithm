/* app.js — Beacon Tactics (turn-based grid strategy vs bot)
   Uses window.FlowDirector for difficulty + flow pacing + assist.
*/
(() => {
  "use strict";

  // --- checkpoint system ---
  const STORAGE_KEY = "beacon_tactics_state_v1";
  const CHECKPOINT_POINTS = 1000;
  const POINTS_PER_WIN = 100;
  const POINTS_PER_LOSS = -100;

  // --- game config ---
  const SIZE = 7;
  const ACTIONS_PER_TURN = 2;
  const WIN_BEACONS = 5;
  const MAX_TURNS = 18;

  const UNIT_HP = 2;
  const SHIELD_PER_FORTIFY = 1;
  const SNIPER_RANGE = 2;

  // UI helpers
  const byId = (id) => document.getElementById(id);
  const setText = (el, v) => { if (el) el.textContent = String(v); };

  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const fmt = (n) => Number(n).toLocaleString("en-US");

  // storage state
  const defaultProgress = () => ({
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
      if (!raw) return defaultProgress();
      try { return { ...defaultProgress(), ...JSON.parse(raw) }; }
      catch { return defaultProgress(); }
    },
    save(s) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); },
    reset() { localStorage.removeItem(STORAGE_KEY); return defaultProgress(); },
  };

  const getWinRate = (s) => (s.totalGames ? s.wins / s.totalGames : 0.5);

  const getCheckpointInfo = (points) => {
    const p = Math.max(0, Number(points) || 0);
    const current = Math.floor(p / CHECKPOINT_POINTS);
    const base = current * CHECKPOINT_POINTS;
    const next = (current + 1) * CHECKPOINT_POINTS;
    const prog = (p - base) / CHECKPOINT_POINTS;
    return { current, base, next, prog };
  };

  // director (flow + difficulty + pacing)
  const director = new window.FlowDirector({
    targetWinRate: 0.58,
    turnTimeTargetMs: 7000,
    actionsPerTurnTarget: ACTIONS_PER_TURN,
    botDelayMs: 650,
  });

  // DOM
  const el = {
    appError: byId("appError"),

    checkpointScreen: byId("checkpointScreen"),
    gameScreen: byId("gameScreen"),
    playBtn: byId("playBtn"),
    backBtn: byId("backBtn"),
    resetRunBtn: byId("resetRunBtn"),

    pointsValue: byId("pointsValue"),
    winRateValue: byId("winRateValue"),
    flowValue: byId("flowValue"),

    checkpointValue: byId("checkpointValue"),
    nextCheckpoint: byId("nextCheckpoint"),
    trackFill: byId("trackFill"),
    checkpointDots: byId("checkpointDots"),
    directorBadge: byId("directorBadge"),
    assistBadge: byId("assistBadge"),

    turnBanner: byId("turnBanner"),
    turnOwner: byId("turnOwner"),
    turnValue: byId("turnValue"),
    actionsLeftValue: byId("actionsLeftValue"),
    playerBeacons: byId("playerBeacons"),
    botBeacons: byId("botBeacons"),
    selectedUnit: byId("selectedUnit"),

    difficultyValue: byId("difficultyValue"),
    pacingValue: byId("pacingValue"),
    assistValue: byId("assistValue"),
    beatValue: byId("beatValue"),

    startMatchBtn: byId("startMatchBtn"),
    endTurnBtn: byId("endTurnBtn"),

    board: byId("gameBoard"),
  };

  const requireIds = [
    "checkpointScreen","gameScreen","playBtn","backBtn","resetRunBtn",
    "pointsValue","winRateValue","flowValue",
    "checkpointValue","nextCheckpoint","trackFill","checkpointDots",
    "turnBanner","turnOwner","turnValue","actionsLeftValue","playerBeacons","botBeacons","selectedUnit",
    "difficultyValue","pacingValue","assistValue","beatValue",
    "startMatchBtn","endTurnBtn","gameBoard"
  ];
  const missing = requireIds.filter((id) => !byId(id));
  if (missing.length) {
    el.appError.hidden = false;
    el.appError.textContent = `Missing required element(s): ${missing.join(", ")}`;
    return;
  }

  // ---------- game state ----------
  let progress = Storage.load();

  let matchActive = false;
  let activeSide = "player";
  let turn = 1;
  let actionsLeft = ACTIONS_PER_TURN;

  let playerBeaconScore = 0;
  let botBeaconScore = 0;

  let selectedUnitId = null;
  let botTimeout = null;

  // timing telemetry
  let turnStartMs = 0;
  let actionCountThisTurn = 0;
  let mistakesThisTurn = 0;

  // map data
  const BEACONS = [
    { r: 1, c: 1 },
    { r: 1, c: 5 },
    { r: 3, c: 3 },
    { r: 5, c: 1 },
    { r: 5, c: 5 },
  ];

  let units = [];

  const mkUnit = (id, side, type, r, c) => ({
    id, side, type, r, c,
    hp: UNIT_HP,
    shield: 0,
    label:
      type === "sniper" ? (side === "player" ? "P-S" : "B-S") :
      type === "tank" ? (side === "player" ? "P-T" : "B-T") :
      (side === "player" ? "P" : "B"),
  });

  const resetMatchState = () => {
    matchActive = false;
    activeSide = "player";
    turn = 1;
    actionsLeft = ACTIONS_PER_TURN;
    playerBeaconScore = 0;
    botBeaconScore = 0;
    selectedUnitId = null;
    units = [];
    clearBotTimeout();
    actionCountThisTurn = 0;
    mistakesThisTurn = 0;
    turnStartMs = 0;
  };

  const clearBotTimeout = () => {
    if (botTimeout) {
      clearTimeout(botTimeout);
      botTimeout = null;
    }
  };

  const switchScreen = (name) => {
    if (name === "game") {
      el.checkpointScreen.classList.remove("active");
      el.gameScreen.classList.add("active");
    } else {
      el.gameScreen.classList.remove("active");
      el.checkpointScreen.classList.add("active");
    }
  };

  const setBanner = (msg, outcome) => {
    el.turnBanner.classList.remove("win", "loss");
    if (outcome) el.turnBanner.classList.add(outcome);
    el.turnBanner.textContent = msg;
  };

  const getCheckpointFloor = (points) => getCheckpointInfo(points).base;

  const updateScoreHud = () => {
    setText(el.pointsValue, fmt(progress.points));
    setText(el.winRateValue, `${Math.round(getWinRate(progress) * 100)}%`);

    const rec = director.recommend();
    setText(el.flowValue, `${Math.round(rec.snapshot.flow * 100)}%`);
  };

  const updateDirectorStrip = () => {
    const rec = director.recommend();
    setText(el.difficultyValue, `${Math.round(rec.difficulty * 100)}%`);
    setText(el.pacingValue, `${Math.round(rec.pacingMs)}ms`);
    setText(el.assistValue, rec.assistMode);
    setText(el.beatValue, rec.beat);

    el.assistBadge.textContent = `Assist: ${rec.assistMode}`;
  };

  const updateTrack = (previousLevel = null) => {
    const { current, next, prog } = getCheckpointInfo(progress.points);

    el.trackFill.style.width = `${clamp(prog, 0, 1) * 100}%`;
    el.checkpointDots.innerHTML = "";

    const dotsToShow = 7;
    const start = Math.max(current - 3, 0);
    const frag = document.createDocumentFragment();

    for (let i = 0; i < dotsToShow; i += 1) {
      const lvl = start + i;
      const dot = document.createElement("div");
      dot.className = "track-dot";

      const label = document.createElement("span");
      label.className = "track-dot-label";
      label.textContent = `L${lvl}`;
      dot.appendChild(label);

      if (lvl < current) dot.classList.add("reached");
      if (lvl === current) dot.classList.add("current");
      if (lvl === current + 1) dot.classList.add("next");

      frag.appendChild(dot);
    }

    el.checkpointDots.appendChild(frag);

    setText(el.checkpointValue, String(current));
    setText(el.nextCheckpoint, `${fmt(next)} pts`);

    if (previousLevel !== null && current > previousLevel) {
      const panel = document.querySelector(".track-panel");
      if (panel) {
        panel.classList.remove("celebrate");
        void panel.offsetWidth;
        panel.classList.add("celebrate");
      }
    }
  };

  const updateMeta = () => {
    setText(el.turnOwner, activeSide === "player" ? "Player" : "Bot");
    setText(el.turnValue, String(turn));
    setText(el.actionsLeftValue, String(actionsLeft));
    setText(el.playerBeacons, String(playerBeaconScore));
    setText(el.botBeacons, String(botBeaconScore));
    const u = units.find((x) => x.id === selectedUnitId);
    setText(el.selectedUnit, u ? u.label : "None");
  };

  // ---------- rules ----------
  const inBounds = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;

  const isBeacon = (r, c) => BEACONS.some((b) => b.r === r && b.c === c);

  const unitAt = (r, c) => units.find((u) => u.r === r && u.c === c);

  const neighbors4 = (r, c) => ([
    { r: r - 1, c }, { r: r + 1, c }, { r, c: c - 1 }, { r, c: c + 1 },
  ]).filter((p) => inBounds(p.r, p.c));

  const canLineAttack = (from, to, allUnits) => {
    if (from.r !== to.r && from.c !== to.c) return false;
    const dist = Math.abs(from.r - to.r) + Math.abs(from.c - to.c);
    if (dist < 1 || dist > SNIPER_RANGE) return false;

    const dr = Math.sign(to.r - from.r);
    const dc = Math.sign(to.c - from.c);

    let r = from.r + dr;
    let c = from.c + dc;
    while (r !== to.r || c !== to.c) {
      if (allUnits.some((u) => u.r === r && u.c === c)) return false;
      r += dr; c += dc;
    }
    return true;
  };

  const actionsFor = (unit, allUnits = units) => {
    const acts = [];

    // Fortify (click same unit) — always available
    acts.push({ type: "fortify", unitId: unit.id, to: { r: unit.r, c: unit.c } });

    // adjacent move/attack
    for (const p of neighbors4(unit.r, unit.c)) {
      const occ = allUnits.find((u) => u.r === p.r && u.c === p.c);
      if (!occ) acts.push({ type: "move", unitId: unit.id, to: p });
      else if (occ.side !== unit.side) acts.push({ type: "attack", unitId: unit.id, targetId: occ.id, to: p, ranged: false });
    }

    // sniper line attack
    if (unit.type === "sniper") {
      const enemies = allUnits.filter((u) => u.side !== unit.side);
      for (const e of enemies) {
        if (canLineAttack(unit, e, allUnits)) {
          acts.push({ type: "attack", unitId: unit.id, targetId: e.id, to: { r: e.r, c: e.c }, ranged: true });
        }
      }
    }

    return acts;
  };

  const applyAction = (action, allUnits) => {
    const u = allUnits.find((x) => x.id === action.unitId);
    if (!u) return allUnits;

    if (action.type === "fortify") {
      u.shield = (u.shield || 0) + SHIELD_PER_FORTIFY;
      return allUnits;
    }

    if (action.type === "move") {
      u.r = action.to.r; u.c = action.to.c;
      return allUnits;
    }

    if (action.type === "attack") {
      const t = allUnits.find((x) => x.id === action.targetId);
      if (!t) return allUnits;

      if (t.shield && t.shield > 0) {
        t.shield -= 1;
        return allUnits;
      }

      t.hp -= 1;
      if (t.hp <= 0) return allUnits.filter((x) => x.id !== t.id);
      return allUnits;
    }

    return allUnits;
  };

  const scoreEndOfTurnBeacons = () => {
    // occupied beacons score
    for (const b of BEACONS) {
      const occ = unitAt(b.r, b.c);
      if (!occ) continue;
      if (occ.side === "player") playerBeaconScore += 1;
      else botBeaconScore += 1;
    }
  };

  const checkWinner = () => {
    const pUnits = units.filter((u) => u.side === "player");
    const bUnits = units.filter((u) => u.side === "bot");

    if (playerBeaconScore >= WIN_BEACONS || bUnits.length === 0) return "player";
    if (botBeaconScore >= WIN_BEACONS || pUnits.length === 0) return "bot";

    if (turn > MAX_TURNS) {
      if (playerBeaconScore !== botBeaconScore) return playerBeaconScore > botBeaconScore ? "player" : "bot";
      // tiebreaker: total health+shield
      const pPow = pUnits.reduce((s, u) => s + u.hp + (u.shield || 0) * 0.6, 0);
      const bPow = bUnits.reduce((s, u) => s + u.hp + (u.shield || 0) * 0.6, 0);
      return pPow >= bPow ? "player" : "bot";
    }

    return null;
  };

  // ---------- rendering ----------
  const render = () => {
    el.board.innerHTML = "";

    const rec = director.recommend();
    const showHighlights = rec.showHighlights;
    const showAttackHints = rec.showAttackHints;

    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c < SIZE; c += 1) {
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = "grid-tile";
        tile.dataset.r = String(r);
        tile.dataset.c = String(c);

        if (isBeacon(r, c)) tile.classList.add("beacon");

        const occ = unitAt(r, c);
        if (occ) {
          const wrap = document.createElement("div");
          wrap.className = `unit ${occ.side}`;

          const label = document.createElement("div");
          label.className = "unit-label";
          label.textContent = occ.label;

          const hp = document.createElement("div");
          hp.className = "unit-hp";
          for (let i = 0; i < occ.hp; i += 1) {
            const dot = document.createElement("span");
            dot.className = "hp-dot";
            hp.appendChild(dot);
          }
          for (let i = 0; i < (occ.shield || 0); i += 1) {
            const dot = document.createElement("span");
            dot.className = "shield-dot";
            hp.appendChild(dot);
          }

          wrap.appendChild(label);
          wrap.appendChild(hp);
          tile.appendChild(wrap);

          if (isBeacon(r, c)) {
            tile.classList.add(occ.side === "player" ? "held-player" : "held-bot");
          }
        }

        tile.addEventListener("click", () => onTileClick(r, c, showHighlights, showAttackHints));
        el.board.appendChild(tile);
      }
    }

    if (matchActive && activeSide === "player" && selectedUnitId && showHighlights) {
      highlightSelected(showAttackHints);
    }
  };

  const highlightSelected = (showAttackHints) => {
    const u = units.find((x) => x.id === selectedUnitId);
    if (!u) return;

    const acts = actionsFor(u);
    for (const a of acts) {
      if (a.type === "fortify") continue;
      const tile = el.board.querySelector(`[data-r="${a.to.r}"][data-c="${a.to.c}"]`);
      if (!tile) continue;
      if (a.type === "attack" && showAttackHints) tile.classList.add("attack");
      else tile.classList.add("highlight");
    }
  };

  // ---------- player interaction ----------
  const startTurnTimer = () => {
    turnStartMs = Date.now();
    actionCountThisTurn = 0;
    mistakesThisTurn = 0;
  };

  const commitTurnTelemetry = () => {
    const turnMs = Date.now() - (turnStartMs || Date.now());
    director.observeTurn({
      turnMs,
      actionsTaken: actionCountThisTurn,
      mistakes: mistakesThisTurn,
    });
    updateDirectorStrip();
    updateScoreHud();
  };

  const onTileClick = (r, c, showHighlights, showAttackHints) => {
    if (!matchActive || activeSide !== "player") return;
    if (actionsLeft <= 0) return;

    const clicked = unitAt(r, c);

    // selecting your unit
    if (clicked && clicked.side === "player") {
      if (selectedUnitId === clicked.id) {
        // fortify
        units = applyAction({ type: "fortify", unitId: clicked.id, to: { r, c } }, units);
        actionsLeft -= 1;
        actionCountThisTurn += 1;
        selectedUnitId = null;

        updateMeta();
        render();
        setBanner(`Your turn — ${actionsLeft} action(s) left.`, null);

        const winner = checkWinner();
        if (winner) return finishMatch(winner);

        el.endTurnBtn.disabled = false;
        return;
      }

      selectedUnitId = clicked.id;
      updateMeta();
      render();
      return;
    }

    if (!selectedUnitId) { mistakesThisTurn += 1; return; }

    const u = units.find((x) => x.id === selectedUnitId);
    if (!u) { selectedUnitId = null; return; }

    const acts = actionsFor(u);
    const chosen = acts.find((a) => a.type !== "fortify" && a.to.r === r && a.to.c === c);
    if (!chosen) { mistakesThisTurn += 1; return; }

    units = applyAction(chosen, units);
    actionsLeft -= 1;
    actionCountThisTurn += 1;
    selectedUnitId = null;

    updateMeta();
    render();

    const winner = checkWinner();
    if (winner) return finishMatch(winner);

    setBanner(`Your turn — ${actionsLeft} action(s) left.`, null);
    el.endTurnBtn.disabled = false;
  };

  // ---------- bot AI (adaptive, depth, randomness) ----------
  const deepCloneUnits = (arr) => arr.map((u) => ({ ...u }));

  const evalState = (allUnits, pB, bB) => {
    // bot-centric score (higher is better for bot)
    const p = allUnits.filter((u) => u.side === "player");
    const b = allUnits.filter((u) => u.side === "bot");

    const pow = (u) => u.hp + (u.shield || 0) * 0.6 + (u.type === "sniper" ? 0.35 : 0);
    const pPow = p.reduce((s, u) => s + pow(u), 0);
    const bPow = b.reduce((s, u) => s + pow(u), 0);

    const beaconDiff = (bB - pB) * 2.2;
    const powerDiff = (bPow - pPow) * 1.35;

    // beacon occupancy bonus
    let occ = 0;
    for (const be of BEACONS) {
      const o = allUnits.find((u) => u.r === be.r && u.c === be.c);
      if (!o) continue;
      occ += (o.side === "bot") ? 0.55 : -0.55;
    }

    // position toward beacons
    const distToBeacon = (u) => {
      let best = 999;
      for (const be of BEACONS) {
        const d = Math.abs(u.r - be.r) + Math.abs(u.c - be.c);
        best = Math.min(best, d);
      }
      return best;
    };
    const bPos = b.reduce((s, u) => s + (7 - distToBeacon(u)) * 0.10, 0);
    const pPos = p.reduce((s, u) => s + (7 - distToBeacon(u)) * 0.10, 0);

    return beaconDiff + powerDiff + occ + (bPos - pPos);
  };

  const actionsForSide = (side, allUnits) =>
    allUnits.filter((u) => u.side === side).flatMap((u) => actionsFor(u, allUnits));

  const simulate = (action, allUnits) => {
    const clone = deepCloneUnits(allUnits);
    return applyAction(action, clone);
  };

  const immediateHeuristic = (action, allUnits) => {
    let score = 0;
    const u = allUnits.find((x) => x.id === action.unitId);
    if (!u) return 0;

    if (action.type === "fortify") {
      // good if threatened
      const threats = actionsForSide(u.side === "bot" ? "player" : "bot", allUnits)
        .some((a) => a.type === "attack" && a.targetId === u.id);
      return threats ? 2.2 : 0.6;
    }

    if (action.type === "attack") {
      score += action.ranged ? 3.2 : 3.0;
      const t = allUnits.find((x) => x.id === action.targetId);
      if (t) {
        const eff = t.hp + (t.shield || 0);
        if (eff <= 1) score += 3.8;
        if (isBeacon(t.r, t.c)) score += 2.0;
      }
      return score;
    }

    if (action.type === "move") {
      if (isBeacon(action.to.r, action.to.c)) score += 3.2;
      else score += 0.7;
      return score;
    }

    return score;
  };

  const pickBotAction = (allUnits, pB, bB, rec) => {
    const acts = actionsForSide("bot", allUnits);
    if (!acts.length) return null;

    const depth = rec.depth;
    const randomness = rec.randomness;
    const gamma = 0.75;

    const scored = acts.map((a) => {
      const imm = immediateHeuristic(a, allUnits);

      let future;
      const afterBot = simulate(a, allUnits);

      if (depth >= 2) {
        const replies = actionsForSide("player", afterBot);
        if (replies.length) {
          // player chooses reply that minimizes bot eval
          let bestMin = Infinity;
          for (const ra of replies) {
            const afterP = simulate(ra, afterBot);
            const s = evalState(afterP, pB, bB);
            bestMin = Math.min(bestMin, s);
          }
          const botAfter = evalState(afterBot, pB, bB);
          future = botAfter - Math.max(0, botAfter - bestMin);
        } else {
          future = evalState(afterBot, pB, bB);
        }
      } else {
        future = evalState(afterBot, pB, bB);
      }

      return { action: a, score: imm + gamma * future };
    });

    scored.sort((x, y) => y.score - x.score);

    // adaptive randomness: sample among top window
    const best = scored[0].score;
    const margin = clamp(0.8 + randomness * 1.6, 0.7, 2.0);
    const pool = scored.filter((x) => x.score >= best - margin);
    const maxPick = Math.max(2, Math.round(2 + randomness * 6));
    const slice = pool.slice(0, Math.min(maxPick, pool.length));

    // shuffle
    for (let i = slice.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [slice[i], slice[j]] = [slice[j], slice[i]];
    }
    return slice[0].action;
  };

  const botActSequence = () => {
    if (!matchActive || activeSide !== "bot") return;

    const rec = director.recommend();
    const pacing = rec.pacingMs;

    let botActsLeft = ACTIONS_PER_TURN;

    const actOnce = () => {
      const chosen = pickBotAction(units, playerBeaconScore, botBeaconScore, rec);
      if (!chosen) { botActsLeft = 0; return; }
      units = applyAction(chosen, units);
      botActsLeft -= 1;
      render();

      const winner = checkWinner();
      if (winner) {
        botActsLeft = 0;
        finishMatch(winner);
      }
    };

    const finishBotTurn = () => {
      if (!matchActive) return;

      // bot scores beacons at end of its turn
      scoreEndOfTurnBeacons();

      const winner = checkWinner();
      if (winner) return finishMatch(winner);

      activeSide = "player";
      turn += 1;
      actionsLeft = ACTIONS_PER_TURN;
      selectedUnitId = null;

      startTurnTimer();
      updateMeta();
      render();

      setBanner(`Your turn — ${actionsLeft} action(s) left.`, null);
      el.endTurnBtn.disabled = false;
    };

    // pacing between bot actions
    actOnce();
    if (!matchActive) return;

    if (botActsLeft > 0) {
      botTimeout = setTimeout(() => {
        actOnce();
        finishBotTurn();
      }, Math.max(280, pacing * 0.6));
    } else {
      finishBotTurn();
    }
  };

  // ---------- match lifecycle ----------
  const deployUnits = () => {
    // player: 2 troopers + 1 sniper
    units = [
      mkUnit("p1", "player", "trooper", 6, 1),
      mkUnit("p2", "player", "trooper", 6, 3),
      mkUnit("p3", "player", "sniper", 6, 5),

      mkUnit("b1", "bot", "trooper", 0, 1),
      mkUnit("b2", "bot", "trooper", 0, 3),
      mkUnit("b3", "bot", "sniper", 0, 5),
    ];
  };

  const startMatch = () => {
    resetMatchState();
    matchActive = true;

    deployUnits();

    activeSide = "player";
    actionsLeft = ACTIONS_PER_TURN;
    turn = 1;

    startTurnTimer();
    updateDirectorStrip();
    updateScoreHud();
    updateMeta();

    render();

    el.startMatchBtn.disabled = true;
    el.endTurnBtn.disabled = false;

    setBanner(`Your turn — ${actionsLeft} action(s) left.`, null);
  };

  const endPlayerTurn = () => {
    if (!matchActive || activeSide !== "player") return;

    // telemetry for player turn
    commitTurnTelemetry();

    // score beacons at end of player turn
    scoreEndOfTurnBeacons();

    const winner = checkWinner();
    if (winner) return finishMatch(winner);

    activeSide = "bot";
    selectedUnitId = null;

    updateMeta();
    render();
    setBanner("Bot is thinking…", null);

    el.endTurnBtn.disabled = true;

    // bot starts after pacing
    const rec = director.recommend();
    botTimeout = setTimeout(() => botActSequence(), Math.max(260, rec.pacingMs));
  };

  const finishMatch = (winner) => {
    matchActive = false;
    clearBotTimeout();

    // close/comeback flags for director
    const closeGame = Math.abs(playerBeaconScore - botBeaconScore) <= 1;
    const comeback = false; // simple placeholder; can be computed with more tracking

    // update progress points with checkpoint floor
    const pointsBefore = progress.points;
    const prevLevel = getCheckpointInfo(progress.points).current;

    const playerWon = winner === "player";

    if (playerWon) {
      progress.points += POINTS_PER_WIN;
      progress.wins += 1;
    } else {
      const floor = getCheckpointFloor(progress.points);
      progress.points = Math.max(progress.points + POINTS_PER_LOSS, floor);
      progress.losses += 1;
    }
    progress.totalGames += 1;

    Storage.save(progress);

    // director learns from match outcome
    director.observeGame({
      playerWon,
      turns: turn,
      closeGame,
      comeback,
      playerBeaconScore,
      botBeaconScore,
    });

    updateScoreHud();
    updateTrack(prevLevel);
    updateDirectorStrip();

    el.startMatchBtn.disabled = false;
    el.endTurnBtn.disabled = true;

    setBanner(
      playerWon ? "Victory! Points locked into your checkpoint run." : "Defeat. Checkpoints hold your floor.",
      playerWon ? "win" : "loss"
    );
  };

  // ---------- wiring ----------
  el.playBtn.addEventListener("click", () => {
    switchScreen("game");
    // don’t auto-start; let user hit Start Match for clarity
    setBanner("Press Start Match to deploy.", null);
    updateDirectorStrip();
    updateMeta();
    render();
  });

  el.backBtn.addEventListener("click", () => {
    matchActive = false;
    clearBotTimeout();
    switchScreen("checkpoint");
    setBanner("Press Start Match to deploy.", null);
  });

  el.startMatchBtn.addEventListener("click", startMatch);
  el.endTurnBtn.addEventListener("click", endPlayerTurn);

  el.resetRunBtn.addEventListener("click", () => {
    progress = Storage.reset();
    Storage.save(progress);
    updateScoreHud();
    updateTrack(null);
    resetMatchState();
    setBanner("Progress reset. Ready when you are.", null);
  });

  // initial
  updateScoreHud();
  updateTrack(null);
  updateDirectorStrip();
  updateMeta();
  render();
})();
