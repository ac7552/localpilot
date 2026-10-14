// The agent loop end to end: a scripted model, the real UI, real files in a temporary workspace.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { loadApp, sleep } = require('../harness/app');
const { fakeModel } = require('../harness/fake-model');
const { test, run } = require('../harness/run');

const call = (name, args) => ({ name, args });
const toolResults = (body) => body.messages.filter((x) => x.role === 'tool').map((x) => x.content);

// One fresh app per test; the fake model answers in order.
async function withApp(opts, replies, fn) {
  const app = await loadApp(opts);
  const model = fakeModel(replies);
  try {
    await fn(app, model);
    assert.deepEqual(app.errors, [], 'no errors in the page');
  } finally {
    model.restore();
    await app.close();
  }
}

test('Auto mode: writes a file, runs a command without asking, then answers', () => withApp({}, [
  { reasoning: 'Write the script first.', tools: [call('write_file', { path: 'hello/hello.py', content: 'print("hi from hello")\n' })] },
  { tools: [call('run_command', { command: 'python3 hello/hello.py', reason: 'Check the script prints its greeting.' })] },
  { content: 'Done! Run it with `python3 hello/hello.py`.' },
], async (app, model) => {
  await app.start('Make a hello script and run it');
  assert.equal(app.buttons('Run').length, 0, 'no approval card for a safe command');
  assert.equal(app.text(app.window.document.querySelector('.tool .tool-reason')), 'Check the script prints its greeting.', 'the reason is shown');

  assert.equal(fs.readFileSync(path.join(app.workspace, 'hello/hello.py'), 'utf8'), 'print("hi from hello")\n');
  assert.match(toolResults(model.requests[1])[0], /Wrote 23 bytes to hello\/hello.py\nAutomatic check: Syntax check passed\./);
  assert.match(toolResults(model.requests[2])[1], /^exit code: 0\nhi from hello/);
  assert.equal(app.text(app.lastAnswer().querySelector('.content')), 'Done! Run it with python3 hello/hello.py.');
  assert(app.buttons('Save as skill').length, 'the answer can be saved as a skill');
  assert.equal(app.ev('state.chat.project'), 'hello', 'the project is picked up from the path');

  const saved = JSON.parse(fs.readFileSync(path.join(app.m.dataDir, 'chats', `${app.ev('state.chat.id')}.json`), 'utf8'));
  assert.equal(saved.messages.filter((x) => x.role === 'assistant').at(-1).content, 'Done! Run it with `python3 hello/hello.py`.');

  await app.click('Undo');
  await app.waitFor(() => !fs.existsSync(path.join(app.workspace, 'hello/hello.py')), 'undo to remove the file');
}));

test('Manual mode asks before a command; denied, it doesn\'t run and the model hears why', () => withApp({ settings: { mode: 'manual' } }, [
  { tools: [call('run_command', { command: 'touch ran.txt' })] },
  { content: 'Understood, I won\'t run it.' },
], async (app, model) => {
  const sending = app.start('Touch a file');
  await app.waitFor(() => app.buttons('Deny')[0], 'the approval card');
  app.window.document.querySelector('.tool-actions input').value = 'use Python instead';
  await app.click('Deny');
  await sending;
  assert(!fs.existsSync(path.join(app.workspace, 'ran.txt')));
  assert.match(toolResults(model.requests[1])[0], /The user denied this run_command\. Reason: use Python instead/);
}));

const fetchStub = { 'tool:fetch_url': ({ url }) => `HTTP 200 ${url}\n\nPage text` };

test('Auto mode runs risky-looking commands and fetches any URL without asking', () => withApp({ settings: { web: true }, overrides: fetchStub }, [
  { tools: [call('run_command', { command: 'touch ran.txt && rm -f ran.txt && touch kept.txt' })] },
  { tools: [call('fetch_url', { url: 'https://example.com/log?d=c2VjcmV0' })] },
  { content: 'Done.' },
], async (app, model) => {
  await app.start('Look into example.com');
  assert.equal(app.window.document.querySelectorAll('.tool-actions').length, 0, 'no approval cards');
  assert(fs.existsSync(path.join(app.workspace, 'kept.txt')));
  assert.match(toolResults(model.requests[2])[1], /^HTTP 200 https:\/\/example.com\/log\?d=/);
}));

