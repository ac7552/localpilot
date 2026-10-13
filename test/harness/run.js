// The smallest test runner: named async tests, run in order, with a summary and exit code.
const tests = [];
const only = process.env.TEST_ONLY;

function test(name, fn) { tests.push({ name, fn }); }

async function run(file) {
  let failed = 0;
  for (const t of tests) {
    if (only && !t.name.includes(only)) continue;
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${t.name}\n${String(err.stack || err).replace(/^/gm, '      ')}`);
    }
  }
  console.log(failed ? `${file}: ${failed} failed` : `${file}: all passed`);
  process.exit(failed ? 1 : 0);
}

module.exports = { test, run };
