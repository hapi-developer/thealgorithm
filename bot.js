const BotEngine = (() => {
  const cache = new Map();
  let config = {
    minN: 8,
    maxN: 20,
    defaultN: 12,
    thinkTimeRange: [250, 900],
  };

  function initBot(nextConfig = {}) {
    config = { ...config, ...nextConfig };
    return config;
  }

  function buildGrundy(N) {
    if (cache.has(N)) return cache.get(N);

    const grundy = Array.from({ length: N + 1 }, () => new Array(N + 1).fill(0));
    let maxGrundy = 0;
    const seen = new Array(N * 3 + 5).fill(false);

    for (let x = 0; x <= N; x += 1) {
      for (let y = 0; y <= N; y += 1) {
        if (x === 0 && y === 0) {
          grundy[x][y] = 0;
          continue;
        }
        seen.fill(false);

        for (let k = 1; k <= x; k += 1) {
          seen[grundy[x - k][y]] = true;
        }
        for (let k = 1; k <= y; k += 1) {
          seen[grundy[x][y - k]] = true;
        }
        const diag = Math.min(x, y);
        for (let k = 1; k <= diag; k += 1) {
          seen[grundy[x - k][y - k]] = true;
        }

        let mex = 0;
        while (seen[mex]) mex += 1;
        grundy[x][y] = mex;
        if (mex > maxGrundy) maxGrundy = mex;
      }
    }

    const result = { grundy, maxGrundy };
    cache.set(N, result);
    return result;
  }

  function listLegalMoves(x, y) {
    const moves = [];
    for (let k = 1; k <= x; k += 1) moves.push({ toX: x - k, toY: y });
    for (let k = 1; k <= y; k += 1) moves.push({ toX: x, toY: y - k });
    const diag = Math.min(x, y);
    for (let k = 1; k <= diag; k += 1) moves.push({ toX: x - k, toY: y - k });
    return moves;
  }

  function countReplies(state, pos) {
    const moves = listLegalMoves(pos.toX, pos.toY);
    return moves.length;
  }

  function chooseStartState(directorState) {
    const skill = directorState.skill ?? 0.5;
    let minN = config.minN;
    let maxN = config.maxN;

    if (skill < 0.35) {
      minN = 8;
      maxN = 10;
    } else if (skill < 0.7) {
      minN = 11;
      maxN = 15;
    } else {
      minN = 16;
      maxN = 20;
    }

    const N = randomInt(minN, maxN);
    const grundyData = buildGrundy(N);

    const minCoord = skill < 0.35 ? 2 : skill < 0.7 ? 4 : 6;
    const maxCoord = Math.max(minCoord, N - 1);
    let startX = 0;
    let startY = 0;
    let attempts = 0;

    while ((startX === 0 && startY === 0) || grundyData.grundy[startX][startY] === 0) {
      startX = randomInt(minCoord, maxCoord);
      startY = randomInt(minCoord, maxCoord);
      attempts += 1;
      if (attempts > 100) {
        startX = randomInt(1, N);
        startY = randomInt(1, N);
      }
    }

    return {
      N,
      startX,
      startY,
      botGoesFirst: true,
      grundyData,
    };
  }

  function getBotMove(state) {
    const { x, y, grundy, playerModel } = state;
    if (x === 0 && y === 0) return null;

    const current = grundy[x][y];
    const legal = listLegalMoves(x, y);
    const coldMoves = legal.filter((move) => grundy[move.toX][move.toY] === 0);

    if (current === 0 || coldMoves.length === 0) {
      return {
        ...legal[0],
        meta: { reasoning: "warning_no_cold" },
      };
    }

    const skill = playerModel?.skill ?? 0.5;
    const style = skill < 0.5 ? "teaching" : "competitive";

    let chosen = coldMoves[0];
    if (style === "teaching") {
      chosen = coldMoves.reduce((best, move) => {
        const score = countReplies(state, move);
        const bestScore = countReplies(state, best);
        return score < bestScore ? move : best;
      }, coldMoves[0]);
    } else {
      chosen = coldMoves.reduce((best, move) => {
        const score = countReplies(state, move);
        const bestScore = countReplies(state, best);
        return score > bestScore ? move : best;
      }, coldMoves[0]);
    }

    return {
      ...chosen,
      meta: { reasoning: "cold_target", style },
    };
  }

  function updatePlayerModel(playerModel, turnData) {
    const next = { ...playerModel };
    const alpha = 0.25;
    const { toX, toY, grundyData, decisionTime, misclicks } = turnData;
    const g = grundyData.grundy[toX][toY];
    const badness = g === 0 ? 0 : Math.min(1, g / Math.max(1, grundyData.maxGrundy));

    next.avgBadness = lerp(next.avgBadness ?? badness, badness, alpha);
    next.avgSpeed = lerp(next.avgSpeed ?? decisionTime, decisionTime, alpha);
    next.misclicks = (next.misclicks ?? 0) + misclicks;

    const speedScore = 1 - Math.min(1, (next.avgSpeed ?? 900) / 1200);
    const consistency = 1 - Math.min(1, next.misclicks / Math.max(1, (next.turns ?? 1) * 3));

    next.skill =
      0.55 * (1 - next.avgBadness) +
      0.25 * speedScore +
      0.2 * consistency;

    next.turns = (next.turns ?? 0) + 1;
    return next;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  return {
    initBot,
    buildGrundy,
    getBotMove,
    chooseStartState,
    updatePlayerModel,
  };
})();

window.BotEngine = BotEngine;
