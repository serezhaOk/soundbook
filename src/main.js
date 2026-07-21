import Matter from 'matter-js';
import * as Tone from 'tone';
import SAMPLE_MAP from './sample-map.json';

const { Engine, Composite, Bodies, Body, Events } = Matter;

// ---------- сетка ----------
const CELL = 20;
let W = 0, H = 0, COLS = 0, ROWS = 0;
let grid = new Uint8Array(0); // 0 пусто, иначе id цвета

// id цветов и их роли
const JELLY = 1, BOUNCE = 2, SPIN = 3, ARP = 4, SPLIT = 5;

// цвета точно из палитры макета
const CELL_FILL = {
  [JELLY]: '#c9a3ed',
  [BOUNCE]: '#f6ce5c',
  [SPIN]: '#83c9ed',
  [ARP]: '#a7e29b',
  [SPLIT]: '#f58f8b',
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

// ---------- audio: сэмплерный движок v2 ----------
const BPM = 120;

// мастер-шина: EQ -> глю-компрессор -> лимитер
const limiter = new Tone.Limiter(-1).toDestination();
const glue = new Tone.Compressor({ threshold: -18, ratio: 3, attack: 0.01, release: 0.18 }).connect(limiter);
const master = new Tone.EQ3({ low: -1, mid: 0, high: 1.5 }).connect(glue);

// общий реверб-send + shimmer (октава вверх внутрь реверба — «поющий» хвост)
const reverb = new Tone.Reverb({ decay: 6.5, preDelay: 0.02, wet: 1 }).connect(master);
const shimmer = new Tone.PitchShift({ pitch: 12, windowSize: 0.08, wet: 1 }).connect(reverb);

// duck-шина: пад и дрон приседают под ударами батута (сайдчейн)
const duck = new Tone.Gain(1).connect(master);

function duckHit(depth = 0.35) {
  const g = duck.gain;
  const t = Tone.now();
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(depth, t + 0.045);
  g.linearRampToValueAtTime(1, t + 0.6);
}

// жёлтый (батут): сухой + send'ы в реверб и shimmer (приглушены под остальные)
const yellowDry = new Tone.Gain(0.6).connect(master);
const yellowRev = new Tone.Gain(0.4).connect(reverb);
const yellowShim = new Tone.Gain(0.16).connect(shimmer);

// синий (центрифуга): delay, синхронный темпу (точечная 1/8)
const blueDelay = new Tone.FeedbackDelay('8n.', 0.5).connect(master);
blueDelay.wet.value = 0.42;
const blueRev = new Tone.Gain(0.22).connect(reverb);

// зелёный (арпеджиатор): свипующий БЭНДПАСС-фильтр в темпе + пинг-понг
const greenPong = new Tone.PingPongDelay('16n', 0.32).connect(master);
greenPong.wet.value = 0.35;
const greenBP = new Tone.AutoFilter({
  frequency: '2n',
  baseFrequency: 260,
  octaves: 3.4,
  filter: { type: 'bandpass', rolloff: -24, Q: 2.4 },
  wet: 1,
}).connect(greenPong).start();

// розовый (сплиттер): тёплый Chebyshev-кранч + суб-удар
const pinkLP = new Tone.Filter(2400, 'lowpass').connect(master);
const pinkCheby = new Tone.Chebyshev(3).connect(pinkLP);
pinkCheby.wet.value = 0.6;
const subKick = new Tone.MembraneSynth({
  pitchDecay: 0.03,
  octaves: 5,
  envelope: { attack: 0.001, decay: 0.32, sustain: 0 },
  volume: -13,
}).connect(master);

// фиолетовый пад: фильтр -> хорус -> реверб -> duck (дакается от батута)
const jellyVerb = new Tone.Reverb({ decay: 5, preDelay: 0.03, wet: 0.4 }).connect(duck);
const jellyChorus = new Tone.Chorus(0.4, 4.5, 0.3).connect(jellyVerb).start();
const jellyFilter = new Tone.Filter(850, 'lowpass', -12).connect(jellyChorus);

// тихий рут-дрон для глубины, тоже под сайдчейном
const droneGain = new Tone.Gain(0).connect(duck);
const droneLP = new Tone.Filter(320, 'lowpass').connect(droneGain);
const droneOsc = [
  new Tone.Oscillator('A2', 'sine').connect(droneLP),
  new Tone.Oscillator('E3', 'sine').connect(droneLP),
];

// пользовательский сэмпл-пак: 11 one-shot инструментов (public/samples),
// корень C4, каждый шарик получает случайный инструмент
const SAMPLE_BASE = import.meta.env.BASE_URL + 'samples/';
const INSTRUMENTS = SAMPLE_MAP.length;

// буферы декодируем один раз и шарим между всеми сэмплерами всех шин
const instBuffers = SAMPLE_MAP.map(
  (m) => new Tone.ToneAudioBuffer(SAMPLE_BASE + encodeURIComponent(m.file))
);

let samplers = null;

function buildSamplers() {
  const mk = (volume, ...dests) => SAMPLE_MAP.map((m, i) => {
    const s = new Tone.Sampler({
      urls: { [m.note]: instBuffers[i] },
      volume: volume + m.gainDb,
      release: 0.7,
    });
    for (const d of dests) s.connect(d);
    return s;
  });
  samplers = {
    bounce: mk(-11, yellowDry, yellowRev, yellowShim),
    spin: mk(-10, blueDelay, blueRev),
    arp: mk(-11, greenBP),
    split: mk(-11, pinkCheby),
    spawn: mk(-26, master),
  };
}

// длительность звучания на цвет (сэмпл живёт до release)
const NOTE_DUR = { bounce: 1.6, spin: 0.7, arp: 0.3, split: 0.6, spawn: 0.4 };

// --- бюджет полифонии: не даём голосам лавинообразно расти (причина фризов) ---
const MAX_VOICES = 16;      // всего одновременно
const PER_KIND_CAP = 5;     // не больше на один цвет -> место остаётся другим
let activeVoices = 0;
const kindActive = { bounce: 0, spin: 0, arp: 0, split: 0, spawn: 0 };

function allocVoice(kind) {
  if (activeVoices >= MAX_VOICES) return false;
  if (kindActive[kind] >= PER_KIND_CAP) return false;
  activeVoices++;
  kindActive[kind]++;
  return true;
}
function freeVoiceLater(kind, ms) {
  setTimeout(() => {
    activeVoices = Math.max(0, activeVoices - 1);
    kindActive[kind] = Math.max(0, kindActive[kind] - 1);
  }, ms);
}

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
  await Tone.loaded(); // ждём декодирования сэмпл-пака
  if (!samplers) buildSamplers();
  // Transport с лёгким свингом — база для мягкой квантизации
  Tone.Transport.bpm.value = BPM;
  Tone.Transport.swing = 0.12;
  Tone.Transport.swingSubdivision = '16n';
  Tone.Transport.start();
  droneOsc.forEach((o) => o.start());
  droneGain.gain.rampTo(0.055, 3); // дрон вплывает медленно
  audioReady = true;
}

