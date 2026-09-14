/**
 * Thrill Digger — browser game.
 *
 * Renders the board, handles input, and drives the game loop plus the
 * analysis/agent UI.
 */
import * as THREE from 'three';


import { CONTENT, SCORE, VARIANTS, Board, boardFromState, HOLE_SPACING, FIRST_BOMB_REROLL_CHANCE } from './board.js';
import {
  OBS, buildPosterior, pureGreedy, sampleGameBoard,
  observedFromGameContent, gameTierForCount, hasHazard2x2Game, isObservableValid,
} from './agent.js';

/* ------------------------------------------------------------------ *
 *  Analysis / 2D board presentation
 * ------------------------------------------------------------------ */

const CONTENT_STYLE = Object.freeze({
  [CONTENT.NONE]:   { cls: '',    short: '' },
  [CONTENT.GREEN]:  { cls: 't1',  short: '1' },
  [CONTENT.BLUE]:   { cls: 't2',  short: '5' },
  [CONTENT.RED]:    { cls: 't3',  short: '20' },
  [CONTENT.SILVER]: { cls: 't4',  short: '100' },
  [CONTENT.GOLD]:   { cls: 't5',  short: '300' },
  [CONTENT.RUPOOR]: { cls: 'rup', short: 'R' },
  [CONTENT.BOMB]:   { cls: 'bmb', short: 'B' },
});

const AGENT_NAMES = ['Rupoor', 'Bomb', 'Green', 'Blue', 'Red', 'Silver', 'Gold'];
const AGENT_COLORS = ['#7a4bb5', '#2b2b2b', '#3fa34d', '#2f6fd0', '#c0392b', '#aeb6bd', '#e6b800'];

const OBS_STYLE = Object.freeze({
  [OBS.UNDUG]:  { cls: '',    short: '' },
  [OBS.EMPTY]:  { cls: '',    short: '' },
  [OBS.RUPOOR]: { cls: 'rup', short: 'R' },
  [OBS.BOMB]:   { cls: 'bmb', short: 'B' },
  [OBS.GREEN]:  { cls: 't1',  short: '1' },
  [OBS.BLUE]:   { cls: 't2',  short: '5' },
  [OBS.RED]:    { cls: 't3',  short: '20' },
  [OBS.SILVER]: { cls: 't4',  short: '100' },
  [OBS.GOLD]:   { cls: 't5',  short: '300' },
});

const OBS_TO_GAME = Object.freeze([
  CONTENT.NONE, CONTENT.NONE, CONTENT.RUPOOR, CONTENT.BOMB,
  CONTENT.GREEN, CONTENT.BLUE, CONTENT.RED, CONTENT.SILVER, CONTENT.GOLD,
]);

const HIDDEN_PALETTE = Object.freeze([
  { id: 'bomb',   kind: 'hazard', value: CONTENT.BOMB,   label: 'Bomb',   cls: 'bmb' },
  { id: 'rupoor', kind: 'hazard', value: CONTENT.RUPOOR, label: 'Rupoor', cls: 'rup' },
  { id: 'erase',  kind: 'hazard', value: CONTENT.NONE,   label: 'Erase',  cls: '' },
  { id: 'dug',    kind: 'dug',    value: null,            label: 'Dug',    cls: 'dug' },
]);

const OBS_PALETTE = Object.freeze([
  { id: 'undug',  kind: 'obs', value: OBS.UNDUG,  label: 'Undug',  cls: '' },
  { id: 'green',  kind: 'obs', value: OBS.GREEN,  label: 'Green',  cls: 't1' },
  { id: 'blue',   kind: 'obs', value: OBS.BLUE,   label: 'Blue',   cls: 't2' },
  { id: 'red',    kind: 'obs', value: OBS.RED,    label: 'Red',    cls: 't3' },
  { id: 'silver', kind: 'obs', value: OBS.SILVER, label: 'Silver', cls: 't4' },
  { id: 'gold',   kind: 'obs', value: OBS.GOLD,   label: 'Gold',   cls: 't5' },
  { id: 'rupoor', kind: 'obs', value: OBS.RUPOOR, label: 'Rupoor', cls: 'rup' },
  { id: 'bomb',   kind: 'obs', value: OBS.BOMB,   label: 'Bomb',   cls: 'bmb' },
]);

const PALETTE_COLORS = Object.freeze({
  t1: '#3fa34d', t2: '#2f6fd0', t3: '#c0392b',
  t4: '#aeb6bd', t5: '#e6b800', rup: '#7a4bb5', bmb: '#2b2b2b', dug: '#8a7a5c',
});

function paletteColor(cls) {
  return PALETTE_COLORS[cls] || '#6e6950';
}

/* ------------------------------------------------------------------ *
 *  Timing (frames @ 60 fps)
 * ------------------------------------------------------------------ */
const PLAY_FRAMES = 18000;      // 5 minutes
const WARN_FRAMES = 1800;       // 30 seconds left
const WAIT_FRAMES = 30;         // ~0.5 s
const START_FRAMES = 120;       // ~2 s countdown

/* ------------------------------------------------------------------ *
 *  Asset helpers
 * ------------------------------------------------------------------ */

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.json();
}

function buildGeometry(mesh) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(mesh.uvs, 2));
  if (mesh.colors && mesh.colors.length === (mesh.positions.length / 3) * 4) {
    const c = mesh.colors.map((v) => v / 255);
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 4));
  }
  g.setIndex(mesh.indices);
  g.computeBoundingSphere();
  return g;
}

/* ------------------------------------------------------------------ *
 *  Small WebAudio helper (procedural — no game audio assets)
 * ------------------------------------------------------------------ */

class Sfx {
  constructor() { this.ctx = null; }
  init() {
    if (this.ctx) return;
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* ignore */ }
  }
  tone(freq, dur, type = 'sine', gain = 0.08, slideTo = null, delay = 0) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
  noise(dur, gain = 0.3, delay = 0) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1400, t0);
    lp.frequency.exponentialRampToValueAtTime(180, t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.buffer = buf;
    src.connect(lp).connect(g).connect(this.ctx.destination);
    src.start(t0);
  }
  dig() { this.tone(190, 0.09, 'square', 0.05, 90); }
  rupee(big) { this.tone(big ? 880 : 620, 0.14, 'triangle', 0.06, big ? 1320 : 880); }
  rupoor() { this.tone(320, 0.2, 'sawtooth', 0.05, 120); }
  fuse() { this.tone(1500, 0.55, 'sawtooth', 0.02, 2100); }
  boom() { this.noise(0.55, 0.4); this.tone(95, 0.6, 'sine', 0.3, 38); }
}

/* ------------------------------------------------------------------ *
 *  Scene
 * ------------------------------------------------------------------ */

class ThrillDigger {
  constructor(container) {
    this.container = container;
    this.clock = new THREE.Clock();
    this.acc = 0;
    this.frame = 1 / 60;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x7fb0d8);
    this.scene.fog = new THREE.Fog(0x9cc0dd, 3500, 9000);

