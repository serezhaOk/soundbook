import Matter from 'matter-js';
import * as Tone from 'tone';

const { Engine, Composite, Bodies, Body, Events, Query } = Matter;

// ---------- canvas ----------
const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');
let W = 0, H = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// ---------- audio ----------
// Три шины: сухая нота, delay (голубые преграды), bitcrush (красные)
const master = new Tone.Limiter(-2).toDestination();

const buses = {
  normal: new Tone.Gain(0.9).connect(master),
  delay: new Tone.FeedbackDelay(0.32, 0.6).connect(master),
  crush: new Tone.Filter(2200, 'lowpass').connect(master),
};
const crusher = new Tone.BitCrusher(4).connect(buses.crush);

function makeSynth(dest, opts = {}) {
  const s = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.002, decay: 0.28, sustain: 0, release: 0.25 },
    volume: -6,
    ...opts,
  });
  s.connect(dest);
  return s;
}

const synths = {
  normal: makeSynth(buses.normal),
  delay: makeSynth(buses.delay),
  crush: makeSynth(crusher, { oscillator: { type: 'square' }, volume: -10 }),
  spawn: makeSynth(buses.normal, { volume: -18, oscillator: { type: 'sine' } }),
};

let audioReady = false;
async function ensureAudio() {
  if (audioReady) return;
  audioReady = true;
  await Tone.start();
  document.getElementById('audio-hint')?.remove();
}

// Пентатоника — любые столкновения звучат консонансно
const SCALE = ['C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5', 'G5', 'A5'];

function play(type, note, velocity) {
  if (!audioReady) return;
  // лёгкий джиттер, чтобы одновременные удары не конфликтовали по времени
  const t = Tone.now() + Math.random() * 0.008;
  synths[type].triggerAttackRelease(note, 0.2, t, velocity);
}

// ---------- physics ----------
const engine = Engine.create({ gravity: { x: 0, y: 1 } });
const world = engine.world;

const BALL_R = 9;
const BAR_THICK = 12;
const MAX_BALLS = 90;

const TYPE_COLORS = { normal: '#e8e8f0', delay: '#4da3ff', crush: '#ff4d6d' };

const balls = [];
const barriers = [];
const lastHit = new Map(); // "ballId:barId" -> timestamp, анти-дребезг

let noteIndex = 0;
const emitter = { x: W * 0.5, y: 24 };

function spawnBall() {
  const note = SCALE[noteIndex % SCALE.length];
  const hue = (noteIndex * 36) % 360;
  noteIndex++;
  const b = Bodies.circle(emitter.x + (Math.random() - 0.5) * 3, emitter.y, BALL_R, {
    restitution: 0.72,
    friction: 0.005,
    frictionAir: 0.0012,
    density: 0.002,
    label: 'ball',
  });
  b.plugin.note = note;
  b.plugin.hue = hue;
  b.plugin.flash = 0;
  Composite.add(world, b);
  balls.push(b);
  play('spawn', note, 0.25);

  if (balls.length > MAX_BALLS) removeBall(balls[0]);
}

function removeBall(b) {
  Composite.remove(world, b);
  const i = balls.indexOf(b);
  if (i !== -1) balls.splice(i, 1);
}

function createBarrier(x1, y1, x2, y2, type) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 24) return null;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const body = Bodies.rectangle((x1 + x2) / 2, (y1 + y2) / 2, len, BAR_THICK, {
    isStatic: true,
    angle,
    restitution: 0.6,
    friction: 0.01,
    label: 'barrier',
  });
  body.plugin.type = type;
  body.plugin.len = len;
  body.plugin.flash = 0;
  Composite.add(world, body);
  barriers.push(body);
  return body;
}

function removeBarrier(b) {
  Composite.remove(world, b);
  const i = barriers.indexOf(b);
  if (i !== -1) barriers.splice(i, 1);
}

Events.on(engine, 'collisionStart', (e) => {
  for (const pair of e.pairs) {
    const { bodyA, bodyB } = pair;
    const ball = bodyA.label === 'ball' ? bodyA : bodyB.label === 'ball' ? bodyB : null;
    const bar = bodyA.label === 'barrier' ? bodyA : bodyB.label === 'barrier' ? bodyB : null;
    if (!ball || !bar) continue;

    const speed = Math.hypot(ball.velocity.x, ball.velocity.y);
    if (speed < 0.7) continue; // покоящийся контакт — не звучит

    const key = ball.id + ':' + bar.id;
    const now = performance.now();
    if (now - (lastHit.get(key) || 0) < 130) continue;
    lastHit.set(key, now);

    const velocity = Math.min(1, 0.3 + speed / 14);
    play(bar.plugin.type, ball.plugin.note, velocity);
    bar.plugin.flash = 1;
    ball.plugin.flash = 1;
  }
});

// ---------- state / UI ----------
let running = true;
let bpm = 120;
let tool = 'draw';
let barrierType = 'normal';

const tempoInput = document.getElementById('tempo');
const bpmLabel = document.getElementById('bpmLabel');
tempoInput.addEventListener('input', () => {
  bpm = Number(tempoInput.value);
  bpmLabel.textContent = bpm;
});

const playBtn = document.getElementById('playBtn');
playBtn.addEventListener('click', () => {
  running = !running;
  playBtn.textContent = running ? '⏸' : '▶️';
});

document.getElementById('clearBtn').addEventListener('click', () => {
  [...barriers].forEach(removeBarrier);
});

