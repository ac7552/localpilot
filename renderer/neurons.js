// A glowing brain of fine fibres on a dark field, grown in 3D and seen in perspective: long,
// smooth bundles radiate from two cores and sweep along the surface. Fibres nearer the viewer
// are thicker and brighter, with a light core like a lit tube; those behind are thin and dim.
// Red and orange at the cores turn yellow, green and teal along the paths and blue and cyan at
// the cortex, with tiny bright glints along the fibres.
//
// Everything moves slowly. The brain breathes (a CSS transform, so it costs nothing to draw);
// the fibres under the pointer gather light and let it fade; sparks glide along fibres with
// eased motion and long tails; thinking warms the cores. The anatomy is painted once per
// layout, and the animation loop sleeps whenever nothing is lit.

(() => {
  const brainEl = document.getElementById('brain');
  const brainCanvas = document.getElementById('brainCanvas');
  const brainLive = document.getElementById('brainLive');
  if (!brainEl || !brainCanvas || !brainLive) return;
  const bctx = brainCanvas.getContext('2d');
  const blive = brainLive.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);

  // Palette sampled from the reference.
  const RED = [255, 70, 52];
  const ORANGE = [255, 128, 50];
  const YELLOW = [255, 196, 92];
  const GREEN = [140, 228, 122];
  const TEAL = [62, 220, 200];
  const CYAN = [96, 204, 255];
  const BLUE = [64, 134, 255];
  const DEEP = [72, 102, 232];

  let W = 0;
  let H = 0;
  let geo = null;              // { cx, cy, s, rot }
  let strands = [];            // projected fibres
  let hubs = [];
  let grid = new Map();        // hover lookup over fibre samples
  const lit = new Map();       // sample -> light, for the glow that follows the pointer
  let sparks = [];
  let heat = 0;
  let mode = 'hero';
  let running = false;

  // ---------- easing, randomness, vectors ----------
  const easeInOut = (t) => 0.5 - Math.cos(Math.PI * t) / 2;
  let seed = 1337;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const gauss = () => {
    let u = 0;
    let v = 0;
    while (!u) u = rnd();
    while (!v) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

  // ---------- the brain in 3D ----------
  // An ellipsoid, a little flatter underneath and with gentle lobes.
  const AX = [1, 0.66, 0.78];
  const shape = (x, y, z) => {
    const lobe = 1 + 0.05 * Math.cos(3 * Math.atan2(y, x)) + 0.03 * Math.cos(4 * Math.atan2(z, x));
    const yy = y > 0.3 ? y * 1.1 : y;
    return ((x / AX[0]) ** 2 + (yy / AX[1]) ** 2 + (z / AX[2]) ** 2) / lobe;
  };
  // Outward normal of the ellipsoid, for sliding fibres along the surface.
  const normal = (x, y, z) => norm([x / AX[0] ** 2, y / AX[1] ** 2, z / AX[2] ** 2]);
  const tangent = (d, n) => { const k = d[0] * n[0] + d[1] * n[1] + d[2] * n[2]; return norm([d[0] - n[0] * k, d[1] - n[1] * k, d[2] - n[2] * k]); };

  let brain = null;
  function grow() {
    seed = 1337;
    const out = [];
    const hubList = [
      { p: [-0.3, 0.1, 0.12], r: 1 }, { p: [0.24, 0.16, -0.04], r: 1 },
      { p: [-0.04, -0.24, 0.2], r: 0.55 }, { p: [0.5, -0.08, -0.22], r: 0.45 }, { p: [-0.56, -0.14, -0.18], r: 0.45 },
    ];
    // Bundles radiate from a core in smooth curves, then turn to run along the surface.
    const walk = (p, dir, len, depth, hub) => {
      if (out.length > 520) return;
      const pts = [p.slice()];
      let d = dir;
      let bend = [gauss() * 0.02, gauss() * 0.02, gauss() * 0.02];
      for (let i = 0; i < len; i++) {
        bend = [bend[0] * 0.92 + gauss() * 0.006, bend[1] * 0.92 + gauss() * 0.006, bend[2] * 0.92 + gauss() * 0.006];
        const away = norm([p[0] - hub.p[0], p[1] - hub.p[1], p[2] - hub.p[2]]);
        d = norm([d[0] + bend[0] + away[0] * 0.025, d[1] + bend[1] + away[1] * 0.025, d[2] + bend[2] + away[2] * 0.025]);
        const e = shape(...p);
        if (e > 0.72) d = norm(tangent(d, normal(...p)).map((v, k) => v * (1 - (e - 0.72)) + d[k] * (1 - e) * 0.2));
        p = [p[0] + d[0] * 0.013, p[1] + d[1] * 0.013, p[2] + d[2] * 0.013];
        if (shape(...p) > 1) break;
        pts.push(p.slice());
        if (depth < 2 && i > 14 && rnd() < 0.014) {
          walk(p, norm([d[0] + gauss() * 0.5, d[1] + gauss() * 0.5, d[2] + gauss() * 0.5]), len * 0.6, depth + 1, hub);
        }
      }
      if (pts.length > 10) out.push({ pts, depth, kind: 'axon', tint: Math.floor(rnd() * 3) });
    };
    for (let i = 0; i < 150; i++) {
      const hub = rnd() < 0.78 ? hubList[Math.floor(rnd() * 2)] : hubList[2 + Math.floor(rnd() * 3)];
      const start = hub.p.map((v) => v + gauss() * 0.03);
      walk(start, norm([gauss(), gauss() * 0.8, gauss()]), 120 + rnd() * 140, 0, hub);
    }
    // Long sweeping fibres over the cortex, each following the surface like a great circle.
    for (let i = 0; i < 120; i++) {
      let p = norm([gauss(), gauss(), gauss()]);
      const depthIn = 0.9 + rnd() * 0.08;
      const onSurface = (q) => {
        const s = Math.sqrt(shape(...q)) || 1;
        return q.map((v) => (v / s) * depthIn);
      };
      p = onSurface(p);
      let d = tangent(norm([gauss(), gauss(), gauss()]), normal(...p));
      const turn = gauss() * 0.012;
      const pts = [];
      const n = 70 + rnd() * 150;
      for (let k = 0; k < n; k++) {
        const nrm = normal(...p);
        const side = norm([d[1] * nrm[2] - d[2] * nrm[1], d[2] * nrm[0] - d[0] * nrm[2], d[0] * nrm[1] - d[1] * nrm[0]]);
        d = tangent(norm([d[0] + side[0] * turn, d[1] + side[1] * turn, d[2] + side[2] * turn]), nrm);
        p = onSurface([p[0] + d[0] * 0.014, p[1] + d[1] * 0.014, p[2] + d[2] * 0.014]);
        pts.push(p.slice());
      }
      out.push({ pts, depth: 3, kind: 'cortex', tint: Math.floor(rnd() * 3) });
    }
    brain = { strands: out, hubs: hubList };
  }

  // Red and orange at the cores, through yellow, green and teal, to cyan and blue.
  function colorAt(kind, k, tint = 0) {
    if (kind === 'cortex') return [BLUE, CYAN, DEEP][tint % 3];
    const stops = [[0, RED], [0.1, ORANGE], [0.2, YELLOW], [0.32, GREEN], [0.44, TEAL], [0.58, CYAN], [0.8, tint === 2 ? DEEP : BLUE]];
    for (let i = 1; i < stops.length; i++) {
      if (k <= stops[i][0]) return mix(stops[i - 1][1], stops[i][1], (k - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
    }
    return stops[stops.length - 1][1];
  }

  // ---------- projection ----------
  const VIEW = { yaw: -0.5, pitch: 0.32 };
  function project(p) {
    const [x0, y0, z0] = p;
    const cy = Math.cos(VIEW.yaw);
    const sy = Math.sin(VIEW.yaw);
    const x1 = x0 * cy + z0 * sy;
    const z1 = -x0 * sy + z0 * cy;
    const cp = Math.cos(VIEW.pitch);
    const sp = Math.sin(VIEW.pitch);
    const y2 = y0 * cp - z1 * sp;
    const z2 = y0 * sp + z1 * cp;
    const f = 1 / (1 + z2 * 0.28);                 // gentle perspective
    const c = Math.cos(geo.rot);
    const s = Math.sin(geo.rot);
    const X = x1 * f;
    const Y = y2 * f;
    return [geo.cx + (X * c - Y * s) * geo.s, geo.cy + (X * s + Y * c) * geo.s, clamp((1 - z2) / 2, 0, 1)];  // depth: 1 = nearest
  }

  function makePath(pts3, kind, depth, tint) {
    const n = pts3.length;
    const p = { xs: new Float32Array(n), ys: new Float32Array(n), ds: new Float32Array(n), len: new Float32Array(n), total: 0, kind, depth, tint };
    for (let i = 0; i < n; i++) {
      const [x, y, d] = project(pts3[i]);
      p.xs[i] = x;
      p.ys[i] = y;
      p.ds[i] = d;
      if (i) p.total += Math.hypot(p.xs[i] - p.xs[i - 1], p.ys[i] - p.ys[i - 1]);
      p.len[i] = p.total;
    }
    return p;
  }

  function pointAt(p, d) {
    d = clamp(d, 0, p.total);
    let lo = 0;
    let hi = p.len.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (p.len[mid] < d) lo = mid; else hi = mid;
    }
    const k = (d - p.len[lo]) / (p.len[hi] - p.len[lo] || 1);
    return [p.xs[lo] + (p.xs[hi] - p.xs[lo]) * k, p.ys[lo] + (p.ys[hi] - p.ys[lo]) * k, p.ds[lo]];
  }

  // Place the brain to the right of the greeting and suggestions, shrinking it rather than
  // letting it cover them.
  let textRight = null;
  function placeBrain(area) {
    const text = [...document.querySelectorAll('.empty h1, .empty .suggestion')].map((el) => el.getBoundingClientRect().right);
    if (text.length) textRight = Math.max(...text);
    const free = textRight ? area.right - 24 - (textRight + 24) : area.width * 0.64;
    const s = Math.max(110, Math.min(area.width * 0.32, area.height * 0.46, free / 2.1));
    const cx = textRight ? Math.min(area.right - 24 - s * 1.05, Math.max(textRight + 24 + s * 1.05, area.left + area.width * 0.66)) : area.left + area.width * 0.66;
    return { cx, cy: area.top + area.height * 0.49, s, rot: -0.12 };
  }

  function build() {
    W = window.innerWidth;
    H = window.innerHeight;
    for (const cv of [brainCanvas, brainLive]) {
      cv.width = W * DPR;
      cv.height = H * DPR;
      cv.style.width = `${W}px`;
      cv.style.height = `${H}px`;
    }
    const area = document.getElementById('messages')?.getBoundingClientRect();
    if (!area || !area.width) return;
    if (!brain) grow();
    geo = placeBrain(area);
    brainEl.style.transformOrigin = `${geo.cx}px ${geo.cy}px`;
    strands = brain.strands.map((st) => makePath(st.pts, st.kind, st.depth, st.tint));
    hubs = brain.hubs.map((h) => ({ r: h.r, xy: project(h.p) }));
    lit.clear();
    sparks = [];  // positions changed; let old sparks go
    indexForHover();
    paint();
  }

  // ---------- hover lookup ----------
  const CELL = 36;
  const STEP = 3;  // a fibre sample every few points
  function indexForHover() {
    grid = new Map();
    for (const p of strands) {
      for (let i = 0; i + STEP < p.xs.length; i += STEP) {
        const key = `${Math.floor(p.xs[i] / CELL)},${Math.floor(p.ys[i] / CELL)}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push({ x: p.xs[i], y: p.ys[i], p, i });
      }
    }
  }

  function samplesNear(x, y, R) {
    const out = [];
    const r = Math.ceil(R / CELL);
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        for (const s of grid.get(`${cx + i},${cy + j}`) ?? []) {
          const d = Math.hypot(s.x - x, s.y - y);
          if (d < R) out.push([s, d]);
        }
      }
    }
    return out;
  }

  // ---------- painting the brain ----------
  function stroke(c, p, i0, i1) {
    c.beginPath();
    c.moveTo(p.xs[i0], p.ys[i0]);
    for (let i = i0 + 1; i <= i1; i++) c.lineTo(p.xs[i], p.ys[i]);
    c.stroke();
  }

  const kAt = (p, i) => (p.kind === 'cortex' ? 0.9 : p.len[i] / (p.total || 1));
  const baseWidth = (p) => (p.kind === 'cortex' ? 0.85 : [1.7, 1.2, 0.85][p.depth] ?? 0.85);

  function paint() {
    if (!geo) return;
    const c = bctx;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.clearRect(0, 0, W, H);
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const scale = clamp(geo.s / 300, 0.6, 1.4);
    const CH = 6;  // points per stroke, so colour and depth can change along a fibre
    // Back to front: glow, body, then the bright core of each tube; out-of-focus halos for the nearest.
    for (const pass of ['glow', 'body', 'core', 'bokeh']) {
      for (const p of strands) {
        const w0 = baseWidth(p) * scale;
        for (let i0 = 0; i0 < p.xs.length - 1; i0 += CH) {
          const i1 = Math.min(i0 + CH, p.xs.length - 1);
          const mid = (i0 + i1) >> 1;
          const d = p.ds[mid];
          const [r, g, b] = colorAt(p.kind, kAt(p, mid), p.tint);
          const w = w0 * (0.45 + d * 0.95);
          if (pass === 'glow') {
            c.strokeStyle = `rgba(${r},${g},${b},${0.035 + d * 0.05})`;
            c.lineWidth = w * 5;
          } else if (pass === 'body') {
            c.strokeStyle = `rgba(${r},${g},${b},${0.16 + d * 0.62})`;
            c.lineWidth = w;
          } else if (pass === 'core') {
            if (d < 0.45) continue;
            const [hr, hg, hb] = mix([r, g, b], [255, 255, 255], 0.6);
            c.strokeStyle = `rgba(${hr},${hg},${hb},${(d - 0.45) * 0.9})`;
            c.lineWidth = Math.max(0.4, w * 0.32);
          } else {
            if (d < 0.86) continue;
            c.strokeStyle = `rgba(${r},${g},${b},${(d - 0.86) * 0.9})`;
            c.lineWidth = w * 3.2;
          }
          stroke(c, p, i0, i1);
        }
      }
    }
    // Glints: tiny bright points along the fibres, more of them in front.
    seed = 4242;
    for (let n = 0; n < 900; n++) {
      const p = strands[Math.floor(rnd() * strands.length)];
      const j = Math.floor(rnd() * p.xs.length);
      const d = p.ds[j];
      if (rnd() > 0.25 + d * 0.75) continue;
      const base = colorAt(p.kind, kAt(p, j), p.tint);
      const [r, g, b] = mix(base, [255, 255, 255], 0.55);
      const rad = (0.5 + rnd() * 0.9) * scale * (0.6 + d * 0.6);
      const x = p.xs[j];
      const y = p.ys[j];
      const g2 = c.createRadialGradient(x, y, 0, x, y, rad * 3);
      g2.addColorStop(0, `rgba(${r},${g},${b},${0.5 + d * 0.5})`);
      g2.addColorStop(1, `rgba(${base},0)`);
      c.fillStyle = g2;
      c.fillRect(x - rad * 3, y - rad * 3, rad * 6, rad * 6);
    }
    c.globalCompositeOperation = 'source-over';
  }

  // ---------- sparks: eased glides with long fading tails ----------
  function send(path, d0, d1, color, duration = null) {
    const dur = duration ?? clamp(Math.abs(d1 - d0) / 120, 1.6, 5) * 1000;
    sparks.push({ path, d0, d1, color, dur, t: 0 });
    wake();
  }

  const pickStrands = (n, kind = null) => {
    const pool = kind ? strands.filter((p) => p.kind === kind) : strands;
    return Array.from({ length: n }, () => pool[Math.floor(Math.random() * pool.length)]).filter(Boolean);
  };

  function fireStrands(list) {
    for (const p of list) send(p, 0, p.total, colorAt(p.kind, p.kind === 'cortex' ? 0.9 : 0.12, p.tint));
  }

  // ---------- the light under the pointer ----------
  let lastSpark = 0;
  function illuminate(x, y) {
    const R = 90;
    let nearest = null;
    for (const [s, d] of samplesNear(x, y, R)) {
      const e = (1 - d / R) ** 2;
      if (e > (lit.get(s) ?? 0)) lit.set(s, Math.min(1, (lit.get(s) ?? 0) * 0.5 + e));
      if (!nearest || d < nearest[1]) nearest = [s, d];
    }
    // Now and then the touched fibre carries a slow spark away from the pointer.
    const now = performance.now();
    if (nearest && nearest[1] < 28 && now - lastSpark > 600) {
      lastSpark = now;
      const { p, i } = nearest[0];
      send(p, p.len[i], Math.random() < 0.5 ? 0 : p.total, colorAt(p.kind, kAt(p, i), p.tint));
      heat = Math.min(1, heat + 0.06);
    }
    if (lit.size) wake();
  }

  // ---------- the live layer ----------
  let last = 0;
  function drawSpark(c, m) {
    const prog = clamp(m.t / m.dur, 0, 1);
    const head = m.d0 + (m.d1 - m.d0) * easeInOut(prog);
    const dir = Math.sign(m.d1 - m.d0) || 1;
    const fade = Math.sin(Math.PI * prog) ** 0.6;  // in and out, never popping
    const [r, g, b] = m.color;
    const tail = 80;
    const N = 12;
    for (let j = N; j >= 1; j--) {
      const [x0, y0] = pointAt(m.path, head - (dir * tail * j) / N);
      const [x1, y1] = pointAt(m.path, head - (dir * tail * (j - 1)) / N);
      const a = (1 - j / (N + 1)) ** 1.6;
      c.strokeStyle = `rgba(${r},${g},${b},${a * 0.9 * fade})`;
      c.lineWidth = 0.8 + a * 1.8;
      c.beginPath();
      c.moveTo(x0, y0);
      c.lineTo(x1, y1);
      c.stroke();
    }
    const [hx, hy, hd] = pointAt(m.path, head);
    const R = 6 + hd * 5;
    const g2 = c.createRadialGradient(hx, hy, 0, hx, hy, R);
    g2.addColorStop(0, `rgba(255,255,255,${0.95 * fade})`);
    g2.addColorStop(0.3, `rgba(${r},${g},${b},${0.7 * fade})`);
    g2.addColorStop(1, `rgba(${r},${g},${b},0)`);
    c.fillStyle = g2;
    c.fillRect(hx - R, hy - R, R * 2, R * 2);
  }

  function frame(now) {
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
    last = now;
    heat = Math.max(0, heat - dt * 0.18);
    const c = blive;
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.clearRect(0, 0, W, H);
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round';

    // The cores glow warmer while the network is active.
    if (heat > 0.01 && geo) {
      for (const h of hubs) {
        const r = geo.s * 0.2 * h.r * (0.8 + heat * 0.5);
        const g = c.createRadialGradient(h.xy[0], h.xy[1], 0, h.xy[0], h.xy[1], r);
        g.addColorStop(0, `rgba(255,110,60,${0.3 * heat * h.r})`);
        g.addColorStop(1, 'rgba(255,110,60,0)');
        c.fillStyle = g;
        c.fillRect(h.xy[0] - r, h.xy[1] - r, r * 2, r * 2);
      }
    }

    // Fibres under the pointer: brighter light that fades over about a second.
    const decay = Math.exp(-dt / 0.9);
    for (const [s, e] of lit) {
      const next = e * decay;
      if (next < 0.02) { lit.delete(s); continue; }
      lit.set(s, next);
      const { p, i } = s;
      const [r, g, b] = mix(colorAt(p.kind, kAt(p, i), p.tint), [255, 255, 255], 0.3);
      const end = Math.min(i + STEP, p.xs.length - 1);
      const depth = 0.5 + p.ds[i] * 0.5;
      c.strokeStyle = `rgba(${r},${g},${b},${0.14 * next * depth})`;
      c.lineWidth = 6;
      stroke(c, p, i, end);
      c.strokeStyle = `rgba(${r},${g},${b},${0.85 * next * depth})`;
      c.lineWidth = 1.1 + next;
      stroke(c, p, i, end);
    }

    for (let i = sparks.length - 1; i >= 0; i--) {
      const m = sparks[i];
      m.t += dt * 1000;
      drawSpark(c, m);
      if (m.t >= m.dur) sparks.splice(i, 1);
    }
    c.globalCompositeOperation = 'source-over';
    if (sparks.length || lit.size || heat > 0.01) requestAnimationFrame(frame);
    else { running = false; last = 0; c.clearRect(0, 0, W, H); }
  }

  function wake() {
    if (running || reduceMotion) return;
    running = true;
    requestAnimationFrame(frame);
  }

  // ---------- listening to the app ----------

  let pointer = null;
  document.addEventListener('pointermove', (e) => {
    const queued = !!pointer;
    pointer = [e.clientX, e.clientY];
    if (queued) return;
    requestAnimationFrame(() => { const [x, y] = pointer; pointer = null; illuminate(x, y); });
  }, { passive: true });

  // Typing stirs the network a little.
  let lastKey = 0;
  document.getElementById('input')?.addEventListener('keydown', () => {
    const now = performance.now();
    if (now - lastKey < 900) return;
    lastKey = now;
    fireStrands(pickStrands(1));
  });

  // The model's activity: thinking warms the cores and fires them, writing fires the rest.
  let lastChunkSpark = 0;
  window.localpilot?.onChatChunk?.(({ chunk }) => {
    const now = performance.now();
    for (const ch of chunk.choices ?? []) {
      const d = ch.delta ?? {};
      if (d.reasoning_content) heat = Math.min(0.9, heat + 0.02);
      if ((d.reasoning_content || d.content || d.tool_calls) && now - lastChunkSpark > 260) {
        lastChunkSpark = now;
        fireStrands(pickStrands(1, d.reasoning_content ? 'axon' : null));
      }
    }
    wake();
  });

  // Now and then the network stirs on its own, more while the model is busy.
  function idle() {
    if (!document.hidden && strands.length) fireStrands(pickStrands(mode === 'busy' ? 3 : 1));
    setTimeout(idle, mode === 'busy' ? 1400 + Math.random() * 1200 : 3500 + Math.random() * 3500);
  }

  // Loading ring, centred on the brain.
  let lastStatus = '';
  function syncStatus() {
    const status = document.getElementById('modelStatus')?.textContent || '';
    if (status === lastStatus) return;
    lastStatus = status;
    const ring = document.getElementById('loadRing');
    if (!ring) return;
    if (/^(loading|restoring)/.test(status)) {
      const pct = Number((status.match(/(\d+)%/) || [])[1] || 0);
      const area = document.getElementById('messages').getBoundingClientRect();
      const [x, y] = geo ? [geo.cx, geo.cy] : [area.left + area.width / 2, area.top + area.height / 2];
      ring.classList.remove('hidden');
      ring.style.left = `${x - 66}px`;
      ring.style.top = `${y - 66}px`;
      ring.querySelector('.ring-progress').style.strokeDashoffset = String(301.6 * (1 - pct / 100));
      ring.querySelector('.ring-label').textContent = /^restoring/.test(status) ? 'Restoring' : 'Loading';
      ring.querySelector('.ring-sub').textContent = `${pct}%`;
      fireStrands(pickStrands(2));
      heat = Math.min(0.8, heat + 0.15);
    } else {
      ring.classList.add('hidden');
    }
  }

  // Behind a conversation the brain dims (a slow CSS fade, so nothing repaints).
  function syncMode() {
    const busy = !document.getElementById('stopBtn')?.classList.contains('hidden');
    const empty = !!document.getElementById('messages')?.querySelector('.empty');
    mode = busy ? 'busy' : empty ? 'hero' : 'chat';
    brainEl.dataset.mode = mode;
  }

  let relayout = 0;
  const schedule = () => { clearTimeout(relayout); relayout = setTimeout(build, 140); };

  function start() {
    build();
    syncMode();
    syncStatus();
    brainEl.classList.add('ready');
    const watch = (el, opts, fn) => { if (el) new MutationObserver(fn).observe(el, opts); };
    watch(document.getElementById('messages'), { childList: true }, () => { syncMode(); if (mode === 'hero') schedule(); });
    watch(document.getElementById('stopBtn'), { attributes: true, attributeFilter: ['class'] }, syncMode);
    watch(document.getElementById('modelStatus'), { childList: true, characterData: true, subtree: true }, syncStatus);
    const ro = new ResizeObserver(schedule);
    const area = document.getElementById('messages');
    if (area) ro.observe(area);
    window.addEventListener('resize', schedule);
    document.fonts?.ready.then(schedule);
    setTimeout(idle, 3000);
  }

  window.__neural = {
    fire: () => fireStrands(pickStrands(3)),
    fireAt: (x, y) => { illuminate(x, y); return samplesNear(x, y, 40).length > 0; },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
