require('./vscode-stub.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SendToAIPanel } = require('../out/panel.js');

// 3.10.0–3.13.0 shipped a side panel whose script did not parse (a regex
// escaped for a TypeScript template literal came out as a syntax error), so the
// panel was dead. The script now lives in media/panel.js and this test
// parses it, and checks the HTML wires it in under the nonce-locked CSP.
test('panel script parses and is loaded from media/ under a nonce-locked CSP', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'panel.js'), 'utf8');
  assert.doesNotThrow(() => new Function(src), 'media/panel.js must be valid JavaScript');

  const panel = new SendToAIPanel({ fsPath: 'C:/ext' });
  const webview = {
    cspSource: 'vscode-resource:',
    asWebviewUri: (u) => ({ toString: () => 'vscode-resource://' + u.fsPath }),
  };
  const html = panel._html(webview);
  assert.match(html, /<link rel="stylesheet" href="vscode-resource:\/\/C:\/ext\/media\/panel\.css">/);
  assert.match(html, /<script nonce="([0-9a-f]{32})" src="vscode-resource:\/\/C:\/ext\/media\/panel\.js"><\/script>/);
  const nonce = html.match(/script-src 'nonce-([0-9a-f]{32})'/);
  assert.ok(nonce, 'CSP must carry the nonce');
  assert.ok(html.includes(`<script nonce="${nonce[1]}"`), 'script tag nonce must match the CSP nonce');
  assert.doesNotMatch(html, /<script nonce="[0-9a-f]+">/, 'no inline script blocks remain');
  assert.match(html, /style-src vscode-resource: 'unsafe-inline'/);
});

test('panel CSS exists and is non-trivial', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'panel.css'), 'utf8');
  assert.ok(css.length > 2000);
  assert.match(css, /--vscode-foreground/);
});
