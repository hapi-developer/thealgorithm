(() => {
  const canvas = document.getElementById("driftCanvas");
  const ctx = canvas.getContext("2d");
  const scoreValue = document.getElementById("scoreValue");
  const comboValue = document.getElementById("comboValue");
  const phaseValue = document.getElementById("phaseValue");

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (min, max) => Math.random() * (max - min) + min;
  const randInt = (min, max) => Math.floor(rand(min, max));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  const storageKey = "driftline-adaptive-v1";
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reducedMotion = prefersReducedMotion.matches;
  prefersReducedMotion.addEventListener("change", (event) => {
    reducedMotion = event.matches;
  });

  const input = {
    up: false,
    down: false,
    left: false,
    right: false,
  };

  const engine = {
    state: null,
    lastSave: 0,
    init() {
      this.state = this.load() || createInitialEngineState();
    },
    updateEmbedding(metrics) {
      const embed = this.state.playerEmbedding;
      embed.controlSmoothness = lerp(embed.controlSmoothness, metrics.smoothness, 0.15);
      embed.reactionMargin = lerp(embed.reactionMargin, metrics.reactionMargin, 0.2);
      embed.riskBias = lerp(embed.riskBias, metrics.riskBias, 0.2);
      embed.explorationRate = lerp(embed.explorationRate, metrics.explorationRate, 0.2);
      embed.patternComprehension = lerp(embed.patternComprehension, metrics.patternComprehension, 0.18);
      embed.enduranceState = lerp(embed.enduranceState, metrics.enduranceState, 0.15);
    },
    updateModel(features, outcome) {
      const weights = this.state.modelWeights;
      const learningRate = 0.08;
      const predicted = dot(weights, features);
      const error = outcome - predicted;
      weights.forEach((_, index) => {
        weights[index] = clamp(weights[index] + learningRate * error * features[index], -2, 2);
      });
    },
    evaluate(metrics) {
      this.updateEmbedding(metrics);
      const features = buildFeatureVector(this.state.playerEmbedding, this.state.experience);
      this.updateModel(features, metrics.engagementScore);

      const candidates = buildCandidates(this.state.experience);
      const scored = candidates.map((candidate) => {
        const score = scoreCandidate(candidate, this.state, metrics);
        return { candidate, score };
      });

      scored.sort((a, b) => b.score - a.score);
      const chosen = scored[0].candidate;
      this.state.experience = chosen;
      this.state.experienceHistory.unshift(experienceVector(chosen));
      this.state.experienceHistory = this.state.experienceHistory.slice(0, 12);

      updateMechanics(this.state, metrics);
      this.save();
      return chosen;
    },
    save() {
      const now = performance.now();
      if (now - this.lastSave < 4000) return;
      this.lastSave = now;
      localStorage.setItem(storageKey, JSON.stringify(this.state));
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
  };

  const game = {
    width: 0,
    height: 0,
    lastFrame: performance.now(),
    player: {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      radius: 10,
      glow: 0,
      drift: 1,
    },
    score: 0,
    combo: 1,
    comboTimer: 0,
    phaseName: "Spiral Drift",
    pulses: [],
    orbiters: [],
    lattices: [],
    sparks: [],
    trails: [],
    metricsWindow: createMetricsWindow(),
    lastAdaptiveTick: performance.now(),
    targetExperience: null,
    currentExperience: null,
  };

  function createInitialEngineState() {
    return {
      playerEmbedding: {
        controlSmoothness: 0.6,
        reactionMargin: 0.6,
        riskBias: 0.4,
        explorationRate: 0.5,
        patternComprehension: 0.6,
        enduranceState: 0.6,
      },
      experience: {
        enemyTopology: "spiral",
        patternSymmetry: 3,
        temporalRhythm: 1.0,
        visualDensity: 0.9,
        colorDynamics: 0.4,
        rewardStructure: 0.6,
        cameraBehavior: 0.3,
        ruleMutations: {
          mirror: 0.2,
          curveSpace: 0.2,
          timeDilation: 0.1,
          precisionScoring: 0.3,
        },
      },
      modelWeights: new Array(1 + 6 + 8).fill(0).map(() => rand(-0.4, 0.4)),
      experienceHistory: [],
      mechanics: {
        mirror: 0.2,
        curveSpace: 0.2,
        timeDilation: 0.1,
        precisionScoring: 0.3,
      },
    };
  }

  function buildFeatureVector(embedding, experience) {
    return [
      1,
      embedding.controlSmoothness,
      embedding.reactionMargin,
      embedding.riskBias,
      embedding.explorationRate,
      embedding.patternComprehension,
      embedding.enduranceState,
      experience.patternSymmetry / 6,
      experience.temporalRhythm / 1.6,
      experience.visualDensity / 1.6,
      experience.colorDynamics,
      experience.rewardStructure,
      experience.cameraBehavior,
      experience.ruleMutations.mirror,
      experience.ruleMutations.curveSpace,
    ];
  }

  function scoreCandidate(candidate, state, metrics) {
    const features = buildFeatureVector(state.playerEmbedding, candidate);
    const predictedEngagement = dot(state.modelWeights, features);
    const mastery = state.playerEmbedding.patternComprehension * 0.6 + state.playerEmbedding.controlSmoothness * 0.4;
    const aesthetic = 0.3 + candidate.colorDynamics * 0.5 + candidate.patternSymmetry / 8;

    const novelty = noveltyScore(candidate, state.experienceHistory);
    const frustration = metrics.collisionRate * 1.4 + (1 - metrics.reactionMargin) * 0.4;
    const load = candidate.visualDensity * 0.7 + candidate.temporalRhythm * 0.4;

    const noveltyPenalty = novelty < 0.18 ? (0.18 - novelty) * 1.5 : 0;
    const frustrationPenalty = frustration > 0.55 ? (frustration - 0.55) * 1.4 : 0;
    const loadPenalty = load > 1.35 ? (load - 1.35) * 1.2 : 0;

    return predictedEngagement + mastery + aesthetic + novelty - noveltyPenalty - frustrationPenalty - loadPenalty;
  }

  function noveltyScore(candidate, history) {
    if (!history.length) return 0.4;
    const vector = experienceVector(candidate);
    const distances = history.map((entry) => vectorDistance(vector, entry));
    const avg = distances.reduce((sum, value) => sum + value, 0) / distances.length;
    return avg;
  }

  function experienceVector(exp) {
    return [
      topologyIndex(exp.enemyTopology) / 4,
      exp.patternSymmetry / 6,
      exp.temporalRhythm / 1.6,
      exp.visualDensity / 1.6,
      exp.colorDynamics,
      exp.rewardStructure,
      exp.cameraBehavior,
      exp.ruleMutations.mirror,
      exp.ruleMutations.curveSpace,
      exp.ruleMutations.timeDilation,
      exp.ruleMutations.precisionScoring,
    ];
  }

  function vectorDistance(a, b) {
    const diff = a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0);
    return diff / a.length;
  }

  function topologyIndex(name) {
    return ["spiral", "pulse", "lattice", "orbit", "mirror"].indexOf(name);
  }

  function buildCandidates(current) {
    const candidates = [current];
    const topologies = ["spiral", "pulse", "lattice", "orbit", "mirror"];
    for (let i = 0; i < 6; i += 1) {
      const clone = JSON.parse(JSON.stringify(current));
      if (Math.random() < 0.3) {
        clone.enemyTopology = topologies[randInt(0, topologies.length)];
      }
      clone.patternSymmetry = clamp(clone.patternSymmetry + rand(-1.2, 1.2), 2, 6);
      clone.temporalRhythm = clamp(clone.temporalRhythm + rand(-0.2, 0.25), 0.7, 1.6);
      clone.visualDensity = clamp(clone.visualDensity + rand(-0.2, 0.3), 0.6, 1.6);
      clone.colorDynamics = clamp(clone.colorDynamics + rand(-0.15, 0.2), 0.1, 1);
      clone.rewardStructure = clamp(clone.rewardStructure + rand(-0.15, 0.2), 0.3, 1);
      clone.cameraBehavior = clamp(clone.cameraBehavior + rand(-0.1, 0.15), 0, 1);
      clone.ruleMutations.mirror = clamp(clone.ruleMutations.mirror + rand(-0.1, 0.12), 0, 1);
      clone.ruleMutations.curveSpace = clamp(clone.ruleMutations.curveSpace + rand(-0.1, 0.12), 0, 1);
      clone.ruleMutations.timeDilation = clamp(clone.ruleMutations.timeDilation + rand(-0.08, 0.1), 0, 1);
      clone.ruleMutations.precisionScoring = clamp(clone.ruleMutations.precisionScoring + rand(-0.1, 0.12), 0, 1);
      candidates.push(clone);
    }
    return candidates;
  }

  function updateMechanics(state, metrics) {
    const mechanics = state.mechanics;
    mechanics.mirror = clamp(lerp(mechanics.mirror, metrics.riskBias, 0.12), 0, 1);
    mechanics.curveSpace = clamp(lerp(mechanics.curveSpace, metrics.explorationRate, 0.1), 0, 1);
    mechanics.timeDilation = clamp(lerp(mechanics.timeDilation, 1 - metrics.reactionMargin, 0.1), 0, 1);
    mechanics.precisionScoring = clamp(lerp(mechanics.precisionScoring, metrics.smoothness, 0.1), 0, 1);

    state.experience.ruleMutations.mirror = mechanics.mirror;
    state.experience.ruleMutations.curveSpace = mechanics.curveSpace;
    state.experience.ruleMutations.timeDilation = mechanics.timeDilation;
    state.experience.ruleMutations.precisionScoring = mechanics.precisionScoring;
  }

  function dot(a, b) {
    return a.reduce((sum, value, index) => sum + value * b[index], 0);
  }

  function createMetricsWindow() {
    return {
      time: 0,
      collisions: 0,
      nearMisses: 0,
      hazardChecks: 0,
      smoothnessSamples: [],
      reactionSamples: [],
      explorationCells: new Set(),
      scoreGains: 0,
      comboGains: 0,
    };
  }

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * ratio;
    canvas.height = window.innerHeight * ratio;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    game.width = window.innerWidth;
    game.height = window.innerHeight;
  }

  function setupInput() {
    const setKey = (key, value) => {
      if (key === "ArrowUp" || key === "w" || key === "W") input.up = value;
      if (key === "ArrowDown" || key === "s" || key === "S") input.down = value;
      if (key === "ArrowLeft" || key === "a" || key === "A") input.left = value;
      if (key === "ArrowRight" || key === "d" || key === "D") input.right = value;
    };

    window.addEventListener("keydown", (event) => setKey(event.key, true));
    window.addEventListener("keyup", (event) => setKey(event.key, false));
  }

  function initializeGame() {
    engine.init();
    resize();
    setupInput();
    window.addEventListener("resize", resize);

    game.player.x = game.width / 2;
    game.player.y = game.height / 2;
    game.targetExperience = engine.state.experience;
    game.currentExperience = JSON.parse(JSON.stringify(engine.state.experience));
    game.phaseName = phaseName(game.currentExperience);
    phaseValue.textContent = game.phaseName;

    requestAnimationFrame(loop);
  }

  function loop(timestamp) {
    const deltaRaw = (timestamp - game.lastFrame) / 1000;
    game.lastFrame = timestamp;

    const timeScale = reducedMotion ? 0.9 : 1;
    const timeDilation = 1 - game.currentExperience.ruleMutations.timeDilation * 0.25 * game.player.glow;
    const delta = Math.min(0.03, deltaRaw) * timeScale * timeDilation;

    updateExperience(delta);
    updatePlayer(delta);
    updatePatterns(delta);
    updateSparks(delta);
    updateTrails(delta);
    updateMetrics(delta);
    render();

    if (timestamp - game.lastAdaptiveTick > 4500) {
      tickAdaptive();
      game.lastAdaptiveTick = timestamp;
    }

    requestAnimationFrame(loop);
  }

  function updateExperience(delta) {
    const current = game.currentExperience;
    const target = game.targetExperience;
    if (!target) return;

    current.patternSymmetry = lerp(current.patternSymmetry, target.patternSymmetry, delta * 0.4);
    current.temporalRhythm = lerp(current.temporalRhythm, target.temporalRhythm, delta * 0.4);
    current.visualDensity = lerp(current.visualDensity, target.visualDensity, delta * 0.4);
    current.colorDynamics = lerp(current.colorDynamics, target.colorDynamics, delta * 0.4);
    current.rewardStructure = lerp(current.rewardStructure, target.rewardStructure, delta * 0.4);
    current.cameraBehavior = lerp(current.cameraBehavior, target.cameraBehavior, delta * 0.4);
    current.ruleMutations.mirror = lerp(current.ruleMutations.mirror, target.ruleMutations.mirror, delta * 0.4);
    current.ruleMutations.curveSpace = lerp(current.ruleMutations.curveSpace, target.ruleMutations.curveSpace, delta * 0.4);
    current.ruleMutations.timeDilation = lerp(current.ruleMutations.timeDilation, target.ruleMutations.timeDilation, delta * 0.4);
    current.ruleMutations.precisionScoring = lerp(
      current.ruleMutations.precisionScoring,
      target.ruleMutations.precisionScoring,
      delta * 0.4
    );

    if (current.enemyTopology !== target.enemyTopology) {
      current.enemyTopology = target.enemyTopology;
      game.phaseName = phaseName(current);
      phaseValue.textContent = game.phaseName;
    }
  }

  function updatePlayer(delta) {
    const accel = 260;
    const curve = game.currentExperience.ruleMutations.curveSpace;

    if (input.up) game.player.vy -= accel * delta;
    if (input.down) game.player.vy += accel * delta;
    if (input.left) game.player.vx -= accel * delta;
    if (input.right) game.player.vx += accel * delta;

    if (curve > 0.05) {
      const swirl = curve * 0.5;
      const temp = game.player.vx;
      game.player.vx = lerp(game.player.vx, -game.player.vy, swirl * delta * 2);
      game.player.vy = lerp(game.player.vy, temp, swirl * delta * 2);
    }

    game.player.vx *= 0.88;
    game.player.vy *= 0.88;

    game.player.x += game.player.vx * delta;
    game.player.y += game.player.vy * delta;

    const margin = game.player.radius + 10;
    game.player.x = clamp(game.player.x, margin, game.width - margin);
    game.player.y = clamp(game.player.y, margin, game.height - margin);

    const speed = Math.hypot(game.player.vx, game.player.vy);
    game.player.glow = lerp(game.player.glow, clamp(speed / 240, 0, 1), 0.12);

    if (!reducedMotion) {
      game.trails.push({
        x: game.player.x,
        y: game.player.y,
        life: 0.6,
        radius: game.player.radius + 6,
      });
    }
  }

  function updatePatterns(delta) {
    const exp = game.currentExperience;
    const density = exp.visualDensity;
    const rhythm = exp.temporalRhythm;
    const centerShift = exp.ruleMutations.mirror * 0.3;
    const center = {
      x: game.width / 2 + game.player.vx * centerShift,
      y: game.height / 2 + game.player.vy * centerShift,
    };

    if (exp.enemyTopology === "pulse") {
      if (game.pulses.length < 6 * density && Math.random() < delta * rhythm * 0.9) {
        game.pulses.push(createPulse(center));
      }
    } else if (exp.enemyTopology === "spiral") {
      if (game.pulses.length < 5 * density && Math.random() < delta * rhythm * 0.8) {
        game.pulses.push(createSpiral(center, exp.patternSymmetry));
      }
    } else if (exp.enemyTopology === "orbit") {
      if (game.orbiters.length < 5 + density * 3) {
        game.orbiters = createOrbiters(center, exp.patternSymmetry, density);
      }
    } else if (exp.enemyTopology === "lattice") {
      if (game.lattices.length < 4) {
        game.lattices = createLattices(exp.patternSymmetry, density);
      }
    } else if (exp.enemyTopology === "mirror") {
      if (game.orbiters.length < 3 + density * 4) {
        game.orbiters = createMirrorOrbits(exp.patternSymmetry, density);
      }
    }

    game.pulses.forEach((pulse) => {
      pulse.radius += pulse.speed * delta;
      pulse.angle += pulse.rotation * delta;
      pulse.life -= delta * 0.25;
    });
    game.pulses = game.pulses.filter((pulse) => pulse.life > 0 && pulse.radius < game.width * 0.9);

    game.orbiters.forEach((orbiter) => {
      orbiter.angle += orbiter.speed * delta;
      orbiter.radius += Math.sin(performance.now() / 600 + orbiter.phase) * delta * 4;
    });

    game.lattices.forEach((line) => {
      line.offset += line.speed * delta;
    });
  }

  function updateSparks(delta) {
    const reward = game.currentExperience.rewardStructure;
    if (game.sparks.length < 6 && Math.random() < delta * (0.6 + reward)) {
      const spot = findSparkSpot();
      if (spot) {
        game.sparks.push({ x: spot.x, y: spot.y, radius: 6, life: 4 });
      }
    }

    game.sparks.forEach((spark) => {
      spark.life -= delta;
    });
    game.sparks = game.sparks.filter((spark) => spark.life > 0);

    game.sparks = game.sparks.filter((spark) => {
      if (dist(game.player, spark) < game.player.radius + spark.radius + 4) {
        const precisionBoost = 1 + game.currentExperience.ruleMutations.precisionScoring * game.player.glow;
        const gain = Math.round(12 * precisionBoost * game.combo);
        game.score += gain;
        game.combo += 0.2;
        game.comboTimer = 0;
        game.metricsWindow.scoreGains += gain;
        game.metricsWindow.comboGains += 1;
        spawnBurst(spark.x, spark.y, 12, "rgba(120,255,220,0.7)");
        return false;
      }
      return true;
    });

    game.comboTimer += delta;
    if (game.comboTimer > 4) {
      game.combo = lerp(game.combo, 1, delta * 0.6);
    }

    scoreValue.textContent = Math.floor(game.score).toString();
    comboValue.textContent = `x${game.combo.toFixed(1)}`;
  }

  function updateTrails(delta) {
    game.trails.forEach((trail) => {
      trail.life -= delta;
    });
    game.trails = game.trails.filter((trail) => trail.life > 0);
  }

  function updateMetrics(delta) {
    const windowData = game.metricsWindow;
    windowData.time += delta;

    const cellX = Math.floor((game.player.x / game.width) * 6);
    const cellY = Math.floor((game.player.y / game.height) * 6);
    windowData.explorationCells.add(`${cellX}:${cellY}`);

    const speed = Math.hypot(game.player.vx, game.player.vy);
    const smoothness = clamp(1 - Math.abs(speed - 140) / 180, 0, 1);
    windowData.smoothnessSamples.push(smoothness);

    const reactionMargin = nearestHazardDistance() / 120;
    windowData.reactionSamples.push(clamp(reactionMargin, 0, 1));
  }

  function tickAdaptive() {
    const metrics = buildMetrics();
    const exp = engine.evaluate(metrics);
    game.targetExperience = exp;
    game.metricsWindow = createMetricsWindow();
  }

  function buildMetrics() {
    const windowData = game.metricsWindow;
    const smoothness = average(windowData.smoothnessSamples, 0.6);
    const reactionMargin = average(windowData.reactionSamples, 0.6);
    const explorationRate = windowData.explorationCells.size / 36;
    const collisionRate = windowData.collisions / Math.max(1, windowData.hazardChecks);
    const riskBias = windowData.nearMisses / Math.max(1, windowData.hazardChecks);
    const patternComprehension = clamp(1 - collisionRate * 1.2, 0, 1);
    const enduranceState = clamp(1 - windowData.time / 200 - collisionRate * 0.4, 0, 1);

    const engagementScore = clamp(
      (windowData.scoreGains / Math.max(1, windowData.time)) * 0.02 +
        windowData.comboGains * 0.05 +
        patternComprehension * 0.4 +
        smoothness * 0.3,
      0,
      1
    );

    return {
      smoothness,
      reactionMargin,
      explorationRate,
      collisionRate,
      riskBias,
      patternComprehension,
      enduranceState,
      engagementScore,
    };
  }

  function findSparkSpot() {
    const tries = 8;
    for (let i = 0; i < tries; i += 1) {
      const x = rand(40, game.width - 40);
      const y = rand(40, game.height - 40);
      if (nearestHazardDistance({ x, y }) > 70) {
        return { x, y };
      }
    }
    return null;
  }

  function nearestHazardDistance(point = game.player) {
    let nearest = 200;
    const hazardPoints = gatherHazards();
    hazardPoints.forEach((hazard) => {
      const d = Math.hypot(point.x - hazard.x, point.y - hazard.y) - hazard.radius;
      if (d < nearest) nearest = d;
    });
    return clamp(nearest, 0, 200);
  }

  function gatherHazards() {
    const hazards = [];
    game.pulses.forEach((pulse) => {
      const points = pulsePoints(pulse);
      points.forEach((point) => hazards.push(point));
    });

    if (game.currentExperience.enemyTopology === "orbit" || game.currentExperience.enemyTopology === "mirror") {
      game.orbiters.forEach((orbiter) => {
        const pos = orbiterPosition(orbiter);
        hazards.push({ x: pos.x, y: pos.y, radius: orbiter.size });
      });
    }

    if (game.currentExperience.enemyTopology === "lattice") {
      game.lattices.forEach((line) => {
        latticePoints(line).forEach((point) => hazards.push(point));
      });
    }

    return hazards;
  }

  function pulsePoints(pulse) {
    const points = [];
    const segments = 10 + Math.floor(game.currentExperience.patternSymmetry * 3);
    for (let i = 0; i < segments; i += 1) {
      const angle = (Math.PI * 2 * i) / segments;
      const gapDiff = Math.abs(normalizeAngle(angle - pulse.angle));
      if (gapDiff < pulse.gapSize) continue;
      points.push({
        x: pulse.center.x + Math.cos(angle) * pulse.radius,
        y: pulse.center.y + Math.sin(angle) * pulse.radius,
        radius: pulse.thickness,
      });
    }
    return points;
  }

  function latticePoints(line) {
    const points = [];
    const count = 8 + Math.floor(game.currentExperience.patternSymmetry * 2);
    for (let i = 0; i < count; i += 1) {
      const offset = (i / count) * game.height;
      if (line.axis === "x") {
        points.push({
          x: line.offset + Math.sin(i + performance.now() / 800) * 60,
          y: offset,
          radius: line.thickness,
        });
      } else {
        points.push({
          x: offset,
          y: line.offset + Math.cos(i + performance.now() / 900) * 60,
          radius: line.thickness,
        });
      }
    }
    return points;
  }

  function orbiterPosition(orbiter) {
    const center = { x: game.width / 2, y: game.height / 2 };
    const mirror = game.currentExperience.enemyTopology === "mirror";
    if (mirror) {
      const offsetX = (center.x - game.player.x) * 0.6;
      const offsetY = (center.y - game.player.y) * 0.6;
      center.x += offsetX;
      center.y += offsetY;
    }
    return {
      x: center.x + Math.cos(orbiter.angle) * orbiter.radius,
      y: center.y + Math.sin(orbiter.angle) * orbiter.radius,
    };
  }

  function updateCollisions() {
    const hazards = gatherHazards();
    hazards.forEach((hazard) => {
      const d = Math.hypot(game.player.x - hazard.x, game.player.y - hazard.y);
      if (d < game.player.radius + hazard.radius) {
        game.metricsWindow.collisions += 1;
        game.combo = 1;
        game.player.vx *= -0.3;
        game.player.vy *= -0.3;
        spawnBurst(game.player.x, game.player.y, 16, "rgba(255,120,120,0.6)");
      } else if (d < game.player.radius + hazard.radius + 14) {
        game.metricsWindow.nearMisses += 1;
      }
      game.metricsWindow.hazardChecks += 1;
    });
  }

  function render() {
    ctx.clearRect(0, 0, game.width, game.height);

    drawBackground();
    drawPulses();
    drawLattices();
    drawOrbiters();
    drawSparks();
    drawPlayer();
    drawTrails();

    updateCollisions();
  }

  function drawBackground() {
    const exp = game.currentExperience;
    const hue = (performance.now() / 60) * exp.colorDynamics;
    const gradient = ctx.createRadialGradient(
      game.width * 0.5,
      game.height * 0.5,
      40,
      game.width * 0.5,
      game.height * 0.5,
      Math.max(game.width, game.height)
    );
    gradient.addColorStop(0, `hsla(${200 + hue}, 80%, 25%, 0.35)`);
    gradient.addColorStop(1, "rgba(5, 7, 15, 0.95)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, game.width, game.height);
  }

  function drawPulses() {
    ctx.save();
    ctx.strokeStyle = "rgba(90, 220, 255, 0.5)";
    ctx.lineWidth = 2;

    game.pulses.forEach((pulse) => {
      const segments = 10 + Math.floor(game.currentExperience.patternSymmetry * 3);
      for (let i = 0; i < segments; i += 1) {
        const angle = (Math.PI * 2 * i) / segments;
        const gapDiff = Math.abs(normalizeAngle(angle - pulse.angle));
        if (gapDiff < pulse.gapSize) continue;
        const x = pulse.center.x + Math.cos(angle) * pulse.radius;
        const y = pulse.center.y + Math.sin(angle) * pulse.radius;
        ctx.beginPath();
        ctx.arc(x, y, pulse.thickness, 0, Math.PI * 2);
        ctx.stroke();
      }
    });
    ctx.restore();
  }

  function drawOrbiters() {
    if (!game.orbiters.length) return;
    ctx.save();
    ctx.fillStyle = "rgba(255, 120, 220, 0.6)";
    game.orbiters.forEach((orbiter) => {
      const pos = orbiterPosition(orbiter);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, orbiter.size, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  function drawLattices() {
    if (!game.lattices.length) return;
    ctx.save();
    ctx.strokeStyle = "rgba(120, 255, 200, 0.35)";
    ctx.lineWidth = 2;
    game.lattices.forEach((line) => {
      const points = latticePoints(line);
      points.forEach((point) => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
        ctx.stroke();
      });
    });
    ctx.restore();
  }

  function drawSparks() {
    ctx.save();
    ctx.fillStyle = "rgba(140, 255, 220, 0.9)";
    game.sparks.forEach((spark) => {
      ctx.beginPath();
      ctx.arc(spark.x, spark.y, spark.radius, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  function drawPlayer() {
    ctx.save();
    const glow = 15 + game.player.glow * 18;
    ctx.shadowColor = "rgba(120, 255, 255, 0.8)";
    ctx.shadowBlur = glow;
    ctx.fillStyle = "rgba(120, 220, 255, 0.9)";
    ctx.beginPath();
    ctx.arc(game.player.x, game.player.y, game.player.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawTrails() {
    if (reducedMotion) return;
    ctx.save();
    game.trails.forEach((trail) => {
      ctx.globalAlpha = clamp(trail.life, 0, 1);
      ctx.strokeStyle = "rgba(80, 200, 255, 0.4)";
      ctx.beginPath();
      ctx.arc(trail.x, trail.y, trail.radius, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.restore();
  }

  function spawnBurst(x, y, count, color) {
    if (reducedMotion) return;
    ctx.save();
    ctx.fillStyle = color;
    for (let i = 0; i < count; i += 1) {
      const angle = rand(0, Math.PI * 2);
      const radius = rand(6, 24);
      ctx.beginPath();
      ctx.arc(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function createPulse(center) {
    return {
      center: { ...center },
      radius: rand(30, 80),
      speed: rand(20, 40) * game.currentExperience.temporalRhythm,
      thickness: rand(6, 10) * game.currentExperience.visualDensity,
      angle: rand(0, Math.PI * 2),
      gapSize: rand(0.3, 0.6),
      rotation: rand(-0.6, 0.6),
      life: 1,
    };
  }

  function createSpiral(center, symmetry) {
    return {
      center: { ...center },
      radius: rand(30, 60),
      speed: rand(30, 60) * game.currentExperience.temporalRhythm,
      thickness: rand(5, 9) * game.currentExperience.visualDensity,
      angle: rand(0, Math.PI * 2),
      gapSize: 0.25 + (symmetry / 10),
      rotation: rand(0.4, 0.9),
      life: 1,
    };
  }

  function createOrbiters(center, symmetry, density) {
    const orbiters = [];
    const count = Math.floor(symmetry + density * 2);
    for (let i = 0; i < count; i += 1) {
      orbiters.push({
        angle: (Math.PI * 2 * i) / count,
        radius: rand(80, 220),
        speed: rand(0.4, 0.9),
        size: rand(7, 12) * density,
        phase: rand(0, Math.PI * 2),
      });
    }
    return orbiters;
  }

  function createMirrorOrbits(symmetry, density) {
    const orbiters = [];
    const count = Math.floor(symmetry + density * 3);
    for (let i = 0; i < count; i += 1) {
      orbiters.push({
        angle: (Math.PI * 2 * i) / count,
        radius: rand(60, 200),
        speed: rand(0.5, 1.0),
        size: rand(6, 11) * density,
        phase: rand(0, Math.PI * 2),
      });
    }
    return orbiters;
  }

  function createLattices(symmetry, density) {
    const lines = [];
    const count = Math.max(2, Math.floor(symmetry / 2));
    for (let i = 0; i < count; i += 1) {
      lines.push({
        axis: i % 2 === 0 ? "x" : "y",
        offset: rand(0, i % 2 === 0 ? game.width : game.height),
        speed: rand(-20, 20) * density,
        thickness: rand(6, 10) * density,
      });
    }
    return lines;
  }

  function phaseName(exp) {
    const base = {
      spiral: "Spiral Drift",
      pulse: "Pulse Field",
      lattice: "Lattice Flow",
      orbit: "Orbit Trace",
      mirror: "Mirror Tide",
    }[exp.enemyTopology];
    return base || "Driftline";
  }

  function normalizeAngle(angle) {
    const tau = Math.PI * 2;
    return ((angle % tau) + tau) % tau;
  }

  function average(list, fallback) {
    if (!list.length) return fallback;
    return list.reduce((sum, value) => sum + value, 0) / list.length;
  }

  initializeGame();
})();
