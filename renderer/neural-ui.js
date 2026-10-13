// Interface motion after davidwhyte.com: a ring cursor that trails the pointer and opens
// over anything clickable, text that comes into focus out of a blur and softens again at
// the edges of the scroll area, and a burst of dendrites wherever a control is pressed.
// Purely visual; it never changes what a control does.

(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CONTROLS = 'button, a, select, summary, .chat-list li, .suggestion, .slash-item, .ask .opt, label.check';
  const TYPING = 'input, textarea, [contenteditable="true"]';

  // ---------- ring cursor ----------
  const ring = document.createElement('div');
  ring.className = 'cursor-ring';
  ring.setAttribute('aria-hidden', 'true');
  const dot = document.createElement('div');
  dot.className = 'cursor-dot';
  dot.setAttribute('aria-hidden', 'true');
  document.body.append(ring, dot);
  document.documentElement.classList.add('ring-cursor');

  let px = -100;
  let py = -100;
  let rx = -100;
  let ry = -100;
  let following = false;
  function follow() {
    rx += (px - rx) * 0.11;  // a slow, floating follow
    ry += (py - ry) * 0.11;
    ring.style.transform = `translate(${rx}px, ${ry}px)`;
    if (Math.abs(px - rx) + Math.abs(py - ry) > 0.3) requestAnimationFrame(follow);
    else following = false;
  }
  document.addEventListener('pointermove', (e) => {
    px = e.clientX;
    py = e.clientY;
    dot.style.transform = `translate(${px}px, ${py}px)`;
    if (reduceMotion) { rx = px; ry = py; ring.style.transform = `translate(${rx}px, ${ry}px)`; return; }
    if (!following) { following = true; requestAnimationFrame(follow); }
  }, { passive: true });
  document.addEventListener('pointerover', (e) => {
    const typing = !!e.target.closest?.(TYPING);
    const control = !typing && !!e.target.closest?.(CONTROLS);
    document.documentElement.classList.toggle('cursor-over-control', control);
    document.documentElement.classList.toggle('cursor-over-text', typing);
  }, { passive: true });
  document.addEventListener('pointerleave', () => document.documentElement.classList.add('cursor-away'));
  document.addEventListener('pointerenter', () => document.documentElement.classList.remove('cursor-away'));
  document.addEventListener('pointerdown', () => document.documentElement.classList.add('cursor-pressed'), { passive: true });
  document.addEventListener('pointerup', () => document.documentElement.classList.remove('cursor-pressed'), { passive: true });

  // ---------- a press fires dendrites ----------
  function burst(x, y) {
    const b = document.createElement('div');
    b.className = 'synapse-burst';
    b.style.left = `${x}px`;
    b.style.top = `${y}px`;
    const n = 7;
    for (let i = 0; i < n; i++) {
      const d = document.createElement('i');
      d.style.setProperty('--a', `${(360 / n) * i + Math.random() * 34}deg`);
      d.style.setProperty('--l', `${16 + Math.random() * 24}px`);
      b.append(d);
    }
    document.body.append(b);
    setTimeout(() => b.remove(), 1400);
  }
  document.addEventListener('pointerdown', (e) => {
    const control = e.target.closest?.(CONTROLS);
    if (!control || control.disabled) return;
    if (!reduceMotion) burst(e.clientX, e.clientY);
    if (!window.__neural?.fireAt?.(e.clientX, e.clientY)) window.__neural?.fire?.();
  }, { passive: true });

  // ---------- text in and out of focus at the edges of the conversation ----------
  const messages = document.getElementById('messages');
  const EDGE = 90;
  let queued = false;
  function focusPass() {
    queued = false;
    if (!messages || reduceMotion) return;
    const box = messages.getBoundingClientRect();
    for (const el of messages.children) {
      const r = el.getBoundingClientRect();
      if (r.bottom < box.top - 40 || r.top > box.bottom + 40 || el.classList.contains('empty')) {
        if (el.style.filter) { el.style.filter = ''; el.style.opacity = ''; }
        continue;
      }
      // Judge by the element's middle, so a long answer only softens when it's mostly gone.
      const mid = (r.top + r.bottom) / 2;
      const edge = Math.min(mid - box.top, box.bottom - mid, Math.min(r.bottom - box.top, box.bottom - r.top));
      const k = clamp01((EDGE - edge) / EDGE);
      el.style.filter = k > 0.02 ? `blur(${(k * 5).toFixed(2)}px)` : '';
      el.style.opacity = k > 0.02 ? String(1 - k * 0.55) : '';
    }
  }
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(focusPass); } };
  messages?.addEventListener('scroll', queue, { passive: true });
  if (messages) new MutationObserver(queue).observe(messages, { childList: true });
  window.addEventListener('resize', queue);
})();
