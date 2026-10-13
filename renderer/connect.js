// Connect panel: share this machine, use models on other machines (on this network or in a remote
// group through the relay), split one model across machines, and choose where background jobs run.
// Loaded after renderer.js and uses its helpers ($, el, api, state, notice, …).

(() => {
  const net = api.network;
  if (!net) return;

  const drafts = {};          // what's typed in the panel's inputs, kept across re-renders
  const open = { pairWith: null, addAddress: false, invite: {}, poolCheck: null };
  let renderPending = false;

  const busyNames = (list) => list.map((p) => p.name).join(', ');
  const ago = (ms) => {
    const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const gib = (mib) => `${(mib / 1024).toFixed(mib < 10240 ? 1 : 0)} GB`;
  const input = (key, attrs = {}) => {
    const i = el('input', { type: 'text', ...attrs });
    i.value = drafts[key] ?? '';
    i.addEventListener('input', () => { drafts[key] = i.value; });
    i.addEventListener('blur', () => { if (renderPending) render(); });
    return i;
  };
  const errorLine = (key) => el('p', { class: 'connect-error', text: drafts[`err:${key}`] ?? '' });
  const setError = (key, msg) => { drafts[`err:${key}`] = msg || ''; render(true); };

  // Run a network call; show its error next to the control that asked.
  async function act(key, fn) {
    setError(key, '');
    const res = await fn();
    if (!res?.ok) setError(key, res?.error || 'That didn\'t work.');
    return res?.ok ? res : null;
  }

  function offers(adv) {
    if (!adv?.sharing) return 'not sharing';
    const parts = [];
    if (adv.models.length) parts.push(adv.models.map((m) => m.name).join(', '));
    if (adv.memory) parts.push(`${gib(Math.min(adv.memory.capMiB, adv.memory.freeMiB || adv.memory.capMiB))} memory`);
    if (adv.busy) parts.push('owner is using it');
    return parts.join(' · ') || 'sharing nothing loaded';
  }

  const dot = (on, warn) => el('span', { class: `cdot${on ? (warn ? ' warn' : ' on') : ''}`, 'aria-hidden': 'true' });

  // ---------- sections ----------

  function shareSection(s) {
    const share = s.share;
    const sec = el('section', { class: 'connect-section' });
    const sw = el('button', { class: `switch${share.on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(!!share.on), 'aria-label': 'Share this computer' });
    sw.addEventListener('click', () => act('share', () => net.setShare({ on: !share.on })));
    sec.append(el('div', { class: 'row space' },
      el('div', {}, el('h3', { text: 'Share this computer' }), el('p', { class: 'muted small', text: share.on ? `Others you've paired with or share a group with can use it. Shown to them as “${s.me.name}”.` : 'Off. Turn on to let paired machines and your groups use this computer.' })),
      sw));
    if (share.on) {
      const check = (label, key, disabled, title) => {
        const box = el('input', { type: 'checkbox' });
        box.checked = !!share[key];
        box.disabled = !!disabled;
        box.addEventListener('change', () => act('share', () => net.setShare({ [key]: box.checked })));
        return el('label', { class: 'check', title: title ?? '' }, box, label);
      };
      const mem = el('input', { type: 'number', min: '1', max: '512', step: '1', class: 'num' });
      mem.value = String(share.memoryGiB);
      mem.addEventListener('change', () => act('share', () => net.setShare({ memoryGiB: Number(mem.value) })));
      sec.append(
        el('div', { class: 'row wrap connect-options' },
          check('Models (whatever is loaded)', 'models'),
          check('Memory for pooled models', 'memory', !s.rpcAvailable, s.rpcAvailable ? '' : 'Needs llama.cpp built with RPC in ~/llama.cpp/build-rpc'),
          share.memory ? el('label', { class: 'check' }, 'up to', mem, 'GB') : '',
          check('Pause while I\'m using it', 'onlyIdle')),
      );
      if (s.pairing) {
        sec.append(el('p', { class: 'pair-code' },
          'Pairing code ', el('strong', { class: 'code', text: `${s.pairing.code.slice(0, 3)} ${s.pairing.code.slice(3)}` }),
          el('span', { class: 'muted', 'data-expires': String(s.pairing.expires), text: ` · expires in ${ago(s.pairing.expires)}` })));
      } else {
        const btn = el('button', { class: 'btn small', text: 'Show a pairing code' });
        btn.addEventListener('click', () => act('share', () => net.newCode()));
        sec.append(el('p', { class: 'pair-code muted' }, 'Pair another machine on this network with a code. ', btn));
      }
      if (s.serving.length) sec.append(el('p', { class: 'small ok-text', text: `Answering for ${s.serving.join(', ')} right now.` }));
      if (!s.rpcAvailable) sec.append(el('p', { class: 'muted small', text: 'To share memory for pooled models, build llama.cpp with RPC: cmake -S ~/llama.cpp -B ~/llama.cpp/build-rpc -DGGML_RPC=ON, then build llama-server and ggml-rpc-server.' }));
    }
    if (s.lan.error) sec.append(el('p', { class: 'connect-error', text: s.lan.error }));
    sec.append(errorLine('share'));
    return sec;
  }

  function networkSection(s) {
    const sec = el('section', { class: 'connect-section' });
    sec.append(el('h3', { text: 'On this network' }));
    const list = el('div', { class: 'clist' });
    if (!s.network.length) list.append(el('p', { class: 'muted small', text: 'No other LocalPilot machines found. A machine shows up here when Share this computer is on there.' }));
    for (const p of s.network) {
      const sub = p.connected
        ? `${p.via === 'lan' ? 'direct' : 'through the relay'}${p.rtt != null ? ` · ${p.rtt} ms` : ''} · ${offers(p.adv)}`
        : p.paired ? (p.connecting ? 'connecting…' : `paired · not reachable${p.addr ? ` at ${p.addr}` : ''}`) : `${p.host}:${p.port} · not paired`;
      const actions = el('div', { class: 'row' });
      if (p.paired) {
        const forget = el('button', { class: 'btn ghost small', text: 'Forget' });
        forget.addEventListener('click', () => act(`peer:${p.id}`, () => net.unpair({ id: p.id })));
        actions.append(forget);
      } else {
        const pair = el('button', { class: 'btn small', text: 'Pair' });
        pair.addEventListener('click', () => { open.pairWith = open.pairWith === p.id ? null : p.id; render(true); });
        actions.append(pair);
      }
      list.append(el('div', { class: 'crow' }, dot(p.connected, p.adv?.busy), el('div', { class: 'cmain' }, el('div', { text: p.name }), el('div', { class: 'muted small', text: sub })), actions));
      if (open.pairWith === p.id) list.append(pairForm(`pair:${p.id}`, { id: p.id }, p.name));
      if (drafts[`err:peer:${p.id}`]) list.append(errorLine(`peer:${p.id}`));
    }
    sec.append(list);
    const add = el('button', { class: 'btn ghost small', text: open.addAddress ? 'Cancel' : 'Add by address' });
    add.addEventListener('click', () => { open.addAddress = !open.addAddress; render(true); });
    sec.append(el('div', { class: 'row' }, add));
    if (open.addAddress) sec.append(pairForm('pair:addr', null, null));
    return sec;
  }

  function pairForm(key, target, name) {
    const code = input(`${key}:code`, { placeholder: name ? `Code shown on ${name}` : 'Code shown on the other machine', inputmode: 'numeric', maxlength: '7', class: 'code-input' });
    const addr = target ? null : input(`${key}:addr`, { placeholder: '192.168.1.20 or studio.local' });
    const go = el('button', { class: 'btn small primary', text: 'Pair' });
    go.addEventListener('click', async () => {
      const c = (drafts[`${key}:code`] ?? '').trim();
      if (!/^\d{3}\s?\d{3}$/.test(c)) return setError(key, 'Enter the 6-digit code shown on the other machine.');
      if (!target && !(drafts[`${key}:addr`] ?? '').trim()) return setError(key, 'Enter the other machine\'s address.');
      go.disabled = true;
      go.textContent = 'Pairing…';
      const res = await act(key, () => net.pair({ ...(target ?? { address: drafts[`${key}:addr`] }), code: c }));
      if (res) {
        drafts[`${key}:code`] = '';
        open.pairWith = null;
        open.addAddress = false;
        notice(`Paired with ${res.name}. Its shared models are in the model list.`);
        render(true);
      }
    });
    return el('div', { class: 'pair-form' }, el('div', { class: 'row' }, ...(addr ? [addr] : []), code, go), errorLine(key));
  }

  function groupSection(s) {
    const sec = el('section', { class: 'connect-section' });
    sec.append(el('h3', { text: 'Remote groups' }));
    if (!s.relay.url) {
      sec.append(el('p', { class: 'muted small', text: 'Groups let machines outside your home use each other\'s models. They connect through a relay server, which passes along encrypted traffic it can\'t read.' }));
      const url = input('relay', { placeholder: 'wss://relay.example.com/ws' });
      const save = el('button', { class: 'btn small', text: 'Use this relay' });
      save.addEventListener('click', () => act('relay', () => net.setRelay({ url: drafts.relay })));
      sec.append(el('div', { class: 'row' }, url, save), errorLine('relay'));
      return sec;
    }
    sec.append(el('p', { class: 'muted small' }, dot(s.relay.connected), ` ${s.relay.connected ? 'Connected to' : 'Can\'t reach'} the relay at ${s.relay.url}${s.relay.error && !s.relay.connected ? ` (${s.relay.error})` : ''}`));
    for (const g of s.groups) {
      const box = el('div', { class: 'cgroup' });
      box.append(el('div', { class: 'row space' }, el('strong', { text: g.name }), el('span', { class: 'muted small', text: `${g.members.filter((m) => m.online).length} of ${g.members.length} online` })));
      const list = el('div', { class: 'clist' });
      for (const m of g.members) {
        const sub = m.me ? 'this machine'
          : !m.online ? 'offline'
            : m.connected ? `${m.via === 'lan' ? 'direct' : 'through the relay'}${m.rtt != null ? ` · ${m.rtt} ms` : ''} · ${offers(m.adv)}` : 'connecting…';
        const row = el('div', { class: 'crow' }, dot(m.me || m.online, m.adv?.busy), el('div', { class: 'cmain' }, el('div', { text: `${m.name}${m.id === g.owner ? ' (owner)' : ''}` }), el('div', { class: 'muted small', text: sub })));
        if (g.mine && !m.me) {
          const rm = el('button', { class: 'btn ghost small', text: 'Remove' });
          rm.addEventListener('click', () => act(`group:${g.id}`, () => net.group({ t: 'remove', group: g.id, id: m.id })));
          row.append(rm);
        }
        list.append(row);
      }
      for (const p of g.pending) {
        const yes = el('button', { class: 'btn small primary', text: 'Approve' });
        const no = el('button', { class: 'btn ghost small', text: 'Deny' });
        yes.addEventListener('click', () => act(`group:${g.id}`, () => net.group({ t: 'approve', group: g.id, id: p.id, ok: true })));
        no.addEventListener('click', () => act(`group:${g.id}`, () => net.group({ t: 'approve', group: g.id, id: p.id, ok: false })));
        list.append(el('div', { class: 'crow pending' }, dot(true, true), el('div', { class: 'cmain' }, el('div', { text: p.name }), el('div', { class: 'muted small', text: 'wants to join' })), el('div', { class: 'row' }, yes, no)));
      }
      box.append(list);
      const invite = el('button', { class: 'btn small', text: 'Invite' });
      invite.addEventListener('click', async () => {
        const res = await act(`group:${g.id}`, () => net.group({ t: 'invite', group: g.id }));
        if (res) { open.invite[g.id] = res.code; render(true); }
      });
      const leave = el('button', { class: 'btn ghost small danger-text', text: 'Leave' });
      leave.addEventListener('click', () => {
        if (window.confirm(`Leave ${g.name}? Its machines' models disappear from your list.`)) act(`group:${g.id}`, () => net.group({ t: 'leave', group: g.id }));
      });
      box.append(el('div', { class: 'row' }, invite, el('span', { class: 'spacer' }), leave));
      if (open.invite[g.id]) {
        const code = open.invite[g.id];
        const copy = el('button', { class: 'btn ghost small', text: 'Copy' });
        copy.addEventListener('click', () => { navigator.clipboard?.writeText(code); copy.textContent = 'Copied'; });
        box.append(el('p', { class: 'pair-code' }, 'Invite code ', el('strong', { class: 'code', text: code }), ' ', copy,
          el('span', { class: 'muted small', text: ' · works once, for 24 hours. They enter it under Join a group, then you approve them here.' })));
      }
      box.append(errorLine(`group:${g.id}`));
      sec.append(box);
    }
    for (const w of s.waiting) sec.append(el('p', { class: 'muted small', text: `Waiting for someone in ${w.name} to approve you.` }));
    const name = input('newGroup', { placeholder: 'Group name, e.g. Campbell lab' });
    const create = el('button', { class: 'btn small', text: 'Create a group' });
    create.addEventListener('click', async () => {
      if (await act('groups', () => net.group({ t: 'create', name: drafts.newGroup || 'My group' }))) { drafts.newGroup = ''; render(true); }
    });
    const code = input('joinCode', { placeholder: 'Invite code, e.g. LP-7Q4K-92', class: 'code-input' });
    const join = el('button', { class: 'btn small', text: 'Join a group' });
    join.addEventListener('click', async () => {
      if (!(drafts.joinCode ?? '').trim()) return setError('groups', 'Enter the invite code you were given.');
      const res = await act('groups', () => net.group({ t: 'join', code: drafts.joinCode }));
      if (res) { drafts.joinCode = ''; notice(res.status === 'member' ? 'You\'re already in that group.' : 'Request sent. Someone in the group needs to approve you.'); render(true); }
    });
    sec.append(el('div', { class: 'row' }, name, create), el('div', { class: 'row' }, code, join), errorLine('groups'));
    const change = el('button', { class: 'btn ghost small', text: 'Change relay' });
    change.addEventListener('click', () => { if (window.confirm('Disconnect from this relay? Your groups stay on it.')) act('relay', () => net.setRelay({ url: '' })); });
    sec.append(el('div', { class: 'row' }, change), errorLine('relay'));
    return sec;
  }

  function poolSection(s) {
    const sec = el('section', { class: 'connect-section' });
    sec.append(el('h3', { text: 'Pooled model' }));
    sec.append(el('p', { class: 'muted small', text: 'Run a model too big for this Mac by splitting it across machines that share memory. Every word passes through each machine, so it\'s fast on a home network and slow over the internet.' }));
    if (s.pool) sec.append(el('p', { class: 'small ok-text', text: `Running ${modelInfo(s.pool.modelKey)?.displayName ?? s.pool.modelKey}, pooled with ${s.pool.peers.join(', ')}.` }));
    if (!s.rpcAvailable) {
      sec.append(el('p', { class: 'muted small', text: 'This Mac needs llama.cpp built with RPC (in ~/llama.cpp/build-rpc) to load pooled models.' }));
      return sec;
    }
    if (!s.poolCandidates.length) {
      sec.append(el('p', { class: 'muted small', text: 'No connected machine is sharing memory. On the other machine, turn on Share this computer and Memory for pooled models.' }));
      return sec;
    }
    const pick = el('select', { 'aria-label': 'Model to split' });
    for (const m of state.models.downloaded) pick.append(el('option', { value: m.modelKey, text: m.displayName }));
    if (drafts.poolModel) pick.value = drafts.poolModel;
    pick.addEventListener('change', () => { drafts.poolModel = pick.value; open.poolCheck = null; });
    drafts.poolModel = pick.value;
    const chosen = drafts.poolPeers ??= new Set();
    const list = el('div', { class: 'clist' });
    for (const p of s.poolCandidates) {
      const box = el('input', { type: 'checkbox' });
      box.checked = chosen.has(p.id);
      box.addEventListener('change', () => { if (box.checked) chosen.add(p.id); else chosen.delete(p.id); open.poolCheck = null; render(true); });
      list.append(el('label', { class: 'crow check' }, box, el('div', { class: 'cmain' },
        el('div', { text: p.name }),
        el('div', { class: 'muted small', text: `${gib(Math.min(p.capMiB, p.freeMiB || p.capMiB))} · ${p.via === 'lan' ? 'direct' : 'through the relay'}${p.rtt != null ? ` · ${p.rtt} ms` : ''}` }))));
    }
    const check = el('button', { class: 'btn small', text: 'Check speed' });
    const load = el('button', { class: 'btn small primary', text: 'Load across machines' });
    check.disabled = load.disabled = !chosen.size;
    check.addEventListener('click', async () => {
      check.textContent = 'Measuring…';
      const res = await act('pool', () => net.poolEstimate({ peerIds: [...chosen] }));
      if (res) { open.poolCheck = res; render(true); }
    });
    load.addEventListener('click', async () => {
      let est = open.poolCheck;
      if (!est) est = await act('pool', () => net.poolEstimate({ peerIds: [...chosen] }));
      if (!est) return;
      if (est.slow && !window.confirm(`Measured just now: about ${est.tokPerSec} tokens a second, and long prompts can take minutes before the first word. If one machine leaves, the model stops. It starts on Low effort (no thinking). Load it anyway?`)) return;
      state.loadingModel = 'loading across machines…';
      renderModelStatus();
      closeModals();
      const res = await net.loadPool({ modelKey: drafts.poolModel, contextLength: state.settings.contextLength, peerIds: [...chosen] });
      state.loadingModel = null;
      if (res.ok) {
        state.settings = await api.setSettings({ model: drafts.poolModel, ...(est.slow ? { effort: 'low' } : {}) });
        if (est.slow) setSegment('effortSeg', 'low');
        notice(`Loaded ${modelInfo(drafts.poolModel)?.displayName ?? drafts.poolModel} across this Mac and ${[...chosen].length} other machine${chosen.size > 1 ? 's' : ''}.`);
      } else {
        notice(`Couldn't load the pooled model: ${res.error}`, 'error');
      }
      await refreshModels();
    });
    sec.append(el('div', { class: 'row' }, pick), list, el('div', { class: 'row' }, check, load));
    if (open.poolCheck) {
      const e = open.poolCheck;
      sec.append(el('p', { class: `small ${e.slow ? 'warn-text' : 'ok-text'}`, text: `About ${e.tokPerSec} tokens a second, ${gib(e.totalMiB)} of memory in total.${e.slow ? ' Over the internet: slow, and long prompts take minutes before the first word.' : ''}` }));
    }
    sec.append(errorLine('pool'));
    return sec;
  }

  function backgroundSection(s) {
    const sec = el('section', { class: 'connect-section' });
    sec.append(el('h3', { text: 'Background jobs' }));
    sec.append(el('p', { class: 'muted small', text: 'Journal summaries and note tidy-ups can run on another machine, so this one stays free for your chat.' }));
    const pick = el('select', { 'aria-label': 'Where background jobs run' });
    pick.append(el('option', { value: '', text: 'The chat\'s model (this Mac)' }));
    for (const m of state.models.remote ?? []) {
      pick.append(el('option', { value: m.modelKey, text: m.route ? `Best available on ${m.scopeName}` : `${m.displayName} on ${m.peerName}` }));
    }
    pick.value = s.background || '';
    pick.addEventListener('change', async () => {
      await act('bg', () => net.setBackground({ model: pick.value }));
      state.settings = await api.getSettings();
    });
    sec.append(el('div', { class: 'row' }, pick), errorLine('bg'));
    return sec;
  }

  function nameSection(s) {
    const sec = el('div', { class: 'row connect-me' });
    const name = input('deviceName', { placeholder: s.me.name, 'aria-label': 'This machine\'s name' });
    const save = el('button', { class: 'btn ghost small', text: 'Rename' });
    save.addEventListener('click', async () => {
      if (await act('name', () => net.rename({ name: drafts.deviceName }))) { drafts.deviceName = ''; render(true); }
    });
    sec.append(el('span', { class: 'muted small', text: 'This machine:' }), name, save);
    return el('div', {}, sec, errorLine('name'));
  }

  // ---------- render ----------

  function render(force = false) {
    const body = $('connectBody');
    if ($('connectModal').classList.contains('hidden') || !state.network) return;
    // Don't redraw under someone typing; catch up when they leave the field.
    if (!force && body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') {
      renderPending = true;
      return;
    }
    renderPending = false;
    const s = state.network;
    body.innerHTML = '';
    body.append(
      nameSection(s),
      shareSection(s),
      networkSection(s),
      groupSection(s),
      poolSection(s),
      backgroundSection(s),
      el('p', { class: 'connect-trust muted small', text: '🔒 Prompts go to the machine running the model, and its owner could see them. Connect only machines you trust. The model status at the top always says where a chat is running.' }),
    );
  }

  function renderBadge() {
    const s = state.network;
    const badge = $('connectBadge');
    const pending = (s?.groups ?? []).reduce((n, g) => n + g.pending.length, 0);
    const n = pending || s?.online || 0;
    badge.textContent = String(n);
    badge.classList.toggle('hidden', !n);
    badge.classList.toggle('attention', pending > 0);
    $('connectBtn').title = pending ? `${pending} waiting for approval` : n ? `${n} machine${n > 1 ? 's' : ''} sharing with you` : 'Use models on other machines, or share this one';
  }

  function apply(s) {
    state.network = s;
    state.models.remote = s.remoteModels ?? [];
    renderModelSelect();
    renderModelStatus();
    renderBadge();
    render();
  }

  net.onState(apply);
  net.onServed(({ slotOwner, peerName }) => {
    (state.servedBy ??= {})[slotOwner] = peerName;
    renderModelStatus();
  });
  net.state().then((r) => { if (r?.ok) apply(r.state); });

  $('connectBtn').addEventListener('click', () => { openModal('connectModal'); render(true); });

  // Count down the pairing code while the panel is open.
  setInterval(() => {
    const span = document.querySelector('#connectBody [data-expires]');
    if (!span) return;
    const left = Number(span.dataset.expires) - Date.now();
    if (left <= 0) return net.state().then((r) => r?.ok && apply(r.state));
    span.textContent = ` · expires in ${ago(Number(span.dataset.expires))}`;
  }, 1000);
})();
