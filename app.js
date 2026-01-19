const EVENT_BUS = (() => {
  const handlers = new Map();
  return {
    on(eventName, handler) {
      if (!handlers.has(eventName)) {
        handlers.set(eventName, new Set());
      }
      handlers.get(eventName).add(handler);
    },
    emit(eventName, payload) {
      if (!handlers.has(eventName)) return;
      handlers.get(eventName).forEach((handler) => handler(payload));
    },
  };
})();

const STORAGE_KEY = "pac_state_v1";
const MAX_HISTORY = 500;
const DEFAULT_RETENTION_DAYS = 30;

const Utils = {
  now() {
    return Date.now();
  },
  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  },
  uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  },
  normalizeText(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  },
  pickRandom(list) {
    return list[Math.floor(Math.random() * list.length)];
  },
  formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  },
};

const Storage = (() => {
  let memoryState = null;
  const canStore = (() => {
    try {
      localStorage.setItem("__pac_test", "1");
      localStorage.removeItem("__pac_test");
      return true;
    } catch (error) {
      return false;
    }
  })();

  const defaultState = () => ({
    version: 1,
    userId: Utils.uuid(),
    traits: TraitModel.defaultTraits(),
    history: [],
    experiments: {},
    convo: {
      messages: [],
      episode: null,
      step: "idle",
      lastAssistantId: null,
      lastInteraction: Utils.now(),
    },
    settings: {
      adaptiveMode: true,
      dataRetentionDays: DEFAULT_RETENTION_DAYS,
      reduceData: false,
    },
  });

  const pruneHistory = (state) => {
    const cutoff = Utils.now() - state.settings.dataRetentionDays * 24 * 60 * 60 * 1000;
    state.history = state.history.filter((entry) => entry.endTime ? entry.endTime >= cutoff : true);
  };

  return {
    getState() {
      if (!canStore) {
        if (!memoryState) memoryState = defaultState();
        return memoryState;
      }
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      try {
        const parsed = JSON.parse(raw);
        const merged = { ...defaultState(), ...parsed };
        pruneHistory(merged);
        return merged;
      } catch (error) {
        return defaultState();
      }
    },
    saveState(state) {
      if (!canStore) {
        memoryState = state;
        return;
      }
      const snapshot = JSON.parse(JSON.stringify(state));
      if (snapshot.settings.reduceData) {
        snapshot.convo.messages = [];
        snapshot.history = snapshot.history.map((entry) => ({
          id: entry.id,
          type: entry.type,
          startTime: entry.startTime,
          endTime: entry.endTime,
          outcome: entry.outcome,
          probes: entry.probes,
        }));
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    },
    reset() {
      if (canStore) {
        localStorage.removeItem(STORAGE_KEY);
      }
      memoryState = defaultState();
      return memoryState;
    },
    export(state) {
      const data = JSON.stringify(state, null, 2);
      const blob = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "passive-adaptive-chat-data.json";
      link.click();
      URL.revokeObjectURL(url);
    },
  };
})();

const TraitModel = {
  defaultTraits() {
    const baseTrait = () => ({ mean: 0.5, variance: 0.25 });
    return {
      deliberation: baseTrait(),
      frustrationSensitivity: baseTrait(),
      explorationPreference: baseTrait(),
      structurePreference: baseTrait(),
      autonomyPreference: baseTrait(),
      difficultyTolerance: baseTrait(),
      verbosityPreference: baseTrait(),
      ambiguityTolerance: baseTrait(),
      reflectionTolerance: baseTrait(),
    };
  },
  updateTrait(state, name, delta, weight = 0.4) {
    const trait = state.traits[name];
    if (!trait) return;
    const adjusted = trait.mean + delta * weight;
    const newMean = Utils.clamp(adjusted, 0.05, 0.95);
    const consistency = 1 - Math.min(Math.abs(delta), 1);
    const newVariance = Utils.clamp(trait.variance * (0.96 + 0.02 * consistency), 0.04, 0.3);
    state.traits[name] = { mean: newMean, variance: newVariance };
  },
  applyUserFeatures(state, features) {
    const { draftDuration, messageLength, editRatio, typingSpeed, rageSignal } = features;
    const longDraft = draftDuration > 6 && messageLength > 40;
    const shortFast = draftDuration < 2 && messageLength < 15;

    if (longDraft) this.updateTrait(state, "deliberation", 0.25, 0.5);
    if (shortFast) this.updateTrait(state, "deliberation", -0.2, 0.5);

    if (editRatio > 0.15) this.updateTrait(state, "deliberation", 0.1, 0.3);
    if (typingSpeed > 6) this.updateTrait(state, "verbosityPreference", 0.1, 0.2);
    if (messageLength > 80) this.updateTrait(state, "verbosityPreference", 0.2, 0.4);
    if (messageLength < 12) this.updateTrait(state, "verbosityPreference", -0.15, 0.4);

    if (rageSignal) this.updateTrait(state, "frustrationSensitivity", 0.3, 0.5);
    if (!rageSignal && editRatio < 0.08) this.updateTrait(state, "frustrationSensitivity", -0.1, 0.3);

    if (messageLength > 60) this.updateTrait(state, "explorationPreference", 0.2, 0.3);
    if (messageLength < 20) this.updateTrait(state, "explorationPreference", -0.1, 0.3);

    if (features.quickReplyUsed) this.updateTrait(state, "autonomyPreference", 0.15, 0.3);
    if (!features.quickReplyUsed && messageLength > 30) this.updateTrait(state, "autonomyPreference", -0.1, 0.3);
  },
  applyAssistantView(state, features) {
    if (features.timeToType > 5) this.updateTrait(state, "deliberation", 0.1, 0.2);
    if (features.timeToType < 2) this.updateTrait(state, "deliberation", -0.1, 0.2);
    if (features.scrollDepth > 0.7) this.updateTrait(state, "structurePreference", 0.1, 0.2);
  },
};

const ProbeEngine = {
  families: {
    framing: ["experiment", "practice", "challenge"],
    structure: ["bullets", "narrative"],
    interaction: ["quick", "open"],
    feedback: ["hint-first", "question-first"],
    pacing: ["immediate", "typing-delay"],
  },
  getContextBucket(traits) {
    const fr = traits.frustrationSensitivity.mean > 0.65 ? "fragile" : "steady";
    const struct = traits.structurePreference.mean > 0.6 ? "structured" : "flow";
    const diff = traits.difficultyTolerance.mean > 0.6 ? "bold" : "careful";
    return `${fr}-${struct}-${diff}`;
  },
  getStats(state, family, bucket) {
    if (!state.experiments[family]) state.experiments[family] = {};
    if (!state.experiments[family][bucket]) state.experiments[family][bucket] = {};
    return state.experiments[family][bucket];
  },
  pickVariant(state, family, traits, adaptiveMode) {
    const variants = this.families[family];
    if (!adaptiveMode) return variants[0];
    const bucket = this.getContextBucket(traits);
    const stats = this.getStats(state, family, bucket);
    const epsilon = 0.2;
    if (Math.random() < epsilon) return Utils.pickRandom(variants);
    let best = variants[0];
    let bestScore = -Infinity;
    variants.forEach((variant) => {
      const entry = stats[variant];
      const mean = entry ? entry.mean : 0;
      if (mean > bestScore) {
        bestScore = mean;
        best = variant;
      }
    });
    return best;
  },
  update(state, probes, traits, reward) {
    const bucket = this.getContextBucket(traits);
    Object.entries(probes).forEach(([family, variant]) => {
      const stats = this.getStats(state, family, bucket);
      if (!stats[variant]) stats[variant] = { count: 0, mean: 0, m2: 0 };
      const entry = stats[variant];
      entry.count += 1;
      const delta = reward - entry.mean;
      entry.mean += delta / entry.count;
      entry.m2 += delta * (reward - entry.mean);
    });
  },
};

const PassiveSignalCollector = (bus) => {
  let draftStart = null;
  let lastKeyTime = null;
  let keystrokes = 0;
  let backspaces = 0;
  let pasteCount = 0;
  let interKeyIntervals = [];
  let lastAssistantTime = null;
  let typingStartedAfterAssistant = false;
  let lastScrollDepth = 0;
  let lastVisibility = Utils.now();

  const input = document.getElementById("messageInput");
  const chatWindow = document.getElementById("chatWindow");

  const resetDraft = () => {
    draftStart = null;
    lastKeyTime = null;
    keystrokes = 0;
    backspaces = 0;
    pasteCount = 0;
    interKeyIntervals = [];
    typingStartedAfterAssistant = false;
  };

  input.addEventListener("keydown", (event) => {
    if (!draftStart) draftStart = Utils.now();
    keystrokes += 1;
    if (event.key === "Backspace") backspaces += 1;
    if (lastKeyTime) interKeyIntervals.push(Utils.now() - lastKeyTime);
    lastKeyTime = Utils.now();
    if (lastAssistantTime && !typingStartedAfterAssistant) {
      typingStartedAfterAssistant = true;
      bus.emit("assistant_message_viewed", {
        timeToType: (Utils.now() - lastAssistantTime) / 1000,
        scrollDepth: lastScrollDepth,
      });
    }
  });

  input.addEventListener("input", () => {
    if (!draftStart && input.value.trim().length > 0) draftStart = Utils.now();
  });

  input.addEventListener("paste", () => {
    pasteCount += 1;
  });

  input.addEventListener("blur", () => {
    if (input.value.trim() === "") resetDraft();
  });

  chatWindow.addEventListener("scroll", () => {
    const depth = chatWindow.scrollTop / (chatWindow.scrollHeight - chatWindow.clientHeight || 1);
    lastScrollDepth = Utils.clamp(depth, 0, 1);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      bus.emit("session_end", { reason: "hidden", timestamp: Utils.now() });
      lastVisibility = Utils.now();
    } else {
      bus.emit("session_resume", { downtime: Utils.now() - lastVisibility });
    }
  });

  return {
    markAssistantMessage() {
      lastAssistantTime = Utils.now();
    },
    captureSend(text, usedQuickReply = false) {
      const now = Utils.now();
      const draftDuration = draftStart ? (now - draftStart) / 1000 : 0.2;
      const avgInterKey = interKeyIntervals.length
        ? interKeyIntervals.reduce((a, b) => a + b, 0) / interKeyIntervals.length
        : 0;
      const typingSpeed = avgInterKey ? 1000 / avgInterKey : 0;
      const messageLength = text.trim().length;
      const editRatio = keystrokes ? backspaces / keystrokes : 0;
      const rageSignal = backspaces > 12 || /[A-Z]{4,}/.test(text) || (draftDuration < 1 && messageLength > 20);

      resetDraft();

      const features = {
        draftDuration,
        keystrokes,
        backspaces,
        pasteCount,
        typingSpeed,
        messageLength,
        editRatio,
        rageSignal,
        quickReplyUsed: usedQuickReply,
      };

      bus.emit("user_message_features", features);
      return features;
    },
  };
};

