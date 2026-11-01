require('./vscode-stub.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  compilePattern, matchesGitignore, shouldIgnore, isUnderIgnoredDir,
  compactSource, stripJSComments, estimateTokens,
} = require('../out/bundler.js');

const rules = (...lines) => lines.map(compilePattern).filter(Boolean);

test('gitignore: simple glob, anchored dir, negation, and **/ at root level', () => {
  const r = rules('*.log', '/build', '!keep.log', '**/*.tmp', 'docs/**');
  assert.equal(matchesGitignore('debug.log', r, 'debug.log'), true);
  assert.equal(matchesGitignore('keep.log', r, 'keep.log'), false, 'negation wins');
  assert.equal(matchesGitignore('build', r, 'build'), true);
  assert.equal(matchesGitignore('build', r, 'src/build'), false, 'anchored pattern only at root');
  assert.equal(matchesGitignore('a.tmp', r, 'a.tmp'), true, '**/x must match a root-level file');
  assert.equal(matchesGitignore('a.tmp', r, 'deep/er/a.tmp'), true);
  assert.equal(matchesGitignore('x.md', r, 'docs/x.md'), true);
});

test('shouldIgnore: secrets are always skipped, .env templates are not', () => {
  const none = [];
  assert.equal(shouldIgnore('.env', false, none, '.env'), true);
  assert.equal(shouldIgnore('.env.production', false, none, '.env.production'), true);
  assert.equal(shouldIgnore('.env.example', false, none, '.env.example'), false);
  assert.equal(shouldIgnore('id_rsa', false, none, 'id_rsa'), true);
  assert.equal(shouldIgnore('id_ed25519.pub', false, none, 'id_ed25519.pub'), true);
  assert.equal(shouldIgnore('server.pem', false, none, 'certs/server.pem'), true);
  assert.equal(shouldIgnore('.npmrc', false, none, '.npmrc'), true);
  assert.equal(shouldIgnore('Credentials.JSON', false, none, 'Credentials.JSON'), true);
  assert.equal(shouldIgnore('terraform.tfstate', false, none, 'infra/terraform.tfstate'), true);
  assert.equal(shouldIgnore('app.log', false, none, 'app.log'), true);
  assert.equal(shouldIgnore('index.ts', false, none, 'src/index.ts'), false);
  assert.equal(shouldIgnore('node_modules', true, none, 'node_modules'), true);
  assert.equal(shouldIgnore('src', true, none, 'src'), false);
});

test('isUnderIgnoredDir: Open Tabs / Git modes respect ignored ancestors', () => {
  const r = rules('generated/');
  assert.equal(isUnderIgnoredDir('node_modules/pkg/index.js', r), true);
  assert.equal(isUnderIgnoredDir('dist/app.js', r), true);
  assert.equal(isUnderIgnoredDir('src/generated/x.ts', r), true, 'gitignored directory deep in the tree');
  assert.equal(isUnderIgnoredDir('src/components/App.tsx', r), false);
  assert.equal(isUnderIgnoredDir('README.md', r), false);
});

test('compactSource keeps preprocessor and attribute lines in C-family / Rust', () => {
  const c = '#include <stdio.h>\n// a comment\nint main() { return 0; } // trailing\n';
  assert.equal(compactSource(c, '.c').trimEnd(), '#include <stdio.h>\nint main() { return 0; } // trailing');
  const rs = '#![allow(dead_code)]\n#[derive(Debug)]\n// doc\nstruct A;\n';
  assert.equal(compactSource(rs, '.rs').trimEnd(), '#![allow(dead_code)]\n#[derive(Debug)]\nstruct A;');
  const cs = '#region Foo\n// x\nclass A {}\n#endregion\n';
  assert.equal(compactSource(cs, '.cs').trimEnd(), '#region Foo\nclass A {}\n#endregion');
});

test('compactSource strips # comments in Python but keeps the shebang', () => {
  const py = '#!/usr/bin/env python3\n# comment\nx = 1  # inline stays\n\n\n\nprint(x)\n';
  assert.equal(compactSource(py, '.py').trimEnd(), '#!/usr/bin/env python3\nx = 1  # inline stays\n\nprint(x)');
});

test('stripJSComments preserves // inside strings, templates and regex literals', () => {
  const src = [
    'const url = "https://x.test/path"; // comment',
    'const t = `line // not a comment\n${a /* keep */}`;',
    'const re = /\\/\\/ok/; /* block */ const n = 10 / 2 / 1;',
  ].join('\n');
  const out = stripJSComments(src);
  assert.match(out, /"https:\/\/x\.test\/path"/);
  assert.doesNotMatch(out, /\/\/ comment/);
  assert.match(out, /line \/\/ not a comment/);
  assert.match(out, /\/\\\/\\\/ok\//);
  assert.doesNotMatch(out, /block/);
  assert.match(out, /10 \/ 2 \/ 1/);
});

test('estimateTokens is monotonic and roughly chars/4', () => {
  assert.equal(estimateTokens(''), 0);
  const a = estimateTokens('x'.repeat(400));
  const b = estimateTokens('x'.repeat(800));
  assert.ok(a > 0 && b > a);
  assert.ok(a >= 100 && a <= 135, 'code is denser than 4 chars/token; estimate leans high');
});

const { decodeText } = require('../out/bundler.js');

test('decodeText: UTF-8, UTF-8 BOM, UTF-16 LE/BE by BOM, binary -> null', () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.equal(decodeText(enc('plain')), 'plain');
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('bom')])), 'bom', 'UTF-8 BOM stripped');
  const le = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
  assert.equal(decodeText(le), 'hi', 'UTF-16 LE');
  const be = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
  assert.equal(decodeText(be), 'hi', 'UTF-16 BE');
  assert.equal(decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), null, 'NUL without BOM is binary');
  assert.equal(decodeText(new Uint8Array([])), '');
});

test('gitignore compilation refuses patterns that would backtrack', () => {
  assert.equal(compilePattern('**/'.repeat(12) + 'x') !== null, true, 'runs of **/ collapse to one');
  assert.equal(compilePattern('a*a*a*a*a*a*a*a*a*a*b'), null, 'too many wildcards');
  assert.equal(compilePattern('x'.repeat(300)), null, 'too long');
  const r = compilePattern('**/'.repeat(12) + 'x');
  const deep = Array(80).fill('d').join('/') + '/x';
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) { matchesGitignore('x', [r], deep); }
  assert.ok(Date.now() - t0 < 500, 'deep paths must match in linear time');
});
