// Living neural-network backdrop, drawn like ink and watercolour on stone paper.
// Grows a brain-shaped web of filaments once,
// caches it, then animates only small signal pulses so it stays light on the GPU the
// model is using. Reacts to the agent by watching the DOM and the chat stream (read-only).

(() => {
  const canvas = document.getElementById('neuralCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  const FPS = 30;

  // Ink and watercolour: terracotta and ochre at the cores, sage mid-paths, graphite periphery.
  const WARM = [[169, 76, 33], [190, 104, 52], [205, 140, 72]];
  const TEAL = [[104, 128, 78], [132, 150, 92]];
  const BLUE = [[38, 38, 36], [70, 68, 62], [98, 95, 86]];
  const DANGER = [168, 54, 31];

  let W = 0, H = 0;           // canvas size in CSS px
  let strands = [];           // [{ pts: Float32Array [x,y,...] in brain space (-1..1), hub }]
  let hubs = [];
  let cache = null;           // offscreen render of the static network
  let pulses = [];
  let last = 0;
  let t = 0;

  // Behaviour state, eased every frame.
  const target = { alpha: 0.9, scale: 1, heat: 0 };
  const cur = { alpha: 0, scale: 0.96, heat: 0 };
  let spawnRate = 0.6;        // idle pulses per second
  let mode = 'hero';

  // ---------- deterministic randomness so the brain looks the same every launch ----------
  let seed = 1337;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));

  // Brain outline: a tilted ellipse with a slightly flattened base and lobed top.
  const inside = (x, y) => {
    const lobe = 1 + 0.06 * Math.cos(3 * Math.atan2(y, x));
    const yy = y > 0.35 ? y * 1.12 : y;
    return (x * x) / (1.0 * lobe) + (yy * yy) / (0.6 * lobe) <= 1;
  };

  function grow() {
    seed = 1337;
    strands = [];
    hubs = [
      { x: -0.32, y: 0.12, r: 1 }, { x: 0.22, y: 0.2, r: 1 },
      { x: -0.05, y: -0.22, r: 0.6 }, { x: 0.5, y: -0.1, r: 0.5 }, { x: -0.6, y: -0.15, r: 0.5 },
    ];

    // Axon-like strands that fan out from the hubs toward the cortex, sometimes branching.
    const walk = (x, y, ang, len, depth, hub) => {
      if (strands.length > 1200) return;  // keep the one-time render fast
      const pts = [x, y];
      let curl = (rnd() - 0.5) * 0.05;
      const wobF = 0.12 + rnd() * 0.22, wobA = 0.05 + rnd() * 0.09, wobP = rnd() * 6.28;
      for (let i = 0; i < len; i++) {
        curl += (rnd() - 0.5) * 0.03;
        curl *= 0.95;
        ang += curl + Math.sin(i * wobF + wobP) * wobA;
        // Gentle outward pull keeps paths radiating from the core; near the edge they
        // turn to run along the cortex like fibre bundles.
        const out = Math.atan2(y - hub.y, x - hub.x);
        const edge = (x * x) + (y * y) / 0.6;
        ang += edge > 0.55 ? Math.sin(out + Math.PI / 2 * Math.sign(curl || 1) - ang) * 0.05 : Math.sin(out - ang) * 0.03;
        const step = 0.011 + rnd() * 0.006;
        x += Math.cos(ang) * step;
        y += Math.sin(ang) * step;
        if (!inside(x, y)) break;
        pts.push(x, y);
        if (depth < 2 && i > 12 && rnd() < 0.018) walk(x, y, ang + (rnd() - 0.5) * 0.9, len * 0.7, depth + 1, hub);
      }
      if (pts.length > 8) strands.push({ pts: new Float32Array(pts), hub, depth, kind: 'axon' });
    };
    for (let i = 0; i < 150; i++) {
      const hub = rnd() < 0.75 ? hubs[Math.floor(rnd() * 2)] : pick(hubs);
      walk(hub.x + (rnd() - 0.5) * 0.06, hub.y + (rnd() - 0.5) * 0.06, rnd() * Math.PI * 2, 110 + rnd() * 140, 0, hub);
    }

    // Cortex: wavy filaments hugging the outline, giving the brain its silhouette.
    for (let i = 0; i < 130; i++) {
      let a = rnd() * Math.PI * 2;
      let r = 0.78 + rnd() * 0.2;
      let dr = 0;
      const dir = rnd() < 0.5 ? -1 : 1;
      const pts = [];
      const n = 40 + rnd() * 110;
      for (let k = 0; k < n; k++) {
        a += dir * (0.011 + rnd() * 0.004);
        dr += (rnd() - 0.5) * 0.004;
        dr *= 0.95;
        r = Math.min(Math.max(r + dr, 0.7), 0.995);
        const fold = Math.sin(a * 14 + i) * 0.025 + Math.sin(a * 5 + i * 0.3) * 0.02;
        const x = Math.cos(a) * (r + fold);
        const y = Math.sin(a) * (r + fold) * 0.76;
        if (!inside(x, y)) { r -= 0.02; continue; }
        pts.push(x, y);
      }
      if (pts.length > 8) strands.push({ pts: new Float32Array(pts), hub: null, depth: 3, kind: 'cortex' });
    }
  }

  // Brain-space → screen transform for the current layout: the brain floats in the sky of
  // the watercolour landscape, to the right of the greeting, like a cloud of nerve fibres.
  function frame() {
    const area = document.getElementById('messages')?.getBoundingClientRect();
    if (!area || !area.width) return { cx: W / 2, cy: H / 2, s: Math.min(W, H) * 0.3, rot: -0.22 };
    const s = Math.max(70, Math.min(area.width * 0.17, area.height * 0.27));
    return { cx: area.left + area.width * 0.7, cy: area.top + area.height * 0.34, s, rot: -0.22 };
  }

  function colorFor(strand, k) {
    if (strand.kind === 'cortex') return pick(BLUE);
    if (k < 0.24) return pick(WARM);
    if (k < 0.38) return mix(pick(WARM), pick(TEAL), (k - 0.24) / 0.14);
    if (k < 0.6) return mix(pick(TEAL), pick(BLUE), (k - 0.38) / 0.22);
    return pick(BLUE);
  }

  // Render the static network once into an offscreen canvas.
  let geom = null;
  function renderCache() {
    const f = (geom = frame());
    const pad = 1.25;
    const side = Math.ceil(f.s * 2 * pad);
    cache = document.createElement('canvas');
    cache.width = side * DPR;
    cache.height = side * DPR;
    const c = cache.getContext('2d');
    c.scale(DPR, DPR);
    c.translate(side / 2, side / 2);
    c.globalCompositeOperation = 'multiply';  // pigment darkens paper, like a wash
    c.lineCap = 'round';
    seed = 4242;

    for (const pass of ['glow', 'line']) {
      for (const st of strands) {
        const p = st.pts;
        const segs = p.length / 2 - 1;
        // Draw in a few chunks so colour can shift from warm core to blue edge.
        const chunks = st.kind === 'cortex' ? 1 : 7;
        for (let ch = 0; ch < chunks; ch++) {
          const a = Math.floor((segs * ch) / chunks);
          const b = Math.floor((segs * (ch + 1)) / chunks);
          if (b <= a) continue;
          const k = (ch + 0.5) / chunks;
          const [r, g, bl] = colorFor(st, k);
          const thick = st.kind === 'cortex' ? 0.7 : Math.max(0.5, (1.6 - st.depth * 0.4) * (1 - k * 0.5));
          c.beginPath();
          c.moveTo(p[a * 2] * f.s, p[a * 2 + 1] * f.s);
          for (let i = a + 1; i <= b; i++) c.lineTo(p[i * 2] * f.s, p[i * 2 + 1] * f.s);
          if (pass === 'glow') {
            // A soft, wide wash under each stroke, like wet pigment bleeding into paper.
            c.strokeStyle = `rgba(${r},${g},${bl},0.035)`;
            c.lineWidth = thick * 7;
          } else {
            c.strokeStyle = `rgba(${r},${g},${bl},${st.kind === 'cortex' ? 0.17 : 0.28})`;
            c.lineWidth = thick * 0.8;
          }
          c.stroke();
        }
      }
    }

    // Synapses: small drops of pigment along the paths (no grey, which reads as smudges).
    for (let i = 0; i < 160; i++) {
      const st = strands[Math.floor(rnd() * strands.length)];
      const j = Math.floor(rnd() * (st.pts.length / 2)) * 2;
      const [r, g, b] = rnd() < 0.4 ? pick(WARM) : pick(TEAL);
      const rad = 0.6 + rnd() * 1.3;
      const grd = c.createRadialGradient(st.pts[j] * f.s, st.pts[j + 1] * f.s, 0, st.pts[j] * f.s, st.pts[j + 1] * f.s, rad * 3);
      grd.addColorStop(0, `rgba(${r},${g},${b},0.3)`);
      grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
      c.fillStyle = grd;
      c.beginPath();
      c.arc(st.pts[j] * f.s, st.pts[j + 1] * f.s, rad * 3, 0, Math.PI * 2);
      c.fill();
    }
    // Let the edges dissolve into the paper, like the watercolours on the reference site.
    c.globalCompositeOperation = 'destination-in';
    const mist = c.createRadialGradient(0, 0, f.s * 0.45, 0, 0, f.s * 1.12);
    mist.addColorStop(0, 'rgba(0,0,0,1)');
    mist.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = mist;
    c.fillRect(-side / 2, -side / 2, side, side);
    cache.side = side;
  }

  // Small glowing sprite reused for every pulse.
  const sprites = {};
  function sprite([r, g, b]) {
    const key = `${r},${g},${b}`;
    if (sprites[key]) return sprites[key];
    const s = document.createElement('canvas');
    s.width = s.height = 32;
    const c = s.getContext('2d');
    const grd = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, `rgba(${r},${g},${b},0.6)`);
    grd.addColorStop(0.35, `rgba(${r},${g},${b},0.25)`);
    grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
    c.fillStyle = grd;
    c.fillRect(0, 0, 32, 32);
    return (sprites[key] = s);
  }

  // Signals travel outward along a strand (or inward when "listening").
  function spawn(kind = 'idle', n = 1) {
    for (let i = 0; i < n && pulses.length < 160; i++) {
      const pool = kind === 'think' || kind === 'tool' ? strands.filter((s) => s.kind === 'axon') : strands;
      const st = pool[Math.floor(Math.random() * pool.length)];
      const color = kind === 'think' ? WARM[Math.floor(Math.random() * 3)]
        : kind === 'tool' ? WARM[0]
          : kind === 'error' ? DANGER
            : TEAL[Math.floor(Math.random() * 2)];  // ink-dark pulses read as smudges on paper
      pulses.push({
        st, pos: 0, speed: (kind === 'idle' ? 0.35 : 0.9) + Math.random() * 0.8,
        color, size: kind === 'idle' ? 5 : kind === 'tool' ? 11 : 8, life: 1,
      });
    }
  }

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    renderCache();
    if (reduceMotion) draw(0);
  }

  function draw(dt) {
    const f = geom || (geom = frame());
    const ease = 1 - Math.pow(0.001, dt);
    cur.alpha += (target.alpha - cur.alpha) * ease * 0.6;
    cur.scale += (target.scale - cur.scale) * ease * 0.6;
    cur.heat += (target.heat - cur.heat) * ease;

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Static web, breathing very slightly.
    const breathe = 1 + Math.sin(t * 0.6) * 0.008 + cur.heat * 0.01;
    const sc = cur.scale * breathe;
    ctx.save();
    ctx.translate(f.cx, f.cy);
    ctx.rotate(f.rot + Math.sin(t * 0.07) * 0.02);
    ctx.scale(sc, sc);
    ctx.globalAlpha = cur.alpha;
    ctx.drawImage(cache, -cache.side / 2, -cache.side / 2, cache.side, cache.side);

    // Hubs bloom like watercolour stains while the model is thinking.
    ctx.globalCompositeOperation = 'multiply';
    for (const h of hubs) {
      const glow = (0.25 + cur.heat * 0.9) * h.r * (0.85 + 0.15 * Math.sin(t * 2 + h.x * 5));
      const s = sprite(WARM[0]);
      const size = f.s * 0.14 * glow;
      ctx.globalAlpha = Math.min(1, cur.alpha * glow);
      ctx.drawImage(s, h.x * f.s - size / 2, h.y * f.s - size / 2, size, size);
    }

    // Pulses.
    ctx.globalAlpha = 1;
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      const n = p.st.pts.length / 2;
      p.pos += p.speed * dt * 30;
      if (p.pos >= n - 1) { pulses.splice(i, 1); continue; }
      const j = Math.floor(p.pos) * 2;
      const fr = p.pos % 1;
      const x = (p.st.pts[j] + (p.st.pts[j + 2] - p.st.pts[j]) * fr) * f.s;
      const y = (p.st.pts[j + 1] + (p.st.pts[j + 3] - p.st.pts[j + 1]) * fr) * f.s;
      const fade = Math.min(1, p.pos / 4) * Math.min(1, (n - 1 - p.pos) / 6);
      ctx.globalAlpha = fade * Math.max(cur.alpha, 0.22);
      ctx.drawImage(sprite(p.color), x - p.size, y - p.size, p.size * 2, p.size * 2);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function loop(now) {
    if (document.hidden || paused) { last = 0; return; }
    requestAnimationFrame(loop);
    if (last && now - last < 1000 / FPS - 2) return;
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 1 / FPS;
    last = now;
    t += dt;
    if (Math.random() < spawnRate * dt) spawn(mode === 'busy' ? 'token' : 'idle');
    draw(dt);
  }

  // ---------- reacting to the app ----------

  function setMode(next) {
    if (next !== mode && (next === 'hero' || mode === 'hero')) requestAnimationFrame(() => renderCache());
    mode = next;
    if (next === 'hero') Object.assign(target, { alpha: 0.9, scale: 1, heat: 0.1 });
    if (next === 'chat') Object.assign(target, { alpha: 0.14, scale: 1.08, heat: 0 });
    if (next === 'busy') Object.assign(target, { alpha: 0.24, scale: 1.08, heat: 0.35 });
    spawnRate = next === 'busy' ? 3 : next === 'hero' ? 1.2 : 0.4;
  }

  function syncFromDom() {
    const messages = document.getElementById('messages');
    const busy = !document.getElementById('stopBtn')?.classList.contains('hidden');
    const empty = !!messages?.querySelector('.empty');
    setMode(busy ? 'busy' : empty ? 'hero' : 'chat');

    // Model loading ring. Only touch it when the status really changed (it is outside
    // the observed elements, but this keeps layout work to a minimum).
    const status = document.getElementById('modelStatus')?.textContent || '';
    if (status === syncFromDom.lastStatus) return;
    syncFromDom.lastStatus = status;
    const ring = document.getElementById('loadRing');
    if (!ring) return;
    if (/^(loading|restoring)/.test(status)) {
      const pct = Number((status.match(/(\d+)%/) || [])[1] || 0);
      ring.classList.remove('hidden');
      const f = frame();
      ring.style.left = `${f.cx - 66}px`;
      ring.style.top = `${f.cy - 66}px`;
      ring.querySelector('.ring-progress').style.strokeDashoffset = String(301.6 * (1 - pct / 100));
      ring.querySelector('.ring-label').textContent = /^restoring/.test(status) ? 'Restoring' : 'Loading';
      ring.querySelector('.ring-sub').textContent = `${pct}%`;
      target.heat = 0.25 + pct / 200;
      spawn('idle', 3);
    } else if (!ring.classList.contains('hidden')) {
      ring.classList.add('hidden');
    }
  }

  // Stream activity: thinking lights the warm cores, written tokens send teal signals.
  window.localpilot?.onChatChunk?.(({ chunk }) => {
    for (const ch of chunk.choices ?? []) {
      const d = ch.delta ?? {};
      if (d.reasoning_content) { target.heat = 0.9; if (Math.random() < 0.6) spawn('think'); }
      if (d.content) { target.heat = Math.max(0.35, target.heat * 0.97); if (Math.random() < 0.7) spawn('token'); }
      if (d.tool_calls && Math.random() < 0.3) spawn('tool');
    }
  });

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.('.tool') || node.querySelector?.('.tool')) spawn('tool', 26);
        if (node.matches?.('.ask') || node.querySelector?.('.ask')) { spawn('think', 18); target.heat = 0.6; }
        if (node.matches?.('.notice.error')) spawn('error', 20);
        if (node.matches?.('.undo-bar')) spawn('idle', 12);
      }
    }
    syncFromDom();
  });

  function start() {
    const t0 = performance.now();
    grow();
    resize();
    window.__neuralStats = { strands: strands.length, setupMs: Math.round(performance.now() - t0) };
    syncFromDom();
    // Watch only what matters: new messages, the busy button, and the model status text.
    const watch = (id, opts) => { const el = document.getElementById(id); if (el) observer.observe(el, opts); };
    watch('messages', { childList: true, subtree: true });
    watch('stopBtn', { attributes: true, attributeFilter: ['class'] });
    watch('modelStatus', { childList: true, characterData: true, subtree: true });
    window.addEventListener('resize', () => { clearTimeout(start.rt); start.rt = setTimeout(resize, 150); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !reduceMotion) requestAnimationFrame(loop); });
    if (!reduceMotion) requestAnimationFrame(loop);
  }

  // Small control surface (used for the performance check and by the app if needed).
  let paused = false;
  window.__neural = {
    pause() { paused = true; ctx.clearRect(0, 0, canvas.width, canvas.height); canvas.style.visibility = 'hidden'; },
    resume() { if (!paused) return; paused = false; canvas.style.visibility = ''; last = 0; requestAnimationFrame(loop); },
    get paused() { return paused; },
    // A burst of signals, used when the user presses a control.
    fire(n = 8) {
      spawn('think', n);
      target.heat = Math.min(1, target.heat + 0.25);
      clearTimeout(this.cool);
      this.cool = setTimeout(() => syncFromDom(), 900);
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
