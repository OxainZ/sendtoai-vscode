// Runs inside the VS Code extension host: the scripted demo for the README GIF.
// Each step waits long enough to be captured by capture.ps1 (one frame ~180 ms).
const vscode = require('vscode');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPLY = [
  'Here is the fix. `add` should guard against non-finite numbers, and the helper gets its own file.',
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
  'export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));',
  '```',
].join('\n');

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('oxainz.sendtoai');
  const api = await ext.activate();

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.zoomIn');
  await vscode.commands.executeCommand('workbench.action.zoomIn');
  await sleep(1500);
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(300);

  // 1. The panel with the scanned tree
  await vscode.commands.executeCommand('sendtoai.panel.focus');
  await sleep(1200);
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(1800);

  // 2. A file open next to it, then Bundle (notification shows the token count)
  const a = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'src', 'a.ts');
  await vscode.window.showTextDocument(a, { preview: false });
  await sleep(1200);
  await api._test.bundle({ mode: 'project', format: 'standard', prompt: 'Make add() reject non-finite numbers', includeContext: false, targetWindow: 0 });
  await sleep(2600);

  // 3. "The AI replied": put a reply on the clipboard and apply it
  await vscode.env.clipboard.writeText(REPLY);
  const applying = vscode.commands.executeCommand('sendtoai.applyResponse');
  await sleep(1800);                                                   // file picker visible
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await sleep(900);                                                    // Apply / Preview / Cancel
  await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
  await sleep(500);
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await sleep(3200);                                                   // diff preview open
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  await applying;
  await sleep(2400);                                                   // applied + undo hint

  // leave the edited file in view for the final frames
  await vscode.window.showTextDocument(a, { preview: false });
  await sleep(1500);

  // restore the fixture so the repo stays clean
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await vscode.commands.executeCommand('undo');
};