const ConversationTemplates = {
  greetings: {
    concise: [
      "Hey! I can offer quick challenges, planning help, or study drills. Want to pick a track?",
      "Ready for a mini challenge or a planning sprint?",
    ],
    supportive: [
      "Hi there! I can keep things light and useful—quick puzzles, study drills, or planning steps.",
      "Welcome back! I can guide a short challenge or help you organize a task.",
    ],
  },
  outro: [
    "Nice work. Want another short challenge or a different track?",
    "All set. I can switch to a new mini-session if you want.",
  ],
  pauseOffer: "Want to pause for now?",
};

const Episodes = {
  twoChoice: {
    intro: {
      title: "Two-Choice Reasoning",
      prompt: "We can approach this in two ways. Pick what feels best:",
      chips: ["Quick brainstorm", "Step-by-step plan"],
      responses: {
        "quick brainstorm": "Got it. I’ll keep it fast and flexible. Tell me the topic you want to explore.",
        "step-by-step plan": "Great. I’ll keep it structured. Share a topic or goal and we’ll outline steps.",
      },
    },
  },
  logic: {
    easy: [
      {
        question: "Logic warm-up: If all glims are bloms and no bloms are zits, can any glim be a zit?",
        answers: [/no/i, /none/i, /cannot/i],
        hint: "Think about set inclusion: glims are inside bloms.",
      },
    ],
    medium: [
      {
        question: "A lamp is off. You have two switches outside the room. You can flip switches twice total. How do you determine which switch controls the lamp?",
        answers: [/feel|warm|heat|hot/i, /second|switch/i],
        hint: "One switch can be used to heat the bulb.",
      },
    ],
    hard: [
      {
        question: "Three boxes: one labeled Apples, one Oranges, one Apples & Oranges. All labels are wrong. You can take one fruit from one box. How do you label the boxes?",
        answers: [/apples|oranges/i, /mislabel|wrong/i],
        hint: "Pick a fruit from the mixed-labeled box.",
      },
    ],
  },
  study: {
    cards: [
      { term: "abate", definition: "to reduce in intensity" },
      { term: "lucid", definition: "clear and easy to understand" },
      { term: "novel", definition: "new or unusual" },
      { term: "fracture", definition: "a break or crack" },
    ],
  },
  planning: {
    prompt: "Share a goal you want to move forward today. I’ll break it into steps.",
  },
  debugging: {
    prompt: "Describe a bug or issue you’re facing. I’ll suggest a short diagnostic checklist.",
  },
  creativity: {
    prompt: "Pick a theme (e.g., snacks, study breaks, app ideas). I’ll generate ideas with constraints.",
  },
};

