import Matter from 'matter-js';
import * as Tone from 'tone';

const { Engine, Composite, Bodies, Body, Events } = Matter;

// ---------- сетка ----------
const CELL = 20;
let W = 0, H = 0, COLS = 0, ROWS = 0;
let grid = new Uint8Array(0); // 0 пусто, иначе id цвета

// id цветов и их роли
const JELLY = 1, BOUNCE = 2, SPIN = 3, ARP = 4, SPLIT = 5;

const CELL_FILL = {
  [JELLY]: '#cfa9f0',
  [BOUNCE]: '#f2dd8a',
  [SPIN]: '#8fd8f0',
  [ARP]: '#a3e69d',
  [SPLIT]: '#f7b3c8',
};

// ---------- canvas ----------
const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');
const gridCanvas = document.createElement('canvas');
const gctx = gridCanvas.getContext('2d');
let gridDirty = true;

let DPR = 1;
function resize() {
  // полный DPR (на iPhone это 3): кап давал мыльную картинку
  DPR = Math.min(window.devicePixelRatio || 1, 3);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.imageSmoothingEnabled = false;
  gridCanvas.width = canvas.width;
  gridCanvas.height = canvas.height;
  gctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  const cols = Math.ceil(W / CELL);
  const rows = Math.ceil(H / CELL);
  if (cols !== COLS || rows !== ROWS) {
    const next = new Uint8Array(cols * rows);
    for (let y = 0; y < Math.min(rows, ROWS); y++)
      for (let x = 0; x < Math.min(cols, COLS); x++)
        next[y * cols + x] = grid[y * COLS + x];
    COLS = cols;
    ROWS = rows;
    grid = next;
    rebuildSolidBodies();
  }
  gridDirty = true;
}

function safeTop() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--sat');
  return parseFloat(v) || 0;
}

// ---------- audio ----------
const master = new Tone.Limiter(-2).toDestination();

// жёлтый: щипок с огромным реверб-хвостом
const reverb = new Tone.Reverb({ decay: 7, preDelay: 0.02, wet: 0.55 }).connect(master);
// синий: feedback delay для центрифуги
const delayBus = new Tone.FeedbackDelay(0.28, 0.55).connect(master);
// зелёный: пинг-понг для зиппер-арпеджио
const arpBus = new Tone.PingPongDelay(0.13, 0.35).connect(master);
arpBus.wet.value = 0.4;
// розовый: хрустящий сплит
const distBus = new Tone.Filter(2400, 'lowpass').connect(master);
const dist = new Tone.Distortion(0.7).connect(distBus);
// фиолетовый: тёплый пад — фильтр -> хорус -> мягкий реверб
const jellyVerb = new Tone.Reverb({ decay: 5, preDelay: 0.03, wet: 0.4 }).connect(master);
const jellyChorus = new Tone.Chorus(0.4, 4.5, 0.3).connect(jellyVerb).start();
const jellyFilter = new Tone.Filter(850, 'lowpass', -12).connect(jellyChorus);

function makeSynth(dest, opts = {}) {
  const s = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.002, decay: 0.28, sustain: 0, release: 0.25 },
    volume: -8,
    ...opts,
  });
  s.connect(dest);
  return s;
}

const synths = {
  bounce: makeSynth(reverb),
  spin: makeSynth(delayBus, { volume: -10 }),
  arp: makeSynth(arpBus, {
    volume: -12,
    envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.08 },
  }),
  split: makeSynth(dist, { oscillator: { type: 'square' }, volume: -16 }),
  spawn: makeSynth(master, { volume: -20, oscillator: { type: 'sine' } }),
};

// пул голосов для желе: пад живёт, пока шарик внутри.
// fat-осцилляторы (расстроенный унисон) + медленная атака = мягкий хор
const jellyVoices = Array.from({ length: 4 }, () => {
  const v = new Tone.Synth({
    oscillator: { type: 'fattriangle', count: 3, spread: 16 },
    envelope: { attack: 1.1, decay: 0.6, sustain: 0.7, release: 2.4 },
    volume: -15,
  }).connect(jellyFilter);
  v._busy = false;
  return v;
});

let audioReady = false;

