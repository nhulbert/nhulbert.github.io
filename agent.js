/**
 * agent.js — Pure Greedy planner for the Thrill Digger browser game.
 *
 * Computes the exact posterior over hidden boards and the Pure Greedy action:
 *   - a hazard-layout transfer DP with the game's no-2x2-hazard-block
 *     rejection rule, and
 *   - the bomb/rupoor split that turns hazard layouts into the exact number of
 *     labelled boards in which a cell holds each content type.
 *
 * The game (board.js) uses a row-major grid with its own CONTENT codes; the
 * counter works column-major with the codes below. The public helpers in this
 * module translate between the two and expose, for every cell:
 *
 *   counts[7]  — how many complete, valid boards consistent with the observed
 *                cells put each content type there,
 *   total      — the sum of `counts` (boards consistent with the observation),
 *   ev         — the Pure Greedy expected immediate value of digging it.
 */

import { CONTENT } from './board.js';

/* ------------------------------------------------------------------ *
 *  Content / observation vocabularies
 * ------------------------------------------------------------------ */

/** Exact hidden content (matches `DistCellTypes` in the Rust counter). */
export const AGENT = Object.freeze({
  RUPOOR: 0,
  BOMB: 1,
  GREEN: 2,
  BLUE: 3,
  RED: 4,
  SILVER: 5,
  GOLD: 6,
});

export const N_CONTENT = 7;

/** What the player can see (matches `ObservedCellTypes` in the counter). */
export const OBS = Object.freeze({
  EMPTY: 0,   // dug, known safe, rupee tier unknown (also the DP border)
  UNDUG: 1,   // not dug: unconstrained
  RUPOOR: 2,  // dug up a rupoor
  BOMB: 3,    // dug up a bomb (ends a real round)
  GREEN: 4,   // hint: 0 adjacent hazards
  BLUE: 5,    // hint: 1-2
  RED: 6,     // hint: 3-4
  SILVER: 7,  // hint: 5-6
  GOLD: 8,    // hint: 7-8
});

/** Board-game content -> exact hidden content. */
export const GAME_TO_AGENT = Object.freeze([
  -1,                // NONE (unreachable on a valid board)
  AGENT.GREEN,
  AGENT.BLUE,
  AGENT.RED,
  AGENT.SILVER,
  AGENT.GOLD,
  AGENT.RUPOOR,
  AGENT.BOMB,
]);

/** Exact hidden content -> board-game content. */
export const AGENT_TO_GAME = Object.freeze([
  CONTENT.RUPOOR,
  CONTENT.BOMB,
  CONTENT.GREEN,
  CONTENT.BLUE,
  CONTENT.RED,
  CONTENT.SILVER,
  CONTENT.GOLD,
]);

/** Exact hidden content -> observed content. */
export const AGENT_TO_OBS = Object.freeze([
  OBS.RUPOOR,
  OBS.BOMB,
  OBS.GREEN,
  OBS.BLUE,
  OBS.RED,
  OBS.SILVER,
  OBS.GOLD,
]);

/** Board-game content -> observed content. */
export function observedFromGameContent(c) {
  switch (c) {
    case CONTENT.RUPOOR: return OBS.RUPOOR;
    case CONTENT.BOMB: return OBS.BOMB;
    case CONTENT.GREEN: return OBS.GREEN;
    case CONTENT.BLUE: return OBS.BLUE;
    case CONTENT.RED: return OBS.RED;
    case CONTENT.SILVER: return OBS.SILVER;
    case CONTENT.GOLD: return OBS.GOLD;
    case CONTENT.NONE: return OBS.EMPTY;
    default: return OBS.UNDUG;
  }
}

/** Value of a dug cell, by exact hidden content. Bombs score nothing. */
export const AGENT_VALUE = Object.freeze([-10, 0, 1, 5, 20, 100, 300]);

/** Rupee tier for an adjacency count 0..8 (green,blue,blue,red,red,...). */
const TIER_FOR_COUNT = Object.freeze([
  AGENT.GREEN, AGENT.BLUE, AGENT.BLUE, AGENT.RED, AGENT.RED,
  AGENT.SILVER, AGENT.SILVER, AGENT.GOLD, AGENT.GOLD,
]);

