// Records the README demo GIF: launches a real VS Code on the fixture project,
// drives the extension through its demo sequence (tools/demo/suite), captures
// the window with capture.ps1, then assembles images/demo.gif.
// Usage: node tools/demo/record.cjs      (Windows only; needs a visible desktop)
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { runTests } = require('@vscode/test-electron');

delete process.env.ELECTRON_RUN_AS_NODE;

const here = __dirname;
const repo = path.resolve(here, '..', '..');
const frames = path.join(here, 'frames');
const fixture = path.resolve(repo, 'test', 'fixtures', 'sample');

fs.rmSync(frames, { recursive: true, force: true });
fs.mkdirSync(frames, { recursive: true });
// the e2e runner's transient fixture files, so the tree looks like a project
fs.mkdirSync(path.join(fixture, 'node_modules', 'leftpad'), { recursive: true });
fs.writeFileSync(path.join(fixture, 'node_modules', 'leftpad', 'index.js'), 'module.exports = s => s;\n');
fs.rmSync(path.join(fixture, 'big.csv'), { force: true });   // e2e leftover, ugly in a demo
// The demo reply creates src/utils/clamp.ts and rewrites src/math.ts; put both back.
const cleanupFixture = () => {
  fs.rmSync(path.join(fixture, 'src', 'utils', 'clamp.ts'), { force: true });
  try { require('node:child_process').execFileSync('git', ['checkout', '--', 'test/fixtures/sample/src/math.ts'], { cwd: repo, stdio: 'ignore' }); } catch { /* not a git checkout */ }
};
cleanupFixture();

const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'capture.ps1'), frames, 'Visual Studio Code'], { stdio: 'inherit' });

(async () => {
  let code = 0;
  try {
    await runTests({
      extensionDevelopmentPath: repo,
      extensionTestsPath: path.join(here, 'suite'),
      launchArgs: [fixture, '--disable-extensions', '--disable-workspace-trust', '--disable-gpu'],
    });
  } catch (e) {
    console.error('demo run failed:', e.message);
    code = 1;
  } finally {
    fs.writeFileSync(path.join(frames, 'STOP'), '');
    cleanupFixture();
    await new Promise(r => ps.on('exit', r));
  }
  if (code) { process.exit(code); }
  const n = fs.readdirSync(frames).filter(f => f.endsWith('.png')).length;
  console.log(`frames captured: ${n}`);
  require('./build-gif.cjs');
})();
