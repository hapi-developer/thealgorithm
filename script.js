/*
  Dodge & Collect — Adaptive Experience Engine Demo
  All logic runs locally. No network requests, no external dependencies.
*/

(() => {
  const canvas = document.getElementById("gameCanvas");
  const ctx = canvas.getContext("2d");
  const scoreValue = document.getElementById("scoreValue");
  const roundValue = document.getElementById("roundValue");
  const timeValue = document.getElementById("timeValue");
  const onboardingTip = document.getElementById("onboardingTip");

  const ui = {
    skillBar: document.getElementById("skillBar"),
    focusBar: document.getElementById("focusBar"),
    fatigueBar: document.getElementById("fatigueBar"),
    noveltyBar: document.getElementById("noveltyBar"),
    skillValue: document.getElementById("skillValue"),
    focusValue: document.getElementById("focusValue"),
    fatigueValue: document.getElementById("fatigueValue"),
    noveltyValue: document.getElementById("noveltyValue"),
    prefTags: document.getElementById("prefTags"),
    tuningList: document.getElementById("tuningList"),
    rationaleText: document.getElementById("rationaleText"),
    signalList: document.getElementById("signalList"),
    ideasList: document.getElementById("ideasList"),
    roundSummary: document.getElementById("roundSummary"),
    rewardTrend: document.getElementById("rewardTrend"),
    personalizationToggle: document.getElementById("personalizationToggle"),
    reducedMotionToggle: document.getElementById("reducedMotionToggle"),
    breakToggle: document.getElementById("breakToggle"),
    breakMinutes: document.getElementById("breakMinutes"),
    breakModal: document.getElementById("breakModal"),
    snoozeBtn: document.getElementById("snoozeBtn"),
    closeBreakBtn: document.getElementById("closeBreakBtn"),
    funModal: document.getElementById("funModal"),
    funButtons: document.getElementById("funButtons"),
    howModal: document.getElementById("howModal"),
    howItWorksBtn: document.getElementById("howItWorksBtn"),
    closeHowBtn: document.getElementById("closeHowBtn"),
    resetBtn: document.getElementById("resetBtn"),
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (min, max) => Math.random() * (max - min) + min;

  const storageKey = "adaptive-experience-engine-v1";

  const engine = {
    state: null,
    events: [],
    armStats: {},
    arms: [],
    ideaArchive: [],
    init() {
      this.arms = generateArms();
      const stored = this.load();
      this.state = stored?.state || createInitialState();
      this.armStats = stored?.armStats || initArmStats(this.arms);
      this.ideaArchive = stored?.ideaArchive || [];
    },
    track(eventName, payload = {}) {
      const event = { name: eventName, payload, time: performance.now() };
      this.events.push(event);
      if (this.events.length > 200) {
        this.events.shift();
      }
    },
    summarizeRound(summary) {
      const { playerModel } = this.state;
      updatePlayerModel(playerModel, summary);
      this.state.roundHistory.unshift(summary);
      this.state.roundHistory = this.state.roundHistory.slice(0, 6);
    },
    chooseExperience(context) {
      if (!this.state.personalizationEnabled) {
        return this.arms.find((arm) => arm.id === "stable-medium");
      }

      const fatigue = this.state.playerModel.fatigue.value;
      const totalPlays = Object.values(this.armStats).reduce((sum, arm) => sum + arm.count, 0);

      let bestArm = this.arms[0];
      let bestScore = -Infinity;

      for (const arm of this.arms) {
        const stats = this.armStats[arm.id];
        const mean = stats.mean;
        const exploration = stats.count < 1 ? 1.2 : Math.sqrt(Math.log(totalPlays + 1) / (stats.count + 1));
        const noveltyPenalty = getRecencyPenalty(this.state.recentArms, arm.id);
        const preferenceFit = getPreferenceFit(arm, this.state.playerModel.prefs);

        let score = mean + exploration * (0.6 + (1 - fatigue) * 0.6) + preferenceFit * 0.3 - noveltyPenalty;
        if (fatigue > 0.7 && arm.tier === "hard") {
          score -= 1.5;
        }
        if (fatigue > 0.6 && arm.restRound) {
          score += 0.7;
        }
        if (context.sessionSeconds < 60 && arm.tier === "hard") {
          score -= 0.5;
        }
        if (score > bestScore) {
          bestScore = score;
          bestArm = arm;
        }
      }

      return bestArm;
    },
    applyExperience(packet) {
      this.state.currentArm = packet;
      this.state.recentArms.unshift(packet.id);
      this.state.recentArms = this.state.recentArms.slice(0, 6);
    },
    recordReward(armId, reward) {
      const stats = this.armStats[armId];
      stats.count += 1;
      const delta = reward - stats.mean;
      stats.mean += delta / stats.count;
      stats.variance = lerp(stats.variance, delta * delta, 0.2);
      this.state.rewardTrend = lerp(this.state.rewardTrend, reward, 0.3);
    },
    save() {
      const payload = {
        state: this.state,
        armStats: this.armStats,
        ideaArchive: this.ideaArchive,
      };
      localStorage.setItem(storageKey, JSON.stringify(payload));
    },
    load() {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (error) {
        return null;
      }
    },
    reset() {
      localStorage.removeItem(storageKey);
      this.init();
    },
  };

  const game = {
    player: {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: 10,
      speed: 180,
    },
    hazards: [],
    coins: [],
    particles: [],
    score: 0,
    streak: 0,
    streakTimer: 0,
    round: 1,
    roundTime: 0,
    roundLength: 40,
    lastFrame: performance.now(),
    lastRoundEnd: performance.now(),
    sessionStart: performance.now(),
    lastInputTime: performance.now(),
    spawnTimer: 0,
    coinTimer: 0,
    nearMisses: 0,
    collisions: 0,
    collected: 0,
    coinsSpawned: 0,
    reactionSamples: [],
    inputSamples: [],
    roundActive: true,
    activePacket: null,
    reducedMotion: false,
    shakeTime: 0,
  };

  const input = {
    up: false,
    down: false,
    left: false,
    right: false,
  };

  const defaultPacket = {
    id: "stable-medium",
    tier: "medium",
    rewardDensity: "normal",
    chaos: "low",
    novelty: "medium",
    restRound: false,
    params: {
      hazardSpawn: 1.2,
      hazardSpeed: 120,
      hazardSize: 14,
      hazardPattern: 0.3,
      coinSpawn: 1.0,
      coinValue: 10,
      streakWindow: 6,
      friction: 0.92,
      playerSpeed: 180,
      shake: 0.2,
      roundLength: 40,
      intensityRamp: 1.0,
    },
  };

  function createInitialState() {
    return {
      playerModel: {
        skill: createEstimate(0.5),
        focus: createEstimate(0.55),
        fatigue: createEstimate(0.1),
        noveltyTolerance: createEstimate(0.5),
        prefs: {
          speed: 0.5,
          precision: 0.5,
          risk: 0.5,
          exploration: 0.5,
        },
      },
      personalizationEnabled: true,
      reducedMotion: false,
      breakNudges: true,
      rewardTrend: 0.5,
      roundHistory: [],
      recentArms: [],
      currentArm: defaultPacket,
      lastBreakTime: performance.now(),
      breakMinutes: 10,
    };
  }

  function createEstimate(value) {
    return { value, variance: 0.1 };
  }

  function updateEstimate(estimate, sample, alpha = 0.2) {
    const delta = sample - estimate.value;
    estimate.value = clamp(estimate.value + delta * alpha, 0, 1);
    estimate.variance = lerp(estimate.variance, delta * delta, 0.2);
  }

  function updatePlayerModel(model, summary) {
    const successRate = summary.coinsCollected / Math.max(1, summary.coinsSpawned);
    const avoidance = 1 - summary.collisionRate;
    const smoothness = summary.smoothness;
    const reaction = summary.reactionScore;

    updateEstimate(model.skill, clamp((successRate + avoidance + reaction) / 3, 0, 1));
    updateEstimate(model.focus, clamp((smoothness + reaction) / 2, 0, 1));

    const fatigueSignal = clamp(summary.fatigueSignal, 0, 1);
    updateEstimate(model.fatigue, fatigueSignal, 0.12);

    const noveltyDrop = summary.repetitionPenalty;
    updateEstimate(model.noveltyTolerance, 1 - noveltyDrop, 0.12);

    model.prefs.speed = clamp(lerp(model.prefs.speed, summary.prefSignals.speed, 0.2), 0, 1);
    model.prefs.precision = clamp(lerp(model.prefs.precision, summary.prefSignals.precision, 0.2), 0, 1);
    model.prefs.risk = clamp(lerp(model.prefs.risk, summary.prefSignals.risk, 0.2), 0, 1);
    model.prefs.exploration = clamp(lerp(model.prefs.exploration, summary.prefSignals.exploration, 0.2), 0, 1);
  }

  function generateArms() {
    const tiers = ["easy", "medium", "hard"];
    const reward = ["sparse", "normal", "dense"];
    const chaos = ["low", "high"];
    const novelty = ["low", "medium", "high"];
    const arms = [];

    let id = 0;
    for (const tier of tiers) {
      for (const rewardDensity of reward) {
        for (const chaosLevel of chaos) {
          if (arms.length >= 18) break;
          const noveltyLevel = novelty[id % novelty.length];
          arms.push(buildArm({
            id: `arm-${id++}`,
            tier,
            rewardDensity,
            chaos: chaosLevel,
            novelty: noveltyLevel,
            restRound: false,
          }));
        }
      }
    }

    arms.push(buildArm({
      id: "rest-1",
      tier: "easy",
      rewardDensity: "dense",
      chaos: "low",
      novelty: "low",
      restRound: true,
    }));
    arms.push(buildArm({
      id: "rest-2",
      tier: "easy",
      rewardDensity: "normal",
      chaos: "low",
      novelty: "medium",
      restRound: true,
    }));
    arms.push(defaultPacket);

    return arms;
  }

  function buildArm({ id, tier, rewardDensity, chaos, novelty, restRound }) {
    const tierMultiplier = tier === "easy" ? 0.8 : tier === "hard" ? 1.2 : 1.0;
    const chaosMultiplier = chaos === "high" ? 1.2 : 0.9;
    const rewardMultiplier = rewardDensity === "dense" ? 1.3 : rewardDensity === "sparse" ? 0.8 : 1.0;

    return {
      id,
      tier,
      rewardDensity,
      chaos,
      novelty,
      restRound,
      params: {
        hazardSpawn: 1.0 * tierMultiplier * chaosMultiplier,
        hazardSpeed: 110 * tierMultiplier * chaosMultiplier,
        hazardSize: 14 * tierMultiplier,
        hazardPattern: chaos === "high" ? 0.65 : 0.35,
        coinSpawn: 1.1 * rewardMultiplier,
        coinValue: rewardDensity === "dense" ? 9 : rewardDensity === "sparse" ? 12 : 10,
        streakWindow: rewardDensity === "sparse" ? 5 : 7,
        friction: restRound ? 0.95 : 0.9,
        playerSpeed: 170 * (restRound ? 0.9 : 1.0),
        shake: chaos === "high" ? 0.4 : 0.2,
        roundLength: restRound ? 30 : 40,
        intensityRamp: restRound ? 0.7 : 1.1,
      },
    };
  }

  function initArmStats(arms) {
    const stats = {};
    for (const arm of arms) {
      stats[arm.id] = { count: 0, mean: 0.5, variance: 0.1 };
    }
    return stats;
  }

  function getRecencyPenalty(recentArms, armId) {
    const index = recentArms.indexOf(armId);
    if (index === -1) return 0;
    return (6 - index) * 0.05;
  }

  function getPreferenceFit(arm, prefs) {
    const speedWeight = arm.chaos === "high" ? 1 : 0.5;
    const precisionWeight = arm.rewardDensity === "sparse" ? 0.8 : 0.4;
    const riskWeight = arm.tier === "hard" ? 1 : 0.4;
    const explorationWeight = arm.novelty === "high" ? 1 : 0.3;
    return (
      prefs.speed * speedWeight +
      prefs.precision * precisionWeight +
      prefs.risk * riskWeight +
      prefs.exploration * explorationWeight
    ) / 2.6;
  }

  function createIdeaGenerator() {
    const adjectives = ["swift", "precision", "arcade", "zen", "chaotic", "drift"];
    const modifiers = ["pulse", "orbit", "spiral", "streak", "echo", "glide"];
    const ruleChanges = [
      "hazards ripple outward in waves",
      "coins appear in mirrored pairs",
      "safe zones drift across the arena",
      "hazards slow down near the center",
      "coins boost speed for a moment",
      "edges are slick and bouncy",
    ];

    return () => {
      const genome = {
        pattern: rand(0, 1),
        speedCurve: rand(0, 1),
        coinRule: rand(0, 1),
        arenaMod: rand(0, 1),
        theme: rand(0, 1),
      };
      const ideaText = `Try a ${pick(adjectives)} ${pick(modifiers)} mode where ${pick(ruleChanges)}.`;
      return { id: `idea-${Date.now()}-${Math.floor(Math.random() * 1000)}`, genome, text: ideaText };
    };
  }

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  const generateIdea = createIdeaGenerator();

  function scoreIdea(genome, prefs, archive) {
    const novelty = archive.length === 0 ? 1 : Math.min(1, averageDistance(genome, archive));
    const preferenceFit = (prefs.exploration + prefs.speed * genome.speedCurve + prefs.risk * genome.pattern) / 3;
    return 0.6 * novelty + 0.4 * preferenceFit;
  }

  function averageDistance(genome, archive) {
    const distances = archive.map((entry) => genomeDistance(genome, entry));
    const sum = distances.reduce((acc, d) => acc + d, 0);
    return sum / distances.length;
  }

  function genomeDistance(a, b) {
    const keys = Object.keys(a);
    const diff = keys.reduce((acc, key) => acc + Math.abs(a[key] - b[key]), 0);
    return diff / keys.length;
  }

  function openModal(modal) {
    modal.classList.add("active");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal(modal) {
    modal.classList.remove("active");
    modal.setAttribute("aria-hidden", "true");
  }

  function setupInput() {
    const setInput = (key, value) => {
      if (key === "ArrowUp" || key === "w" || key === "W") input.up = value;
      if (key === "ArrowDown" || key === "s" || key === "S") input.down = value;
      if (key === "ArrowLeft" || key === "a" || key === "A") input.left = value;
      if (key === "ArrowRight" || key === "d" || key === "D") input.right = value;
    };

    window.addEventListener("keydown", (event) => {
      setInput(event.key, true);
      engine.track("input", { key: event.key });
      game.lastInputTime = performance.now();
    });
    window.addEventListener("keyup", (event) => {
      setInput(event.key, false);
      game.lastInputTime = performance.now();
    });
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * window.devicePixelRatio;
    canvas.height = rect.height * window.devicePixelRatio;
    ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
  }

  function initGame() {
    engine.init();
    resizeCanvas();
    setupInput();
    window.addEventListener("resize", resizeCanvas);
    window.addEventListener("beforeunload", () => engine.track("session_end", {}));
    initializePlayer();
    setupUi();
    startRound(engine.state.currentArm || defaultPacket);
    requestAnimationFrame(loop);
    engine.track("session_start", { startedAt: Date.now() });
  }

  function setupUi() {
    ui.personalizationToggle.checked = engine.state.personalizationEnabled;
    ui.reducedMotionToggle.checked = engine.state.reducedMotion;
    ui.breakToggle.checked = engine.state.breakNudges;
    ui.breakMinutes.value = engine.state.breakMinutes || 10;
    game.reducedMotion = engine.state.reducedMotion;

    ui.personalizationToggle.addEventListener("change", () => {
      engine.state.personalizationEnabled = ui.personalizationToggle.checked;
      engine.save();
    });

    ui.reducedMotionToggle.addEventListener("change", () => {
      engine.state.reducedMotion = ui.reducedMotionToggle.checked;
      game.reducedMotion = ui.reducedMotionToggle.checked;
    });

    ui.breakToggle.addEventListener("change", () => {
      engine.state.breakNudges = ui.breakToggle.checked;
    });

    ui.breakMinutes.addEventListener("change", () => {
      engine.state.breakMinutes = parseInt(ui.breakMinutes.value, 10) || 10;
    });

    ui.snoozeBtn.addEventListener("click", () => {
      engine.state.lastBreakTime = performance.now();
      closeModal(ui.breakModal);
    });

    ui.closeBreakBtn.addEventListener("click", () => {
      closeModal(ui.breakModal);
    });

    ui.howItWorksBtn.addEventListener("click", () => openModal(ui.howModal));
    ui.closeHowBtn.addEventListener("click", () => closeModal(ui.howModal));

    ui.resetBtn.addEventListener("click", () => {
      engine.reset();
      initializePlayer();
      startRound(engine.state.currentArm || defaultPacket);
    });

    buildFunButtons();
  }

  function buildFunButtons() {
    ui.funButtons.innerHTML = "";
    for (let i = 1; i <= 5; i += 1) {
      const btn = document.createElement("button");
      btn.textContent = i;
      btn.addEventListener("click", () => {
        engine.track("fun_rating", { rating: i });
        engine.state.lastFun = i / 5;
        closeModal(ui.funModal);
      });
      ui.funButtons.appendChild(btn);
    }
  }

  function initializePlayer() {
    game.player.x = canvas.clientWidth / 2;
    game.player.y = canvas.clientHeight / 2;
    game.player.vx = 0;
    game.player.vy = 0;
  }

  function startRound(packet) {
    game.roundActive = true;
    game.activePacket = packet;
    game.roundTime = 0;
    game.spawnTimer = 0;
    game.coinTimer = 0;
    game.nearMisses = 0;
    game.collisions = 0;
    game.collected = 0;
    game.coinsSpawned = 0;
    game.reactionSamples = [];
    game.inputSamples = [];
    game.streakTimer = 0;
    game.hazards = [];
    game.coins = [];
    engine.applyExperience(packet);
    updateDashboard();
  }

  function endRound() {
    game.roundActive = false;
    const totalTime = game.roundTime;
    const collisionRate = game.collisions / Math.max(1, totalTime / 10);
    const reactionScore = average(game.reactionSamples, 0.5);
    const smoothness = average(game.inputSamples, 0.5);
    const fatigueSignal = clamp(
      (performance.now() - game.sessionStart) / 1000 / 900 + collisionRate * 0.5 + (1 - smoothness) * 0.4,
      0,
      1
    );

    const summary = {
      round: game.round,
      coinsCollected: game.collected,
      coinsSpawned: game.coinsSpawned,
      collisionRate,
      nearMisses: game.nearMisses,
      reactionScore,
      smoothness,
      fatigueSignal,
      repetitionPenalty: getRecencyPenalty(engine.state.recentArms, game.activePacket.id),
      prefSignals: {
        speed: clamp(game.activePacket.chaos === "high" ? 0.7 : 0.4, 0, 1),
        precision: clamp(game.activePacket.rewardDensity === "sparse" ? 0.8 : 0.5, 0, 1),
        risk: clamp(game.activePacket.tier === "hard" ? 0.8 : 0.4, 0, 1),
        exploration: clamp(game.activePacket.novelty === "high" ? 0.8 : 0.4, 0, 1),
      },
    };

    const reward = computeReward(summary);
    engine.summarizeRound(summary);
    engine.recordReward(game.activePacket.id, reward);
    engine.track("round_end", { summary, reward });
    engine.save();

    updateDashboard();
    maybePromptFunCheck();

    game.round += 1;
    roundValue.textContent = game.round;
    const nextPacket = engine.chooseExperience({
      sessionSeconds: (performance.now() - game.sessionStart) / 1000,
    });
    startRound(flowAdjustPacket(nextPacket));
  }

  function computeReward(summary) {
    const flowZone = 1 - Math.abs(summary.collisionRate - 0.25);
    const improvement = clamp(summary.coinsCollected / 15, 0, 1);
    const nearMiss = clamp(summary.nearMisses / 10, 0, 1);
    const frustration = clamp(summary.collisionRate * 1.4, 0, 1);
    const fatiguePenalty = summary.fatigueSignal * 0.8;
    const fun = engine.state.lastFun || 0.6;
    return clamp(flowZone * 0.35 + improvement * 0.25 + nearMiss * 0.1 + fun * 0.2 - frustration * 0.25 - fatiguePenalty * 0.3, 0, 1);
  }

  function flowAdjustPacket(packet) {
    const targetSuccess = 0.72;
    const lastSummary = engine.state.roundHistory[0];
    if (!lastSummary) return packet;

    const success = lastSummary.coinsCollected / Math.max(1, lastSummary.coinsSpawned);
    const delta = clamp((targetSuccess - success) * 0.2, -0.15, 0.15);

    const tuned = { ...packet, params: { ...packet.params } };
    tuned.params.hazardSpawn = clamp(tuned.params.hazardSpawn + delta, 0.6, 2.0);
    tuned.params.hazardSpeed = clamp(tuned.params.hazardSpeed + delta * 50, 80, 220);
    tuned.params.coinSpawn = clamp(tuned.params.coinSpawn - delta, 0.6, 1.6);
    tuned.params.playerSpeed = clamp(tuned.params.playerSpeed + delta * 20, 140, 210);
    return tuned;
  }

  function maybePromptFunCheck() {
    if (game.round % 3 === 0) {
      openModal(ui.funModal);
    }
  }

  function updateDashboard() {
    const model = engine.state.playerModel;
    updateMetric(ui.skillBar, ui.skillValue, model.skill.value);
    updateMetric(ui.focusBar, ui.focusValue, model.focus.value);
    updateMetric(ui.fatigueBar, ui.fatigueValue, model.fatigue.value);
    updateMetric(ui.noveltyBar, ui.noveltyValue, model.noveltyTolerance.value);

    ui.prefTags.innerHTML = "";
    Object.entries(model.prefs).forEach(([key, value]) => {
      const tag = document.createElement("div");
      tag.className = "tag";
      tag.textContent = `${key}: ${(value * 100).toFixed(0)}%`;
      ui.prefTags.appendChild(tag);
    });

    ui.tuningList.innerHTML = "";
    const packet = game.activePacket || engine.state.currentArm || defaultPacket;
    Object.entries(packet.params).forEach(([key, value]) => {
      const item = document.createElement("div");
      item.textContent = `${key}: ${typeof value === "number" ? value.toFixed(2) : value}`;
      ui.tuningList.appendChild(item);
    });

    const rationale = buildRationale(packet);
    ui.rationaleText.textContent = rationale.text;
    ui.signalList.innerHTML = "";
    rationale.signals.forEach((signal) => {
      const div = document.createElement("div");
      div.textContent = `• ${signal}`;
      ui.signalList.appendChild(div);
    });

    renderRoundSummary();
    renderIdeas();
    ui.rewardTrend.textContent = `Rolling reward trend: ${engine.state.rewardTrend.toFixed(2)}`;
  }

  function updateMetric(bar, valueEl, value) {
    bar.style.width = `${(value * 100).toFixed(0)}%`;
    valueEl.textContent = value.toFixed(2);
  }

  function buildRationale(packet) {
    const model = engine.state.playerModel;
    const signals = [];

    signals.push(`Skill ${(model.skill.value * 100).toFixed(0)}% with uncertainty ${model.skill.variance.toFixed(2)}`);
    signals.push(`Focus ${(model.focus.value * 100).toFixed(0)}% and fatigue ${(model.fatigue.value * 100).toFixed(0)}%`);
    signals.push(`Preference fit: speed ${(model.prefs.speed * 100).toFixed(0)}%, precision ${(model.prefs.precision * 100).toFixed(0)}%`);

    let text = "Selected a balanced packet to keep you in the flow zone.";
    if (model.fatigue.value > 0.6 || packet.restRound) {
      text = "Fatigue signals are rising, so the engine slowed the tempo and added more rest.";
    } else if (packet.tier === "hard") {
      text = "Your recent performance is strong, so difficulty was nudged up carefully.";
    }

    return { text, signals };
  }

  function renderRoundSummary() {
    ui.roundSummary.innerHTML = "";
    engine.state.roundHistory.forEach((summary) => {
      const item = document.createElement("div");
      item.textContent = `Round ${summary.round}: coins ${summary.coinsCollected}, collisions ${summary.collisionRate.toFixed(2)}`;
      ui.roundSummary.appendChild(item);
    });
  }

  function renderIdeas() {
    ui.ideasList.innerHTML = "";
    const ideas = [];
    for (let i = 0; i < 3; i += 1) {
      const idea = generateIdea();
      const score = scoreIdea(idea.genome, engine.state.playerModel.prefs, engine.ideaArchive);
      ideas.push({ ...idea, score });
    }
    ideas
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .forEach((idea) => {
        const card = document.createElement("div");
        card.className = "idea";
        const text = document.createElement("div");
        text.textContent = idea.text;
        const actions = document.createElement("div");
        actions.className = "idea-actions";

        const accept = document.createElement("button");
        accept.textContent = "Accept";
        accept.addEventListener("click", () => {
          engine.ideaArchive.push(idea.genome);
          engine.state.playerModel.prefs.exploration = clamp(engine.state.playerModel.prefs.exploration + 0.05, 0, 1);
          engine.save();
          updateDashboard();
        });

        const reject = document.createElement("button");
        reject.textContent = "Reject";
        reject.className = "ghost";
        reject.addEventListener("click", () => {
          engine.state.playerModel.prefs.precision = clamp(engine.state.playerModel.prefs.precision + 0.03, 0, 1);
          engine.save();
          updateDashboard();
        });

        actions.appendChild(accept);
        actions.appendChild(reject);
        card.appendChild(text);
        card.appendChild(actions);
        ui.ideasList.appendChild(card);
      });
  }

  function updateBreakNudge() {
    if (!engine.state.breakNudges) return;
    const breakMinutes = parseInt(ui.breakMinutes.value, 10) || engine.state.breakMinutes || 10;
    const breakMs = breakMinutes * 60 * 1000;
    if (performance.now() - engine.state.lastBreakTime > breakMs) {
      openModal(ui.breakModal);
      engine.state.lastBreakTime = performance.now();
    }
  }

  function loop(timestamp) {
    const delta = (timestamp - game.lastFrame) / 1000;
    game.lastFrame = timestamp;
    game.roundTime += delta;
    timeValue.textContent = Math.floor(game.roundTime);

    updatePlayer(delta);
    updateSpawns(delta);
    updateHazards(delta);
    updateCoins(delta);
    updateParticles(delta);
    game.shakeTime = Math.max(0, game.shakeTime - delta);
    checkCollisions();
    render();

    if (game.roundTime >= game.activePacket.params.roundLength) {
      endRound();
    }

    if (timestamp - game.sessionStart > 2500) {
      onboardingTip.classList.add("hidden");
    }

    updateBreakNudge();
    requestAnimationFrame(loop);
  }

  function updatePlayer(delta) {
    const params = game.activePacket.params;
    const accel = params.playerSpeed;

    if (input.up) game.player.vy -= accel * delta;
    if (input.down) game.player.vy += accel * delta;
    if (input.left) game.player.vx -= accel * delta;
    if (input.right) game.player.vx += accel * delta;

    const friction = params.friction;
    game.player.vx *= friction;
    game.player.vy *= friction;

    game.player.x += game.player.vx * delta;
    game.player.y += game.player.vy * delta;

    const padding = game.player.radius + 6;
    game.player.x = clamp(game.player.x, padding, canvas.clientWidth - padding);
    game.player.y = clamp(game.player.y, padding, canvas.clientHeight - padding);

    const speedMag = Math.hypot(game.player.vx, game.player.vy);
    game.inputSamples.push(clamp(speedMag / 200, 0, 1));
    game.streakTimer += delta;
    if (game.streakTimer > params.streakWindow) {
      game.streak = 0;
      game.streakTimer = 0;
    }
  }

  function updateSpawns(delta) {
    const params = game.activePacket.params;
    game.spawnTimer += delta;
    game.coinTimer += delta;

    const ramp = clamp(1 + (game.roundTime / params.roundLength - 0.5) * 0.3 * params.intensityRamp, 0.7, 1.5);
    const hazardInterval = 1 / (params.hazardSpawn * ramp);
    const coinInterval = 1 / params.coinSpawn;

    if (game.spawnTimer >= hazardInterval) {
      game.spawnTimer = 0;
      spawnHazard();
    }

    if (game.coinTimer >= coinInterval) {
      game.coinTimer = 0;
      spawnCoin();
    }
  }

  function spawnHazard() {
    const size = game.activePacket.params.hazardSize;
    const edge = Math.floor(Math.random() * 4);
    let x = 0;
    let y = 0;
    if (edge === 0) {
      x = rand(0, canvas.clientWidth);
      y = -size;
    } else if (edge === 1) {
      x = canvas.clientWidth + size;
      y = rand(0, canvas.clientHeight);
    } else if (edge === 2) {
      x = rand(0, canvas.clientWidth);
      y = canvas.clientHeight + size;
    } else {
      x = -size;
      y = rand(0, canvas.clientHeight);
    }

    const angle = Math.atan2(game.player.y - y, game.player.x - x);
    const speed = game.activePacket.params.hazardSpeed * rand(0.7, 1.2);
    game.hazards.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size,
      pattern: rand(0, 1),
      spawnTime: performance.now(),
    });
  }

  function spawnCoin() {
    const padding = 30;
    const x = rand(padding, canvas.clientWidth - padding);
    const y = rand(padding, canvas.clientHeight - padding);
    game.coins.push({ x, y, radius: 8, spawnTime: performance.now() });
    game.coinsSpawned += 1;
  }

  function updateHazards(delta) {
    const patternStrength = game.activePacket.params.hazardPattern;
    game.hazards.forEach((hazard) => {
      if (hazard.pattern < patternStrength) {
        const angle = Math.atan2(game.player.y - hazard.y, game.player.x - hazard.x);
        hazard.vx = lerp(hazard.vx, Math.cos(angle) * game.activePacket.params.hazardSpeed, 0.02);
        hazard.vy = lerp(hazard.vy, Math.sin(angle) * game.activePacket.params.hazardSpeed, 0.02);
      }

      hazard.x += hazard.vx * delta;
      hazard.y += hazard.vy * delta;
    });

    game.hazards = game.hazards.filter(
      (hazard) => hazard.x > -40 && hazard.x < canvas.clientWidth + 40 && hazard.y > -40 && hazard.y < canvas.clientHeight + 40
    );
  }

  function updateCoins(delta) {
    const floatSpeed = game.reducedMotion ? 0 : 0.6;
    game.coins.forEach((coin) => {
      coin.y += Math.sin(performance.now() / 400) * floatSpeed * delta;
    });
  }

  function updateParticles(delta) {
    game.particles.forEach((particle) => {
      particle.life -= delta;
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
    });
    game.particles = game.particles.filter((p) => p.life > 0);
  }

  function checkCollisions() {
    const player = game.player;

    game.hazards.forEach((hazard) => {
      const dist = Math.hypot(player.x - hazard.x, player.y - hazard.y);
      if (dist < player.radius + hazard.size) {
        game.collisions += 1;
        game.streak = 0;
        game.streakTimer = 0;
        engine.track("collision", { time: performance.now() });
        if (!game.reducedMotion) {
          game.shakeTime = 0.25;
        }
        spawnBurst(player.x, player.y, "#f97316");
      } else if (dist < player.radius + hazard.size + 18) {
        game.nearMisses += 1;
        engine.track("near_miss", { time: performance.now() });
      }
    });

    game.coins = game.coins.filter((coin) => {
      const dist = Math.hypot(player.x - coin.x, player.y - coin.y);
      if (dist < player.radius + coin.radius) {
        game.collected += 1;
        const streakBonus = Math.floor(game.streak / 3);
        game.score += game.activePacket.params.coinValue + streakBonus;
        game.streak += 1;
        game.streakTimer = 0;
        const reactionTime = (performance.now() - coin.spawnTime) / 1000;
        game.reactionSamples.push(clamp(1 - reactionTime / 2.2, 0, 1));
        engine.track("coin_collect", { reactionTime });
        spawnBurst(coin.x, coin.y, "#34d399");
        return false;
      }
      return true;
    });

    scoreValue.textContent = game.score;
  }

  function spawnBurst(x, y, color) {
    if (game.reducedMotion) return;
    for (let i = 0; i < 6; i += 1) {
      game.particles.push({
        x,
        y,
        vx: rand(-40, 40),
        vy: rand(-40, 40),
        life: rand(0.4, 0.9),
        color,
      });
    }
  }

  function render() {
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    ctx.save();
    if (game.shakeTime > 0 && !game.reducedMotion) {
      const intensity = game.activePacket.params.shake * 4;
      const offsetX = rand(-intensity, intensity) * (game.shakeTime / 0.25);
      const offsetY = rand(-intensity, intensity) * (game.shakeTime / 0.25);
      ctx.translate(offsetX, offsetY);
    }

    drawArenaGlow();

    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.arc(game.player.x, game.player.y, game.player.radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#f97316";
    game.hazards.forEach((hazard) => {
      ctx.beginPath();
      ctx.arc(hazard.x, hazard.y, hazard.size, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = "#22c55e";
    game.coins.forEach((coin) => {
      ctx.beginPath();
      ctx.arc(coin.x, coin.y, coin.radius, 0, Math.PI * 2);
      ctx.fill();
    });

    game.particles.forEach((particle) => {
      ctx.globalAlpha = clamp(particle.life, 0, 1);
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    });
    ctx.restore();
  }

  function drawArenaGlow() {
    if (game.reducedMotion) return;
    ctx.save();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = "#1d4ed8";
    ctx.beginPath();
    ctx.arc(canvas.clientWidth / 2, canvas.clientHeight / 2, 220, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function average(list, fallback = 0) {
    if (!list || list.length === 0) return fallback;
    return list.reduce((sum, value) => sum + value, 0) / list.length;
  }

  initGame();
})();