/* ------------------------------------------------------------------ *
 *  Bit / grid helpers (column-major, mirroring the Rust counter)
 * ------------------------------------------------------------------ */

const popcount = (mask) => {
  let n = 0;
  for (; mask; mask >>= 1) n += mask & 1;
  return n;
};
const bitAt = (mask, row) => (mask >> row) & 1;
const pairIndex = (left, mid, s) => left * s + mid;

function cellCompatible(observed, isBad) {
  if (observed === OBS.UNDUG) return true;
  if (observed === OBS.RUPOOR || observed === OBS.BOMB) return isBad;
  return !isBad;
}

function columnCompatible(mask, col, observed, height) {
  for (let r = 0; r < height; r++) {
    if (!cellCompatible(observed[col * height + r], bitAt(mask, r))) return false;
  }
  return true;
}

function hazardNeighbours(left, mid, right, row, height) {
  let n = 0;
  const masks = [left, mid, right];
  for (let dc = 0; dc < 3; dc++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (dc === 1 && dr === 0) continue;
      const y = row + dr;
      if (y >= 0 && y < height) n += bitAt(masks[dc], y);
    }
  }
  return n;
}

const HINT_LIMITS = Object.freeze({
  [OBS.GREEN]: [0, 0],
  [OBS.BLUE]: [1, 2],
  [OBS.RED]: [3, 4],
  [OBS.SILVER]: [5, 6],
  [OBS.GOLD]: [7, 8],
});

function columnHintsOk(col, left, mid, right, observed, height) {
  for (let r = 0; r < height; r++) {
    const limits = HINT_LIMITS[observed[col * height + r]];
    if (!limits) continue;
    const n = hazardNeighbours(left, mid, right, r, height);
    if (n < limits[0] || n > limits[1]) return false;
  }
  return true;
}

/** Do adjacent column masks hold a 2x2 all-hazard block? */
export function hasBad2x2(a, b) {
  return ((a & (a >> 1)) & (b & (b >> 1))) !== 0;
}

function transferAllowed(col, left, mid, right, observed, height) {
  if (!columnHintsOk(col, left, mid, right, observed, height)) return false;
  if (hasBad2x2(left, mid)) return false;
  if (hasBad2x2(mid, right)) return false;
  return true;
}

export const hasHazard2x2Game = (contents, rows, cols) => {
  const isHaz = (i) => contents[i] === CONTENT.BOMB || contents[i] === CONTENT.RUPOOR;
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const i = row * cols + col;
      if (isHaz(i) && isHaz(i + 1) && isHaz(i + cols) && isHaz(i + cols + 1)) return true;
    }
  }
  return false;
};

/** Adjacency count -> board-game rupee content, for an arbitrary game grid. */
export function gameTierForCount(count) {
  return AGENT_TO_GAME[TIER_FOR_COUNT[count]];
}

/* ------------------------------------------------------------------ *
 *  Transfer DP
 * ------------------------------------------------------------------ */

function makeTable(numBads, s) {
  const table = new Array(numBads + 1);
  for (let b = 0; b <= numBads; b++) table[b] = new Float64Array(s * s);
  return table;
}

function buildForward(observed, height, numBads) {
  const s = 1 << height;
  const cols = observed.length / height;
  const tables = new Array(cols);

  let f = makeTable(numBads, s);
  for (let mid = 0; mid < s; mid++) {
    if (!columnCompatible(mid, 0, observed, height)) continue;
    const b = popcount(mid);
    if (b <= numBads) f[b][pairIndex(0, mid, s)] += 1;
  }
  tables[0] = f;

  for (let k = 1; k < cols; k++) {
    const next = makeTable(numBads, s);
    for (let b = 0; b <= numBads; b++) {
      const src = f[b];
      for (let p = 0; p < s * s; p++) {
        const ways = src[p];
        if (ways === 0) continue;
        const left = (p / s) | 0;
        const mid = p % s;
        for (let right = 0; right < s; right++) {
          if (!columnCompatible(right, k, observed, height)) continue;
          if (!transferAllowed(k - 1, left, mid, right, observed, height)) continue;
          const nb = b + popcount(right);
          if (nb <= numBads) next[nb][pairIndex(mid, right, s)] += ways;
        }
      }
    }
    tables[k] = next;
    f = next;
  }
  return tables;
}