test('Manual mode asks before fetching a URL that didn\'t come from the user or a search', () => withApp({ settings: { web: true, mode: 'manual' }, overrides: fetchStub }, [
  { tools: [call('fetch_url', { url: 'https://example.com/docs' })] },
  { content: 'Done.' },
], async (app, model) => {
  const sending = app.start('Look into example.com');
  await app.waitFor(() => app.buttons('Approve')[0], 'the approval card');
  assert.equal(model.requests.length, 1, 'the fetch waits for approval');
  await app.click('Approve');
  await sending;
  assert.match(toolResults(model.requests[1])[0], /^HTTP 200 https:\/\/example.com\/docs/);
}));

test('Auto mode keeps going past the effort\'s step limit by itself', () => withApp({ settings: { effort: 'low' } }, [
  ...Array.from({ length: 10 }, (_, i) => ({ tools: [call('run_command', { command: `echo step ${i}`, reason: 'Count.' })] })),
  { content: 'All ten steps done.' },
], async (app, model) => {
  await app.start('Do ten steps');
  assert.equal(model.requests.length, 11, 'it ran past Low effort\'s 8 steps without waiting');
  assert(app.notices().some((n) => /Auto mode is continuing on its own/.test(n)));
  assert.equal(app.text(app.lastAnswer().querySelector('.content')), 'All ten steps done.');
}));

test('Auto mode stops a model stuck repeating the same tool call', () => withApp({}, () => (
  { tools: [call('run_command', { command: 'echo same', reason: 'Again.' })] }
), async (app, model) => {
  await app.start('Loop forever');
  assert.equal(model.requests.length, 3, 'stops after the third identical call');
  assert(app.notices().some((n) => /same tool call 3 times in a row/.test(n)));
}));

test('Auto mode stops a model making no progress, even with reworded retries', () => withApp({}, (_body, n) => (
  // A different failing command each step: not an exact repeat (so SAME_CALL_LIMIT misses it),
  // but every one exits non-zero, so the no-progress breaker should stop it.
  { tools: [call('run_command', { command: `echo attempt ${n} >&2; exit 1`, reason: `Retry ${n}.` })] }
), async (app, model) => {
  await app.start('Keep failing');
  assert.equal(model.requests.length, 5, 'stops after 5 unproductive steps, not at AUTO_MODE_MAX_STEPS');
  assert(app.notices().some((n) => /steps in a row returned errors or no output/.test(n)));
}));

test('Manual mode still stops at the step limit', () => withApp({ settings: { effort: 'low', mode: 'manual' } }, (_body, n) => (
  { tools: [call('search_files', { pattern: `term${n}` })] }
), async (app, model) => {
  await app.start('Search a lot');
  assert.equal(model.requests.length, 8);
  assert(app.notices().some((n) => /Reached the 8-step limit for low effort/.test(n)));
}));

test('Manual mode asks before writing a file and shows what it will write', () => withApp({ settings: { mode: 'manual' } }, [
  { tools: [call('write_file', { path: 'notes.txt', content: 'line one\nline two' })] },
  { content: 'OK, left it alone.' },
], async (app, model) => {
  const sending = app.start('Write some notes');
  await app.waitFor(() => app.buttons('Approve')[0], 'the approval card');
  assert.match(app.text(app.window.document.querySelector('.tool.pending')), /New file \(2 lines\) line one line two/);
  await app.click('Deny');
  await sending;
  assert(!fs.existsSync(path.join(app.workspace, 'notes.txt')));
  assert.match(toolResults(model.requests[1])[0], /The user denied this write_file/);
}));