// ля минор (натуральный, без F — чтобы случайные тембры не диссонировали в хвостах)
const SCALE = ['A3', 'C4', 'D4', 'E4', 'G4', 'A4', 'B4', 'C5', 'D5', 'E5'];

// мягкая квантизация: снапим к ближайшей 1/16 только если она ближе 75мс
function qTime() {
  const spb = 60 / BPM / 4;
  const pos = Tone.Transport.seconds;
  const d = Math.ceil(pos / spb + 1e-6) * spb - pos;
  return Tone.now() + (d < 0.075 ? d : 0) + 0.002 + Math.random() * 0.004;
}

function play(kind, noteIdx, velocity, durOverride, inst = 0) {
  if (!audioReady || !samplers) return false;
  const s = samplers[kind][((inst % INSTRUMENTS) + INSTRUMENTS) % INSTRUMENTS];
  if (!s || !s.loaded) return false;
  if (!allocVoice(kind)) return false; // бюджет исчерпан -> тихо пропускаем
  const note = SCALE[((noteIdx % SCALE.length) + SCALE.length) % SCALE.length];
  const dur = durOverride ?? NOTE_DUR[kind];
  const vel = velocity * (0.9 + Math.random() * 0.2); // хуманизация
  s.triggerAttackRelease(note, dur, qTime(), vel);
  freeVoiceLater(kind, Math.min(1100, dur * 1000 + 120)); // слот освобождается вовремя
  return true;
}