// Зацикленный тихий <audio> переводит аудиосессию iOS в режим playback,
// поэтому WebAudio звучит даже при включённом беззвучном переключателе.
function makeSilentWavUrl(seconds = 1) {
  const sampleRate = 8000;
  const numSamples = Math.floor(sampleRate * seconds);
  const dataSize = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, dataSize, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

let silentEl = null;
function unlockIOSAudio() {
  if (!silentEl) {
    silentEl = document.createElement('audio');
    silentEl.src = makeSilentWavUrl(1);
    silentEl.loop = true;
    silentEl.setAttribute('playsinline', '');
  }
  silentEl.play().catch(() => {});
}

async function ensureAudio() {
  if (audioReady) return;
  unlockIOSAudio();
  await Tone.start();
  await Tone.getContext().resume();
  audioReady = true;
}

const SCALE = ['C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5', 'G5', 'A5'];

function play(synth, noteIdx, velocity, dur = 0.2) {
  if (!audioReady) return;
  const note = SCALE[((noteIdx % SCALE.length) + SCALE.length) % SCALE.length];
  const t = Tone.now() + Math.random() * 0.008;
  synth.triggerAttackRelease(note, dur, t, velocity);
}

// ---------- физика ----------
const engine = Engine.create({ gravity: { x: 0, y: 0.55 } });
const world = engine.world;

const BALL_R = 7;
const MAX_BALLS = 70;
const BASE_FRICTION_AIR = 0.0012;

const balls = [];
const solidBodies = new Map(); // idx ячейки -> статическое тело (жёлтые)
const lastHit = new Map();
const cellFlash = new Map(); // idx -> 0..1

// ---------- аркадный джус: партиклы и тряска ----------
const particles = [];
const MAX_PARTICLES = 350;

function burst(x, y, color, n = 10, speed = 3) {
  for (let i = 0; i < n && particles.length < MAX_PARTICLES; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.4 + Math.random() * 0.9);
    particles.push({
      kind: 'dot', x, y,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s - speed * 0.35,
      size: 1.5 + Math.random() * 2.5,
      color, life: 1, decay: 0.02 + Math.random() * 0.025, g: 0.14,
    });
  }
}

function ring(x, y, color, size = 8, vsize = 2.4) {
  if (particles.length < MAX_PARTICLES)
    particles.push({ kind: 'ring', x, y, size, vsize, color, life: 1, decay: 0.055 });
}

let shakeMag = 0;
function shake(m) { shakeMag = Math.min(5, shakeMag + m * 0.45); }

