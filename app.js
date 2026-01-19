const STORAGE_KEY = "checkpoint_command_state_v1";
const CHECKPOINT_POINTS = 1000;
const POINTS_PER_WIN = 100;
const POINTS_PER_LOSS = -100;
const ROUNDS_PER_MATCH = 5;
const BASE_PULSE_SPEED = 0.38;
const MIN_ZONE_WIDTH = 0.12;
const MAX_ZONE_WIDTH = 0.32;

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
  const zoneWidth = Utils.clamp(baseWidth, MIN_ZONE_WIDTH, MAX_ZONE_WIDTH);

  const speed = Utils.clamp(
    BASE_PULSE_SPEED + levelPressure * 0.55 + Math.abs(emaDrift) * 0.25,
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
};

const updateScoreboard = (state) => {
  setText($("pointsValue"), Utils.formatNumber(state.points));
  setText($("winRateValue"), Utils.percentage(getWinRate(state)));
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
  const stopBtn = $("stopBtn");
  const resetRunBtn = $("resetRunBtn");
  const targetZone = $("targetZone");
  const marker = $("marker");
  const resultBanner = $("resultBanner");

  if (!checkpointScreen || !gameScreen || !playBtn || !backBtn || !startMatchBtn || !stopBtn || !resetRunBtn || !targetZone || !marker || !resultBanner) {
    return;
  }

  let matchActive = false;
  let roundsPlayed = 0;
  let roundsWon = 0;
  let pulseSpeed = BASE_PULSE_SPEED;
  let pulseWidth = 0.2;
  let pulsePosition = 0.1;
  let pulseDirection = 1;
  let frameId = null;
  let lastFrameTime = 0;

  const switchScreen = (target) => {
    if (target === "game") {
      checkpointScreen.classList.remove("active");
      gameScreen.classList.add("active");
    } else {
      gameScreen.classList.remove("active");
      checkpointScreen.classList.add("active");
    }
  };

  const resetPulse = () => {
    pulsePosition = Math.random() * 0.6 + 0.2;
    pulseDirection = Math.random() > 0.5 ? 1 : -1;
    marker.style.left = `${pulsePosition * 100}%`;
  };

  const updateZone = () => {
    const zoneStart = Utils.clamp(Math.random() * (1 - pulseWidth), 0.05, 0.75);
    targetZone.style.left = `${zoneStart * 100}%`;
    targetZone.style.width = `${pulseWidth * 100}%`;
  };

  const updateResult = (message, outcome) => {
    updateResultBanner(resultBanner, outcome);
    if (message) {
      resultBanner.textContent = message;
    }
  };

  const stopAnimation = () => {
    if (frameId) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
  };

  const resolveMatch = () => {
    matchActive = false;
    stopAnimation();
    stopBtn.disabled = true;
    startMatchBtn.disabled = false;

    const playerWins = roundsWon >= Math.ceil(ROUNDS_PER_MATCH / 2);

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
    updateResult(playerWins ? "Victory. +100 points locked in at your checkpoint." : "Defeat. -100 points, but checkpoints prevent further drops.", playerWins ? "win" : "loss");
  };

  const evaluateRound = () => {
    const zoneLeft = parseFloat(targetZone.style.left) / 100;
    const zoneWidth = parseFloat(targetZone.style.width) / 100;
    const zoneRight = zoneLeft + zoneWidth;
    const hit = pulsePosition >= zoneLeft && pulsePosition <= zoneRight;
    roundsPlayed += 1;
    if (hit) {
      roundsWon += 1;
    }

    const roundsRemaining = ROUNDS_PER_MATCH - roundsPlayed;
    if (roundsRemaining <= 0) {
      resolveMatch();
      return;
    }

    updateResult(hit ? "Hit. Keep the rhythm." : "Missed. Refocus and try again.", hit ? "win" : "loss");
    updateZone();
    resetPulse();
  };

  const tick = (timestamp) => {
    if (!matchActive) {
      stopAnimation();
      return;
    }

    if (!lastFrameTime) {
      lastFrameTime = timestamp;
    }

    const delta = (timestamp - lastFrameTime) / 1000;
    lastFrameTime = timestamp;
    pulsePosition += delta * pulseSpeed * pulseDirection;

    if (pulsePosition >= 0.98) {
      pulsePosition = 0.98;
      pulseDirection = -1;
    }
    if (pulsePosition <= 0.02) {
      pulsePosition = 0.02;
      pulseDirection = 1;
    }

    marker.style.left = `${pulsePosition * 100}%`;
    frameId = requestAnimationFrame(tick);
  };

  const startMatch = () => {
    const challenge = calculateAdaptiveChallenge(state);
    pulseWidth = challenge.zoneWidth;
    pulseSpeed = challenge.speed;
    roundsPlayed = 0;
    roundsWon = 0;
    lastFrameTime = 0;
    matchActive = true;
    startMatchBtn.disabled = true;
    stopBtn.disabled = false;
    updateZone();
    resetPulse();
    updateTrack(state);
    updateResult("Round started. Stop the pulse inside the target zone.", null);
    stopAnimation();
    frameId = requestAnimationFrame(tick);
  };

  playBtn.addEventListener("click", () => {
    switchScreen("game");
    startMatch();
  });

  backBtn.addEventListener("click", () => {
    switchScreen("checkpoint");
  });

  startMatchBtn.addEventListener("click", startMatch);

  stopBtn.addEventListener("click", () => {
    if (!matchActive) return;
    evaluateRound();
  });

  resetRunBtn.addEventListener("click", () => {
    state = Storage.reset();
    Storage.save(state);
    updateScoreboard(state);
    updateTrack(state);
    matchActive = false;
    stopAnimation();
    startMatchBtn.disabled = false;
    stopBtn.disabled = true;
    updateResultBanner(resultBanner, null);
    resetPulse();
  });

  updateScoreboard(state);
  updateTrack(state);
  resetPulse();
};

document.addEventListener("DOMContentLoaded", initApp);
