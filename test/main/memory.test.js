// Chats on disk, the journal's queue of chats to summarize, project notes and history search.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { loadMain } = require('../harness/main');
const { test, run } = require('../harness/run');

const m = loadMain();
const chat = (id, updatedAt, messages) => ({ id, title: `Chat ${id}`, updatedAt, messages });
const answered = [{ role: 'user', content: 'make a budget script' }, { role: 'assistant', content: 'Done: budget.py totals expenses by category.' }];

test('saves, lists newest first, loads and deletes chats', async () => {
  await m.invoke('chats:save', chat('a', 1000, answered));
  await m.invoke('chats:save', chat('b', 2000, answered));
  assert.deepEqual((await m.invoke('chats:list')).map((c) => c.id), ['b', 'a']);
  assert.equal((await m.invoke('chats:load', 'a')).messages[1].content, answered[1].content);
  await m.invoke('chats:delete', 'b');
  assert.deepEqual((await m.invoke('chats:list')).map((c) => c.id), ['a']);
});

test('chat ids can\'t reach outside the chats folder', async () => {
  await m.invoke('chats:save', chat('../../evil', 1, answered));
  assert(!fs.existsSync(path.join(m.dataDir, '..', '..', 'evil.json')));
  assert(fs.existsSync(path.join(m.dataDir, 'chats', 'evil.json')));
  await m.invoke('chats:delete', '../../evil');
});

test('the journal queues chats with an answer that changed since their summary', async () => {
  await m.invoke('chats:save', chat('q1', 5000, answered));
  await m.invoke('chats:save', chat('q2', 6000, answered));
  await m.invoke('chats:save', chat('thinking-only', 7000, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', reasoning: 'hmm' }]));
  assert.deepEqual(await m.invoke('journal:pending', {}), ['q2', 'q1', 'a'], 'newest first, no answer-less chats');
  assert.deepEqual(await m.invoke('journal:pending', { exclude: 'q2' }), ['q1', 'a'], 'the open chat can be left out');

  assert.equal(await m.invoke('journal:save', { chatId: 'q1', chatUpdatedAt: 5000, summary: 'Budget script.' }), true);
  assert.deepEqual(await m.invoke('journal:pending', {}), ['q2', 'a']);
  await m.invoke('chats:save', chat('q1', 8000, answered));
  assert.deepEqual(await m.invoke('journal:pending', {}), ['q1', 'q2', 'a'], 'a chat that continued is summarized again');
  assert.equal(await m.invoke('journal:save', { chatId: 'gone', chatUpdatedAt: 1 }), false, 'no entries for deleted chats');
});

test('reads the workspace and project notes', async () => {
  fs.writeFileSync(path.join(m.workspace, 'LOCALPILOT.md'), '# Workspace\nUse Python 3.\n');
  fs.mkdirSync(path.join(m.workspace, 'budget'), { recursive: true });
  fs.writeFileSync(path.join(m.workspace, 'budget', 'LOCALPILOT.md'), '# Budget\nCSV in, totals out.\n');
  const mem = await m.invoke('memory:read', { project: 'budget' });
  assert.match(mem.root, /Use Python 3/);
  assert.match(mem.project, /CSV in, totals out/);
  const none = await m.invoke('memory:read', { project: null });
  assert.match(none.root, /Use Python 3/);
  assert(!none.project);
});

test('long notes are cut at a line break, and the full size is reported', async () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `- note ${i}: keep the budget script simple`);
  const text = lines.join('\n');
  fs.writeFileSync(path.join(m.workspace, 'LOCALPILOT.md'), text);
  const mem = await m.invoke('memory:read', { project: null });
  assert.equal(mem.rootSize, text.length);
  assert(mem.root.length <= mem.limit && mem.root.length > mem.limit / 2);
  assert(lines.includes(mem.root.split('\n').at(-1)), 'ends on a whole line');
});

test('search_history finds earlier chats but not the current one', async () => {
  const out = await m.invoke('history:search', { query: 'budget expenses', excludeChatId: 'q2' });
  assert.match(out, /Chat q1|Chat a/);
  assert(!/Chat q2/.test(out), out);
  await assert.rejects(m.invoke('history:search', { query: ' ' }), /query is required/);
});

run('memory');