function updateParticles(dt) {
  const k = dt / 16.7;
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= p.decay * k;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    if (p.kind === 'dot') {
      p.x += p.vx * k;
      p.y += p.vy * k;
      p.vy += p.g * k;
      p.vx *= 0.985;
    } else {
      p.size += p.vsize * k;
    }
  }
  shakeMag *= Math.pow(0.86, k);
  if (shakeMag < 0.05) shakeMag = 0;
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
    if (p.kind === 'dot') {
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 0.5 + 2 * p.life;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

let noteIndex = 0;
const emitter = { x: 0, y: 0 };
function placeEmitter() {
  emitter.x = W / 2;
  emitter.y = Math.round(safeTop() + 18);
}

function cellIdxAt(x, y) {
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return -1;
  return cy * COLS + cx;
}

function colorAt(x, y) {
  const i = cellIdxAt(x, y);
  return i < 0 ? 0 : grid[i];
}

function addSolidBody(idx) {
  const cx = idx % COLS, cy = (idx / COLS) | 0;
  const b = Bodies.rectangle(cx * CELL + CELL / 2, cy * CELL + CELL / 2, CELL, CELL, {
    isStatic: true,
    restitution: 0.9,
    friction: 0.01,
    label: 'cell',
  });
  b.plugin.idx = idx;
  Composite.add(world, b);
  solidBodies.set(idx, b);
}

function removeSolidBody(idx) {
  const b = solidBodies.get(idx);
  if (b) { Composite.remove(world, b); solidBodies.delete(idx); }
}

function rebuildSolidBodies() {
  solidBodies.forEach((b) => Composite.remove(world, b));
  solidBodies.clear();
  for (let i = 0; i < grid.length; i++) if (grid[i] === BOUNCE) addSolidBody(i);
}

function setCell(cx, cy, color) {
  if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return;
  const idx = cy * COLS + cx;
  if (grid[idx] === color) return;
  if (grid[idx] === BOUNCE) removeSolidBody(idx);
  grid[idx] = color;
  if (color === BOUNCE) addSolidBody(idx);
  cellFlash.set(idx, 0.5); // короткий поп при покраске/стирании
  gridDirty = true;
}

function spawnBall(noteIdx = noteIndex++, x = emitter.x, y = emitter.y, vel = null, gen = 0) {
  if (balls.length >= MAX_BALLS) return null;
  const b = Bodies.circle(x + (Math.random() - 0.5) * 2, y, BALL_R, {
    restitution: 0.72,
    friction: 0.005,
    frictionAir: BASE_FRICTION_AIR,
    density: 0.002,
    label: 'ball',
  });
  b.plugin.noteIdx = noteIdx;
  b.plugin.hue = (noteIdx * 36) % 360;
  b.plugin.zone = 0;
  b.plugin.gen = gen;
  b.plugin.spin = null;
  b.plugin.jellyVoice = null;
  b.plugin.arp = null;
  b.plugin.splitCool = 0;
  b.plugin.noSpinUntil = 0;
  b.plugin.born = performance.now();
  b.plugin.squash = 0;
  b.plugin.trail = [];
  if (vel) Body.setVelocity(b, vel);
  Composite.add(world, b);
  balls.push(b);
  ring(x, y, `hsl(${b.plugin.hue} 70% 55%)`, 5, 1.8);
  emitterPulse = 1;
  return b;
}

function removeBall(b) {
  releaseJelly(b);
  Composite.remove(world, b);
  const i = balls.indexOf(b);
  if (i !== -1) balls.splice(i, 1);
  lastHit.forEach((_, k) => { if (k.startsWith(b.id + ':')) lastHit.delete(k); });
}

// жёлтые ячейки — обычные столкновения
Events.on(engine, 'collisionStart', (e) => {
  for (const pair of e.pairs) {
    const { bodyA, bodyB } = pair;
    const ball = bodyA.label === 'ball' ? bodyA : bodyB.label === 'ball' ? bodyB : null;
    const cell = bodyA.label === 'cell' ? bodyA : bodyB.label === 'cell' ? bodyB : null;
    if (!ball || !cell) continue;

    const speed = Math.hypot(ball.velocity.x, ball.velocity.y);
    if (speed < 0.7) continue;

    const key = ball.id + ':' + cell.id;
    const now = performance.now();
    if (now - (lastHit.get(key) || 0) < 130) continue;
    lastHit.set(key, now);

    play(synths.bounce, ball.plugin.noteIdx, Math.min(1, 0.3 + speed / 14));
    cellFlash.set(cell.plugin.idx, 1);
    // джус: тряска, сквош, брызги и ударная волна
    shake(Math.min(6, speed * 0.4));
    ball.plugin.squash = 1;
    burst(ball.position.x, ball.position.y, '#eccb54', 4 + Math.min(8, speed | 0), 2 + speed * 0.25);
    ring(ball.position.x, ball.position.y, '#d9b83a', 6, 2.8);
  }
});

// ---------- эффекты полей ----------

function attackJelly(b) {
  const voice = jellyVoices.find((v) => !v._busy);
  if (!voice) return;
  voice._busy = true;
  if (audioReady) {
    const note = SCALE[b.plugin.noteIdx % SCALE.length];
    voice.triggerAttack(note, Tone.now(), 0.5);
  }
  b.plugin.jellyVoice = voice;
  b.plugin.jellyT = 0;
}

function releaseJelly(b) {
  const voice = b.plugin.jellyVoice;
  if (!voice) return;
  b.plugin.jellyVoice = null;
  voice.triggerRelease();
  setTimeout(() => { voice._busy = false; }, 1600);
}

// центр и радиус связной кляксы цвета color (BFS от точки входа)
function blobOf(startIdx, color) {
  const seen = new Set([startIdx]);
  const queue = [startIdx];
  let sx = 0, sy = 0, n = 0;
  while (queue.length && n < 300) {
    const i = queue.pop();
    const cx = i % COLS, cy = (i / COLS) | 0;
    sx += cx; sy += cy; n++;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
      const j = ny * COLS + nx;
      if (!seen.has(j) && grid[j] === color) { seen.add(j); queue.push(j); }
    }
  }
  const mx = (sx / n + 0.5) * CELL;
  const my = (sy / n + 0.5) * CELL;
  const radius = Math.max(CELL, Math.sqrt(n / Math.PI) * CELL);
  return { mx, my, radius };
}