const AdaptationPolicy = {
  decide(traits, lastOutcome) {
    const style = traits.verbosityPreference.mean > 0.6 ? "detailed" : "concise";
    const structure = traits.structurePreference.mean > 0.6 ? "bullets" : "narrative";
    const tone = traits.frustrationSensitivity.mean > 0.6 ? "supportive" : "direct";
    const quickReplies = traits.autonomyPreference.mean > 0.55;
    let difficulty = "easy";
    if (traits.difficultyTolerance.mean > 0.6) difficulty = "hard";
    else if (traits.difficultyTolerance.mean > 0.45) difficulty = "medium";

    if (lastOutcome && !lastOutcome.success && traits.frustrationSensitivity.mean > 0.6) {
      difficulty = "easy";
    }

    const pacingDelay = traits.deliberation.mean > 0.6 ? 800 : 400;

    return {
      style,
      structure,
      tone,
      quickReplies,
      difficulty,
      pacingDelay,
      followUp: traits.frustrationSensitivity.mean > 0.6 ? "hint" : "question",
    };
  },
};

const ConversationEngine = (state, ui, bus) => {
  const buildEpisode = (type, policy) => {
    const probes = {
      framing: ProbeEngine.pickVariant(state, "framing", state.traits, state.settings.adaptiveMode),
      structure: ProbeEngine.pickVariant(state, "structure", state.traits, state.settings.adaptiveMode),
      interaction: ProbeEngine.pickVariant(state, "interaction", state.traits, state.settings.adaptiveMode),
      feedback: ProbeEngine.pickVariant(state, "feedback", state.traits, state.settings.adaptiveMode),
      pacing: ProbeEngine.pickVariant(state, "pacing", state.traits, state.settings.adaptiveMode),
    };

    return {
      id: Utils.uuid(),
      type,
      policy,
      probes,
      startTime: Utils.now(),
      attempts: 0,
      success: false,
      completed: false,
      features: [],
      quickRepliesUsed: 0,
      messages: [],
    };
  };

  const formatPrompt = (text, policy, probes) => {
    if (probes.structure === "bullets" || policy.structure === "bullets") {
      return `• ${text}`;
    }
    return text;
  };

  const startEpisode = (type, lastOutcome) => {
    const policy = AdaptationPolicy.decide(state.traits, lastOutcome);
    const episode = buildEpisode(type, policy);
    state.convo.episode = episode;
    state.convo.step = "intro";

    const greetingPool = policy.tone === "supportive" ? ConversationTemplates.greetings.supportive : ConversationTemplates.greetings.concise;
    const introMessage = Utils.pickRandom(greetingPool);

    ui.sendAssistant(introMessage, { pacing: policy.pacingDelay, probes: episode.probes });
    proceedEpisode();
  };

  const proceedEpisode = () => {
    const episode = state.convo.episode;
    if (!episode) return;

    if (state.convo.step === "intro") {
      let prompt = "";
      let chips = [];

      if (episode.type === "twoChoice") {
        prompt = `${Episodes.twoChoice.intro.prompt}`;
        chips = Episodes.twoChoice.intro.chips;
      } else if (episode.type === "logic") {
        const puzzle = Utils.pickRandom(Episodes.logic[episode.policy.difficulty]);
        episode.payload = puzzle;
        prompt = puzzle.question;
      } else if (episode.type === "study") {
        const card = Utils.pickRandom(Episodes.study.cards);
        episode.payload = card;
        prompt = `Study drill: What does "${card.term}" mean?`;
      } else if (episode.type === "planning") {
        prompt = Episodes.planning.prompt;
      } else if (episode.type === "debugging") {
        prompt = Episodes.debugging.prompt;
      } else if (episode.type === "creativity") {
        prompt = Episodes.creativity.prompt;
      }

      if (episode.probes.framing === "experiment") {
        prompt = `Quick experiment: ${prompt}`;
      } else if (episode.probes.framing === "practice") {
        prompt = `Practice round: ${prompt}`;
      }

      const formatted = formatPrompt(prompt, episode.policy, episode.probes);
      const useQuick = episode.probes.interaction === "quick" || episode.policy.quickReplies;

      ui.sendAssistant(formatted, {
        pacing: episode.probes.pacing === "typing-delay" ? episode.policy.pacingDelay : 0,
        chips: useQuick ? chips : [],
        probes: episode.probes,
      });

      state.convo.step = "awaiting";
    }
  };

  const evaluate = (text) => {
    const episode = state.convo.episode;
    if (!episode) return { success: false };
    const normalized = Utils.normalizeText(text);

    if (episode.type === "twoChoice") {
      const responseKey = normalized.includes("step") ? "step-by-step plan" : "quick brainstorm";
      const reply = Episodes.twoChoice.intro.responses[responseKey];
      episode.success = true;
      episode.completed = true;
      return { success: true, reply, wrap: true };
    }

    if (episode.type === "logic") {
      const puzzle = episode.payload;
      const success = puzzle.answers.some((regex) => regex.test(text));
      if (success) {
        episode.success = true;
        return { success: true, reply: "Nice reasoning. You got it." };
      }
      return { success: false, reply: episode.policy.followUp === "hint" ? puzzle.hint : "Want to try again or see a hint?" };
    }

    if (episode.type === "study") {
      const card = episode.payload;
      const normalizedDefinition = Utils.normalizeText(card.definition);
      const success = normalizedDefinition.split(" ").every((word) => normalized.includes(word));
      if (success || normalized.includes("reduce") && card.term === "abate") {
        episode.success = true;
        return { success: true, reply: `Correct — "${card.term}" means ${card.definition}.` };
      }
      return { success: false, reply: `Close. "${card.term}" means ${card.definition}. Want another card?` };
    }

    if (episode.type === "planning") {
      const hasTime = /today|tomorrow|week|month|by\s+\w+/i.test(text);
      const steps = [
        "Clarify the goal in one sentence.",
        "List 2-3 key milestones.",
        "Pick the smallest next action you can do in 10 minutes.",
      ];
      episode.success = true;
      return {
        success: true,
        reply: `${hasTime ? "Nice timeframe." : ""} Here’s a simple plan:\n- ${steps.join("\n- ")}`,
      };
    }

    if (episode.type === "debugging") {
      const checks = [
        "Reproduce the bug in one consistent case.",
        "Check recent changes or configuration toggles.",
        "Look at logs or console output for the first error.",
        "Try a minimal version to isolate the issue.",
      ];
      episode.success = true;
      return { success: true, reply: `Here’s a quick checklist:\n- ${checks.join("\n- ")}` };
    }

    if (episode.type === "creativity") {
      const themes = text.split(/,|\n/).map((item) => item.trim()).filter(Boolean);
      const base = themes.length ? themes[0] : "ideas";
      const constraints = ["under 5 minutes", "using only what you have", "low-cost", "for two people"];
      const verbs = ["design", "sketch", "try", "build", "prototype"];
      const ideas = Array.from({ length: 4 }).map((_, index) => {
        const verb = verbs[index % verbs.length];
        const constraint = constraints[index % constraints.length];
        return `${verb} ${base} ${constraint}`;
      });
      episode.success = true;
      return { success: true, reply: `Here are constraint ideas:\n- ${ideas.join("\n- ")}` };
    }

    return { success: false, reply: "Thanks!" };
  };

  const finalizeEpisode = (episode, outcome) => {
    episode.completed = true;
    episode.endTime = Utils.now();
    const featureAgg = episode.features.reduce(
      (acc, f) => {
        acc.count += 1;
        acc.draftDuration += f.draftDuration;
        acc.editRatio += f.editRatio;
        acc.rage += f.rageSignal ? 1 : 0;
        acc.quickReplies += f.quickReplyUsed ? 1 : 0;
        return acc;
      },
      { count: 0, draftDuration: 0, editRatio: 0, rage: 0, quickReplies: 0 }
    );

    const frictionScore = featureAgg.count
      ? Utils.clamp(featureAgg.editRatio / featureAgg.count + featureAgg.rage * 0.2, 0, 1)
      : 0;

    const reward = Utils.clamp(
      (outcome.success ? 0.6 : 0.2) + (outcome.completed ? 0.2 : 0) - frictionScore * 0.3,
      0,
      1
    );

    const historyEntry = {
      id: episode.id,
      type: episode.type,
      startTime: episode.startTime,
      endTime: episode.endTime,
      probes: episode.probes,
      outcome: {
        success: outcome.success,
        completed: outcome.completed,
        frictionScore,
        reward,
      },
    };

    state.history.push(historyEntry);
    if (state.history.length > MAX_HISTORY) state.history.shift();

    ProbeEngine.update(state, episode.probes, state.traits, reward);

    state.convo.episode = null;
    state.convo.step = "idle";

    return historyEntry;
  };

  const handleUser = (text, features) => {
    const episode = state.convo.episode;
    if (!episode) {
      const normalized = Utils.normalizeText(text);
      if (normalized.includes("pause")) {
        ui.sendAssistant("Paused. When you want to continue, just say \"Continue\".", { pacing: 200 });
        return;
      }
      if (normalized.includes("continue")) {
        startNextEpisode("auto");
        return;
      }
      if (normalized.includes("study")) return startNextEpisode("study");
      if (normalized.includes("plan")) return startNextEpisode("planning");
      if (normalized.includes("debug")) return startNextEpisode("debugging");
      if (normalized.includes("creative") || normalized.includes("idea")) return startNextEpisode("creativity");
      if (normalized.includes("logic") || normalized.includes("puzzle")) return startNextEpisode("logic");
      if (normalized.includes("challenge")) return startNextEpisode("logic");
      return startNextEpisode("auto");
    }
    episode.features.push(features);
    if (features.quickReplyUsed) episode.quickRepliesUsed += 1;

    episode.attempts += 1;
    const outcome = evaluate(text);
    ui.sendAssistant(outcome.reply, { pacing: episode.policy.pacingDelay, probes: episode.probes });

    if (episode.type === "logic" && !outcome.success && episode.attempts < 2) {
      state.convo.step = "awaiting";
      return;
    }

    const final = finalizeEpisode(episode, {
      success: outcome.success,
      completed: true,
    });

    const outro = Utils.pickRandom(ConversationTemplates.outro);
    ui.sendAssistant(outro, { pacing: 300, chips: ["Another challenge", "Switch topic", "Pause"], probes: episode.probes });

    state.lastOutcome = final.outcome;
    Storage.saveState(state);
  };

  const startNextEpisode = (intent) => {
    let type = intent;
    if (!type || type === "auto") {
      const lastOutcome = state.lastOutcome;
      const traits = state.traits;
      if (lastOutcome && !lastOutcome.success) {
        type = traits.frustrationSensitivity.mean > 0.6 ? "planning" : "logic";
      } else if (traits.explorationPreference.mean > 0.6) {
        type = "creativity";
      } else if (traits.structurePreference.mean > 0.6) {
        type = "planning";
      } else {
        const options = ["twoChoice", "logic", "study", "planning", "debugging", "creativity"];
        type = Utils.pickRandom(options);
      }
    }

    startEpisode(type, state.lastOutcome);
  };

  return {
    startNextEpisode,
    handleUser,
  };
};

