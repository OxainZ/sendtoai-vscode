// Minimal stand-in for the `vscode` module so the compiled extension code can
// be loaded under plain Node for unit tests of its pure functions.
// Only what the module top-levels touch is needed; nothing here is exercised.
const Module = require('module');

class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.path = fsPath.replace(/\\/g, '/'); }
  static file(p) { return new Uri(p); }
  static parse(p) { return new Uri(p); }
  static joinPath(base, ...parts) { return new Uri([base.fsPath, ...parts].join('/')); }
  toString() { return this.fsPath; }
}

const stub = {
  Uri,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  Position: class { constructor(l, c) { this.line = l; this.character = c; } },
  Range: class { constructor(a, b, c, d) { this.start = [a, b]; this.end = [c, d]; } },
  WorkspaceEdit: class {},
  TabInputText: class {},
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  window: { tabGroups: { all: [] } },
  workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: () => undefined }) },
  commands: {},
  env: { machineId: 'test-machine', clipboard: {} },
  extensions: { getExtension: () => undefined },
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') { return stub; }
  return origLoad.call(this, request, ...rest);
};