// ---------- физика ----------
const engine = Engine.create({ gravity: { x: 0, y: 0.32 } });
const world = engine.world;

const BALL_R = 7;
const MAX_BALLS = 50;
const BASE_FRICTION_AIR = 0.004; // выше сопротивление -> ниже предельная скорость

const balls = [];
const solidBodies = new Map(); // idx ячейки -> статическое тело (жёлтые)
const lastHit = new Map();
const cellFlash = new Map(); // idx -> 0..1

// ---------- аркадный джус: партиклы и тряска ----------
const particles = [];
const MAX_PARTICLES = 240;

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
  // голова прижата к верху экрана; спавн — там, где рот
  emitter.y = Math.round(safeTop() + CAT_H * CAT_MOUTH);
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
  // градации чёрного: самый тёмный #3B3B3B (L 23%), дальше осветляются к серому
  b.plugin.grayL = 23 + ((noteIdx * 17) % 6) * 6; // 23..53% (потемнее)
  b.plugin.ringStyle = noteIdx % 4 === 3; // каждая четвёртая нота — колечко
  b.plugin.inst = (Math.random() * INSTRUMENTS) | 0; // случайный инструмент из пака
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
  ring(x, y, `hsl(0 0% ${b.plugin.grayL}%)`, 5, 1.8);
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

    play('bounce', ball.plugin.noteIdx, Math.min(1, 0.3 + speed / 14), undefined, ball.plugin.inst);
    duckHit(); // пад и дрон приседают под ударом (сайдчейн)
    cellFlash.set(cell.plugin.idx, 1);
    // джус: тряска, сквош, брызги и ударная волна
    shake(Math.min(6, speed * 0.4));
    ball.plugin.squash = 1;
    burst(ball.position.x, ball.position.y, '#e0b840', 4 + Math.min(8, speed | 0), 2 + speed * 0.25);
    ring(ball.position.x, ball.position.y, '#e0b840', 6, 2.8);
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
      play('spin', b.plugin.noteIdx + s.step, 0.32, 0.12, b.plugin.inst);
      s.nextTrig = now + Math.max(150, 340 - s.t / 16);
    }
    if (s.r > s.radius + CELL * 0.8) {
      // выплёвываем: октава вверх, тангенциальный вылет
      play('spin', b.plugin.noteIdx + 5, 0.55, 0.25, b.plugin.inst);
      burst(b.position.x, b.position.y, '#5fb8e0', 10, 3.5);
      ring(b.position.x, b.position.y, '#5fb8e0', 8, 3.2);
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
      ring(b.position.x, b.position.y, '#b98fe0', 10, 1.4);
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
      play('spin', b.plugin.noteIdx, 0.5, 0.2, b.plugin.inst);
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
      burst(b.position.x, b.position.y, '#e97f8a', 14, 4);
      ring(b.position.x, b.position.y, '#e97f8a', 7, 3);
      shake(2.5);
      // суб-удар октавой-двумя ниже — только если основная нота прошла по бюджету
      if (play('split', b.plugin.noteIdx, 0.7, undefined, b.plugin.inst)) {
        const note = SCALE[b.plugin.noteIdx % SCALE.length];
        subKick.triggerAttackRelease(Tone.Frequency(note).transpose(-24), '8n', qTime(), 0.6);
      }
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
      play('arp', b.plugin.noteIdx + a.step, 0.4, 0.08, b.plugin.inst);
      a.step++;
      a.pulse = 1; // вспышка размера + смена формы в ритм
      a.next = now + 175;
    }
  }
}

