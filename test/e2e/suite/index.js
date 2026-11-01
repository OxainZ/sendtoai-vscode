// Runs inside the VS Code extension host. @vscode/test-electron calls run().
const assert = require('node:assert/strict');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) { return; }
    await sleep(250);
  }
  assert.fail(`timed out waiting for ${what}`);
}

function filePaths(node, out = []) {
  for (const c of node.children) { if (c.isDir) { filePaths(c, out); } else { out.push(c.path); } }
  return out;
}

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('oxainz.sendtoai');
  assert.ok(ext, 'extension oxainz.sendtoai must be installed in the test host');
  const api = await ext.activate();
  assert.ok(api && api._test, 'activate() must return the test hooks');

  // 1. Scan: ignores apply (node_modules, .env, keys, dist via .gitignore); source is present
  const tree = await api._test.scan();
  const paths = filePaths(tree);
  assert.ok(paths.includes('src/a.ts'), `src/a.ts missing from ${paths}`);
  assert.ok(paths.includes('README.md'));
  assert.ok(!paths.some((p) => p.startsWith('node_modules/')), 'node_modules must be ignored');
  assert.ok(!paths.includes('.env'), '.env must be ignored');
  assert.ok(!paths.includes('keys/server.pem'), 'private keys must be ignored');
  assert.ok(!paths.some((p) => p.startsWith('dist/')), '.gitignore rules must apply');

  // 2. Bundle through the same handler the panel uses; the result lands on the clipboard
  await api._test.bundle({ mode: 'project', format: 'standard', prompt: '', includeContext: false, targetWindow: 0 });
  const clip = await vscode.env.clipboard.readText();
  assert.ok(clip.includes('src/a.ts'), 'bundle must list src/a.ts');
  assert.ok(clip.includes('export const a'), 'bundle must contain file content');
  assert.ok(!clip.includes('SECRET_TOKEN'), 'bundle must never contain .env contents');
  assert.ok(clip.includes('big.csv') && clip.includes('exceeds the 1 MB'), 'oversized files are listed with a skip placeholder');
  assert.ok(!clip.includes('x'.repeat(5000)), 'oversized file content must not be inlined');

  // 3. The webview must really execute its script: opening the view has to
  //    produce a requestScan message from the page. (3.11.1–3.13.0 shipped a
  //    panel whose script did not parse; this is the check that catches it.)
  await vscode.commands.executeCommand('sendtoai.panel.focus');
  await until(() => api._test.inbound().includes('requestScan'), 20_000,
    'the panel script to post requestScan (is media/panel.js broken?)');

  // 4. License state machine with no key: free tier, no crash
  assert.equal(api._test.isPro(), false);
};