function bindGroup(id, attr, onPick) {
  const el = document.getElementById(id);
  el.addEventListener('click', (e) => {
    const btn = e.target.closest(`[data-${attr}]`);
    if (!btn) return;
    el.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    onPick(btn.dataset[attr]);
  });
}
bindGroup('tools', 'tool', (v) => (tool = v));
bindGroup('types', 'type', (v) => {
  barrierType = v;
  // выбор типа — это намерение рисовать
  tool = 'draw';
  document.querySelectorAll('#tools button').forEach((b) =>
    b.classList.toggle('active', b.dataset.tool === 'draw'));
});

// ---------- pointer: рисование / перемещение / удаление ----------
let drawing = null; // {x1,y1,x2,y2}
let dragging = null; // {kind:'emitter'} | {kind:'body', body, dx, dy}

function pos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener('pointerdown', (e) => {
  ensureAudio();
  canvas.setPointerCapture(e.pointerId);
  const p = pos(e);

  if (tool === 'draw') {
    drawing = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  } else if (tool === 'move') {
    if (Math.hypot(p.x - emitter.x, p.y - emitter.y) < 34) {
      dragging = { kind: 'emitter' };
    } else {
      const found = Query.point(barriers, p);
      if (found.length) {
        const body = found[0];
        dragging = { kind: 'body', body, dx: body.position.x - p.x, dy: body.position.y - p.y };
      }
    }
  } else if (tool === 'erase') {
    Query.point(barriers, p).forEach(removeBarrier);
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = pos(e);
  if (drawing) {
    drawing.x2 = p.x;
    drawing.y2 = p.y;
  } else if (dragging?.kind === 'emitter') {
    emitter.x = Math.max(BALL_R, Math.min(W - BALL_R, p.x));
    emitter.y = Math.max(14, Math.min(H * 0.5, p.y));
  } else if (dragging?.kind === 'body') {
    Body.setPosition(dragging.body, { x: p.x + dragging.dx, y: p.y + dragging.dy });
  } else if (tool === 'erase' && e.buttons) {
    Query.point(barriers, p).forEach(removeBarrier);
  }
});

canvas.addEventListener('pointerup', () => {
  if (drawing) {
    createBarrier(drawing.x1, drawing.y1, drawing.x2, drawing.y2, barrierType);
    drawing = null;
  }
  dragging = null;
});
canvas.addEventListener('pointercancel', () => {
  drawing = null;
  dragging = null;
});

// ---------- render / loop ----------
function drawBarrier(b) {
  const color = TYPE_COLORS[b.plugin.type];
  const flash = b.plugin.flash;
  const half = b.plugin.len / 2;
  ctx.save();
  ctx.translate(b.position.x, b.position.y);
  ctx.rotate(b.angle);
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.55 + flash * 0.45;
  ctx.lineWidth = BAR_THICK * (1 + flash * 0.35);
  ctx.shadowColor = color;
  ctx.shadowBlur = 6 + flash * 26;
  ctx.beginPath();
  ctx.moveTo(-half, 0);
  ctx.lineTo(half, 0);
  ctx.stroke();
  ctx.restore();
  b.plugin.flash = Math.max(0, flash - 0.06);
}

function drawBall(b) {
  const flash = b.plugin.flash;
  ctx.save();
  ctx.fillStyle = `hsl(${b.plugin.hue} 85% ${62 + flash * 25}%)`;
  ctx.shadowColor = ctx.fillStyle;
  ctx.shadowBlur = 8 + flash * 22;
  ctx.beginPath();
  ctx.arc(b.position.x, b.position.y, BALL_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  b.plugin.flash = Math.max(0, flash - 0.08);
}

function drawEmitter(t) {
  const pulse = 1 + 0.12 * Math.sin(t / 250);
  ctx.save();
  ctx.strokeStyle = '#b18cff';
  ctx.shadowColor = '#b18cff';
  ctx.shadowBlur = 14;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(emitter.x, emitter.y, 14 * pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.arc(emitter.x, emitter.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#b18cff';
  ctx.fill();
  ctx.restore();
}

let last = performance.now();
let spawnAcc = 0;

function frame(now) {
  const dt = Math.min(now - last, 50);
  last = now;

  if (running) {
    spawnAcc += dt;
    const interval = 60000 / bpm;
    while (spawnAcc >= interval) {
      spawnAcc -= interval;
      spawnBall();
    }
  }

  Engine.update(engine, dt);

  // мячи, улетевшие за экран, убираем
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    if (b.position.y > H + 120 || b.position.x < -120 || b.position.x > W + 120) {
      lastHit.forEach((_, k) => { if (k.startsWith(b.id + ':')) lastHit.delete(k); });
      removeBall(b);
    }
  }

  ctx.clearRect(0, 0, W, H);
  drawEmitter(now);
  barriers.forEach(drawBarrier);
  balls.forEach(drawBall);

  if (drawing) {
    ctx.save();
    ctx.strokeStyle = TYPE_COLORS[barrierType];
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = BAR_THICK;
    ctx.lineCap = 'round';
    ctx.setLineDash([4, 10]);
    ctx.beginPath();
    ctx.moveTo(drawing.x1, drawing.y1);
    ctx.lineTo(drawing.x2, drawing.y2);
    ctx.stroke();
    ctx.restore();
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// стартовая сцена: пара преград, чтобы сразу было слышно идею
createBarrier(W * 0.28, H * 0.3, W * 0.55, H * 0.42, 'normal');
createBarrier(W * 0.68, H * 0.55, W * 0.42, H * 0.66, 'delay');
createBarrier(W * 0.2, H * 0.78, W * 0.45, H * 0.86, 'crush');