// ---------- сплеш: тап по книге -> открытие -> чистый канвас ----------
const startScreen = document.getElementById('start-screen');
let started = false;
let opening = false;
document.getElementById('book').addEventListener('click', async () => {
  if (opening) return;
  opening = true;
  ensureAudio(); // не ждём: анимация идёт, звук догружается параллельно
  placeEmitter();
  startScreen.classList.add('opening');
  // раскадровка: обложка открылась и книга заняла экран -> старт нот -> фейд сплеша
  setTimeout(() => { started = true; }, 1150);
  setTimeout(() => startScreen.classList.add('hidden'), 1350);
  setTimeout(() => startScreen.remove(), 1900);
});

// демо-сцена убрана: канвас после открытия книги — чистый лист

// ---------- state / UI ----------
let running = true;
const bpm = 120; // слайдер темпа пока закомментирован
let tool = 'paint'; // paint | erase  (перетаскивание пока закомментировано)
let paintColor = SPIN; // по умолчанию активен синий (как в макете)

const playBtn = document.getElementById('playBtn');
const icPlay = playBtn.querySelector('.ic-play');
const icPause = playBtn.querySelector('.ic-pause');
playBtn.addEventListener('click', () => {
  running = !running;
  icPause.style.display = running ? 'block' : 'none';
  icPlay.style.display = running ? 'none' : 'block';
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

// ---------- pointer: прицел эмиттера / покраска / ластик ----------
let painting = false;
let lastPoint = null;

// направление вылета нот: по умолчанию null = обычное падение вниз
const aim = { active: false, vx: 0, vy: 0 };
let aiming = null; // {x, y} текущая точка перетаскивания, пока тянем от эмиттера
const AIM_GRAB = 46; // радиус захвата вокруг эмиттера
const AIM_MAX_SPEED = 15;

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
  const p = pos(e);
  // старт рядом с эмиттером -> режим прицела (не красим)
  if (Math.hypot(p.x - emitter.x, p.y - emitter.y) < AIM_GRAB) {
    aiming = p;
    return;
  }
  painting = true;
  lastPoint = p;
  applyAt(lastPoint);
});

canvas.addEventListener('pointermove', (e) => {
  if (aiming) { aiming = pos(e); return; }
  if (!painting) return;
  const p = pos(e);
  applyStroke(lastPoint, p);
  lastPoint = p;
});

function endAim() {
  if (!aiming) return;
  const dx = aiming.x - emitter.x;
  const dy = aiming.y - emitter.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 14) {
    aim.active = false; // короткий тап у эмиттера -> сброс к падению вниз
  } else {
    const speed = Math.min(dist * 0.09, AIM_MAX_SPEED);
    aim.active = true;
    aim.vx = (dx / dist) * speed;
    aim.vy = (dy / dist) * speed;
  }
  aiming = null;
}

canvas.addEventListener('pointerup', () => {
  endAim();
  painting = false;
  lastPoint = null;
});
canvas.addEventListener('pointercancel', () => {
  aiming = null;
  painting = false;
  lastPoint = null;
});

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

// эмиттер — голова кота ~100px, прижата к верху; при вылете рот открывается
const CAT_W = 100;
let CAT_H = 92;           // пересчитывается по натуральному аспекту картинки
const CAT_MOUTH = 0.82;   // доля высоты головы, где рот = точка спавна
let catOpenUntil = 0;     // до этого времени показываем «открытый рот»

const catClosed = new Image();
const catOpen = new Image();
catClosed.onload = () => {
  CAT_H = CAT_W * (catClosed.naturalHeight / catClosed.naturalWidth);
  placeEmitter();
};
catClosed.src = SAMPLE_BASE.replace('samples/', '') + 'cat-closed.png';
catOpen.src = SAMPLE_BASE.replace('samples/', '') + 'cat-open.png';

