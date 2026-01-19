const STORAGE_KEY = "checkpoint_clash_state_v1";
const CHECKPOINT_POINTS = 1000;
const POINTS_PER_WIN = 100;
const POINTS_PER_LOSS = -100;
const MAX_CHECKPOINTS_SHOWN = 6;

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
};

const getDefaultState = () => ({
  points: 0,
  wins: 0,
  losses: 0,
  streak: 0,
  streakType: "none",
  totalGames: 0,
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

const getWinRate = (state) => {
  if (state.totalGames === 0) return 0.5;
  return state.wins / state.totalGames;
};

const getCheckpointInfo = (points) => {
  const current = Math.floor(points / CHECKPOINT_POINTS);
  const nextValue = (current + 1) * CHECKPOINT_POINTS;
  return {
    current,
    nextValue,
    toNext: nextValue - points,
  };
};

const getDifficultyLabel = (points) => {
  if (points >= 6000) return "Elite";
  if (points >= 4000) return "Hard";
  if (points >= 2000) return "Focused";
  if (points >= 1000) return "Steady";
  return "Balanced";
};

const calculateWinChance = (state) => {
  const winRate = getWinRate(state);
  const { toNext } = getCheckpointInfo(state.points);
  const oneWinAway = toNext === POINTS_PER_WIN;

  const winRateCorrection = (0.5 - winRate) * 0.3;
  const skillPenalty = Math.min(state.points / 6000, 0.18);
  const checkpointPenalty = oneWinAway ? 0.12 : 0;

  const winChance = Utils.clamp(0.5 + winRateCorrection - skillPenalty - checkpointPenalty, 0.22, 0.78);

  return {
    winChance,
    oneWinAway,
  };
};

const generateDuelPowers = (playerWins) => {
  if (playerWins) {
    const player = Math.floor(Math.random() * 7) + 6;
    const bot = Math.floor(Math.random() * (player - 1)) + 1;
    return { player, bot };
  }
  const bot = Math.floor(Math.random() * 7) + 6;
  const player = Math.floor(Math.random() * (bot - 1)) + 1;
  return { player, bot };
};

const updateCheckpointPath = (container, points) => {
  const { current } = getCheckpointInfo(points);
  container.innerHTML = "";

  const track = document.createElement("div");
  track.className = "checkpoint-track";

  const line = document.createElement("div");
  line.className = "track-line";
  track.appendChild(line);

  for (let index = 0; index < MAX_CHECKPOINTS_SHOWN; index += 1) {
    const checkpointLevel = current + index;
    const checkpointPoints = checkpointLevel * CHECKPOINT_POINTS;

    const checkpoint = document.createElement("div");
    checkpoint.className = "checkpoint";
    checkpoint.textContent = checkpointLevel;

    if (checkpointLevel < current) {
      checkpoint.classList.add("reached");
    }

    if (checkpointLevel === current) {
      checkpoint.classList.add("current");
    }

    const label = document.createElement("div");
    label.className = "checkpoint-label";
    label.textContent = `${Utils.formatNumber(checkpointPoints)} pts`;

    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "6px";
    wrapper.appendChild(checkpoint);
    wrapper.appendChild(label);

    track.appendChild(wrapper);
  }

  container.appendChild(track);
};

const updateUI = (state) => {
  const pointsValue = document.getElementById("pointsValue");
  const recordValue = document.getElementById("recordValue");
  const checkpointValue = document.getElementById("checkpointValue");
  const winRateValue = document.getElementById("winRateValue");
  const streakValue = document.getElementById("streakValue");
  const difficultyValue = document.getElementById("difficultyValue");
  const fairnessValue = document.getElementById("fairnessValue");
  const nextCheckpoint = document.getElementById("nextCheckpoint");

  const winRate = getWinRate(state);
  const checkpoint = getCheckpointInfo(state.points);
  const { winChance, oneWinAway } = calculateWinChance(state);

  pointsValue.textContent = Utils.formatNumber(state.points);
  recordValue.textContent = `${state.wins}W - ${state.losses}L`;
  checkpointValue.textContent = `${checkpoint.current}`;
  winRateValue.textContent = Utils.percentage(winRate);
  streakValue.textContent = state.streak === 0 ? "0" : `${state.streak} ${state.streakType}`;
  difficultyValue.textContent = getDifficultyLabel(state.points);
  fairnessValue.textContent = `Targeting ${Utils.percentage(winChance)} this round`;
  nextCheckpoint.textContent = `${Utils.formatNumber(checkpoint.nextValue)} pts${oneWinAway ? " (pressure round)" : ""}`;

  updateCheckpointPath(document.getElementById("checkpointPath"), state.points);
};

const updateResultBanner = (banner, outcome) => {
  banner.classList.remove("win", "loss");
  if (!outcome) {
    banner.textContent = "Your duel result shows here.";
    return;
  }

  banner.classList.add(outcome === "win" ? "win" : "loss");
  banner.textContent = outcome === "win"
    ? "Victory! +100 points. The bot recalibrates its odds."
    : "Defeat. -100 points. The bot eases up to keep it fair.";
};

const initGame = () => {
  let state = Storage.load();

  const playBtn = document.getElementById("playBtn");
  const resetBtn = document.getElementById("resetBtn");
  const playerPower = document.getElementById("playerPower");
  const botPower = document.getElementById("botPower");
  const playerStatus = document.getElementById("playerStatus");
  const botStatus = document.getElementById("botStatus");
  const resultBanner = document.getElementById("resultBanner");

  updateUI(state);
  updateResultBanner(resultBanner, null);

  const runDuel = () => {
    playBtn.disabled = true;
    playerPower.textContent = "--";
    botPower.textContent = "--";
    playerStatus.textContent = "Charging";
    botStatus.textContent = "Analyzing";

    const { winChance } = calculateWinChance(state);
    const playerWins = Math.random() < winChance;
    const powerValues = generateDuelPowers(playerWins);

    setTimeout(() => {
      playerPower.textContent = powerValues.player;
      botPower.textContent = powerValues.bot;
      playerStatus.textContent = playerWins ? "Overclocked" : "Outmatched";
      botStatus.textContent = playerWins ? "Disrupted" : "Dominant";

      if (playerWins) {
        state.points += POINTS_PER_WIN;
        state.wins += 1;
        state.streak = state.streakType === "win" ? state.streak + 1 : 1;
        state.streakType = "win";
        updateResultBanner(resultBanner, "win");
      } else {
        state.points = Math.max(state.points + POINTS_PER_LOSS, 0);
        state.losses += 1;
        state.streak = state.streakType === "loss" ? state.streak + 1 : 1;
        state.streakType = "loss";
        updateResultBanner(resultBanner, "loss");
      }

      state.totalGames += 1;
      Storage.save(state);
      updateUI(state);
      playBtn.disabled = false;
    }, 600);
  };

  playBtn.addEventListener("click", runDuel);
  resetBtn.addEventListener("click", () => {
    state = Storage.reset();
    Storage.save(state);
    playerPower.textContent = "--";
    botPower.textContent = "--";
    playerStatus.textContent = "Ready";
    botStatus.textContent = "Calibrating";
    updateResultBanner(resultBanner, null);
    updateUI(state);
  });
};

document.addEventListener("DOMContentLoaded", initGame);