test('Chat mode sends no tools', () => withApp({ settings: { mode: 'chat' } }, [
  { content: 'A TCP handshake is SYN, SYN-ACK, ACK.' },
], async (app, model) => {
  await app.send('How does a TCP handshake work?');
  assert.equal(model.requests[0].tools, undefined);
  assert.equal(app.text(app.lastAnswer().querySelector('.content')), 'A TCP handshake is SYN, SYN-ACK, ACK.');
}));

test('Chat mode flags an answer that claims it created files', () => withApp({ settings: { mode: 'chat' } }, [
  { content: 'I\'ve created the file audit.py for you. The files are located at /tmp/audit.py.' },
], async (app) => {
  await app.send('Write me a security audit script and save it');
  const banner = app.lastAnswer().querySelector('.banner.grounding');
  assert(banner, 'a grounding warning is shown');
  assert.match(banner.textContent, /Nothing was created or run/);
  // The next turn is told the claim was false, so a small model stops doubling down.
  const note = app.ev("state.chat.messages.filter((m) => m.role === 'user' && m.hidden).at(-1)?.content");
  assert.match(note, /no file or command tools in Chat mode/);
}));

test('a real file write is not flagged as confabulation', () => withApp({}, [
  { tools: [call('write_file', { path: 'r/real.py', content: 'print("real")\n' })] },
  { content: 'I\'ve created r/real.py for you.' },
], async (app) => {
  await app.send('Make a real script');
  assert(!app.lastAnswer().querySelector('.banner.grounding'), 'no grounding warning when a file really was written');
}));

test('paths outside the workspace come back to the model as errors', () => withApp({}, [
  { tools: [call('write_file', { path: '../escape.txt', content: 'x' }), call('read_file', { path: '/etc/hosts' })] },
  { content: 'I can only work inside the workspace.' },
], async (app, model) => {
  await app.send('Write outside');
  const [w, r] = toolResults(model.requests[1]);
  assert.match(w, /^Error: Path "\.\.\/escape\.txt" is outside the workspace/);
  assert.match(r, /^Error: Path "\/etc\/hosts" is outside the workspace/);
  assert(!fs.existsSync(path.join(path.dirname(app.workspace), 'escape.txt')));
}));

test('bad tool arguments and unknown tools are reported, not run', () => withApp({}, [
  { raw: [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'write_file', arguments: '{"path": "x.txt", ' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'delete_everything', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
    'data: [DONE]\n\n'].join('') },
  { content: 'Sorry about that.' },
], async (app, model) => {
  await app.send('Do something');
  const [bad, unknown] = toolResults(model.requests[1]);
  assert.match(bad, /not valid JSON/);
  assert.match(unknown, /tool "delete_everything" is not available/);
  const sent = model.requests[1].messages.find((x) => x.tool_calls).tool_calls;
  assert.equal(sent[0].function.arguments, '{}', 'broken arguments are not sent back, or LM Studio rejects the request');
  assert.equal(sent[1].function.arguments, '{}');
}));

test('Auto effort starts without thinking and turns it on after a failed self-check', () => withApp({ settings: { effort: 'auto' } }, [
  { tools: [call('write_file', { path: 'calc/calc.py', content: 'def add(a, b:\n    return a + b\n' })] },
  { tools: [call('write_file', { path: 'calc/calc.py', content: 'def add(a, b):\n    return a + b\n' })] },
  { content: 'Fixed and checked.' },
], async (app, model) => {
  await app.send('Write an add function');
  assert.equal(model.requests[0].reasoning_effort, 'none');
  assert.match(toolResults(model.requests[1])[0], /Syntax check failed/);
  assert.equal(model.requests[1].reasoning_effort, undefined, 'thinking is on for the next step');
  assert(app.notices().some((n) => /Thinking turned on .*a self-check failed/.test(n)), app.notices().join('\n'));
}));

