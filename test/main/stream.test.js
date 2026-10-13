// chat:stream: parsing the model server's event stream, errors, stopping, and the end marker.
const assert = require('assert');
const { loadMain } = require('../harness/main');
const { fakeModel } = require('../harness/fake-model');
const { test, run } = require('../harness/run');

const m = loadMain();
const body = (extra = {}) => ({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, ...extra });

// Runs one request and collects what the renderer would receive.
async function stream(reply, { requestId = 'r' + Math.random(), extra, during } = {}) {
  const fake = fakeModel([reply]);
  const start = m.sent.length;
  const pending = m.invoke('chat:stream', { requestId, body: body(extra) });
  if (during) await during(requestId);
  const result = await pending;
  fake.restore();
  const msgs = m.sent.slice(start).filter((s) => s.channel === 'chat:chunk' && s.payload.requestId === requestId).map((s) => s.payload);
  const chunks = msgs.filter((p) => !p.done).map((p) => p.chunk);
  const text = (k) => chunks.flatMap((c) => c.choices ?? []).map((c) => c.delta?.[k] ?? '').join('');
  return { result, msgs, chunks, content: text('content'), reasoning: text('reasoning_content'), request: fake.requests[0] };
}

test('reassembles a reply split at any byte, including inside a character', async () => {
  const content = 'Héllo — wörld 🙂 with "quotes" and\nnewlines';
  for (const chunkBytes of [1, 3, 7, 64]) {
    const r = await stream({ reasoning: 'Thinking it over.', content, chunkBytes });
    assert.deepEqual(r.result, { ok: true });
    assert.equal(r.content, content, `chunkBytes ${chunkBytes}`);
    assert.equal(r.reasoning, 'Thinking it over.');
  }
});

test('passes tool calls through in pieces, as the server sends them', async () => {
  const r = await stream({ tools: [{ name: 'write_file', args: { path: 'a.py', content: 'x = 1' } }] });
  const parts = r.chunks.flatMap((c) => c.choices ?? []).flatMap((c) => c.delta?.tool_calls ?? []);
  assert.equal(parts[0].function.name, 'write_file');
  assert.deepEqual(JSON.parse(parts.map((p) => p.function.arguments).join('')), { path: 'a.py', content: 'x = 1' });
});

test('the end marker comes after every chunk, including the usage', async () => {
  const r = await stream({ content: 'ok', usage: { prompt_tokens: 5, completion_tokens: 2 } });
  assert.deepEqual(r.msgs.at(-1), { requestId: r.msgs[0].requestId, chunk: {}, done: true });
  assert.equal(r.msgs.filter((p) => p.done).length, 1);
  assert.deepEqual(r.msgs.at(-2).chunk.usage, { prompt_tokens: 5, completion_tokens: 2 });
});

test('asks for usage in the stream and passes settings through to LM Studio', async () => {
  const r = await stream({ content: 'ok' }, { extra: { reasoning_effort: 'none', temperature: 0.6 } });
  assert.equal(r.request.stream, true);
  assert.deepEqual(r.request.stream_options, { include_usage: true });
  assert.equal(r.request.reasoning_effort, 'none');
  assert.equal(r.request.temperature, 0.6);
});

test('ignores keep-alives and malformed lines', async () => {
  const good = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const raw = [': keep-alive\n\n', 'data: {not json\n\n', 'event: ping\n',
    good({ choices: [{ delta: { content: 'still ' } }] }), '\n\n', good({ choices: [{ delta: { content: 'fine' }, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'].join('');
  const r = await stream({ raw });
  assert.deepEqual(r.result, { ok: true });
  assert.equal(r.content, 'still fine');
});

test('reports an engine crash mid-answer', async () => {
  const r = await stream({ content: 'partial', error: 'process terminated unexpectedly' });
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /engine crashed while answering/);
  assert.equal(r.msgs.at(-1).done, true, 'the renderer is still told the stream ended');
});

test('reports other engine errors and HTTP errors', async () => {
  const e = await stream({ content: '', error: 'context length exceeded' });
  assert.match(e.result.error, /reported an error: context length exceeded/);
  const h = await stream({ status: 400, text: 'model not loaded' });
  assert.deepEqual(h.result, { ok: false, error: 'LM Studio returned 400: model not loaded' });
  assert.equal(h.msgs.at(-1).done, true);
});

test('stops when aborted and says so', async () => {
  const r = await stream({ content: 'one two three four five six seven eight nine ten', chunkBytes: 4, delayMs: 15 }, {
    during: async (requestId) => {
      await new Promise((res) => setTimeout(res, 60));
      await m.invoke('chat:abort', requestId);
    },
  });
  assert.deepEqual(r.result, { ok: true, aborted: true });
  assert(r.content.length < 'one two three four five six seven eight nine ten'.length, `got all of it: ${r.content}`);
  assert.equal(r.msgs.at(-1).done, true);
});

test('says when the server can\'t be reached', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  try {
    const r = await m.invoke('chat:stream', { requestId: 'down', body: body() });
    assert.deepEqual(r, { ok: false, error: 'Could not reach LM Studio at http://localhost:1234/v1: fetch failed' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

run('stream');