function buildBackward(observed, height, numBads) {
  const s = 1 << height;
  const cols = observed.length / height;
  const tables = new Array(cols);

  let g = makeTable(numBads, s);
  for (let left = 0; left < s; left++) {
    for (let mid = 0; mid < s; mid++) {
      if (!columnCompatible(mid, cols - 1, observed, height)) continue;
      if (!transferAllowed(cols - 1, left, mid, 0, observed, height)) continue;
      const b = popcount(mid);
      if (b <= numBads) g[b][pairIndex(left, mid, s)] += 1;
    }
  }
  tables[cols - 1] = g;

  for (let k = cols - 2; k >= 0; k--) {
    const prev = makeTable(numBads, s);
    for (let left = 0; left < s; left++) {
      for (let mid = 0; mid < s; mid++) {
        if (!columnCompatible(mid, k, observed, height)) continue;
        const midBads = popcount(mid);
        for (let right = 0; right < s; right++) {
          if (!columnCompatible(right, k + 1, observed, height)) continue;
          if (!transferAllowed(k, left, mid, right, observed, height)) continue;
          for (let b = 0; b + midBads <= numBads; b++) {
            const ways = g[b][pairIndex(mid, right, s)];
            if (ways === 0) continue;
            prev[b + midBads][pairIndex(left, mid, s)] += ways;
          }
        }
      }
    }
    tables[k] = prev;
    g = prev;
  }
  return tables;
}

/**
 * For every core column, count the hazard layouts in which each row is a hazard
 * and, if safe, which rupee tier it takes.
 */
function computeMarginals(observed, height, numBads, forward, backward) {
  const s = 1 << height;
  const cols = observed.length / height;
  const result = [];

  for (let k = 1; k <= cols - 2; k++) {
    const columns = Array.from({ length: height }, () => new Float64Array(6));
    for (let left = 0; left < s; left++) {
      for (let mid = 0; mid < s; mid++) {
        for (let right = 0; right < s; right++) {
          if (!transferAllowed(k, left, mid, right, observed, height)) continue;

          let ways = 0;
          for (let bFront = 0; bFront <= numBads; bFront++) {
            const front = forward[k][bFront][pairIndex(left, mid, s)];
            if (front === 0) continue;
            const back = backward[k + 1][numBads - bFront][pairIndex(mid, right, s)];
            if (back === 0) continue;
            ways += front * back;
          }
          if (ways === 0) continue;

          for (let r = 0; r < height; r++) {
            if (bitAt(mid, r)) {
              columns[r][0] += ways; // BAD
            } else {
              const tier = TIER_FOR_COUNT[hazardNeighbours(left, mid, right, r, height)] - 1;
              columns[r][tier] += ways;
            }
          }
        }
      }
    }
    result.push({ height, numBads, columns });
  }
  return result;
}

/* ------------------------------------------------------------------ *
 *  Combinations
 * ------------------------------------------------------------------ */

function choose(a, b) {
  if (a < 0 || b < 0 || b > a) return 0;
  b = Math.min(b, a - b);
  if (b === 0) return 1;
  let r = 1;
  for (let i = 1; i <= b; i++) r = (r * (a - b + i)) / i;
  return r;
}

/* ------------------------------------------------------------------ *
 *  Posterior
 * ------------------------------------------------------------------ */

/**
 * Build the exact posterior over hidden boards.
 *
 * @param {number[]} observedRowMajor  length rows*cols, ObservedCellTypes
 * @param {number} rows
 * @param {number} cols
 * @param {number} numBads      total bombs + rupoors
 * @param {number} totalRupoors total rupoors on the board
 */