function updateBallEffects(b, dt, now) {
  // --- центрифуга: пока крутимся, кинематика своя ---
  if (b.plugin.spin) {
    const s = b.plugin.spin;
    s.t += dt;
    // вдвое спокойнее: медленнее вращение и мягче раскрутка наружу
    s.omega = 0.0021 + s.t * 0.0000018;
    s.ang += s.omega * dt;
    s.r += dt * 0.006 * (1 + s.t / 1100);
    const px = s.mx + Math.cos(s.ang) * s.r;
    const py = s.my + Math.sin(s.ang) * s.r;
    Body.setPosition(b, { x: px, y: py });
    const speed = s.omega * s.r * 16;
    Body.setVelocity(b, { x: -Math.sin(s.ang) * speed, y: Math.cos(s.ang) * speed });

    if (now >= s.nextTrig) {
      s.step++;
      play(synths.spin, b.plugin.noteIdx + s.step, 0.32, 0.12);
      s.nextTrig = now + Math.max(150, 340 - s.t / 16);
    }
    if (s.r > s.radius + CELL * 0.8) {
      // выплёвываем: октава вверх, тангенциальный вылет
      play(synths.spin, b.plugin.noteIdx + 5, 0.55, 0.25);
      burst(b.position.x, b.position.y, '#5cc4e8', 10, 3.5);
      ring(b.position.x, b.position.y, '#5cc4e8', 8, 3.2);
      shake(1.5);
      b.plugin.spin = null;
      b.plugin.noSpinUntil = now + 800;
    }
    return;
  }

  const zone = colorAt(b.position.x, b.position.y);
  const prev = b.plugin.zone;

  if (zone !== prev) {
    // выходы
    if (prev === JELLY) {
      b.frictionAir = BASE_FRICTION_AIR;
      releaseJelly(b);
    }
    if (prev === ARP) {
      b.frictionAir = BASE_FRICTION_AIR;
      b.plugin.arp = null;
    }
    // входы
    if (zone === JELLY) {
      b.frictionAir = 0.09;
      Body.setVelocity(b, { x: b.velocity.x * 0.25, y: b.velocity.y * 0.25 });
      ring(b.position.x, b.position.y, '#b285e0', 10, 1.4);
      attackJelly(b);
    }
    if (zone === ARP) {
      // сильное замедление: шарик почти зависает и пульсирует в ритм
      b.frictionAir = 0.16;
      Body.setVelocity(b, { x: b.velocity.x * 0.35, y: b.velocity.y * 0.35 });
      b.plugin.arp = { next: now, step: 0, pulse: 0 };
    }
    if (zone === SPIN && now >= b.plugin.noSpinUntil) {
      const { mx, my, radius } = blobOf(cellIdxAt(b.position.x, b.position.y), SPIN);
      b.plugin.spin = {
        mx, my, radius,
        ang: Math.atan2(b.position.y - my, b.position.x - mx),
        r: Math.max(4, Math.hypot(b.position.x - mx, b.position.y - my) * 0.5),
        t: 0, omega: 0.004, step: 0, nextTrig: now,
      };
      play(synths.spin, b.plugin.noteIdx, 0.5, 0.2);
    }
    if (zone === SPLIT && now >= b.plugin.splitCool) {
      b.plugin.splitCool = now + 500;
      // отталкиваем от центра кляксы
      const { mx, my } = blobOf(cellIdxAt(b.position.x, b.position.y), SPLIT);
      let dx = b.position.x - mx, dy = b.position.y - my;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
      const speed = Math.max(7, Math.hypot(b.velocity.x, b.velocity.y) * 1.1);
      const rot = (vx, vy, a) => ({
        x: vx * Math.cos(a) - vy * Math.sin(a),
        y: vx * Math.sin(a) + vy * Math.cos(a),
      });
      Body.setVelocity(b, rot(dx * speed, dy * speed, -0.35));
      // дубль той же ноты разлетается веером в другую сторону
      if (b.plugin.gen < 2 && balls.length < MAX_BALLS) {
        const clone = spawnBall(
          b.plugin.noteIdx, b.position.x, b.position.y,
          rot(dx * speed, dy * speed, 0.35), b.plugin.gen + 1
        );
        if (clone) clone.plugin.splitCool = now + 500;
      }
      burst(b.position.x, b.position.y, '#f28cb0', 14, 4);
      ring(b.position.x, b.position.y, '#f28cb0', 7, 3);
      shake(2.5);
      play(synths.split, b.plugin.noteIdx, 0.7, 0.15);
    }
    b.plugin.zone = zone;
  }

  // --- поведение внутри полей ---
  if (zone === JELLY) {
    b.plugin.jellyT = (b.plugin.jellyT || 0) + dt;
    const t = b.plugin.jellyT;
    // почти полная компенсация гравитации + ленивое покачивание
    const g = b.mass * 0.001 * engine.gravity.y;
    Body.applyForce(b, b.position, {
      x: Math.sin(t * 0.003 + b.id) * g * 0.35,
      y: -g * 0.93,
    });
    const voice = b.plugin.jellyVoice;
    if (voice) {
      // еле заметное дыхание вместо скрипучей вибрации
      voice.detune.value = Math.sin(t * 0.0009 + b.id) * 9;
    }
    jellyFilter.frequency.value = 750 + 250 * Math.sin(now * 0.0005);
  } else if (zone === ARP && b.plugin.arp) {
    const a = b.plugin.arp;
    a.pulse = Math.max(0, a.pulse - dt * 0.005);
    if (now >= a.next) {
      play(synths.arp, b.plugin.noteIdx + a.step, 0.4, 0.08);
      a.step++;
      a.pulse = 1; // вспышка размера + смена формы в ритм
      a.next = now + 175;
    }
  }
}

