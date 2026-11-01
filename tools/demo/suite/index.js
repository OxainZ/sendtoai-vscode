// Runs inside the VS Code extension host: the scripted demo for the README GIF.
// A pointer overlay in the sidebar clicks the real buttons; an "AI chat" page
// (tools/demo/chat.html, served from localhost) shows the paste and the reply.
const vscode = require('vscode');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPT = 'Make add() reject non-finite numbers and move clamp into its own file';
const REPLY = [
  'Two changes. `add` now validates its inputs, and `clamp` gets its own module.',
  '',
  '```ts src/a.ts',
  'export const a = 1;',
  '',
  'export function add(x: number, y: number): number {',
  '  if (!Number.isFinite(x) || !Number.isFinite(y)) {',
  '    throw new TypeError(\'add() expects finite numbers\');',
  '  }',
  '  return x + y;',
  '}',
  '```',
  '',
  '```ts src/utils/clamp.ts',
  'export const clamp = (n: number, lo: number, hi: number) =>',
  '  Math.min(hi, Math.max(lo, n));',
  '```',
].join('\n');

// ── tiny state server for the chat page ─────────────────────────────────────
const state = { phase: 'empty', chipName: '', chipMeta: '', prompt: PROMPT, reply: REPLY, upto: 0, copyHot: false };
const html = fs.readFileSync(path.join(__dirname, '..', 'chat.html'), 'utf8');
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/state')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(state)); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html);
});

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('oxainz.sendtoai');
  const api = await ext.activate();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.zoomIn');
  await vscode.commands.executeCommand('workbench.action.zoomIn');
  await sleep(1200);
  await vscode.commands.executeCommand('notifications.clearAll');

  // 1. Sidebar with the scanned tree; a file open so it looks like a project
  await vscode.commands.executeCommand('sendtoai.panel.focus');
  const a = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'src', 'a.ts');
  await vscode.window.showTextDocument(a, { preview: false });
  await sleep(1000);
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(1400);

  // 2. Type the prompt in the panel, then the pointer clicks "Bundle to Clipboard"
  await api._test.panelDemo({ type: 'prompt', text: PROMPT });
  await sleep(1600);
  await api._test.panelDemo({ type: 'click', selector: '#bundleBtn' });
  await sleep(2200);                                                    // "Copied! N files · ~T tokens"
  const clip = await vscode.env.clipboard.readText();
  const files = (clip.match(/FILES INCLUDED: (\d+)/) || [])[1] || '5';
  const tokens = (clip.match(/ESTIMATED TOKENS: ([\d,]+)/) || [])[1] || '';

  // 3. Paste into the AI chat (shown in the editor) and watch the reply stream
  await vscode.commands.executeCommand('notifications.clearAll');   // a toast pauses the embedded browser
  await sleep(300);
  await vscode.commands.executeCommand('simpleBrowser.show', url);
  await sleep(900);
  Object.assign(state, { phase: 'pasted', chipName: 'sample-bundle.txt', chipMeta: `${files} files · ~${tokens} tokens · pasted from clipboard` });
  await sleep(1500);
  state.phase = 'sent'; await sleep(600);
  state.phase = 'streaming';
  for (let i = 0; i <= REPLY.length; i += 9) { state.upto = i; await sleep(55); }
  state.phase = 'done'; await sleep(500);
  state.copyHot = true;                                                 // "Copy reply" highlighted
  await vscode.env.clipboard.writeText(REPLY);
  await sleep(1300);

  // 4. Back in the sidebar: the pointer clicks "Apply AI Reply"
  await vscode.commands.executeCommand('sendtoai.panel.focus');
  await sleep(300);
  await api._test.panelDemo({ type: 'click', selector: '[data-arg="applyResponse"]' });
  await sleep(1800);                                                    // file picker
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await sleep(800);                                                     // Apply / Preview / Cancel
  await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
  await sleep(400);
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await sleep(2600);                                                    // diff preview
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await sleep(600);
  await vscode.window.showTextDocument(a, { preview: false });
  await sleep(2600);                                                    // edited file + "Applied 2 files"

  // restore the fixture
  await vscode.commands.executeCommand('workbench.action.files.revert');
  server.close();
};