    this.camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 1, 20000);
    this.camTarget = new THREE.Vector3(0, 0, 0);
    this.camState = { azimuth: 0, polar: 0.82, radius: 2600 };

    // lighting
    const hemi = new THREE.HemisphereLight(0xf4f8ff, 0xb09060, 1.5);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff4dc, 2.3);
    sun.position.set(1600, 2600, 1200);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 6;
    const sc = sun.shadow.camera;
    sc.left = -2600; sc.right = 2600; sc.top = 2600; sc.bottom = -2600; sc.near = 400; sc.far = 8000;
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    // ground
    const groundGeo = new THREE.PlaneGeometry(20000, 20000);
    groundGeo.rotateX(-Math.PI / 2);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1.0,
      metalness: 0.0,
    });
    this.groundMat = groundMat;
    this.ground = new THREE.Mesh(groundGeo, groundMat);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    // interaction plane + highlight
    this.pickPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(20000, 20000).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    this.scene.add(this.pickPlane);

    const ringGeo = new THREE.RingGeometry(120, 150, 40).rotateX(-Math.PI / 2);
    this.highlight = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })
    );
    this.highlight.position.y = 12;
    this.scene.add(this.highlight);

    this.boardGroup = new THREE.Group();
    this.scene.add(this.boardGroup);

    this.fx = [];
    this.items = [];
    this.moundProto = null;
    this.holeProto = null;
    this.shake = 0;
    this.bombMesh = null;
    this.fuseLight = null;
    this.sfx = new Sfx();

    // state
    this.difficulty = 'normal';
    this.variant = VARIANTS.normal;
    this.phase = 'menu';
    this.selected = { row: 0, col: 0 };
    this.hover = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(-10, -10);
    this.dragging = false;
    this.dragMoved = 0;
    this.lastPointer = { x: 0, y: 0 };
    this.pointerType = 'mouse';
    this.pointers = new Map();
    this.pinching = false;
    this.pinchStartDist = 0;
    this.pinchStartRadius = 0;
    this.camAnchor = { x: 0, y: 0 };

    // responsive / phone layout
    this.mqPhone = window.matchMedia('(max-width: 760px)');
    this.phone = this.mqPhone.matches;
    document.body.classList.toggle('phone', this.phone);

    // modes / analysis
    this.mode = 'play';
    this.show = { hidden: false, agent: false, dist: false };
    this.posterior = null;
    this.agentResult = null;
    this.analysisVariant = VARIANTS.normal;
    this.editor = {
      submode: 'hidden',
      hidden: { hazard: [], dug: [] },
      observed: [],
      tool: null,
    };

    this.bindEvents();
    this.setupUI();
    this.initEditor(this.analysisVariant);
    this.refresh();
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  makeGroundTexture() {
    const s = 256;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#b9a06f';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 9000; i++) {
      const x = Math.random() * s, y = Math.random() * s;
      const v = 170 + Math.random() * 60;
      ctx.fillStyle = `rgba(${v}, ${v * 0.86}, ${v * 0.62}, ${0.12 + Math.random() * 0.18})`;
      ctx.fillRect(x, y, 1 + Math.random() * 1.5, 1 + Math.random() * 1.5);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  applyGroundTexture(tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.repeat.set(6.9, 6.9);
    tex.offset.set(0, 0);
    this.groundMat.map = tex;
    this.groundMat.needsUpdate = true;
  }

  /* ---------------- assets ---------------- */

  async load() {
    const [mound, hole] = await Promise.all([
      fetchJSON('./assets/mound.json'),
      fetchJSON('./assets/hole.json'),
    ]);

    const texBase = './assets/';
    const loadTex = (name) => new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(texBase + name, resolve, undefined, reject);
    });

    // Ground texture, with a procedural fallback.
    try {
      this.applyGroundTexture(await loadTex('ground.png'));
    } catch (err) {
      console.warn('Ground texture unavailable, using procedural fallback', err);
      this.applyGroundTexture(this.makeGroundTexture());
    }

    const all = [mound, hole];
    const texFiles = new Map();
    for (const doc of all) for (const t of doc.textures) texFiles.set(t.name, t.file);
    const textures = {};
    await Promise.all([...texFiles].map(async ([name, file]) => { textures[name] = await loadTex(file); }));

    const makeMaterial = (meshDoc) => {
      const tex = textures[meshDoc.texture];
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        color: new THREE.Color(0xcdbb9a),
        roughness: 0.95,
        metalness: 0.0,
        side: THREE.DoubleSide,
      });
      if (tex) tex.colorSpace = THREE.SRGBColorSpace;
      return mat;
    };

    const toMesh = (doc) => {
      const m = doc.models[0].meshes[0];
      const mesh = new THREE.Mesh(buildGeometry(m), makeMaterial(m));
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      return mesh;
    };

    this.moundProto = toMesh(mound);
    this.holeProto = toMesh(hole);
  }

  /* ---------------- board ---------------- */

  startGame(difficulty, state = null) {
    this.difficulty = difficulty;
    this.variant = VARIANTS[difficulty];
    this.board = state
      ? boardFromState(this.variant, state.contents, state.dug)
      : new Board(this.variant);

    this.score = 0;
    this.dugSafe = 0;
    this.firstBomb = false;
    this.collected = { green: 0, blue: 0, red: 0, silver: 0, gold: 0, rupoor: 0 };
    this.targetReached = false;
    this.roundOver = false;
    this.resultShown = false;
    this.bombed = false;
    this.cleared = false;
    this.shake = 0;
    this.bombExploded = false;
    this.bombMesh = null;
    this.fuseLight = null;
    this.timer = 0;
    this.playTimer = state ? PLAY_FRAMES : 0;
    this.msgTimer = 0;
    this.selected = { row: Math.floor(this.variant.rows / 2), col: Math.floor(this.variant.cols / 2) };
    this.hover = null;

    if (state) {
      this.resumeProgress();
      this.phase = 'play';
    } else {
      this.phase = 'wait';
    }

    while (this.boardGroup.children.length) {
      const c = this.boardGroup.children.pop();
      this.boardGroup.remove(c);
    }
    this.clearFx();

    const spacing = HOLE_SPACING;
    this.cellPos = [];
    for (let row = 0; row < this.variant.rows; row++) {
      for (let col = 0; col < this.variant.cols; col++) {
        const x = (col - (this.variant.cols - 1) / 2) * spacing;
        const z = (row - (this.variant.rows - 1) / 2) * spacing;
        this.cellPos.push(new THREE.Vector3(x, 0, z));

        const group = new THREE.Group();
        group.position.set(x, 0, z);
        const mound = this.moundProto.clone();
        mound.userData = { type: 'mound' };
        const hole = this.holeProto.clone();
        hole.visible = false;
        hole.userData = { type: 'hole' };
        group.add(mound, hole);
        group.userData = { row, col, index: row * this.variant.cols + col };
        this.boardGroup.add(group);
      }
    }

    // camera framing
    this.fitCamera(true);

    if (state) {
      for (let i = 0; i < this.board.numHoles; i++) {
        if (this.board.cells[i].dug) {
          const g = this.boardGroup.children[i];
          g.children[0].visible = false;
          g.children[1].visible = true;
        }
      }
    }

    this.updateHUD();
    this.showOverlay(false);
    this.hideBanner();
    const touch = matchMedia('(pointer: coarse)').matches;
    this.setHint(touch
      ? 'Drag to orbit &middot; pinch to zoom &middot; tap a mound to dig'
      : 'Move <b>WASD</b>/arrows &middot; <b>Space</b> or click to dig &middot; drag to orbit &middot; scroll to zoom');
    this.toast('', 0);
    this.refresh();
  }

  /** Rebuild score / collected counters from a resumed board's dug cells. */
  resumeProgress() {
    const meta = {
      [CONTENT.GREEN]: 'green',
      [CONTENT.BLUE]: 'blue',
      [CONTENT.RED]: 'red',
      [CONTENT.SILVER]: 'silver',
      [CONTENT.GOLD]: 'gold',
    };
    const cells = this.board.cells;
    for (let i = 0; i < cells.length; i++) {
      if (!cells[i].dug) continue;
      const c = cells[i].content;
      if (c === CONTENT.BOMB) continue;
      if (c === CONTENT.RUPOOR) {
        this.collected.rupoor++;
        this.score = Math.max(0, this.score - 10);
        continue;
      }
      const name = meta[c];
      if (name) {
        this.collected[name]++;
        this.score += SCORE[c];
        this.dugSafe++;
      }
    }
    this.firstBomb = cells.some((c) => c.dug);
    this.targetReached = this.score >= this.variant.target;
  }

  /* ---------------- modes / analysis / 2D board ---------------- */

  setupUI() {
    const $ = (id) => document.getElementById(id);
    this.ui = {
      sidebar: $('sidebar'),
      modePlay: $('mode-play'),
      modeAnalysis: $('mode-analysis'),
      sbToggle: $('sb-toggle'),
      playTools: $('play-tools'),
      analysisTools: $('analysis-tools'),
      optHidden: $('opt-hidden'),
      optAgent: $('opt-agent'),
      optDist: $('opt-dist'),
      agentSummary: $('agent-summary'),
      analysisTabs: [...document.querySelectorAll('#analysis-tools .tabs button')],
      analysisVariants: $('analysis-variants'),
      palette: $('palette'),
      analysisActions: $('analysis-actions'),
      analysisStatus: $('analysis-status'),
      boardTitle: $('board-title'),
      boardSub: $('board-sub'),
      boardGrid: $('board-grid'),
      boardLegend: $('board-legend'),
      distDetail: $('dist-detail'),
    };

    this.ui.modePlay.onclick = () => this.setMode('play');
    this.ui.modeAnalysis.onclick = () => this.toAnalysis('hidden');
    this.ui.sbToggle.onclick = () => {
      const collapsed = this.ui.sidebar.classList.toggle('collapsed');
      this.ui.sbToggle.textContent = collapsed ? '\u25B8' : '\u25C2';
      this.fitCamera();
    };
    const fitBtn = $('view-fit');
    if (fitBtn) fitBtn.onclick = () => this.resetView();
    this.ui.optHidden.onchange = () => { this.show.hidden = this.ui.optHidden.checked; this.refresh(); };
    this.ui.optAgent.onchange = () => { this.show.agent = this.ui.optAgent.checked; this.refresh(); };
    this.ui.optDist.onchange = () => { this.show.dist = this.ui.optDist.checked; this.refresh(); };
    this.ui.analysisTabs.forEach((b) => {
      b.onclick = () => this.setAnalysisSubmode(b.dataset.sub);
    });
    this.ui.boardGrid.addEventListener('click', (e) => {
      const cell = e.target.closest('.bcell');
      if (!cell || !cell.classList.contains('clickable')) return;
      this.onCell2DClick(Number(cell.dataset.i));
    });
    this.ui.boardGrid.addEventListener('mousemove', (e) => {
      const cell = e.target.closest('.bcell');
      const i = cell ? Number(cell.dataset.i) : -1;
      if (i !== this.editor.hover) { this.editor.hover = i; this.renderDetail(i); }
    });
    this.ui.boardGrid.addEventListener('mouseleave', () => {
      this.editor.hover = -1;
      this.renderDetail(-1);
    });

    this.ui.boardLegend.innerHTML = [
      ['t1', '1'], ['t2', '5'], ['t3', '20'], ['t4', '100'], ['t5', '300'],
      ['rup', 'Rupoor'], ['bmb', 'Bomb'],
    ].map(([cls, label]) => `<span><i style="background:${paletteColor(cls)}"></i>${label}</span>`).join('');
  }

  /* ---- mode switching ---- */

  setMode(mode) {
    this.mode = mode;
    document.body.classList.toggle('mode-analysis', mode === 'analysis');
    document.body.classList.toggle('mode-play', mode !== 'analysis');
    this.ui.modePlay.classList.toggle('on', mode === 'play');
    this.ui.modeAnalysis.classList.toggle('on', mode === 'analysis');
    this.ui.playTools.classList.toggle('hidden', mode !== 'play');
    this.ui.analysisTools.classList.toggle('hidden', mode !== 'analysis');
    if (mode === 'analysis') {
      this.showOverlay(false);
      this.hideBanner();
      this.toast('', 0);
    } else if (this.phase === 'menu' || this.resultShown) {
      this.showOverlay(true);
    }
    this.refresh();
  }

  toAnalysis(sub) {
    this.setAnalysisSubmode(sub, true);
    this.setMode('analysis');
  }

  setAnalysisSubmode(sub, seed = false) {
    this.editor.submode = sub;
    this.editor.hover = -1;
    if (seed) this.seedAnalysisFromGame();
    this.ui.analysisTabs.forEach((b) => b.classList.toggle('on', b.dataset.sub === sub));
    this.renderPalette();
    this.renderVariantButtons();
    this.refresh();
  }

  seedAnalysisFromGame() {
    if (this.board) {
      this.initEditor(this.board.variant);
      this.seedHiddenFromBoard(this.board);
    } else {
      this.initEditor(this.analysisVariant);
      this.seedHiddenFromBoard(new Board(this.analysisVariant));
    }
    this.seedObservedFromHidden();
  }

  /* ---- editor state ---- */

  initEditor(variant) {
    this.analysisVariant = variant;
    const n = variant.rows * variant.cols;
    this.editor.hidden.hazard = new Array(n).fill(CONTENT.NONE);
    this.editor.hidden.dug = new Array(n).fill(false);
    this.editor.observed = new Array(n).fill(OBS.UNDUG);
    this.editor.tool = null;
    this.editor.hover = -1;
  }

  seedHiddenFromBoard(board) {
    const n = board.numHoles;
    this.editor.hidden.hazard = new Array(n).fill(CONTENT.NONE);
    this.editor.hidden.dug = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      const c = board.cells[i].content;
      if (c === CONTENT.BOMB || c === CONTENT.RUPOOR) this.editor.hidden.hazard[i] = c;
      this.editor.hidden.dug[i] = board.cells[i].dug;
    }
  }

  countHazardNeighbours(hazard, i) {
    const { rows, cols } = this.analysisVariant;
    const row = Math.floor(i / cols), col = i % cols;
    let n = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const r = row + dr, c = col + dc;
        if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
        const h = hazard[r * cols + c];
        if (h === CONTENT.BOMB || h === CONTENT.RUPOOR) n++;
      }
    }
    return n;
  }

  resolvedHiddenContent() {
    const { rows, cols } = this.analysisVariant;
    const n = rows * cols;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const h = this.editor.hidden.hazard[i];
      out[i] = h ? h : gameTierForCount(this.countHazardNeighbours(this.editor.hidden.hazard, i));
    }
    return out;
  }

  hiddenValidity() {
    const { rows, cols, bombs, rupoors } = this.analysisVariant;
    const contents = this.resolvedHiddenContent();
    let b = 0, r = 0;
    for (const c of contents) {
      if (c === CONTENT.BOMB) b++;
      else if (c === CONTENT.RUPOOR) r++;
    }
    const errors = [];
    if (b !== bombs) errors.push(`bombs ${b}/${bombs}`);
    if (r !== rupoors) errors.push(`rupoors ${r}/${rupoors}`);
    if (hasHazard2x2Game(contents, rows, cols)) errors.push('2\u00D72 hazard block');
    return { ok: errors.length === 0, errors, contents, bombs: b, rupoors: r };
  }

  observedFromHiddenEditor() {
    const n = this.editor.hidden.dug.length;
    const contents = this.resolvedHiddenContent();
    const obs = new Array(n);
    for (let i = 0; i < n; i++) {
      obs[i] = this.editor.hidden.dug[i] ? observedFromGameContent(contents[i]) : OBS.UNDUG;
    }
    return obs;
  }

  seedObservedFromHidden() {
    this.editor.observed = this.observedFromHiddenEditor();
  }

  buildObservedFromGame() {
    const cells = this.board.cells;
    const obs = new Array(cells.length);
    for (let i = 0; i < cells.length; i++) {
      obs[i] = cells[i].dug ? observedFromGameContent(cells[i].content) : OBS.UNDUG;
    }
    return obs;
  }

  /* ---- posterior / refresh ---- */

  recomputePosterior() {
    let observed, variant;
    if (this.mode === 'analysis') {
      variant = this.analysisVariant;
      observed = this.editor.submode === 'observable' ? this.editor.observed : this.observedFromHiddenEditor();
    } else {
      if (!this.board) { this.posterior = null; this.agentResult = null; return; }
      variant = this.board.variant;
      observed = this.buildObservedFromGame();
    }
    const numBads = variant.bombs + variant.rupoors;
    const post = buildPosterior(observed, variant.rows, variant.cols, numBads, variant.rupoors);
    this.posterior = post;

    if (isObservableValid(post)) {
      const legal = [];
      for (let i = 0; i < observed.length; i++) if (observed[i] === OBS.UNDUG) legal.push(i);
      this.agentResult = pureGreedy(post, legal);
    } else {
      this.agentResult = null;
    }
  }

  refresh() {
    const needPosterior = this.mode === 'analysis' || this.show.agent || this.show.dist;
    if (needPosterior) this.recomputePosterior();
    else { this.posterior = null; this.agentResult = null; }
    this.renderBoard2D();
    this.renderAgentSummary();
    if (this.mode === 'analysis') this.renderAnalysisActions();
    this.renderAnalysisStatus();
    this.renderDetail(this.editor.hover);
  }

  /* ---- rendering ---- */

  activeVariant() {
    return this.mode === 'analysis'
      ? this.analysisVariant
      : (this.board ? this.board.variant : this.variant);
  }

  renderBoard2D() {
    const grid = this.ui.boardGrid;
    if (!grid) return;
    const variant = this.activeVariant();
    const { rows, cols } = variant;
    const n = rows * cols;
    grid.style.setProperty('--cols', cols);

    const post = this.posterior;
    const best = this.agentResult ? new Set(this.agentResult.best) : null;
    const sub = this.editor.submode;

    let html = '';
    for (let i = 0; i < n; i++) {
      let content = CONTENT.NONE;
      let dug = false;
      let known = true;
      let legal = false;
      let dim = false;

      if (this.mode === 'play') {
        const cell = this.board ? this.board.cells[i] : null;
        dug = cell ? cell.dug : false;
        legal = !dug;
        if (dug) content = cell.content;
        else if (this.show.hidden && cell) { content = cell.content; dim = true; }
        else { content = CONTENT.NONE; known = false; }
      } else if (sub === 'hidden') {
        content = this.editor.hidden.hazard[i]
          || gameTierForCount(this.countHazardNeighbours(this.editor.hidden.hazard, i));
        dug = this.editor.hidden.dug[i];
        legal = !dug;
      } else {
        const o = this.editor.observed[i];
        content = o === OBS.UNDUG ? CONTENT.NONE : OBS_TO_GAME[o];
        dug = o !== OBS.UNDUG;
        legal = o === OBS.UNDUG;
      }

      const st = CONTENT_STYLE[content] || CONTENT_STYLE[CONTENT.NONE];
      let cls = 'bcell ' + st.cls;
      if (dug) cls += ' dug';
      if (dim) cls += ' dim';
      if (this.mode === 'analysis') cls += ' clickable';
      if (best && best.has(i)) cls += ' rec';

      let bar = '';
      if (post && post.cells[i]) {
        const counts = post.cells[i].counts;
        let total = 0;
        for (let c = 0; c < 7; c++) total += counts[c];
        const showBar = this.mode === 'analysis' ? true : (this.show.dist && legal);
        if (showBar && total > 0) {
          bar = '<span class="bar">';
          for (let c = 0; c < 7; c++) {
            const w = (counts[c] / total) * 100;
            if (w > 0.01) bar += `<i style="width:${w}%;background:${AGENT_COLORS[c]}"></i>`;
          }
          bar += '</span>';
        }
      }

      const title = this.cellSummary(i, dug, post);
      const showLabel = this.mode === 'analysis' || dug || known;
      html += `<div class="${cls}" data-i="${i}" title="${title}">`
        + `<span class="lbl">${showLabel ? st.short : ''}</span>${bar}</div>`;
    }
    grid.innerHTML = html;
    this.ui.boardTitle.textContent = this.mode === 'analysis'
      ? (sub === 'hidden' ? 'Hidden board (edit)' : 'Observable state (edit)')
      : 'Board';
    this.ui.boardSub.textContent = `${variant.label} · ${rows}\u00D7${cols}`;
  }

  cellSummary(i, dug, post) {
    const variant = this.activeVariant();
    const row = Math.floor(i / variant.cols), col = i % variant.cols;
    const parts = [`cell (${row}, ${col})${dug ? ' · dug' : ''}`];
    if (post && post.cells[i]) {
      const counts = post.cells[i].counts;
      let total = 0;
      for (let c = 0; c < 7; c++) total += counts[c];
      if (total > 0) {
        for (let c = 0; c < 7; c++) {
          if (counts[c] > 0) {
            parts.push(`${AGENT_NAMES[c]} ${Math.round(counts[c]).toLocaleString()} (${((counts[c] / total) * 100).toFixed(1)}%)`);
          }
        }
      }
    }
    return parts.join(' · ');
  }

  renderAgentSummary() {
    const el = this.ui.agentSummary;
    if (!el) return;
    const show = this.mode === 'analysis' || this.show.agent;
    if (!show || !this.agentResult) { el.textContent = ''; return; }
    const { bestValue, best } = this.agentResult;
    if (!best.length || bestValue <= 0) {
      el.textContent = 'Pure Greedy: stop \u2014 no dig has positive expected value.';
      return;
    }
    const variant = this.activeVariant();
    const coords = best.map((i) => `(${Math.floor(i / variant.cols)}, ${i % variant.cols})`);
    el.textContent = `Pure Greedy: dig ${coords.join(' or ')} \u00B7 EV ${bestValue.toFixed(3)}`;
  }

  renderAnalysisStatus() {
    const el = this.ui.analysisStatus;
    if (!el || this.mode !== 'analysis') return;
    let ok, msg;
    if (this.editor.submode === 'hidden') {
      const v = this.hiddenValidity();
      ok = v.ok;
      msg = ok
        ? `Valid board \u00B7 ${v.bombs} bombs, ${v.rupoors} rupoors. Ready to play.`
        : `Invalid: ${v.errors.join(', ')}.`;
    } else {
      const valid = this.posterior && isObservableValid(this.posterior);
      const total = this.posterior ? this.posterior.totalBoards : 0;
      ok = !!valid;
      msg = valid
        ? `Consistent observable \u00B7 ${Math.round(total).toLocaleString()} possible boards.`
        : 'No consistent board for this observable state.';
    }
    el.className = 'status ' + (ok ? 'ok' : 'bad');
    el.textContent = msg;
  }

  renderDetail(i) {
    const el = this.ui.distDetail;
    if (!el) return;
    if (i == null || i < 0 || !this.posterior || !this.posterior.cells[i]) {
      el.innerHTML = '<div class="muted">Hover a cell to see its distribution of possible contents.</div>';
      return;
    }
    const counts = this.posterior.cells[i].counts;
    let total = 0;
    for (let c = 0; c < 7; c++) total += counts[c];
    const variant = this.activeVariant();
    const row = Math.floor(i / variant.cols), col = i % variant.cols;

    let rowsHtml = '';
    for (let c = 0; c < 7; c++) {
      const pct = total > 0 ? (counts[c] / total) * 100 : 0;
      rowsHtml += `<tr><td class="sw"><i style="background:${AGENT_COLORS[c]}"></i></td>`
        + `<td>${AGENT_NAMES[c]}</td>`
        + `<td class="ct">${Math.round(counts[c]).toLocaleString()}</td>`
        + `<td class="pc">${pct.toFixed(1)}%</td></tr>`;
    }

    let evLine = '';
    if (this.agentResult) {
      const ev = this.agentResult.ev[i];
      evLine = `<div class="muted">expected value ${ev.toFixed(3)}`
        + `${this.agentResult.best.includes(i) ? ' \u00B7 recommended' : ''}</div>`;
    }

    el.innerHTML = `<div class="dt-head">Cell (${row}, ${col})`
      + `${total > 0 ? ` \u00B7 ${Math.round(total).toLocaleString()} boards` : ''}</div>`
      + `<table>${rowsHtml}</table>${evLine}`;
  }

  renderPalette() {
    const host = this.ui.palette;
    if (!host) return;
    const items = this.editor.submode === 'hidden' ? HIDDEN_PALETTE : OBS_PALETTE;
    const tool = this.editor.tool;
    host.innerHTML = items.map((it, idx) => {
      const sw = it.cls ? `<span class="sw" style="background:${paletteColor(it.cls)}"></span>` : '';
      return `<button data-idx="${idx}" class="${tool && tool.id === it.id ? 'on' : ''}">${sw}${it.label}</button>`;
    }).join('');
    host.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const it = items[Number(b.dataset.idx)];
        this.editor.tool = (this.editor.tool && this.editor.tool.id === it.id) ? null : it;
        this.renderPalette();
      };
    });
  }

  renderVariantButtons() {
    const host = this.ui.analysisVariants;
    if (!host) return;
    host.innerHTML = Object.values(VARIANTS).map((v) =>
      `<button data-key="${v.key}" class="${v.key === this.analysisVariant.key ? 'on' : ''}">${v.label}</button>`
    ).join('');
    host.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const v = VARIANTS[b.dataset.key];
        this.initEditor(v);
        if (this.editor.submode === 'hidden') this.seedHiddenFromBoard(new Board(v));
        else this.seedObservedFromHidden();
        this.renderPalette();
        this.renderVariantButtons();
        this.refresh();
      };
    });
  }

  renderAnalysisActions() {
    const host = this.ui.analysisActions;
    if (!host) return;
    if (this.editor.submode === 'hidden') {
      host.innerHTML =
        '<button data-act="random">Random board</button>'
        + '<button data-act="cleardug">Clear dug</button>'
        + '<button data-act="clearhaz">Clear hazards</button>'
        + '<button data-act="play">Play this state</button>';
    } else {
      host.innerHTML =
        '<button data-act="import">Import from hidden</button>'
        + '<button data-act="clear">Clear</button>'
        + '<button data-act="play">Play sampled board</button>';
    }
    host.querySelectorAll('button').forEach((b) => {
      b.onclick = () => this.onAnalysisAction(b.dataset.act);
    });
    const canPlay = this.editor.submode === 'hidden'
      ? this.hiddenValidity().ok
      : !!(this.posterior && isObservableValid(this.posterior));
    const playBtn = host.querySelector('[data-act="play"]');
    if (playBtn) playBtn.disabled = !canPlay;
  }

  onAnalysisAction(act) {
    switch (act) {
      case 'random':
        this.seedHiddenFromBoard(new Board(this.analysisVariant));
        this.seedObservedFromHidden();
        break;
      case 'cleardug':
        this.editor.hidden.dug.fill(false);
        break;
      case 'clearhaz':
        this.editor.hidden.hazard.fill(CONTENT.NONE);
        break;
      case 'import':
        this.seedObservedFromHidden();
        break;
      case 'clear':
        this.editor.observed.fill(OBS.UNDUG);
        break;
      case 'play':
        this.playFromAnalysis();
        return;
      default:
        break;
    }
    this.refresh();
  }

  onCell2DClick(i) {
    if (this.mode !== 'analysis') return;
    const tool = this.editor.tool;
    if (!tool) return;
    if (this.editor.submode === 'hidden') {
      if (tool.kind === 'dug') {
        this.editor.hidden.dug[i] = !this.editor.hidden.dug[i];
      } else {
        const cur = this.editor.hidden.hazard[i];
        if (tool.value === CONTENT.NONE) this.editor.hidden.hazard[i] = CONTENT.NONE;
        else this.editor.hidden.hazard[i] = cur === tool.value ? CONTENT.NONE : tool.value;
      }
    } else {
      this.editor.observed[i] = tool.value;
    }
    this.refresh();
  }

  playFromAnalysis() {
    if (this.editor.submode === 'hidden') {
      const v = this.hiddenValidity();
      if (!v.ok) { this.toast('Cannot play: ' + v.errors.join(', '), 1600); return; }
      this.startGame(this.analysisVariant.key, {
        contents: v.contents,
        dug: this.editor.hidden.dug.slice(),
      });
    } else {
      if (!this.posterior || !isObservableValid(this.posterior)) {
        this.toast('Cannot play: no consistent board.', 1600);
        return;
      }
      const contents = sampleGameBoard(this.posterior, Math.random);
      const dug = this.editor.observed.map((o) => o !== OBS.UNDUG);
      this.startGame(this.analysisVariant.key, { contents, dug });
    }
    this.setMode('play');
  }

  cellGroup(index) { return this.boardGroup.children[index]; }

  screenToCell() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.pickPlane, false)[0];
    if (!hit) return null;
    const { cols, rows } = this.variant;
    const halfW = (cols - 1) / 2, halfD = (rows - 1) / 2;
    let col = Math.round(hit.point.x / HOLE_SPACING + halfW);
    let row = Math.round(hit.point.z / HOLE_SPACING + halfD);
    if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
    return { row, col, index: row * cols + col };
  }

  dig() {
    if (this.phase !== 'play' || this.roundOver) return;
    const { row, col } = this.selected;
    const index = row * this.variant.cols + col;
    const cell = this.board.cells[index];
    if (cell.dug) return;

    cell.dug = true;
    const group = this.cellGroup(index);
    group.children[0].visible = false; // mound
    group.children[1].visible = true;  // hole

    this.sfx?.dig();

    let content = cell.content;

    if (!this.firstBomb) {
      this.firstBomb = true;
      if (content === CONTENT.BOMB) {
        const reroll = this.difficulty === 'normal'
          ? Math.random() < FIRST_BOMB_REROLL_CHANCE
          : true;
        if (reroll) {
          this.board.fillHoles();
          content = this.board.cells[index].content;
        }
      }
    }

    if (content === CONTENT.BOMB) {
      this.startBomb(this.cellPos[index]);
      this.updateHUD();
      this.refresh();
      return;
    }

    if (content === CONTENT.RUPOOR) {
      this.spawnItemFx(this.cellPos[index], 0x7a4bb5, true);
      this.sfx?.rupoor();
      this.collected.rupoor++;
      this.score = Math.max(0, this.score - 10);
    } else if (content === CONTENT.NONE) {
      this.spawnItemFx(this.cellPos[index], 0xcfc7b0, false);
      this.dugSafe++;
    } else {
      const meta = {
        [CONTENT.GREEN]: ['green', 0x3fa34d],
        [CONTENT.BLUE]: ['blue', 0x2f6fd0],
        [CONTENT.RED]: ['red', 0xc0392b],
        [CONTENT.SILVER]: ['silver', 0xaeb6bd],
        [CONTENT.GOLD]: ['gold', 0xe6b800],
      }[content];
      this.collected[meta[0]]++;
      this.score += SCORE[content];
      this.sfx?.rupee(content === CONTENT.SILVER || content === CONTENT.GOLD);
      this.spawnItemFx(this.cellPos[index], meta[1], false);
      this.dugSafe++;
    }

    if (!this.targetReached && this.score >= this.variant.target) {
      this.targetReached = true;
      this.toast('Target reached!', 1800);
    }

    this.updateHUD();
    this.refresh();

    if (this.dugSafe === this.board.safeHoles) {
      this.cleared = true;
      this.endRound();
    }
  }

  endRound() {
    this.roundOver = true;
    this.phase = 'clear';
    this.clearTimer = 0;
  }

  /* ---------------- fx ---------------- */

  spawnItemFx(pos, color, isRupoor) {
    const geo = new THREE.OctahedronGeometry(isRupoor ? 26 : 30, 0);
    geo.scale(0.7, 1.25, 0.7);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.28, roughness: 0.35, metalness: 0.35,
    }));
    mesh.position.copy(pos).setY(20);
    mesh.userData = { t: 0, life: 1.05, type: 'item', vy: 150 };
    this.boardGroup.add(mesh);
    this.items.push(mesh);
  }

  /**
   * A bomb has been uncovered: it pops out of the hole, its fuse burns, then
   * it detonates and the round ends. Mirrors the bomb actor spawned by
   * dAcOholeMinigame_c::executeState_Play().
   */
  startBomb(pos) {
    this.bombed = true;
    this.roundOver = true;
    this.phase = 'bomb';
    this.bombPos = pos.clone();
    this.bombFuse = 0;
    this.bombBoom = 0;
    this.bombExploded = false;

    const bomb = new THREE.Mesh(
      new THREE.SphereGeometry(44, 20, 16),
      new THREE.MeshStandardMaterial({ color: 0x24242a, roughness: 0.55, metalness: 0.15 })
    );
    bomb.castShadow = true;
    bomb.position.set(pos.x, 8, pos.z);
    bomb.scale.setScalar(0.2);
    this.bombMesh = bomb;
    this.boardGroup.add(bomb);

    this.fuseLight = new THREE.PointLight(0xffa030, 0, 500, 2);
    this.fuseLight.position.set(pos.x, 78, pos.z);
    this.boardGroup.add(this.fuseLight);

    this.sfx?.fuse();
  }

  updateBomb(dt) {
    this.bombFuse += dt;
    const fuseTime = 0.9;
    const p = Math.min(this.bombFuse / fuseTime, 1);

    this.bombMesh.scale.setScalar(0.2 + p * 0.85);
    this.bombMesh.position.y = 8 + Math.sin(p * Math.PI) * 62;
    this.bombMesh.rotation.y += dt * 6;
    this.fuseLight.intensity = 3 + Math.max(0, Math.sin(this.bombFuse * 45)) * 6;

    if (!this.bombExploded && this.bombFuse >= fuseTime) {
      this.bombExploded = true;
      this.boardGroup.remove(this.bombMesh);
      this.boardGroup.remove(this.fuseLight);
      this.createExplosion(this.bombPos);
      this.shake = 1.0;
      this.sfx?.boom();
    }

    if (this.bombExploded) {
      this.bombBoom += dt;
      if (this.bombBoom >= 1.35) this.endRound();
    }
  }

  createExplosion(pos) {
    const light = new THREE.PointLight(0xffb347, 0, 3200, 2);
    light.position.set(pos.x, 150, pos.z);
    this.boardGroup.add(light);

    const fire = new THREE.Mesh(
      new THREE.SphereGeometry(70, 20, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffcf70, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    fire.position.set(pos.x, 80, pos.z);
    fire.userData = { type: 'fireball', t: 0, life: 0.85, light };
    this.boardGroup.add(fire);
    this.items.push(fire);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(50, 90, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0xffdca0, transparent: true, opacity: 0.85,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    ring.position.set(pos.x, 10, pos.z);
    ring.userData = { type: 'shock', t: 0, life: 0.6 };
    this.boardGroup.add(ring);
    this.items.push(ring);

    for (let i = 0; i < 26; i++) {
      const s = new THREE.Mesh(
        new THREE.SphereGeometry(6 + Math.random() * 9, 8, 6),
        new THREE.MeshBasicMaterial({
          color: i % 3 === 0 ? 0xffe7a0 : 0xff9a28,
          transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false,
        })
      );
      const a = Math.random() * Math.PI * 2;
      const speed = 260 + Math.random() * 560;
      s.position.set(pos.x, 60, pos.z);
      s.userData = {
        type: 'spark', t: 0, life: 0.85 + Math.random() * 0.5,
        vel: new THREE.Vector3(Math.cos(a) * speed, 260 + Math.random() * 480, Math.sin(a) * speed),
      };
      this.boardGroup.add(s);
      this.items.push(s);
    }
  }

  clearFx() {
    for (const m of this.fx) this.boardGroup.remove(m);
    for (const m of this.items) {
      this.boardGroup.remove(m);
      if (m.userData?.light) this.boardGroup.remove(m.userData.light);
    }
    if (this.bombMesh) { this.boardGroup.remove(this.bombMesh); this.bombMesh = null; }
    if (this.fuseLight) { this.boardGroup.remove(this.fuseLight); this.fuseLight = null; }
    this.fx = [];
    this.items = [];
  }

  updateFx(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const m = this.items[i];
      const u = m.userData;
      u.t += dt;
      const k = Math.min(u.t / u.life, 1);
      if (u.type === 'fireball') {
        m.scale.setScalar(1 + k * 6);
        m.material.opacity = 0.95 * (1 - k);
        u.light.intensity = 900 * (1 - k);
        if (k >= 1) { this.boardGroup.remove(m); this.boardGroup.remove(u.light); this.items.splice(i, 1); }
      } else if (u.type === 'shock') {
        m.scale.setScalar(1 + k * 9);
        m.material.opacity = 0.85 * (1 - k);
        if (k >= 1) { this.boardGroup.remove(m); this.items.splice(i, 1); }
      } else if (u.type === 'spark') {
        u.vel.y -= 980 * dt;
        m.position.addScaledVector(u.vel, dt);
        m.material.opacity = 1 - k;
        if (m.position.y < 6) u.vel.y = Math.abs(u.vel.y) * 0.35;
        if (k >= 1) { this.boardGroup.remove(m); this.items.splice(i, 1); }
      } else {
        // rupee pickup: floats up and shrinks away
        m.position.y += u.vy * dt;
        u.vy *= 0.94;
        m.rotation.y += dt * 3;
        m.scale.multiplyScalar(1 - dt * 0.3);
        m.material.opacity = 1 - k;
        if (k >= 1) { this.boardGroup.remove(m); this.items.splice(i, 1); }
      }
    }
  }

  /* ---------------- input ---------------- */

  bindEvents() {
    addEventListener('pointerdown', () => this.sfx.init(), { once: true });
    addEventListener('keydown', () => this.sfx.init(), { once: true });

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.fitCamera();
    });

    const applyPhone = () => {
      this.phone = this.mqPhone.matches;
      document.body.classList.toggle('phone', this.phone);
      this.fitCamera();
    };
    if (this.mqPhone.addEventListener) this.mqPhone.addEventListener('change', applyPhone);
    else if (this.mqPhone.addListener) this.mqPhone.addListener(applyPhone);

    const el = this.renderer.domElement;
    el.style.touchAction = 'none';

    const ptr = (e) => ({ x: e.clientX, y: e.clientY });
    const trackPointer = (e) => {
      this.pointer.x = (e.clientX / innerWidth) * 2 - 1;
      this.pointer.y = -(e.clientY / innerHeight) * 2 + 1;
    };

    el.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'play') return;
      e.preventDefault();
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (_) {} }
      this.pointers.set(e.pointerId, ptr(e));
      this.pointerType = e.pointerType;
      trackPointer(e);

      if (this.pointers.size === 1) {
        this.dragging = true;
        this.dragMoved = 0;
        this.lastPointer = ptr(e);
      } else if (this.pointers.size === 2) {
        this.dragging = false;
        this.pinching = true;
        const [a, b] = [...this.pointers.values()];
        this.pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        this.pinchStartRadius = this.camState.radius;
      }
    });

    const endPointer = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const wasSingle = this.pointers.size === 1;
      const tapOK = wasSingle && this.dragging && !this.pinching
        && this.dragMoved < 6 && this.phase === 'play';
      this.pointers.delete(e.pointerId);

      if (this.pointers.size === 0) {
        if (tapOK) {
          const cell = this.screenToCell();
          if (cell) { this.selected = { row: cell.row, col: cell.col }; this.dig(); }
        }
        this.dragging = false;
        this.pinching = false;
      } else if (this.pointers.size === 1) {
        this.pinching = false;
        this.dragging = true;
        this.dragMoved = 999;
        this.lastPointer = [...this.pointers.values()][0];
      }
    };
    addEventListener('pointerup', endPointer);
    addEventListener('pointercancel', endPointer);

    addEventListener('pointermove', (e) => {
      if (this.mode !== 'play') return;
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, ptr(e));
      if (e.target && e.target.closest && e.target.closest('#sidebar')) return;
      trackPointer(e);

      if (this.pinching && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        this.camState.radius = Math.min(14000,
          Math.max(760, this.pinchStartRadius * (this.pinchStartDist / d)));
        this.updateCamera();
        return;
      }

      if (this.dragging) {
        const dx = e.clientX - this.lastPointer.x;
        const dy = e.clientY - this.lastPointer.y;
        this.dragMoved += Math.abs(dx) + Math.abs(dy);
        this.lastPointer = ptr(e);
        this.camState.azimuth -= dx * 0.005;
        this.camState.polar = Math.min(1.45, Math.max(0.28, this.camState.polar - dy * 0.004));
        this.updateCamera();
      } else if (this.phase === 'play' && this.pointerType !== 'touch') {
        const cell = this.screenToCell();
        if (cell) { this.selected = { row: cell.row, col: cell.col }; }
      }
    });
    el.addEventListener('wheel', (e) => {
      if (this.mode !== 'play') return;
      e.preventDefault();
      this.camState.radius = Math.min(14000, Math.max(760, this.camState.radius + e.deltaY * 1.6));
      this.updateCamera();
    }, { passive: false });

    addEventListener('keydown', (e) => {
      if (this.mode !== 'play' || this.phase !== 'play') return;
      if (e.target && e.target.closest && e.target.closest('#sidebar')) return;
      const { rows, cols } = this.variant;
      let { row, col } = this.selected;
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') row--;
      else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') row++;
      else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') col--;
      else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') col++;
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.dig(); return; }
      else return;
      e.preventDefault();
      this.selected = {
        row: Math.min(rows - 1, Math.max(0, row)),
        col: Math.min(cols - 1, Math.max(0, col)),
      };
    });
  }

  updateCamera(instant = false) {
    const { azimuth, polar, radius } = this.camState;
    const x = radius * Math.sin(polar) * Math.sin(azimuth);
    const y = radius * Math.cos(polar);
    const z = radius * Math.sin(polar) * Math.cos(azimuth);
    const target = new THREE.Vector3(0, 40, 0);
    const base = new THREE.Vector3(x, y, z).add(target);

    // Screen-space anchoring keeps the board inside the area not covered by the UI.
    const tanV = Math.tan((this.camera.fov * Math.PI / 180) / 2);
    const tanH = tanV * this.camera.aspect;
    const offU = -this.camAnchor.x * radius * tanH;
    const offV = -this.camAnchor.y * radius * tanV;
    const view = target.clone().sub(base).normalize();
    const right = new THREE.Vector3().crossVectors(view, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0); else right.normalize();
    const up = new THREE.Vector3().crossVectors(right, view).normalize();
    const offset = right.multiplyScalar(offU).add(up.multiplyScalar(offV));

    const desired = base.add(offset);
    const lookTarget = target.add(offset);
    if (instant) this.camera.position.copy(desired);
    else this.camera.position.lerp(desired, 0.35);
    if (this.shake > 0) {
      const s = this.shake * 34;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
    }
    this.camera.lookAt(lookTarget);

    // Push the fog back as the camera pulls away so distant boards stay legible.
    if (this.scene.fog) {
      this.scene.fog.near = Math.max(3200, radius * 1.1);
      this.scene.fog.far = this.scene.fog.near + Math.max(6000, radius * 1.2);
    }
  }

  /** Frame the whole board in the part of the screen the UI does not cover. */
  fitCamera(instant = false) {
    const { rows, cols } = this.variant;
    const margin = 220;
    const halfW = ((cols - 1) * HOLE_SPACING) / 2 + margin;
    const halfD = ((rows - 1) * HOLE_SPACING) / 2 + margin;

    const vw = Math.max(1, innerWidth);
    const vh = Math.max(1, innerHeight);
    let fracX = 1, fracY = 1;
    let anchorX = 0, anchorY = 0;

    const sb = this.ui && this.ui.sidebar;
    const sbVisible = sb && sb.getClientRects().length > 0 && !sb.classList.contains('collapsed');
    if (sbVisible) {
      const r = sb.getBoundingClientRect();
      if (this.phone) {
        const usableH = Math.max(140, r.top - 10);
        fracY = Math.min(1, usableH / vh);
        anchorY = 1 - fracY;
      } else {
        const usableW = Math.max(180, r.left - 10);
        fracX = Math.min(1, usableW / vw);
        anchorX = fracX - 1;
      }
    }

    // Board half-extents as seen through the current orbit, so the fit is
    // tight without clipping when the view is rotated.
    const ca = Math.abs(Math.cos(this.camState.azimuth));
    const sa = Math.abs(Math.sin(this.camState.azimuth));
    const extX = halfW * ca + halfD * sa;
    const extZ = halfW * sa + halfD * ca;
    const foreshorten = Math.max(0.35, Math.cos(this.camState.polar));

    const tanV = Math.tan((this.camera.fov * Math.PI / 180) / 2);
    const tanH = tanV * this.camera.aspect;
    // The near edge of the board is closer to the camera, so it projects larger
    // than the board centre; add its depth extent to the required distance.
    const depth = extZ * foreshorten;
    const distH = extX / (tanH * fracX) + depth;
    const distV = depth / (tanV * fracY) + depth;
    this.camState.radius = Math.min(14000, Math.max(760, Math.max(distH, distV) * 1.05));
    this.camAnchor.x = anchorX;
    this.camAnchor.y = anchorY;
    this.updateCamera(instant);
  }

  resetView() {
    this.camState.azimuth = 0;
    this.camState.polar = 0.82;
    this.fitCamera();
  }

  /* ---------------- loop ---------------- */

  update(dt) {
    if (this.mode !== 'play') return;
    if (this.phase === 'wait') {
      this.timer += dt;
      if (this.timer >= WAIT_FRAMES / 60) { this.phase = 'start'; this.timer = 0; }
    } else if (this.phase === 'start') {
      this.timer += dt;
      const left = START_FRAMES / 60 - this.timer;
      if (left > 0) this.showBanner(String(Math.ceil(left)), 'Get ready…');
      else {
        this.showBanner('GO!', '');
        setTimeout(() => this.hideBanner(), 650);
        this.phase = 'play';
        this.playTimer = PLAY_FRAMES;
      }
    } else if (this.phase === 'play') {
      if (this.playTimer === WARN_FRAMES) {
        this.toast('30 seconds left!', 1800);
      }
      this.playTimer--;
      if (this.playTimer <= 0) {
        this.toast('Time up!', 1600);
        this.endRound();
      }
      this.updateHUD();
    } else if (this.phase === 'bomb') {
      this.updateBomb(dt);
    } else if (this.phase === 'clear') {
      this.clearTimer += dt;
      if (this.clearTimer > 1.15 && !this.resultShown) {
        this.resultShown = true;
        this.showResult();
      }
    }

    this.shake = Math.max(0, this.shake - dt * 1.8);

    if (this.phase === 'play') {
      const idx = this.selected.row * this.variant.cols + this.selected.col;
      const p = this.cellPos[idx];
      this.highlight.visible = true;
      this.highlight.position.set(p.x, 12, p.z);
      const pulse = 1 + Math.sin(performance.now() / 220) * 0.06;
      this.highlight.scale.setScalar(pulse);
      this.highlight.material.opacity = this.board.cells[idx].dug ? 0.18 : 0.95;
    } else {
      this.highlight.visible = false;
    }
  }

  animate() {
    requestAnimationFrame(this.animate);
    this.acc += this.clock.getDelta();
    const step = 1 / 60;
    let guard = 0;
    while (this.acc >= step && guard++ < 8) {
      this.update(step);
      this.acc -= step;
    }
    this.updateFx(Math.min(this.acc + step, 0.05));
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  /* ---------------- UI ---------------- */

  fmtTime(frames) {
    const s = Math.max(0, Math.ceil(frames / 60));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  updateHUD() {
    document.getElementById('score').textContent = this.score;
    document.getElementById('target').innerHTML = `Target <b>${this.variant.target}</b>`;
    document.getElementById('stage-label').textContent = `${this.variant.label} · thrill digger`;
    const t = document.getElementById('timer');
    t.textContent = this.fmtTime(this.playTimer);
    t.classList.toggle('warn', this.playTimer <= WARN_FRAMES);
    document.getElementById('c-green').textContent = this.collected.green;
    document.getElementById('c-blue').textContent = this.collected.blue;
    document.getElementById('c-red').textContent = this.collected.red;
    document.getElementById('c-silver').textContent = this.collected.silver;
    document.getElementById('c-gold').textContent = this.collected.gold;
    document.getElementById('c-rupoor').textContent = this.collected.rupoor;
  }

  showBanner(big, sub) {
    const b = document.getElementById('banner');
    b.innerHTML = `<div class="big">${big}</div>${sub ? `<div class="sub">${sub}</div>` : ''}`;
  }
  hideBanner() { document.getElementById('banner').innerHTML = ''; }

  toast(msg, ms) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.toggle('show', !!msg);
    clearTimeout(this._toast);
    if (ms) this._toast = setTimeout(() => el.classList.remove('show'), ms);
  }

  setHint(html) { document.getElementById('hint').innerHTML = html; }
  showOverlay(v) {
    document.getElementById('overlay').classList.toggle('hidden', !v);
    document.body.classList.toggle('overlay-open', v);
    if (!v) this.fitCamera();
  }

  showResult() {
    const win = this.score >= this.variant.target;
    const reason = this.bombed ? 'Bomb!' : (this.cleared ? 'Board cleared!' : 'Time up!');
    const gem = (col) => `<span class="gem" style="background:${col}"></span>`;
    document.getElementById('card-body').innerHTML = `
      <h2 class="${win ? '' : ''}">${win ? 'You reached the target!' : 'Round over'}</h2>
      <div class="result-score">${this.score}</div>
      <div class="result-msg">Target ${this.variant.target} · ${reason}</div>
      <div class="breakdown">
        <div class="rc">${gem('#3fa34d')}×${this.collected.green}</div>
        <div class="rc">${gem('#2f6fd0')}×${this.collected.blue}</div>
        <div class="rc">${gem('#c0392b')}×${this.collected.red}</div>
        <div class="rc">${gem('#aeb6bd')}×${this.collected.silver}</div>
        <div class="rc">${gem('#e6b800')}×${this.collected.gold}</div>
        <div class="rc">${gem('#7a4bb5')}×${this.collected.rupoor}</div>
      </div>
      <button class="primary" id="again">Dig again</button>
      <button class="ghost" id="menu">Change difficulty</button>
    `;
    this.showOverlay(true);
    document.getElementById('again').onclick = () => {
      this.resultShown = false;
      this.startGame(this.difficulty);
    };
    document.getElementById('menu').onclick = () => { this.resultShown = false; this.showMenu(); };
  }

  showMenu() {
    const diffs = Object.values(VARIANTS).map((v) => `
      <div class="diff ${v.key === this.difficulty ? 'active' : ''}" data-diff="${v.key}">
        <div class="n">${v.label}</div>
        <div class="d">${v.rows}×${v.cols} · ${v.bombs} bombs · ${v.rupoors} rupoors</div>
        <div class="d">target ${v.target} pts</div>
        <div class="fee">entry ${v.fee} rupees</div>
      </div>`).join('');
    document.getElementById('card-body').innerHTML = `
      <div class="diffs">${diffs}</div>
      <button class="primary" id="start">Start digging</button>
      <div class="credits">
        Thrill Digger — dig for rupees, dodge the bombs.
      </div>
    `;
    document.querySelectorAll('.diff').forEach((el) => {
      el.onclick = () => {
        this.difficulty = el.dataset.diff;
        document.querySelectorAll('.diff').forEach((d) => d.classList.toggle('active', d === el));
      };
    });
    document.getElementById('start').onclick = () => this.startGame(this.difficulty);
    this.phase = 'menu';
    this.resultShown = false;
    this.showOverlay(true);
  }
}

/* ------------------------------------------------------------------ *
 *  Boot
 * ------------------------------------------------------------------ */

(async function main() {
  const game = new ThrillDigger(document.getElementById('app'));
  window.__thrill = game;
  try {
    await game.load();
  } catch (err) {
    document.getElementById('card-body').innerHTML =
      `<div class="spinner">Failed to load assets.<br><small>${err.message}</small><br><br>
       Serve this folder over HTTP (e.g. <code>python3 -m http.server</code>) rather than opening the file directly.</div>`;
    console.error(err);
    return;
  }
  game.updateCamera(true);
  game.showMenu();

  // Optional deep link: ?start=easy|normal|hard jumps straight into a round.
  const params = new URLSearchParams(location.search);
  if (params.has('start')) {
    const key = params.get('start');
    game.startGame(VARIANTS[key] ? key : 'normal');
  }
})();