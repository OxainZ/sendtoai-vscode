require('./vscode-stub.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractPathToken, parseFileBlocks } = require('../out/extension.js');
const { estimateCost } = require('../out/costEstimator.js');

test('extractPathToken strips markdown and normalises backslashes', () => {
  assert.equal(extractPathToken('**src/a.ts**'), 'src/a.ts');
  assert.equal(extractPathToken('`lib\\util.py`'), 'lib/util.py');
  assert.equal(extractPathToken('File: src/index.tsx'), 'src/index.tsx');
  assert.equal(extractPathToken('ts src/a.ts'), 'src/a.ts');
  assert.equal(extractPathToken('plain words only'), '');
});

test('parseFileBlocks reads the path from the fence info string', () => {
  const reply = 'Here you go:\n```ts src/a.ts\nexport const a = 1;\n```\n';
  assert.deepEqual(parseFileBlocks(reply), [{ path: 'src/a.ts', content: 'export const a = 1;' }]);
});

test('parseFileBlocks reads a label line above the fence, even across a blank line', () => {
  const reply = '**src/b.ts**\n\n```ts\nconst b = 2;\n```\n';
  assert.deepEqual(parseFileBlocks(reply), [{ path: 'src/b.ts', content: 'const b = 2;' }]);
});

test('parseFileBlocks never turns prose like "e.g." or "Node.js" into a target file', () => {
  const reply = 'Install it with npm, e.g. on Node.js 20.\n```bash\nnpm install\n```\n';
  assert.deepEqual(parseFileBlocks(reply), [], 'unlabelled shell block is not a file');
});

test('parseFileBlocks forgets a label once prose intervenes', () => {
  const reply = '`src/c.ts`\nNow run the tests, which should pass.\n```bash\nnpm test\n```\n';
  assert.deepEqual(parseFileBlocks(reply), []);
});

test('estimateCost uses 2026 list prices and the Haiku long-prompt tier', () => {
  const small = estimateCost(10_000);
  assert.equal(small.haiku, '$0.001');
  assert.equal(small.sonnet, '$0.020');
  assert.equal(small.opus, '$0.040');
  const big = estimateCost(200_000);
  assert.equal(big.haiku, '$0.100', '200K tokens at $0.50/M');
  assert.equal(big.opus, '$0.800');
});
