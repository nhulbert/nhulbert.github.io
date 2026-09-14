/**
 * Board generation for the Thrill Digger minigame.
 *
 * A direct port of fillHoles()/placeBombs()/placeRupoors()/fillRupees() from
 * The Legend of Zelda: Skyward Sword (SOUE01) decompilation:
 * src/REL/d/a/obj/d_a_obj_hole_minigame.cpp
 */

export const CONTENT = Object.freeze({
  NONE: 0,
  GREEN: 1,
  BLUE: 2,
  RED: 3,
  SILVER: 4,
  GOLD: 5,
  RUPOOR: 6,
  BOMB: 7,
});

export const SCORE = Object.freeze({ 0: 0, 1: 1, 2: 5, 3: 20, 4: 100, 5: 300, 6: -10, 7: 0 });

export const VARIANTS = Object.freeze({
  easy:   { key: 'easy',   rows: 4, cols: 5, bombs: 4, rupoors: 0, target: 60,  fee: 30, label: 'Easy'   },
  normal: { key: 'normal', rows: 5, cols: 6, bombs: 4, rupoors: 4, target: 100, fee: 50, label: 'Normal' },
  hard:   { key: 'hard',   rows: 5, cols: 8, bombs: 8, rupoors: 8, target: 140, fee: 70, label: 'Hard'   },
});

export const HOLE_SPACING = 300.0;
export const FIRST_BOMB_REROLL_CHANCE = 0.444;
export const MAX_REROLLS = 10;

export class Board {
  constructor(variant, rng = Math.random) {
    this.variant = variant;
    this.rng = rng;
    this.rows = variant.rows;
    this.cols = variant.cols;
    this.numHoles = this.rows * this.cols;
    this.cells = new Array(this.numHoles);
    this.rolls = 0;
    this.fillHoles(0);
  }

  isBombOrRupoor(i) {
    if (i < 0 || i >= this.numHoles) return false;
    const c = this.cells[i].content;
    return c === CONTENT.RUPOOR || c === CONTENT.BOMB;
  }

  placeBombs() {
    const n = this.numHoles;
    let placed = 0;
    while (placed < this.variant.bombs) {
      let index = Math.floor(n * this.rng());
      if (index === n) index = 0;
      if (this.cells[index].content === CONTENT.NONE) {
        this.cells[index].content = CONTENT.BOMB;
        placed++;
      }
    }
  }

  placeRupoors() {
    const n = this.numHoles;
    let placed = 0;
    while (placed < this.variant.rupoors) {
      let index = Math.floor(n * this.rng());
      if (index === n) index = 0;
      if (this.cells[index].content === CONTENT.NONE) {
        this.cells[index].content = CONTENT.RUPOOR;
        placed++;
      }
    }
  }

  fillRupees() {
    const { cols } = this;
    for (let i = 0; i < this.numHoles; i++) {
      if (this.isBombOrRupoor(i)) continue;
      let count = 0;
      const col = i % cols;

      if (col !== 0) {
        if (this.isBombOrRupoor(i - cols - 1)) count++;
        if (this.isBombOrRupoor(i - 1)) count++;
        if (this.isBombOrRupoor(i + cols - 1)) count++;
      }
      if (col !== cols - 1) {
        if (this.isBombOrRupoor(i - cols + 1)) count++;
        if (this.isBombOrRupoor(i + 1)) count++;
        if (this.isBombOrRupoor(i + cols + 1)) count++;
      }
      if (this.isBombOrRupoor(i - cols)) count++;
      if (this.isBombOrRupoor(i + cols)) count++;

      let content;
      if (count === 0) content = CONTENT.GREEN;
      else if (count <= 2) content = CONTENT.BLUE;
      else if (count <= 4) content = CONTENT.RED;
      else if (count <= 6) content = CONTENT.SILVER;
      else if (count <= 8) content = CONTENT.GOLD;
      else content = CONTENT.NONE;
      this.cells[i].content = content;
    }
  }

  /** Zeroes contents (keeping dug flags), places hazards and values. */
  fillHoles(depth = 0) {
    if (!this.cells[0] || this.cells[0].content === undefined) {
      for (let i = 0; i < this.numHoles; i++) this.cells[i] = { content: CONTENT.NONE, dug: false };
    } else {
      for (let i = 0; i < this.numHoles; i++) this.cells[i].content = CONTENT.NONE;
    }

    this.placeBombs();
    this.placeRupoors();

    let hasHazardBlock = false;
    for (let row = 0; row < this.rows - 1; row++) {
      for (let col = 0; col < this.cols - 1; col++) {
        const index = row * this.cols + col;
        if (
          this.isBombOrRupoor(index) &&
          this.isBombOrRupoor(index + 1) &&
          this.isBombOrRupoor(index + this.cols) &&
          this.isBombOrRupoor(index + this.cols + 1)
        ) {
          hasHazardBlock = true;
        }
      }
    }

    if (hasHazardBlock && depth < MAX_REROLLS) {
      this.rolls++;
      this.fillHoles(depth + 1);
    } else {
      this.fillRupees();
    }
  }

  get safeHoles() {
    return this.numHoles - this.variant.bombs - this.variant.rupoors;
  }
}

/**
 * Build a board from an explicit hidden state instead of generating one.
 * `contents` and `dug` are row-major, length rows*cols.
 */
export function boardFromState(variant, contents, dug) {
  const b = Object.create(Board.prototype);
  b.variant = variant;
  b.rng = Math.random;
  b.rows = variant.rows;
  b.cols = variant.cols;
  b.numHoles = b.rows * b.cols;
  b.rolls = 0;
  b.cells = new Array(b.numHoles);
  for (let i = 0; i < b.numHoles; i++) {
    b.cells[i] = { content: contents[i], dug: !!dug[i] };
  }
  return b;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}