export function buildPosterior(observedRowMajor, rows, cols, numBads, totalRupoors) {
  const height = rows;
  const n = rows * cols;

  // The counter is column-major: core[i] with i = col*height + row.
  const core = new Array(n);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      core[col * height + row] = observedRowMajor[row * cols + col];
    }
  }

  const border = new Array(height).fill(OBS.EMPTY);
  const bordered = border.concat(core).concat(border);

  const forward = buildForward(bordered, height, numBads);
  const backward = buildBackward(bordered, height, numBads);
  const simple = computeMarginals(bordered, height, numBads, forward, backward);

  let observedRupoors = 0;
  let observedHazards = 0;
  for (const o of core) {
    if (o === OBS.RUPOOR) observedRupoors++;
    if (o === OBS.RUPOOR || o === OBS.BOMB) observedHazards++;
  }

  // Remaining unobserved hazards, and how many of them are rupoors.
  const H = numBads - observedHazards;
  const R = totalRupoors - observedRupoors;
  const rupoorMult = choose(H - 1, R - 1);
  const bombMult = choose(H - 1, R);
  const safeMult = rupoorMult + bombMult;

  const cells = new Array(n);
  let layoutTotal = 0;
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < height; row++) {
      const rowCounts = simple[col].columns[row];
      const bad = rowCounts[0];
      let safe = 0;
      for (let t = 1; t < 6; t++) safe += rowCounts[t];
      layoutTotal = bad + safe;

      const counts = new Float64Array(N_CONTENT);
      counts[AGENT.RUPOOR] = rupoorMult * bad;
      counts[AGENT.BOMB] = bombMult * bad;
      for (let t = 1; t < 6; t++) counts[t + 1] = safeMult * rowCounts[t];

      let total = 0;
      for (let c = 0; c < N_CONTENT; c++) total += counts[c];

      cells[row * cols + col] = { counts, total, bad, safe };
    }
  }

  const totalBoards = cells.length ? cells[0].total : 0;

  // Observed hazards are certainly that hazard; the bomb/rupoor split above
  // treats a cell as an anonymous hazard, so pin these to a single content.
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const o = observedRowMajor[row * cols + col];
      let fixed = -1;
      if (o === OBS.RUPOOR) fixed = AGENT.RUPOOR;
      else if (o === OBS.BOMB) fixed = AGENT.BOMB;
      if (fixed >= 0) {
        const counts = new Float64Array(N_CONTENT);
        counts[fixed] = totalBoards;
        cells[row * cols + col].counts = counts;
      }
    }
  }

  return {
    rows,
    cols,
    height,
    numBads,
    totalRupoors,
    observedRowMajor: observedRowMajor.slice(),
    core,
    bordered,
    backward,
    forward,
    cells,
    layoutTotal,
    totalBoards,
    rupoorMult,
    bombMult,
    safeMult,
  };
}

/** Expected immediate value of digging a cell with the given content counts. */
export function cellExpectedValue(counts, bombPenalty = 0) {
  const num =
    counts[AGENT.RUPOOR] * -10 +
    counts[AGENT.BOMB] * bombPenalty +
    counts[AGENT.GREEN] * 1 +
    counts[AGENT.BLUE] * 5 +
    counts[AGENT.RED] * 20 +
    counts[AGENT.SILVER] * 100 +
    counts[AGENT.GOLD] * 300;
  let den = 0;
  for (let c = 0; c < N_CONTENT; c++) den += counts[c];
  return den > 0 ? num / den : 0;
}

/**
 * Pure Greedy: the cell with the greatest expected immediate value among the
 * legal actions. Returns the value, the EV of every cell, and every tied-best
 * action (so the UI can highlight all of them).
 */
export function pureGreedy(posterior, legalActions, bombPenalty = 0) {
  const n = posterior.rows * posterior.cols;
  const ev = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ev[i] = cellExpectedValue(posterior.cells[i].counts, bombPenalty);
  }

  let bestValue = -Infinity;
  const best = [];
  for (const i of legalActions) {
    const v = ev[i];
    if (v > bestValue + 1e-12) {
      bestValue = v;
      best.length = 0;
      best.push(i);
    } else if (Math.abs(v - bestValue) <= 1e-12) {
      best.push(i);
    }
  }
  if (!best.length) bestValue = 0;
  return { bestValue, best, ev };
}