function drawEmitter() {
  const open = performance.now() < catOpenUntil;
  const img = open ? catOpen : catClosed;
  emitterPulse = Math.max(0, emitterPulse - 0.05);

  ctx.save();
  if (img.complete && img.naturalWidth) {
    const w = CAT_W * (1 + emitterPulse * 0.1);
    const h = w * (img.naturalHeight / img.naturalWidth);
    const cx = emitter.x;
    // рот удерживаем на точке спавна независимо от того, какая картинка
    const top = emitter.y - h * CAT_MOUTH;
    ctx.drawImage(img, cx - w / 2, top, w, h);
  } else {
    // фолбэк, пока картинки не загрузились
    ctx.fillStyle = '#26222b';
    ctx.beginPath();
    ctx.arc(emitter.x, emitter.y, 10, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// полупрозрачная стрелка направления, пока тянем от эмиттера
function drawAimArrow() {
  if (!aiming) return;
  const dx = aiming.x - emitter.x;
  const dy = aiming.y - emitter.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 6) return;
  const ux = dx / dist, uy = dy / dist;
  const len = Math.min(dist, 150);
  const ex = emitter.x + ux * len, ey = emitter.y + uy * len;

  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = '#26222b';
  ctx.fillStyle = '#26222b';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(emitter.x, emitter.y);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  // наконечник
  const ah = 15;
  const a = Math.atan2(uy, ux);
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - ah * Math.cos(a - 0.42), ey - ah * Math.sin(a - 0.42));
  ctx.lineTo(ex - ah * Math.cos(a + 0.42), ey - ah * Math.sin(a + 0.42));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawTrails() {
  for (const b of balls) {
    const tr = b.plugin.trail;
    for (let i = 0; i < tr.length; i++) {
      const p = tr[i];
      const f = (i + 1) / tr.length;
      ctx.globalAlpha = f * 0.45;
      ctx.fillStyle = `hsl(0 0% ${b.plugin.grayL}%)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.6 + f * 1.2, 0, Math.PI * 2); // маленькие чёткие точки
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
  const grayL = b.plugin.grayL;
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
  // плоская «чернильная» графика: заливка или контурное колечко
  const ink = `hsl(0 0% ${grayL}%)`;
  if (flashing) {
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = ink;
    ctx.stroke();
  } else if (b.plugin.ringStyle) {
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = ink;
    ctx.stroke();
  } else {
    ctx.fillStyle = ink;
    ctx.fill();
  }
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
      if (b) {
        catOpenUntil = now + 150; // кот на миг открывает рот
        // задаём стартовый вектор, если выставлено направление прицела
        if (aim.active) {
          Body.setVelocity(b, {
            x: aim.vx + (Math.random() - 0.5) * 0.4,
            y: aim.vy + (Math.random() - 0.5) * 0.4,
          });
        }
        play('spawn', b.plugin.noteIdx, 0.2, 0.1, b.plugin.inst);
      }
    }
  }

  for (const b of balls) {
    updateBallEffects(b, dt, now);
    b.plugin.squash = Math.max(0, b.plugin.squash - dt * 0.007);
    // пунктирный след: точка каждые ~60мс, как цепочки в генеративном арте
    if (now - (b.plugin.lastTrail || 0) > 60) {
      b.plugin.lastTrail = now;
      const tr = b.plugin.trail;
      tr.push({ x: b.position.x, y: b.position.y });
      if (tr.length > 7) tr.shift();
    }
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
  drawAimArrow();
  balls.forEach((b) => drawBall(b, now));
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  requestAnimationFrame(frame);
}

resize();
placeEmitter();
window.addEventListener('resize', () => { resize(); placeEmitter(); });
window.addEventListener('orientationchange', () => { resize(); placeEmitter(); });
requestAnimationFrame(frame);
