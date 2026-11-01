// Runs inside the VS Code extension host: the scripted demo for the README GIF.
// A pointer overlay in the sidebar clicks the real buttons; an "AI chat" page
// (tools/demo/chat.html, served from localhost) shows the paste and the reply.
// Each step records a caption with absolute timestamps for build-gif.cjs.
const vscode = require('vscode');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPT = 'Make add() reject non-finite numbers and move clamp into its own file';
const REPLY = [
  'Two changes. `add` now validates its inputs, and `clamp` moves to its own module.',
  '',
  '```ts src/math.ts',
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

const framesDir = path.resolve(__dirname, '..', 'frames');
const captions = [];
let current = null;
function caption(step, title, sub) {
  const now = Date.now();
  if (current) { current.to = now; }
  current = { step, title, sub, from: now, to: null };
  captions.push(current);
}
function endCaptions() { if (current) { current.to = Date.now(); } fs.writeFileSync(path.join(framesDir, 'captions.json'), JSON.stringify(captions, null, 2)); }

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
  const root = vscode.workspace.workspaceFolders[0].uri;
  const file = (...p) => vscode.Uri.joinPath(root, ...p);
  const clear = () => vscode.commands.executeCommand('notifications.clearAll');
  const demo = (a) => api._test.panelDemo(a);

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.zoomIn');
  await vscode.commands.executeCommand('workbench.action.zoomIn');
  await sleep(1200);
  await clear();

  // ── 1. Pick files, type the prompt, bundle ──────────────────────────────────
  await vscode.commands.executeCommand('sendtoai.panel.focus');
  await vscode.window.showTextDocument(file('src', 'math.ts'), { preview: false });
  await sleep(900);
  await clear();
  caption(1, 'Pick files, type your prompt', 'ignores node_modules, lock files, secrets and anything in .gitignore');
  await sleep(2200);
  await demo({ type: 'prompt', text: PROMPT });
  await sleep(2400);
  await demo({ type: 'click', selector: '#bundleBtn' });
  await sleep(2600);                                                    // "Copied! N files · ~T tokens"
  const clip = await vscode.env.clipboard.readText();
  const files = (clip.match(/FILES INCLUDED: (\d+)/) || [])[1] || '7';
  const tokens = (clip.match(/ESTIMATED TOKENS: ([\d,]+)/) || [])[1] || '';

  // ── 2. Paste into any AI chat, get the reply ────────────────────────────────
  await clear();                                                        // a toast pauses the embedded browser
  await sleep(300);
  caption(2, 'Paste into any AI chat', 'ChatGPT, Claude, Gemini… the whole project arrives as one message');
  await vscode.commands.executeCommand('simpleBrowser.show', url);
  await sleep(1000);
  Object.assign(state, { phase: 'pasted', chipName: 'sample-api-bundle.txt', chipMeta: `${files} files · ~${tokens} tokens · pasted from clipboard` });
  await sleep(1700);
  state.phase = 'sent'; await sleep(600);
  state.phase = 'streaming';
  for (let i = 0; i <= REPLY.length; i += 9) { state.upto = i; await sleep(50); }
  state.phase = 'done'; await sleep(500);
  state.copyHot = true;
  await vscode.env.clipboard.writeText(REPLY);
  await sleep(1400);

  // ── 3. Apply the reply, preview the diff ────────────────────────────────────
  caption(3, 'Apply the reply back to your files', 'every file block becomes an edit · diff preview · one Ctrl+Z undoes it all');
  await vscode.commands.executeCommand('sendtoai.panel.focus');
  await sleep(300);
  await demo({ type: 'click', selector: '[data-arg="applyResponse"]' });
  await sleep(2000);                                                    // file picker
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await sleep(900);                                                     // Apply / Preview / Cancel
  await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
  await sleep(500);
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await sleep(3000);                                                    // diff previews
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await sleep(600);
  await vscode.window.showTextDocument(file('src', 'math.ts'), { preview: false });
  await sleep(2800);                                                    // edited file + "Applied 2 files"

  // ── 4. Bundle Errors: the Problems panel in one paste ───────────────────────
  await clear();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.window.showTextDocument(file('src', 'routes', 'users.ts'), { preview: false });
  await sleep(2500);                                                    // TypeScript reports the two errors
  await vscode.commands.executeCommand('workbench.actions.view.problems');
  await sleep(1200);
  caption(4, 'Bundle Errors', 'grabs every file the Problems panel flags, plus the exact messages, ready to paste');
  await vscode.commands.executeCommand('sendtoai.panel.focus');
  await sleep(400);
  await demo({ type: 'click', selector: '[data-arg="bundleErrors"]' });
  await sleep(3200);                                                    // "Copied! 1 file(s) with problems + N diagnostics"

  // ── 5. Pro: git diff mode, fit to window, presets ───────────────────────────
  await clear();
  await vscode.commands.executeCommand('workbench.action.closePanel');
  caption(5, 'Pro: Git Changes, Fit to AI Window, presets', '$9.99 once · 5 machines · 30-day refund · free tier bundles the 50 most relevant files');
  await demo({ type: 'scrollTop' });
  await sleep(600);
  await demo({ type: 'click', selector: '[data-arg="git"]' });
  await sleep(1200);
  await demo({ type: 'select', selector: '#windowSelect', value: '27000' });
  await sleep(1200);
  await demo({ type: 'click', selector: '#bundleBtn' });               // free tier → contextual upgrade banner
  await sleep(3600);

  caption(6, 'Send to AI', 'free on the VS Code Marketplace · no API key · nothing leaves your machine but the clipboard');
  await sleep(2600);
  endCaptions();

  // restore the fixture
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  server.close();
};
