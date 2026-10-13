// A stand-in for LM Studio's /chat/completions: replies are scripted per request and streamed as
// server-sent events, the way the real servers send them. Everything else still goes to the network.
const realFetch = globalThis.fetch;

// A reply: { content, reasoning, tools: [{ name, args }], finish, usage, status, error, raw, chunkBytes }
function sse(reply) {
  if (reply.raw != null) return reply.raw;
  const event = (o) => `data: ${JSON.stringify({ object: 'chat.completion.chunk', ...o })}\n\n`;
  const out = [];
  const words = (text) => text.match(/\S+\s*|\s+/g) ?? [];
  for (const w of words(reply.reasoning ?? '')) out.push(event({ choices: [{ index: 0, delta: { reasoning_content: w } }] }));
  for (const w of words(reply.content ?? '')) out.push(event({ choices: [{ index: 0, delta: { content: w } }] }));
  (reply.tools ?? []).forEach((t, i) => {
    const args = JSON.stringify(t.args ?? {});
    const half = Math.ceil(args.length / 2);
    out.push(event({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${i}`, type: 'function', function: { name: t.name, arguments: args.slice(0, half) } }] } }] }));
    out.push(event({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(half) } }] } }] }));
  });
  if (reply.error) out.push(`data: ${JSON.stringify({ error: { message: reply.error } })}\n\n`);
  const finish = reply.finish ?? ((reply.tools ?? []).length ? 'tool_calls' : 'stop');
  out.push(event({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }));
  out.push(event({ choices: [], usage: reply.usage ?? { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
  out.push('data: [DONE]\n\n');
  return out.join('');
}

// Installs the fake. `replies` is a list (used in order) or a function (body, n) => reply.
function fakeModel(replies) {
  const requests = [];
  const next = (body) => {
    const n = requests.length - 1;
    const r = typeof replies === 'function' ? replies(body, n) : replies[n];
    if (!r) throw new Error(`The fake model has no reply #${n + 1} (prompt: ${JSON.stringify(body.messages.at(-1)).slice(0, 200)})`);
    return r;
  };
  globalThis.fetch = async (url, opts = {}) => {
    if (!/\/chat\/completions$/.test(String(url))) return realFetch(url, opts);
    const body = JSON.parse(opts.body);
    requests.push(body);
    const reply = next(body);
    if (reply.status) return new Response(reply.text ?? 'error', { status: reply.status });
    // Arbitrary byte boundaries, as TCP delivers them: lines and even characters get split.
    const bytes = new TextEncoder().encode(sse(reply));
    const size = reply.chunkBytes ?? 7;
    const signal = opts.signal;
    let pos = 0;
    const stream = new ReadableStream({
      async pull(c) {
        if (signal?.aborted) return c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (pos >= bytes.length) return c.close();
        c.enqueue(bytes.slice(pos, pos + size));
        pos += size;
        await new Promise((r) => setTimeout(r, reply.delayMs ?? 0));
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { requests, restore: () => { globalThis.fetch = realFetch; } };
}

module.exports = { fakeModel, sse };
