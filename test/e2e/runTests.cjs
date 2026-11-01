// Launches a real VS Code with the fixture workspace and runs test/e2e/suite.
// Usage: npm run test:e2e   (CI wraps it in xvfb-run on Linux)
const path = require('node:path');
const fs = require('node:fs');
const { runTests } = require('@vscode/test-electron');

// When this runner is started from a terminal inside VS Code, the parent sets
// ELECTRON_RUN_AS_NODE=1 and the downloaded VS Code would start as a bare
// Node process instead of an editor.
delete process.env.ELECTRON_RUN_AS_NODE;

const fixture = path.resolve(__dirname, '..', 'fixtures', 'sample');

// Transient fixture files that must not be committed (the repo's .gitignore
// would drop them anyway): a node_modules tree and a >1 MB data file.
function prepareFixture() {
  fs.mkdirSync(path.join(fixture, 'node_modules', 'leftpad'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'node_modules', 'leftpad', 'index.js'), 'module.exports = s => s;\n');
  fs.writeFileSync(path.join(fixture, 'big.csv'), 'x'.repeat(1_100_000));
  fs.mkdirSync(path.join(fixture, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'dist', 'bundle.js'), 'console.log("built")\n');
}

(async () => {
  try {
    prepareFixture();
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '..', '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite'),
      launchArgs: [fixture, '--disable-extensions', '--disable-workspace-trust', '--disable-gpu'],
    });
  } catch (err) {
    console.error('e2e tests failed:', err);
    process.exit(1);
  }
})();