/* ------------------------------------------------------------------ *
 *  Sampling a full board from the posterior
 * ------------------------------------------------------------------ */

function sampleMasks(posterior, rng) {
  const { bordered, height, numBads, backward } = posterior;
  const s = 1 << height;
  const totalCols = bordered.length / height;
  const masks = new Array(totalCols).fill(0);
  const weights = new Float64Array(s);

  let left = 0;
  let mid = 0;
  let rem = numBads;

  for (let k = 0; k < totalCols - 1; k++) {
    const base = rem - popcount(mid);
    const table = base >= 0 ? backward[k + 1][base] : null;

    let total = 0;
    if (table) {
      for (let right = 0; right < s; right++) {
        weights[right] = 0;
        if (!transferAllowed(k, left, mid, right, bordered, height)) continue;
        const v = table[pairIndex(mid, right, s)];
        if (v > 0) {
          weights[right] = v;
          total += v;
        }
      }
    }

    let right = 0;
    if (total > 0) {
      let x = rng() * total;
      for (; right < s; right++) {
        x -= weights[right];
        if (x <= 0) break;
      }
      if (right >= s) right = s - 1;
    } else {
      for (right = 0; right < s; right++) {
        if (transferAllowed(k, left, mid, right, bordered, height)) break;
      }
      if (right >= s) right = 0;
    }

    masks[k + 1] = right;
    left = mid;
    mid = right;
    rem = base;
  }
  return masks;
}

function labelMasks(masks, core, posterior, rng) {
  const { height, cols, totalRupoors } = posterior;
  const n = height * cols;
  const content = new Array(n).fill(AGENT.GREEN);
  const unobservedHazards = [];
  let observedRupoors = 0;

  for (let c = 0; c < cols; c++) {
    const left = masks[c];
    const mid = masks[c + 1];
    const right = masks[c + 2];
    for (let r = 0; r < height; r++) {
      const i = c * height + r;
      const o = core[i];
      if (o === OBS.RUPOOR) {
        observedRupoors++;
        content[i] = AGENT.RUPOOR;
        continue;
      }
      if (o === OBS.BOMB) {
        content[i] = AGENT.BOMB;
        continue;
      }
      if (o !== OBS.UNDUG) {
        content[i] = TIER_FOR_COUNT[hazardNeighbours(left, mid, right, r, height)];
        continue;
      }
      if (bitAt(mid, r)) {
        unobservedHazards.push(i);
      } else {
        content[i] = TIER_FOR_COUNT[hazardNeighbours(left, mid, right, r, height)];
      }
    }
  }

  const remaining = totalRupoors - observedRupoors;
  if (remaining > 0 && unobservedHazards.length >= remaining) {
    for (let j = 0; j < remaining; j++) {
      const t = j + Math.floor(rng() * (unobservedHazards.length - j));
      const tmp = unobservedHazards[j];
      unobservedHazards[j] = unobservedHazards[t];
      unobservedHazards[t] = tmp;
    }
  }
  for (let j = 0; j < unobservedHazards.length; j++) {
    content[unobservedHazards[j]] = j < remaining ? AGENT.RUPOOR : AGENT.BOMB;
  }
  return content;
}

/**
 * Draw one complete board consistent with the posterior.
 * Returns a row-major array of board-game CONTENT codes.
 */
export function sampleGameBoard(posterior, rng = Math.random) {
  const masks = sampleMasks(posterior, rng);
  const content = labelMasks(masks, posterior.core, posterior, rng);

  const { rows, cols, height } = posterior;
  const out = new Array(rows * cols);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      out[row * cols + col] = AGENT_TO_GAME[content[col * height + row]];
    }
  }
  return out;
}

/** Whether any board is consistent with the observed state. */
export function isObservableValid(posterior) {
  return posterior.totalBoards > 0;
}