test('the model can ask a question and gets the answer', () => withApp({}, [
  { tools: [call('ask_user', { question: 'Which language?', options: ['Python', 'Go'] })] },
  { content: 'Python it is.' },
], async (app, model) => {
  const sending = app.start('Write a script');
  await app.click('Go');
  await sending;
  assert.equal(toolResults(model.requests[1])[0], 'The user answered: Go');
}));

test('an answer left inside unclosed thinking is shown as the answer', () => withApp({}, [
  { tools: [call('write_file', { path: 'a.txt', content: 'a' })] },
  { reasoning: 'Done! I created a.txt for you.' },
], async (app) => {
  await app.send('Make a.txt');
  const answer = app.lastAnswer();
  assert.equal(app.text(answer.querySelector('.content')), 'Done! I created a.txt for you.');
  assert(answer.querySelector('.thinking').classList.contains('hidden'));
  assert(app.buttons('Save as skill').length);
  assert.deepEqual(await app.m.invoke('journal:pending', {}), [app.ev('state.chat.id')], 'the chat can be summarized');
}));

test('running out of output while thinking says so, and keeps the thought as thinking', () => withApp({}, [
  { reasoning: 'Let me think about this very carefully…', finish: 'length' },
], async (app) => {
  await app.send('Something hard');
  assert(app.notices().some((n) => /used its whole .*-token output budget thinking/.test(n)), app.notices().join('\n'));
  assert.equal(app.text(app.lastAnswer().querySelector('.content')), '');
}));

test('usage that arrives after the stream ends is still counted', () => withApp({ chunkDelayMs: 40 }, [
  { content: 'All of this answer arrives.', usage: { prompt_tokens: 321, completion_tokens: 42 } },
], async (app) => {
  await app.send('Hi');
  assert.equal(app.text(app.lastAnswer().querySelector('.content')), 'All of this answer arrives.');
  assert.equal(app.ev('state.chat.usage.completion'), 42);
  assert.match(app.lastAnswer().querySelector('.meta').textContent, /^321 in · 42 out/);
}));

test('saved prompts expand before sending', () => withApp({}, [
  { content: 'Tests written.' },
], async (app, model) => {
  await app.send('/test the CSV parser');
  assert.equal(model.requests[0].messages.at(-1).content, 'Write tests for the CSV parser. Use the project\'s existing test setup if it has one, then run them and fix failures.');
}));

test('Stop ends a run part way through', () => withApp({}, [
  { content: 'one two three four five six seven eight nine ten eleven twelve', chunkBytes: 3, delayMs: 20 },
], async (app) => {
  const sending = app.start('Count slowly');
  await app.waitFor(() => app.text(app.lastAnswer()?.querySelector('.content')).length > 0, 'the answer to start');
  await app.click('Stop');
  await sending;
  assert.match(app.lastAnswer().querySelector('.meta').textContent, /stopped/);
  assert(!app.text(app.lastAnswer().querySelector('.content')).includes('twelve'));
}));

test('the estimate names what makes the whole chat be read again', () => withApp({}, [
  { content: 'Hello.' },
], async (app) => {
  await app.send('Hi');
  const note = async (text) => {
    app.$('input').value = text;
    app.ev('promptHelp.memory.at = 0');
    await app.ev('renderPromptHelp()');
    return app.$('estimateDetail').textContent;
  };
  assert.match(await note('and again'), /Already cached/);
  fs.writeFileSync(path.join(app.workspace, 'LOCALPILOT.md'), '# Notes\nUse Python.\n');
  assert.match(await note('and again'), /The LOCALPILOT\.md notes changed since the last message, so the whole chat is read again\./);
  fs.rmSync(path.join(app.workspace, 'LOCALPILOT.md'));
  await app.click('Low');
  await sleep(50);
  assert.match(await note('and again'), /Effort, mode or tools changed since the last message/);
  await app.click('Medium');
  await sleep(50);
  assert.match(await note('and again'), /Already cached/);
}));

run('agent');