// ---------- стартовый экран ----------
const startScreen = document.getElementById('start-screen');
let started = false;
document.getElementById('startBtn').addEventListener('click', async () => {
  await ensureAudio();
  placeEmitter();
  if (!grid.some((c) => c !== 0)) seedDemo();
  started = true;
  startScreen.classList.add('hidden');
  setTimeout(() => startScreen.remove(), 450);
});

function paintBlob(cx, cy, w, h, color) {
  for (let y = cy; y < cy + h; y++)
    for (let x = cx; x < cx + w; x++)
      setCell(x, y, color);
}

function seedDemo() {
  const mx = (COLS / 2) | 0;
  // жёлтая лесенка
  for (let i = 0; i < 6; i++) paintBlob(mx - 6 + i, ((ROWS * 0.24) | 0) + i, 2, 1, BOUNCE);
  // синяя клякса
  paintBlob(mx + 1, (ROWS * 0.42) | 0, 6, 3, SPIN);
  paintBlob(mx + 2, ((ROWS * 0.42) | 0) - 1, 3, 1, SPIN);
  // фиолетовое желе
  paintBlob(mx - 8, (ROWS * 0.6) | 0, 9, 4, JELLY);
  paintBlob(mx - 6, ((ROWS * 0.6) | 0) + 4, 6, 2, JELLY);
  // зелёная полоска и розовая точка
  paintBlob(mx - 2, (ROWS * 0.8) | 0, 8, 2, ARP);
  paintBlob(mx - 7, (ROWS * 0.86) | 0, 2, 2, SPLIT);
}

// ---------- state / UI ----------
let running = true;
let bpm = 120;
let tool = 'paint'; // paint | erase  (перетаскивание пока закомментировано)
let paintColor = JELLY;

const tempoInput = document.getElementById('tempo');
const bpmLabel = document.getElementById('bpmLabel');
tempoInput.addEventListener('input', () => {
  bpm = Number(tempoInput.value);
  bpmLabel.textContent = bpm;
});

const playBtn = document.getElementById('playBtn');
playBtn.addEventListener('click', () => {
  running = !running;
  playBtn.textContent = running ? '⏸' : '▶';
});

document.getElementById('clearBtn').addEventListener('click', () => {
  grid.fill(0);
  rebuildSolidBodies();
  gridDirty = true;
});

const eraserBtn = document.getElementById('eraserBtn');
const palette = document.getElementById('palette');

function setTool(next, color = paintColor) {
  tool = next;
  paintColor = color;
  eraserBtn.classList.toggle('active', tool === 'erase');
  palette.querySelectorAll('.swatch').forEach((s) =>
    s.classList.toggle('active', tool === 'paint' && Number(s.dataset.color) === paintColor));
}

eraserBtn.addEventListener('click', () => setTool(tool === 'erase' ? 'paint' : 'erase'));
palette.addEventListener('click', (e) => {
  const sw = e.target.closest('.swatch');
  if (sw) setTool('paint', Number(sw.dataset.color));
});