const UI = (state, bus) => {
  const chatWindow = document.getElementById("chatWindow");
  const typingIndicator = document.getElementById("typingIndicator");
  const quickReplies = document.getElementById("quickReplies");
  const input = document.getElementById("messageInput");
  const sendBtn = document.getElementById("sendBtn");

  const renderMessage = (role, text, timestamp) => {
    const row = document.createElement("div");
    row.className = `message-row ${role}`;
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.textContent = text;
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = Utils.formatTime(timestamp);
    row.appendChild(bubble);
    row.appendChild(meta);
    chatWindow.appendChild(row);
    chatWindow.scrollTop = chatWindow.scrollHeight;
  };

  const showTyping = (show) => {
    typingIndicator.classList.toggle("visible", show);
    typingIndicator.setAttribute("aria-hidden", show ? "false" : "true");
  };

  const setQuickReplies = (chips) => {
    quickReplies.innerHTML = "";
    if (!chips || chips.length === 0) {
      quickReplies.classList.add("hidden");
      return;
    }
    quickReplies.classList.remove("hidden");
    chips.forEach((chip) => {
      const btn = document.createElement("button");
      btn.className = "chip";
      btn.textContent = chip;
      btn.addEventListener("click", () => {
        bus.emit("quick_reply_selected", chip);
      });
      quickReplies.appendChild(btn);
    });
  };

  const sendAssistant = (text, options = {}) => {
    const timestamp = Utils.now();
    const pacing = options.pacing ?? 0;
    setQuickReplies([]);
    if (pacing > 0) {
      showTyping(true);
    }
    setTimeout(() => {
      showTyping(false);
      renderMessage("assistant", text, timestamp);
      state.convo.messages.push({ role: "assistant", text, timestamp });
      bus.emit("assistant_sent", { text, timestamp, probes: options.probes });
      if (options.chips && options.chips.length) {
        setQuickReplies(options.chips);
      }
      Storage.saveState(state);
    }, pacing);
  };

  const sendUser = (text) => {
    const timestamp = Utils.now();
    renderMessage("user", text, timestamp);
    state.convo.messages.push({ role: "user", text, timestamp });
    Storage.saveState(state);
  };

  const renderHistory = () => {
    chatWindow.innerHTML = "";
    state.convo.messages.forEach((msg) => renderMessage(msg.role, msg.text, msg.timestamp));
  };

  return {
    sendAssistant,
    sendUser,
    setQuickReplies,
    renderHistory,
    input,
    sendBtn,
  };
};

