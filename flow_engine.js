/* flow_engine.js — Flow Director (healthy engagement + fairness)
   Exposes: window.FlowDirector
*/
(() => {
  "use strict";

  // ---------- small utilities ----------
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const lerp = (a, b, t) => a + (b - a) * t;

  class EMA {
    constructor(alpha, initial = 0) {
      this.alpha = alpha;
      this.value = initial;
      this.initialized = false;
    }
    push(x) {
      if (!this.initialized) {
        this.value = x;
        this.initialized = true;
      } else {
        this.value = this.value + this.alpha * (x - this.value);
      }
      return this.value;
    }
  }

  class RunningStats {
    constructor() {
      this.n = 0;
      this.mean = 0;
      this.m2 = 0;
      this.min = Infinity;
      this.max = -Infinity;
    }
    push(x) {
      const v = Number(x);
      if (!Number.isFinite(v)) return;
      this.n += 1;
      this.min = Math.min(this.min, v);
      this.max = Math.max(this.max, v);
      const delta = v - this.mean;
      this.mean += delta / this.n;
      const delta2 = v - this.mean;
      this.m2 += delta * delta2;
    }
    variance() {
      return this.n > 1 ? this.m2 / (this.n - 1) : 0;
    }
    std() {
      return Math.sqrt(this.variance());
    }
    zScore(x) {
      const s = this.std();
      if (s <= 1e-9) return 0;
      return (x - this.mean) / s;
    }
  }

  // Beta distribution (simple Thompson sampling)
  class BetaBanditArm {
    constructor(name) {
      this.name = name;
      this.a = 1;
      this.b = 1;
    }
    update(success, weight = 1) {
      if (success) this.a += weight;
      else this.b += weight;
    }
    sample(rng) {
      // simple approx via sums of exponentials (not perfect, fine for game)
      // We'll use a crude gamma sampler.
      const ga = gammaSample(this.a, rng);
      const gb = gammaSample(this.b, rng);
      const den = ga + gb;
      return den <= 0 ? 0.5 : ga / den;
    }
    mean() {
      return this.a / (this.a + this.b);
    }
  }

  function gammaSample(k, rng) {
    // Marsaglia-Tsang for k >= 1; boost for k < 1
    if (k < 1) {
      const u = rng();
      return gammaSample(k + 1, rng) * Math.pow(u, 1 / k);
    }
    const d = k - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x = normalSample(rng);
      let v = 1 + c * x;
      if (v <= 0) continue;
      v = v * v * v;
      const u = rng();
      if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  function normalSample(rng) {
    // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Seeded RNG for reproducibility (mulberry32)
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- Player Model ----------
  class PlayerModel {
    constructor(cfg) {
      this.cfg = cfg;

      // skill estimate + uncertainty
      this.skill = cfg.skillInitial;            // 0..1
      this.skillVar = cfg.skillVarInitial;      // uncertainty proxy
      this.skillEma = new EMA(0.10, this.skill);

      // performance and tempo signals
      this.winRateEma = new EMA(0.08, 0.50);
      this.errorRateEma = new EMA(0.10, 0.20);

      // timing signals
      this.turnTimeStats = new RunningStats();
      this.turnTimeEma = new EMA(0.08, cfg.turnTimeTargetMs);

      this.hesitationEma = new EMA(0.12, 0.0);

      // fatigue / volatility
      this.streak = 0;
      this.volatility = new EMA(0.10, 0.20);
      this.fatigue = new EMA(0.06, 0.0);

      // engagement proxy
      this.engagementEma = new EMA(0.08, 0.70);
      this.flowEma = new EMA(0.08, 0.70);

      // last snapshots
      this.lastTurnMs = cfg.turnTimeTargetMs;
      this.lastMistakes = 0;
      this.lastActions = 0;

      // meta
      this.games = 0;
      this.turns = 0;
    }

    observeTurn(summary) {
      // summary: { turnMs, actionsTaken, mistakes, forcedEnds, outcomeHint? }
      const turnMs = clamp(summary.turnMs ?? this.cfg.turnTimeTargetMs, 200, 60000);
      const actions = clamp(summary.actionsTaken ?? 0, 0, 99);
      const mistakes = clamp(summary.mistakes ?? 0, 0, 99);

      this.turns += 1;

      this.turnTimeStats.push(turnMs);
      const tE = this.turnTimeEma.push(turnMs);

      // hesitation proxy: (turn time per action) deviation from target
      const perAction = actions > 0 ? (turnMs / actions) : turnMs;
      const hesitationRaw = clamp((perAction - this.cfg.turnTimeTargetMs / this.cfg.actionsPerTurnTarget) / 2000, -1, 1);
      this.hesitationEma.push(hesitationRaw);

      // error rate proxy
      const errRate = actions > 0 ? mistakes / actions : mistakes > 0 ? 1 : 0;
      this.errorRateEma.push(clamp(errRate, 0, 1));

      // volatility: how “swingy” the player’s pace is
      const z = Math.abs(this.turnTimeStats.zScore(turnMs));
      this.volatility.push(clamp(z / 3, 0, 1));

      // fatigue: sustained slowdowns + streak pressure
      const slow = clamp((tE - this.cfg.turnTimeTargetMs) / this.cfg.turnTimeTargetMs, -0.5, 1.5);
      const fatigueLift = clamp(0.35 * Math.max(0, slow) + 0.12 * Math.max(0, this.volatility.value - 0.35), 0, 1);
      this.fatigue.push(fatigueLift);

      this.lastTurnMs = turnMs;
      this.lastMistakes = mistakes;
      this.lastActions = actions;
    }

    observeGame(result) {
      // result: { playerWon, turns, closeGame, comeback, playerBeaconScore, botBeaconScore }
      this.games += 1;

      const won = !!result.playerWon;
      const reward = won ? 1 : 0;

      const wr = this.winRateEma.push(reward);

      // streak
      if (won) this.streak = this.streak >= 0 ? this.streak + 1 : 1;
      else this.streak = this.streak <= 0 ? this.streak - 1 : -1;

      // skill update (bounded) based on outcome + closeness
      const close = result.closeGame ? 1 : 0;
      const comeback = result.comeback ? 1 : 0;

      // expected win probability from current skill proxy
      // (difficulty will try to match this later)
      const expected = clamp(this.skill, 0.05, 0.95);
      const err = reward - expected;

      // learning rate scales with uncertainty
      const lr = clamp(0.08 + this.skillVar * 0.18, 0.06, 0.22);

      // closeness indicates “right challenge” rather than skill delta
      const closeDampen = 1 - 0.35 * close;
      const comebackBoost = 1 + 0.20 * comeback;

      this.skill = clamp(this.skill + lr * err * closeDampen * comebackBoost, 0.02, 0.98);

      // uncertainty shrinks over games, increases if volatility high
      const shrink = 0.96 - 0.05 * Math.min(1, this.games / 20);
      const inflate = 1 + 0.10 * Math.max(0, this.volatility.value - 0.30);
      this.skillVar = clamp(this.skillVar * shrink * inflate, 0.05, 0.35);

      this.skillEma.push(this.skill);

      // engagement proxy update:
      // - best when winrate ~ target and error-rate moderate and pace moderate
      // - penalize extreme fatigue
      const tempo = clamp(this.turnTimeEma.value / this.cfg.turnTimeTargetMs, 0.4, 1.8);
      const tempoScore = 1 - Math.abs(tempo - 1) * 0.75; // peak at 1
      const errScore = 1 - Math.abs(this.errorRateEma.value - this.cfg.errorRateTarget) * 1.2;
      const wrScore = 1 - Math.abs(wr - this.cfg.targetWinRate) * 1.6;
      const fatiguePenalty = 0.55 * this.fatigue.value;

      const engagement = clamp(0.45 * tempoScore + 0.35 * errScore + 0.35 * wrScore - fatiguePenalty, 0, 1);
      this.engagementEma.push(engagement);

      // flow is a specific “challenge-skill match” proxy
      // (close games, moderate tempo, moderate errors, no fatigue)
      const flow = clamp(
        0.30 * wrScore +
        0.25 * tempoScore +
        0.25 * (1 - Math.abs(this.hesitationEma.value)) +
        0.20 * close -
        0.35 * this.fatigue.value,
        0, 1
      );
      this.flowEma.push(flow);
    }

    snapshot() {
      return {
        skill: this.skill,
        skillTrend: this.skillEma.value,
        skillVar: this.skillVar,
        winRateEma: this.winRateEma.value,
        errorRateEma: this.errorRateEma.value,
        turnTimeEma: this.turnTimeEma.value,
        hesitation: this.hesitationEma.value,
        volatility: this.volatility.value,
        fatigue: this.fatigue.value,
        engagement: this.engagementEma.value,
        flow: this.flowEma.value,
        streak: this.streak,
        games: this.games,
        turns: this.turns,
      };
    }
  }

  // ---------- Beat Scheduler (safe “rhythm” planner) ----------
  class BeatScheduler {
    constructor(cfg, rng) {
      this.cfg = cfg;
      this.rng = rng;

      // beats: what “kind” of match/turn-feel to emphasize
      // safe: no compulsion mechanics, only pacing/clarity/variety knobs
      this.arms = new Map();
      ["recovery", "training", "challenge", "novelty"].forEach((name) => {
        this.arms.set(name, new BetaBanditArm(name));
      });

      this.lastBeat = "training";
      this.cooldowns = { recovery: 0, training: 0, challenge: 0, novelty: 0 };
    }

    tickCooldowns() {
      for (const k of Object.keys(this.cooldowns)) {
        this.cooldowns[k] = Math.max(0, this.cooldowns[k] - 1);
      }
    }

    chooseBeat(playerSnap) {
      this.tickCooldowns();

      // hard rules:
      // - if fatigue high -> prioritize recovery/training
      // - if boredom (engagement low but errors low & tempo fast) -> novelty/challenge
      const fatigue = playerSnap.fatigue;
      const engagement = playerSnap.engagement;
      const err = playerSnap.errorRateEma;
      const tempo = playerSnap.turnTimeEma / this.cfg.turnTimeTargetMs;

      if (fatigue > 0.62) {
        this.cooldowns.recovery = 1;
        this.lastBeat = "recovery";
        return "recovery";
      }

      let bias = {
        recovery: 0,
        training: 0,
        challenge: 0,
        novelty: 0,
      };

      // engagement low, errors low -> likely bored: add novelty
      if (engagement < 0.52 && err < 0.18 && tempo < 0.95) bias.novelty += 0.20;

      // engagement low, errors high -> overwhelmed: training/recovery
      if (engagement < 0.52 && err > 0.30) {
        bias.training += 0.16;
        bias.recovery += 0.12;
      }

      // player winning too much -> challenge
      if (playerSnap.winRateEma > this.cfg.targetWinRate + 0.08) bias.challenge += 0.18;

      // player losing too much -> training
      if (playerSnap.winRateEma < this.cfg.targetWinRate - 0.08) bias.training += 0.18;

      // cooldown penalty
      const cdPenalty = (name) => (this.cooldowns[name] > 0 ? 0.12 : 0);

      // Thompson sample each arm + bias
      const samples = [];
      for (const [name, arm] of this.arms.entries()) {
        const s = arm.sample(this.rng);
        samples.push({
          name,
          score: s + bias[name] - cdPenalty(name),
        });
      }
      samples.sort((a, b) => b.score - a.score);

      const best = samples[0].name;

      // set cooldown to avoid repeating
      this.cooldowns[best] = 1;
      this.lastBeat = best;
      return best;
    }

    learn(beat, improvement) {
      // improvement is “did engagement/flow go up?”
      const arm = this.arms.get(beat);
      if (!arm) return;
      arm.update(improvement, 1);
    }

    snapshot() {
      const out = {};
      for (const [k, arm] of this.arms.entries()) {
        out[k] = { mean: arm.mean(), a: arm.a, b: arm.b };
      }
      return { lastBeat: this.lastBeat, arms: out };
    }
  }

  // ---------- Flow Controller (maps model -> knobs) ----------
  class FlowController {
    constructor(cfg, rng) {
      this.cfg = cfg;
      this.rng = rng;

      // global adaptation knob
      this.bias = 0;

      // smoothing on outputs
      this.difficultyEma = new EMA(0.15, 0.5);
      this.pacingEma = new EMA(0.12, cfg.botDelayMs);
      this.assistEma = new EMA(0.15, 0.5);

      // track progress for learning beat efficacy
      this.lastFlow = 0.70;
      this.lastEng = 0.70;
    }

    compute(playerSnap, beat) {
      const targetWR = this.cfg.targetWinRate;

      const wrGap = clamp(playerSnap.winRateEma - targetWR, -0.5, 0.5);
      const fatigue = clamp(playerSnap.fatigue, 0, 1);
      const err = clamp(playerSnap.errorRateEma, 0, 1);
      const hes = clamp(playerSnap.hesitation, -1, 1);

      // primary: challenge-skill match
      // base difficulty follows skill trend
      let base = clamp(playerSnap.skillTrend, 0.10, 0.90);

      // if player winning too much -> harder; losing too much -> easier
      base = clamp(base + wrGap * 0.55, 0.10, 0.95);

      // fatigue & high errors -> ease off difficulty
      base = clamp(base - 0.35 * fatigue - 0.30 * Math.max(0, err - 0.25), 0.10, 0.95);

      // hesitation indicates cognitive load; ease slightly
      base = clamp(base - 0.12 * Math.max(0, hes), 0.10, 0.95);

      // beat modulation (safe rhythm)
      let diff = base;
      if (beat === "recovery") diff = clamp(diff - 0.16, 0.10, 0.90);
      if (beat === "training") diff = clamp(diff - 0.08, 0.10, 0.93);
      if (beat === "challenge") diff = clamp(diff + 0.10, 0.10, 0.95);
      if (beat === "novelty") diff = clamp(diff + 0.04, 0.10, 0.95);

      // learnable bias (nudges long-run toward target win rate)
      diff = clamp(diff + this.bias, 0.10, 0.95);

      // map difficulty to bot depth and randomness
      const depth = diff >= 0.62 ? 2 : 1;
      const randomness = clamp(0.60 - diff * 0.52, 0.10, 0.60);

      // pacing: higher fatigue -> slower bot (more breathing room)
      let pacing = this.cfg.botDelayMs;
      pacing = pacing + 250 * fatigue - 120 * Math.max(0, wrGap); // if player stomping, speed up a bit
      if (beat === "recovery") pacing += 120;
      if (beat === "challenge") pacing -= 70;
      pacing = clamp(pacing, 260, 1100);

      // assist: increase with fatigue/errors, decrease with high skill and low errors
      let assist = 0.45;
      assist += 0.35 * fatigue + 0.45 * Math.max(0, err - 0.20);
      assist -= 0.30 * Math.max(0, playerSnap.skillTrend - 0.65);
      assist = clamp(assist, 0.10, 0.95);
      if (beat === "training") assist = clamp(assist + 0.08, 0.10, 0.98);
      if (beat === "challenge") assist = clamp(assist - 0.06, 0.10, 0.95);

      // smooth outputs
      diff = this.difficultyEma.push(diff);
      pacing = this.pacingEma.push(pacing);
      assist = this.assistEma.push(assist);

      // convert assist into discrete UI modes
      const assistMode =
        assist >= 0.78 ? "High" :
        assist >= 0.55 ? "Auto" :
        assist >= 0.32 ? "Low" : "Off";

      // hints: show move highlights at higher assist
      const showHighlights = assist >= 0.32;
      const showAttackHints = assist >= 0.55;

      // learn bias update (tiny) toward target WR
      // (computed after games elsewhere, but keep a gentle drift)
      const drift = clamp(wrGap * 0.03, -0.02, 0.02);
      this.bias = clamp(this.bias + drift, -0.18, 0.18);

      return {
        difficulty: diff,
        depth,
        randomness,
        pacingMs: pacing,
        assist,
        assistMode,
        showHighlights,
        showAttackHints,
        beat,
      };
    }

    noteOutcome(playerSnap) {
      // did flow/engagement improve since last?
      const f = playerSnap.flow;
      const e = playerSnap.engagement;
      const improved = (f + e) > (this.lastFlow + this.lastEng) + 0.02;
      this.lastFlow = f;
      this.lastEng = e;
      return improved;
    }
  }

  // ---------- Public Director ----------
  class FlowDirector {
    constructor(options = {}) {
      const nowSeed = (Date.now() ^ (Math.random() * 1e9)) >>> 0;
      const seed = options.seed ?? nowSeed;

      this.cfg = {
        targetWinRate: options.targetWinRate ?? 0.58,
        errorRateTarget: options.errorRateTarget ?? 0.22,
        turnTimeTargetMs: options.turnTimeTargetMs ?? 7000,
        actionsPerTurnTarget: options.actionsPerTurnTarget ?? 2,
        botDelayMs: options.botDelayMs ?? 650,

        // player model init
        skillInitial: options.skillInitial ?? 0.50,
        skillVarInitial: options.skillVarInitial ?? 0.22,
      };

      this.rng = mulberry32(seed);

      this.player = new PlayerModel({
        targetWinRate: this.cfg.targetWinRate,
        errorRateTarget: this.cfg.errorRateTarget,
        turnTimeTargetMs: this.cfg.turnTimeTargetMs,
        actionsPerTurnTarget: this.cfg.actionsPerTurnTarget,
        skillInitial: this.cfg.skillInitial,
        skillVarInitial: this.cfg.skillVarInitial,
      });

      this.beats = new BeatScheduler(
        {
          targetWinRate: this.cfg.targetWinRate,
          turnTimeTargetMs: this.cfg.turnTimeTargetMs,
        },
        this.rng
      );

      this.flow = new FlowController(
        {
          targetWinRate: this.cfg.targetWinRate,
          botDelayMs: this.cfg.botDelayMs,
          turnTimeTargetMs: this.cfg.turnTimeTargetMs,
        },
        this.rng
      );

      this.currentBeat = "training";
      this.currentPlan = this.flow.compute(this.player.snapshot(), this.currentBeat);

      this.session = {
        startedAt: Date.now(),
        turns: 0,
        games: 0,
      };
    }

    observeTurn(turnSummary) {
      this.player.observeTurn(turnSummary);
      this.session.turns += 1;

      // refresh plan after each turn
      const snap = this.player.snapshot();
      // beat stays stable within a match unless fatigue spikes
      if (snap.fatigue > 0.70) this.currentBeat = "recovery";
      this.currentPlan = this.flow.compute(snap, this.currentBeat);
    }

    observeGame(gameResult) {
      this.player.observeGame(gameResult);
      this.session.games += 1;

      const snap = this.player.snapshot();

      // choose next beat
      const nextBeat = this.beats.chooseBeat(snap);
      const improved = this.flow.noteOutcome(snap);
      this.beats.learn(this.currentBeat, improved);

      this.currentBeat = nextBeat;
      this.currentPlan = this.flow.compute(snap, this.currentBeat);

      return this.currentPlan;
    }

    recommend() {
      const snap = this.player.snapshot();
      return {
        ...this.currentPlan,
        snapshot: snap,
      };
    }

    snapshot() {
      return {
        cfg: { ...this.cfg },
        player: this.player.snapshot(),
        beat: this.beats.snapshot(),
        plan: { ...this.currentPlan },
        session: { ...this.session },
      };
    }
  }

  window.FlowDirector = FlowDirector;
})();
