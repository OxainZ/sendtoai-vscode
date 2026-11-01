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

const { cacheSignature, cacheIsAuthentic } = require('../out/extension.js');

test('license cache signature detects tampering and rejects unsigned caches', () => {
  const secret = 'abc123';
  const c = { key: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', valid: false, checkedAt: 1000, lastValidAt: 0 };
  const signed = { ...c, sig: cacheSignature(secret, c) };
  assert.equal(cacheIsAuthentic(secret, signed), true);
  assert.equal(cacheIsAuthentic(secret, { ...signed, valid: true }), false, 'flipping valid must invalidate');
  assert.equal(cacheIsAuthentic(secret, { ...signed, checkedAt: 9_999_999_999 }), false, 'future timestamp must invalidate');
  assert.equal(cacheIsAuthentic('other', signed), false, 'different secret');
  assert.equal(cacheIsAuthentic(secret, c), false, 'unsigned cache is never trusted');
});

const { parseReply, applySearchReplace } = require('../out/reply.js');

test('parseReply: long fences, tilde fences, first-line comment paths', () => {
  const reply = [
    'Here is the README:', '', '````markdown README.md', '# Title', '', '```js', 'inner fence stays', '```', '````', '',
    '~~~python', '# src/app.py', 'print(1)', '~~~', '',
    '```css', '/* styles/main.css */', 'body { margin: 0 }', '```',
  ].join('\n');
  const edits = parseReply(reply);
  assert.deepEqual(edits.map(e => [e.path, e.kind]), [['README.md', 'full'], ['src/app.py', 'full'], ['styles/main.css', 'full']]);
  assert.equal(edits[0].content, '# Title\n\n```js\ninner fence stays\n```', 'inner triple fence must not close a quad fence');
  assert.equal(edits[1].content, 'print(1)', 'comment path line is stripped');
});

test('parseReply: SEARCH/REPLACE inside a fence and raw with a label line', () => {
  const reply = [
    '```', 'src/a.ts', '<<<<<<< SEARCH', 'const a = 1;', '=======', 'const a = 2;', '>>>>>>> REPLACE', '```', '',
    '**src/b.ts**', '<<<<<<< SEARCH', 'old', '=======', 'new', '>>>>>>> REPLACE', '',
    'And prose mentioning Node.js afterwards.',
  ].join('\n');
  const edits = parseReply(reply);
  assert.deepEqual(edits, [
    { path: 'src/a.ts', kind: 'replace', edits: [{ search: 'const a = 1;', replace: 'const a = 2;' }] },
    { path: 'src/b.ts', kind: 'replace', edits: [{ search: 'old', replace: 'new' }] },
  ]);
});

test('applySearchReplace: exact, whitespace/CRLF tolerant, not-found and ambiguous are reported', () => {
  const file = 'function a() {\r\n  return 1;  \r\n}\r\nfunction b() {\r\n  return 1;  \r\n}\r\n';
  const r1 = applySearchReplace(file, [{ search: 'function a() {\n  return 1;\n}', replace: 'function a() {\n  return 42;\n}' }]);
  assert.equal(r1.applied, 1); assert.deepEqual(r1.failed, []);
  assert.ok(r1.content.startsWith('function a() {\r\n  return 42;\r\n}'), 'keeps the file\'s CRLF endings');
  const r2 = applySearchReplace(file, [{ search: '  return 1;', replace: '  return 2;' }]);
  assert.equal(r2.applied, 0); assert.match(r2.failed[0], /ambiguous/);
  const r3 = applySearchReplace(file, [{ search: 'nothing like this', replace: 'x' }]);
  assert.equal(r3.applied, 0); assert.match(r3.failed[0], /not found/);
});

const { groupReplyEdits } = require('../out/reply.js');

test('groupReplyEdits: relativises machine paths, drops escapes, composes full + SEARCH/REPLACE, flags truncation', () => {
  const g = groupReplyEdits([
    { path: 'Users/me/proj/src/a.ts', kind: 'full', content: 'x' },           // C:\\Users\\me\\proj\\src\\a.ts after token extraction
    { path: 'src/a.ts', kind: 'replace', edits: [{ search: 'x', replace: 'y' }] },
    { path: '../etc/passwd', kind: 'full', content: 'nope' },
    { path: './src/b.ts', kind: 'full', content: 'b', truncated: true },
    { path: 'SRC/B.ts', kind: 'replace', edits: [{ search: 'b', replace: 'c' }] },
  ], 'proj');
  assert.deepEqual([...g.keys()], ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(g.get('src/a.ts'), { full: 'x', truncated: undefined, sr: [{ search: 'x', replace: 'y' }] });
  assert.equal(g.get('src/b.ts').truncated, true, 'truncated flag survives');
  assert.equal(g.get('src/b.ts').sr.length, 1, 'case-variant path merged');
});

test('parseReply flags a reply cut off before the closing fence', () => {
  const edits = parseReply('```ts src/a.ts\nconst a = 1;\n// and then the chat ended');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].truncated, true);
});

test('reply parsing stays fast on adversarial input', () => {
  const evil = '```\n// ' + ' '.repeat(20000) + 'x*\n```\n' + 'a'.repeat(200000) + '.ts\n';
  const t0 = Date.now();
  parseReply(evil);
  assert.ok(Date.now() - t0 < 500, 'must not take seconds on long/odd lines');
});