// ---------- pointer: покраска / ластик ----------
let painting = false;
let lastPoint = null;

function pos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function applyAt(p) {
  const cx = Math.floor(p.x / CELL);
  const cy = Math.floor(p.y / CELL);
  if (tool === 'paint') {
    setCell(cx, cy, paintColor);
  } else {
    // ластик 4×4 ячейки
    for (let y = cy - 2; y < cy + 2; y++)
      for (let x = cx - 2; x < cx + 2; x++)
        setCell(x, y, 0);
  }
}

function applyStroke(from, to) {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / (CELL / 2)));
  for (let i = 0; i <= steps; i++) {
    applyAt({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
  }
}

canvas.addEventListener('pointerdown', (e) => {
  ensureAudio();
  canvas.setPointerCapture(e.pointerId);
  painting = true;
  lastPoint = pos(e);
  applyAt(lastPoint);
});

canvas.addEventListener('pointermove', (e) => {
  if (!painting) return;
  const p = pos(e);
  applyStroke(lastPoint, p);
  lastPoint = p;
});

canvas.addEventListener('pointerup', () => { painting = false; lastPoint = null; });
canvas.addEventListener('pointercancel', () => { painting = false; lastPoint = null; });

/*
// перетаскивание преград (закомментировано на время сеточной версии)
// function barrierAt(p, tol) { ... }
// canvas pointerdown: dragging = { body, dx, dy }
// canvas pointermove: Body.setPosition(dragging.body, ...)
*/

// ---------- рендер ----------
function redrawGrid() {
  gctx.clearRect(0, 0, W, H);
  gctx.fillStyle = '#f6f2ea';
  gctx.fillRect(0, 0, W, H);

  const at = (x, y) => (x < 0 || y < 0 || x >= COLS || y >= ROWS ? 0 : grid[y * COLS + x]);

  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const c = grid[cy * COLS + cx];
      const x = cx * CELL, y = cy * CELL;
      if (!c) {
        gctx.fillStyle = '#ded4c4';
        gctx.beginPath();
        gctx.arc(x + CELL / 2, y + CELL / 2, 1.5, 0, Math.PI * 2); // точка 3×3
        gctx.fill();
        continue;
      }
      // скругляем только внешние углы кляксы
      const r = 8;
      const tl = at(cx - 1, cy) !== c && at(cx, cy - 1) !== c ? r : 0;
      const tr = at(cx + 1, cy) !== c && at(cx, cy - 1) !== c ? r : 0;
      const br = at(cx + 1, cy) !== c && at(cx, cy + 1) !== c ? r : 0;
      const bl = at(cx - 1, cy) !== c && at(cx, cy + 1) !== c ? r : 0;
      gctx.fillStyle = CELL_FILL[c];
      gctx.beginPath();
      gctx.roundRect(x, y, CELL + 0.5, CELL + 0.5, [tl, tr, br, bl]);
      gctx.fill();
      gctx.fillStyle = 'rgba(255,255,255,0.85)';
      gctx.beginPath();
      gctx.arc(x + CELL / 2, y + CELL / 2, 1.5, 0, Math.PI * 2); // точка 3×3
      gctx.fill();
    }
  }
  gridDirty = false;
}

let emitterPulse = 0;

