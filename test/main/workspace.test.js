// File tools: everything stays inside the workspace, edits are exact, and a run can be undone.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { loadMain, tempDir } = require('../harness/main');
const { test, run } = require('../harness/run');

const m = loadMain();
const ws = m.workspace;
const outside = tempDir('outside');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not read');
const write = (rel, content) => m.invoke('tool:write_file_tracked', { path: rel, content, chatId: 'c1', runId: 'r1' });

test('reads, writes and lists inside the workspace', async () => {
  assert.match(await write('app/main.py', 'print("hi")\n'), /Wrote 12 bytes to app\/main.py/);
  assert.equal(await m.invoke('tool:read_file', { path: 'app/main.py' }), 'print("hi")\n');
  assert.equal(await m.invoke('tool:list_files', { dir: '.' }), 'app/\napp/main.py');
});

test('refuses paths that leave the workspace', async () => {
  for (const p of ['../x.txt', '/etc/passwd', path.join(outside, 'secret.txt'), 'app/../../x.txt']) {
    await assert.rejects(m.invoke('tool:read_file', { path: p }), /outside the workspace/, p);
    await assert.rejects(write(p, 'x'), /outside the workspace/, p);
  }
  await assert.rejects(m.invoke('tool:list_files', { dir: '..' }), /outside the workspace/);
  assert(!fs.existsSync(path.join(path.dirname(ws), 'x.txt')));
});

test('refuses symlinks that point out of the workspace, for files and folders', async () => {
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'link.txt'));
  fs.symlinkSync(outside, path.join(ws, 'linkdir'));
  await assert.rejects(m.invoke('tool:read_file', { path: 'link.txt' }), /outside the workspace/);
  await assert.rejects(m.invoke('tool:read_file', { path: 'linkdir/secret.txt' }), /outside the workspace/);
  await assert.rejects(write('linkdir/new.txt', 'x'), /outside the workspace/);
  assert(!fs.existsSync(path.join(outside, 'new.txt')));
  fs.rmSync(path.join(ws, 'link.txt'));
  fs.rmSync(path.join(ws, 'linkdir'));
});

test('edit_file replaces exactly one match, or explains why it can\'t', async () => {
  await write('notes.txt', 'a = 1\nb = 1\nb = 1\n');
  const edit = (args) => m.invoke('tool:edit_file', { path: 'notes.txt', chatId: 'c1', runId: 'r1', ...args });
  assert.match(await edit({ old_string: 'a = 1', new_string: 'a = $&2' }), /replaced 1 occurrence\./);
  assert.equal(fs.readFileSync(path.join(ws, 'notes.txt'), 'utf8'), 'a = $&2\nb = 1\nb = 1\n', 'replacement text is literal');
  await assert.rejects(edit({ old_string: 'b = 1', new_string: 'b = 2' }), /appears 2 times/);
  await assert.rejects(edit({ old_string: 'zzz', new_string: 'y' }), /was not found/);
  await assert.rejects(edit({ old_string: '', new_string: 'y' }), /old_string is empty/);
  await assert.rejects(m.invoke('tool:edit_file', { path: 'missing.txt', old_string: 'a', new_string: 'b' }), /does not exist/);
  assert.match(await edit({ old_string: 'b = 1', new_string: 'b = 2', replace_all: true }), /replaced 2 occurrences/);
});

test('undo restores changed files and removes created ones', async () => {
  fs.writeFileSync(path.join(ws, 'keep.txt'), 'original\n');
  const w = (rel, content) => m.invoke('tool:write_file_tracked', { path: rel, content, chatId: 'c2', runId: 'run' });
  await w('keep.txt', 'changed once\n');
  await w('keep.txt', 'changed twice\n');
  await w('new/file.txt', 'brand new\n');
  const changes = await m.invoke('checkpoint:run', { chatId: 'c2', runId: 'run' });
  assert.deepEqual(changes, [{ rel: 'keep.txt', existed: true }, { rel: 'new/file.txt', existed: false }]);
  const r = await m.invoke('checkpoint:undo', { chatId: 'c2', runId: 'run' });
  assert.deepEqual(r, { ok: true, restored: ['removed new/file.txt', 'restored keep.txt'] });
  assert.equal(fs.readFileSync(path.join(ws, 'keep.txt'), 'utf8'), 'original\n', 'back to before the run, not the middle');
  assert(!fs.existsSync(path.join(ws, 'new/file.txt')));
  assert.deepEqual(await m.invoke('checkpoint:undo', { chatId: 'c2', runId: 'run' }), { ok: false, error: 'Nothing to undo for this run.' });
});

test('commands run in the workspace and stream their output', async () => {
  const before = m.sent.length;
  const out = await m.invoke('tool:run_command', { command: 'pwd; echo to-stderr >&2; exit 3', requestId: 'cmd1' });
  assert.match(out, /^exit code: 3\n/);
  assert(out.includes(ws), out);
  assert(out.includes('to-stderr'));
  const streamed = m.sent.slice(before).filter((s) => s.channel === 'tool:commandOutput' && s.payload.requestId === 'cmd1');
  assert(streamed.map((s) => s.payload.text).join('').includes('to-stderr'));
});

test('commands are stopped at their timeout', async () => {
  const t0 = Date.now();
  const out = await m.invoke('tool:run_command', { command: 'sleep 30', requestId: 'cmd2', timeoutSec: 1 });
  assert(Date.now() - t0 < 5000);
  assert.match(out, /stopped after 1s/);
});

test('the self-check catches syntax errors', async () => {
  await write('ok.py', 'x = 1\n');
  await write('bad.py', 'def f(:\n');
  await write('bad.json', '{"a": }');
  assert.equal(await m.invoke('tool:check_file', { path: 'ok.py' }), 'Syntax check passed.');
  assert.match(await m.invoke('tool:check_file', { path: 'bad.py' }), /^Syntax check failed:\nline 1/);
  assert.match(await m.invoke('tool:check_file', { path: 'bad.json' }), /^Invalid JSON/);
  assert.equal(await m.invoke('tool:check_file', { path: 'notes.txt' }), null, 'no checker for plain text');
});

run('workspace');
