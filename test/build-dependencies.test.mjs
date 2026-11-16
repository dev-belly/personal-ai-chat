import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// Resolve the actual consumers in the adapter's dependency tree rather than
// testing an unrelated top-level glob installation.
const adapterRequire = createRequire(import.meta.resolve('@opennextjs/cloudflare'));
const awsRequire = createRequire(adapterRequire.resolve('@opennextjs/aws/minimize-js.js'));
const minify = awsRequire('@node-minify/core');
const compressor = awsRequire('@node-minify/terser');

for (const arrayInput of [false, true]) {
  test(`OpenNext's minifier expands ${arrayInput ? 'array' : 'string'} glob inputs and preserves behavior`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'chat-build-fixture-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = join(directory, 'input');
    await mkdir(source);
    for (const [name, amount] of [['first', 2], ['second', 3]]) {
      await writeFile(join(source, `${name}.js`),
        `/* fixture: must be removed */\nglobalThis.fixtureTotal = (globalThis.fixtureTotal || 0) + ${amount};\n`);
    }
    const pattern = join(source, '*.js').replaceAll('\\', '/');
    const output = join(directory, 'bundle.min.js');
    await minify({ compressor, input: arrayInput ? [pattern] : pattern, output });
    const bundle = await readFile(output, 'utf8');
    assert.doesNotMatch(bundle, /fixture: must be removed/);
    const context = {};
    runInNewContext(bundle, context, { timeout: 1_000 });
    assert.equal(context.fixtureTotal, 5);
  });
}