function drawEmitter(t) {
  emitterPulse = Math.max(0, emitterPulse - 0.05);
  const pulse = 1 + 0.08 * Math.sin(t / 250) + emitterPulse * 0.45;
  ctx.save();
  ctx.strokeStyle = '#26222b';
  ctx.lineWidth = 2 + emitterPulse * 1.5;
  ctx.beginPath();
  ctx.arc(emitter.x, emitter.y, 11 * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#26222b';
  ctx.beginPath();
  ctx.arc(emitter.x, emitter.y, 3.5 * (1 + emitterPulse * 0.6), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawTrails() {
  for (const b of balls) {
    const tr = b.plugin.trail;
    for (let i = 0; i < tr.length; i++) {
      const p = tr[i];
      const f = (i + 1) / tr.length;
      ctx.globalAlpha = f * 0.16;
      ctx.fillStyle = `hsl(${b.plugin.hue} 70% 55%)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, BALL_R * f * 0.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

// easeOutBack — поп с перелётом при рождении шарика
function popScale(t) {
  if (t >= 1) return 1;
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function drawBall(b, now) {
  const { x, y } = b.position;
  const hue = b.plugin.hue;
  ctx.save();
  ctx.translate(x, y);

  // поп при рождении
  const born = Math.min(1, (now - b.plugin.born) / 220);
  let r = BALL_R * Math.max(0.05, popScale(born));

  // в зелёном поле: пульс размера + морф круг -> квадрат -> треугольник
  const a = b.plugin.zone === ARP ? b.plugin.arp : null;
  const shape = a ? a.step % 3 : 0;
  const flashing = a && a.pulse > 0.4; // на смене формы вспыхивает белым
  if (a) r *= 1 + a.pulse * 0.5; // пульс размера на каждой смене формы

  if (!a) {
    // сквош-стретч по направлению скорости — аркадное ощущение веса (мягко)
    const sp = Math.hypot(b.velocity.x, b.velocity.y);
    const stretch = (1 + Math.min(0.16, sp * 0.007)) * (1 - 0.2 * b.plugin.squash);
    ctx.rotate(Math.atan2(b.velocity.y, b.velocity.x));
    ctx.scale(stretch, 1 / stretch);
  } else {
    ctx.rotate(Math.sin(now * 0.004 + b.id) * 0.35); // формы слегка покачиваются
  }

  ctx.beginPath();
  if (shape === 1) {
    const s = r * 1.7;
    ctx.rect(-s / 2, -s / 2, s, s);
  } else if (shape === 2) {
    const rr = r * 1.35;
    ctx.moveTo(0, -rr);
    ctx.lineTo(rr * 0.866, rr * 0.5);
    ctx.lineTo(-rr * 0.866, rr * 0.5);
    ctx.closePath();
  } else {
    ctx.arc(0, 0, r, 0, Math.PI * 2);
  }
  ctx.fillStyle = flashing ? '#ffffff' : `hsl(${hue} 70% 55%)`;
  ctx.fill();
  ctx.restore();
}

function drawFlashes() {
  cellFlash.forEach((v, idx) => {
    const cx = idx % COLS, cy = (idx / COLS) | 0;
    ctx.fillStyle = `rgba(255,255,255,${v * 0.7})`;
    ctx.fillRect(cx * CELL, cy * CELL, CELL, CELL);
    const next = v - 0.07;
    if (next <= 0) cellFlash.delete(idx);
    else cellFlash.set(idx, next);
  });
}

// ---------- loop ----------
let last = performance.now();
let spawnAcc = 0;

function frame(now) {
  const dt = Math.min(now - last, 50);
  last = now;

  if (started && running) {
    spawnAcc += dt;
    const interval = 60000 / bpm;
    while (spawnAcc >= interval) {
      spawnAcc -= interval;
      const b = spawnBall();
      if (b) play(synths.spawn, b.plugin.noteIdx, 0.2, 0.1);
    }
  }

  for (const b of balls) {
    updateBallEffects(b, dt, now);
    b.plugin.squash = Math.max(0, b.plugin.squash - dt * 0.007);
    const tr = b.plugin.trail;
    tr.push({ x: b.position.x, y: b.position.y });
    if (tr.length > 3) tr.shift();
  }

  Engine.update(engine, dt);
  updateParticles(dt);

  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    if (b.position.y > H + 120 || b.position.x < -120 || b.position.x > W + 120) removeBall(b);
  }

  if (gridDirty) redrawGrid();
  // тряска экрана: общий сдвиг и для блита сетки, и для мира
  const shx = (Math.random() * 2 - 1) * shakeMag;
  const shy = (Math.random() * 2 - 1) * shakeMag;
  // кэш сетки блитаем 1:1 в device-пикселях (без масштаба и сглаживания) — резко
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(gridCanvas, Math.round(shx * DPR), Math.round(shy * DPR));
  ctx.setTransform(DPR, 0, 0, DPR, shx * DPR, shy * DPR);
  drawFlashes();
  drawTrails();
  drawParticles();
  drawEmitter(now);
  balls.forEach((b) => drawBall(b, now));
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  requestAnimationFrame(frame);
}

resize();
placeEmitter();
window.addEventListener('resize', () => { resize(); placeEmitter(); });
window.addEventListener('orientationchange', () => { resize(); placeEmitter(); });
requestAnimationFrame(frame);