const initApp = () => {
  const state = Storage.getState();
  const ui = UI(state, EVENT_BUS);
  const signals = PassiveSignalCollector(EVENT_BUS);
  const conversation = ConversationEngine(state, ui, EVENT_BUS);

  const privacyModal = document.getElementById("privacyModal");
  const privacyBtn = document.getElementById("privacyBtn");
  const closePrivacy = document.getElementById("closePrivacy");
  const adaptiveToggle = document.getElementById("adaptiveToggle");
  const minimizeToggle = document.getElementById("minimizeToggle");
  const retentionSelect = document.getElementById("retentionSelect");
  const exportBtn = document.getElementById("exportBtn");
  const resetBtn = document.getElementById("resetBtn");
  const newSessionBtn = document.getElementById("newSessionBtn");

  ui.renderHistory();

  adaptiveToggle.checked = state.settings.adaptiveMode;
  minimizeToggle.checked = state.settings.reduceData;
  retentionSelect.value = String(state.settings.dataRetentionDays);

  privacyBtn.addEventListener("click", () => privacyModal.showModal());
  closePrivacy.addEventListener("click", () => privacyModal.close());

  adaptiveToggle.addEventListener("change", () => {
    state.settings.adaptiveMode = adaptiveToggle.checked;
    Storage.saveState(state);
  });

  minimizeToggle.addEventListener("change", () => {
    state.settings.reduceData = minimizeToggle.checked;
    Storage.saveState(state);
  });

  retentionSelect.addEventListener("change", () => {
    state.settings.dataRetentionDays = Number(retentionSelect.value);
    Storage.saveState(state);
  });

  exportBtn.addEventListener("click", () => Storage.export(state));
  resetBtn.addEventListener("click", () => {
    const fresh = Storage.reset();
    Object.assign(state, fresh);
    ui.renderHistory();
    Storage.saveState(state);
    conversation.startNextEpisode("auto");
  });

  newSessionBtn.addEventListener("click", () => {
    state.convo.messages = [];
    state.convo.episode = null;
    state.convo.step = "idle";
    ui.renderHistory();
    Storage.saveState(state);
    conversation.startNextEpisode("auto");
  });

  EVENT_BUS.on("assistant_sent", () => {
    signals.markAssistantMessage();
  });

  EVENT_BUS.on("user_message_features", (features) => {
    TraitModel.applyUserFeatures(state, features);
    Storage.saveState(state);
  });

  EVENT_BUS.on("assistant_message_viewed", (features) => {
    TraitModel.applyAssistantView(state, features);
    Storage.saveState(state);
  });

  EVENT_BUS.on("quick_reply_selected", (text) => {
    ui.input.value = "";
    const features = signals.captureSend(text, true);
    ui.sendUser(text);
    state.convo.lastInteraction = Utils.now();
    conversation.handleUser(text, features);
  });

  EVENT_BUS.on("session_end", () => {
    Storage.saveState(state);
  });

  EVENT_BUS.on("session_resume", ({ downtime }) => {
    if (downtime > 60000 && !state.convo.episode) {
      ui.sendAssistant(ConversationTemplates.pauseOffer, { pacing: 200, chips: ["Continue", "Pause"] });
    }
  });

  const handleSend = () => {
    const text = ui.input.value.trim();
    if (!text) return;
    ui.input.value = "";
    const features = signals.captureSend(text, false);
    ui.sendUser(text);
    state.convo.lastInteraction = Utils.now();
    conversation.handleUser(text, features);
  };

  ui.sendBtn.addEventListener("click", handleSend);
  ui.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  });

  if (!state.convo.messages.length) {
    conversation.startNextEpisode("auto");
  }
};

document.addEventListener("DOMContentLoaded", initApp);
