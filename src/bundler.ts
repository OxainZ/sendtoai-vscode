import * as vscode from 'vscode';
import * as path from 'path';
import { estimateCost } from './costEstimator';
import { BundleMode, OutputFormat } from './panel';

// ── Ignore rules ──────────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.expo', 'out',
  '.vscode-test', 'coverage', '.nyc_output', '__pycache__',
  '.pytest_cache', '.tox', 'venv', '.venv', 'target', 'vendor',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.vercel',
]);

const IGNORE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.tiff', '.webp', '.avif',
  '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.webm',
  '.bin', '.exe', '.dll', '.so', '.dylib', '.a', '.o',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.vsix', '.wasm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.map',
]);

const IGNORE_NAMES = new Set([
  '.DS_Store', 'Thumbs.db', 'thumbs.db',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'composer.lock', 'Gemfile.lock', 'Cargo.lock', 'poetry.lock',
]);

const IGNORE_PREFIXES = ['.env'];

// ── .gitignore / .sendtoaiignore support ──────────────────────────────────────

async function loadIgnoreFile(rootUri: vscode.Uri, filename: string): Promise<string[]> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(rootUri, filename));
    return new TextDecoder().decode(bytes).split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('!'));
  } catch { return []; }
}

async function loadGitignorePatterns(rootUri: vscode.Uri): Promise<string[]> {
  const [git, sendtoai] = await Promise.all([
    loadIgnoreFile(rootUri, '.gitignore'),
    loadIgnoreFile(rootUri, '.sendtoaiignore'),
  ]);
  return [...git, ...sendtoai];
}

function matchesGitignore(name: string, patterns: string[]): boolean {
  for (const raw of patterns) {
    const p = raw.replace(/\/$/, '');
    if (p === name) { return true; }
    if (p.startsWith('*.') && name.endsWith(p.slice(1))) { return true; }
    if (p.startsWith('*') && name.endsWith(p.slice(1))) { return true; }
    if (p.endsWith('*') && name.startsWith(p.slice(0, -1))) { return true; }
  }
  return false;
}

// ── Core ignore logic ─────────────────────────────────────────────────────────

function shouldIgnore(name: string, isDir: boolean, gitignore: string[]): boolean {
  for (const prefix of IGNORE_PREFIXES) {
    if (name.startsWith(prefix)) { return true; }
  }
  if (matchesGitignore(name, gitignore)) { return true; }
  if (isDir) { return IGNORE_DIRS.has(name); }
  if (IGNORE_NAMES.has(name)) { return true; }

  const lower = name.toLowerCase();
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css')) { return true; }

  const ext = path.extname(name).toLowerCase();
  if (ext && IGNORE_EXTENSIONS.has(ext)) { return true; }
  if (name.endsWith('.lock')) { return true; }
  return false;
}

// ── File tree ─────────────────────────────────────────────────────────────────

type TreeNode = { dirs: Map<string, TreeNode>; files: string[] };

function addToTree(root: TreeNode, parts: string[]): void {
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!node.dirs.has(parts[i])) {
      node.dirs.set(parts[i], { dirs: new Map(), files: [] });
    }
    node = node.dirs.get(parts[i])!;
  }
  node.files.push(parts[parts.length - 1]);
}

function renderTree(node: TreeNode, indent = '', depth = 0): string {
  if (depth >= 3) { return ''; }
  const lines: string[] = [];
  for (const [dir] of [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${indent}📁 ${dir}/`);
    const sub = renderTree(node.dirs.get(dir)!, indent + '  ', depth + 1);
    if (sub) { lines.push(sub); }
  }
  for (const file of [...node.files].sort()) {
    lines.push(`${indent}📄 ${file}`);
  }
  return lines.join('\n');
}

// ── Compact: strip line comments ──────────────────────────────────────────────

function compactSource(text: string, ext: string): string {
  const codeExts = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.cs',
  ]);
  if (!codeExts.has(ext)) { return text; }

  return text
    .split('\n')
    .map(line => {
      const trimmed = line.trimStart();
      // Remove full-line // comments (JS/TS) and # comments (Python/Ruby)
      if (trimmed.startsWith('//') || trimmed.startsWith('#')) { return null; }
      // Collapse runs of blank lines
      return line;
    })
    .filter(l => l !== null)
    .join('\n')
    // Collapse 3+ consecutive blank lines to 1
    .replace(/\n{3,}/g, '\n\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface BundleResult {
  bundle:        string;
  fileCount:     number;
  ignoredCount:  number;
  tokenEstimate: number;
  folderName:    string;
  fileTypes:     Record<string, number>;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Visual file-picker types & scanner ────────────────────────────────────────

export interface FileNode {
  name:      string;
  path:      string;       // relative from workspace root, forward slashes
  isDir:     boolean;
  tokenEst:  number;       // 0 for dirs; Math.ceil(size/4) for files
  children:  FileNode[];   // populated for dirs; empty for files
}

export async function scanProjectTree(rootUri: vscode.Uri): Promise<FileNode> {
  const gitignore = await loadGitignorePatterns(rootUri);

  async function scanDir(uri: vscode.Uri, relBase: string): Promise<FileNode> {
    const name = path.basename(uri.fsPath);
    const node: FileNode = { name, path: relBase, isDir: true, tokenEst: 0, children: [] };

    let entries: [string, vscode.FileType][] = [];
    try { entries = await vscode.workspace.fs.readDirectory(uri); }
    catch { return node; }

    // Dirs first, then files, both alphabetically
    entries.sort(([aN, aT], [bN, bT]) => {
      const aD = (aT & vscode.FileType.Directory) !== 0;
      const bD = (bT & vscode.FileType.Directory) !== 0;
      if (aD !== bD) { return aD ? -1 : 1; }
      return aN.localeCompare(bN);
    });

    for (const [childName, childType] of entries) {
      const isDir = (childType & vscode.FileType.Directory) !== 0;
      if (shouldIgnore(childName, isDir, gitignore)) { continue; }

      const childRel = relBase ? `${relBase}/${childName}` : childName;
      const childUri = vscode.Uri.joinPath(uri, childName);

      if (isDir) {
        const child = await scanDir(childUri, childRel);
        node.children.push(child);
        node.tokenEst += child.tokenEst;
      } else {
        let sizeBytes = 0;
        try { sizeBytes = (await vscode.workspace.fs.stat(childUri)).size; } catch { /* ignore */ }
        const tokenEst = Math.ceil(sizeBytes / 4);
        node.tokenEst += tokenEst;
        node.children.push({ name: childName, path: childRel, isDir: false, tokenEst, children: [] });
      }
    }
    return node;
  }

  const root = await scanDir(rootUri, '');
  root.path = '';   // root path is always ''
  return root;
}

// ── Collect: open tabs ────────────────────────────────────────────────────────

function collectOpenTabs(rootPath: string): vscode.Uri[] {
  const uris: vscode.Uri[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        const p = tab.input.uri.fsPath;
        if (p.startsWith(rootPath)) {
          uris.push(tab.input.uri);
        }
      }
    }
  }
  return uris;
}

// ── Collect: git changes ──────────────────────────────────────────────────────

async function collectGitChanges(rootPath: string): Promise<vscode.Uri[]> {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) { return []; }
  const api = ext.isActive ? ext.exports.getAPI(1) : (await ext.activate()).getAPI(1);
  const repo = api.repositories.find((r: { rootUri: vscode.Uri }) =>
    r.rootUri.fsPath === rootPath || rootPath.startsWith(r.rootUri.fsPath)
  );
  if (!repo) { return []; }

  const changed = [
    ...repo.state.workingTreeChanges,
    ...repo.state.indexChanges,
  ].map((c: { uri: vscode.Uri }) => c.uri);

  // Deduplicate
  const seen = new Set<string>();
  return changed.filter(u => { if (seen.has(u.fsPath)) { return false; } seen.add(u.fsPath); return true; });
}

// ── Main bundler ──────────────────────────────────────────────────────────────

export async function buildBundle(
  rootUri: vscode.Uri,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  mode: BundleMode = 'project',
  format: OutputFormat = 'standard',
  userPrompt = '',
  selectedPaths?: Set<string>,
  contextBlock?: string,
): Promise<BundleResult> {
  const rootPath  = rootUri.fsPath;
  const folderName = path.basename(rootPath);
  const DIV = '='.repeat(64);

  progress.report({ message: 'Reading ignore files…' });
  const gitignore = await loadGitignorePatterns(rootUri);

  // ── Phase 1: collect files ──────────────────────────────────────────────────
  progress.report({ message: 'Scanning files…', increment: 5 });
  let included: vscode.Uri[] = [];
  let ignoredCount = 0;

  if (mode === 'tabs') {
    included = collectOpenTabs(rootPath);
  } else if (mode === 'git') {
    const changed = await collectGitChanges(rootPath);
    if (changed.length === 0) {
      throw new Error('No git changes found. Make sure you have staged or modified files.');
    }
    included = changed;
  } else {
    // Full project scan
    async function scan(uri: vscode.Uri): Promise<void> {
      if (token.isCancellationRequested) { return; }
      let entries: [string, vscode.FileType][];
      try { entries = await vscode.workspace.fs.readDirectory(uri); }
      catch { return; }

      for (const [name, type] of entries) {
        const isDir = (type & vscode.FileType.Directory) !== 0;
        if (shouldIgnore(name, isDir, gitignore)) { ignoredCount++; continue; }
        const child = vscode.Uri.joinPath(uri, name);
        if (isDir) { await scan(child); }
        else { included.push(child); }
      }
    }
    await scan(rootUri);

    // Filter to user-selected files when visual picker is active
    if (selectedPaths !== undefined) {
      included = included.filter(u => {
        const rel = path.relative(rootPath, u.fsPath).replace(/\\/g, '/');
        return selectedPaths.has(rel);
      });
    }
  }

  if (token.isCancellationRequested) { throw new Error('Cancelled'); }

  // ── Phase 2: file tree ──────────────────────────────────────────────────────
  const treeRoot: TreeNode = { dirs: new Map(), files: [] };
  const fileTypes: Record<string, number> = {};

  for (const uri of included) {
    const rel = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
    addToTree(treeRoot, rel.split('/'));
    const ext = path.extname(uri.fsPath).toLowerCase() || '(none)';
    fileTypes[ext] = (fileTypes[ext] ?? 0) + 1;
  }

  // ── Phase 3: assemble bundle ────────────────────────────────────────────────
  const now = new Date().toISOString();
  const modeLabel = mode === 'tabs' ? 'Open Tabs' : mode === 'git' ? 'Git Changes' : 'Full Project';
  const fmtLabel  = format === 'xml' ? 'Claude XML' : format === 'compact' ? 'Compact' : 'Standard';

  const perStep = included.length > 0 ? 80 / included.length : 0;

  // Read file contents in parallel, batched at 20 concurrent reads
  async function readOne(uri: vscode.Uri): Promise<{ rel: string; content: string }> {
    const rel = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
    progress.report({ message: rel, increment: perStep });
    let content: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const probe = bytes.length > 8192 ? bytes.slice(0, 8192) : bytes;
      let binary = false;
      for (let i = 0; i < probe.length; i++) {
        if (probe[i] === 0) { binary = true; break; }
      }
      if (binary) {
        content = `[Binary file — ${bytes.length.toLocaleString()} bytes — skipped]`;
      } else {
        let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        if (format === 'compact') {
          const ext = path.extname(uri.fsPath).toLowerCase();
          text = compactSource(text, ext);
        }
        content = text;
      }
    } catch (e: unknown) {
      content = `[Error: ${e instanceof Error ? e.message : String(e)}]`;
    }
    return { rel, content };
  }

  const CONCURRENCY = 20;
  const fileContents: Array<{ rel: string; content: string }> = [];
  for (let i = 0; i < included.length; i += CONCURRENCY) {
    if (token.isCancellationRequested) { throw new Error('Cancelled'); }
    const batch = included.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(readOne));
    fileContents.push(...results);
  }

  // ── Assemble by format ──────────────────────────────────────────────────────
  let bundle: string;

  if (format === 'xml') {
    // Claude XML format
    const header = [
      `<!-- SendToAI Bundle -->`,
      `<!-- Project: ${folderName} | Files: ${included.length} | Mode: ${modeLabel} | ${now} -->`,
      `<!-- Est. tokens: [calculating] -->`,
      contextBlock ? `\n<project_context>\n${contextBlock}\n</project_context>` : '',
      userPrompt ? `\n<task>${userPrompt}</task>` : '',
      ``,
      `<file_tree>`,
      renderTree(treeRoot),
      `</file_tree>`,
      ``,
      `<documents>`,
    ].filter(l => l !== '').join('\n');

    const docs = fileContents.map(({ rel, content }, i) =>
      `<document index="${i + 1}">\n<source>${rel}</source>\n<document_content>\n${content}\n</document_content>\n</document>`
    ).join('\n');

    bundle = `${header}\n${docs}\n</documents>`;

  } else {
    // Standard / Compact (same structure, compact just has stripped content)
    const lines: string[] = [
      DIV,
      `PROJECT: ${folderName}`,
      `MODE: ${modeLabel} | FORMAT: ${fmtLabel}`,
      `FILES INCLUDED: ${included.length} | FILES IGNORED: ${ignoredCount}`,
      `ESTIMATED TOKENS: [calculating]`,
      `BUNDLED: ${now}`,
      DIV,
      '',
    ];

    if (contextBlock) {
      lines.push('PROJECT CONTEXT & NOTES:');
      lines.push(contextBlock);
      lines.push('');
    }

    if (userPrompt) {
      lines.push(`PROMPT: ${userPrompt}`);
      lines.push('');
    }

    lines.push('FILE TREE:');
    lines.push(renderTree(treeRoot));
    lines.push('');

    for (const { rel, content } of fileContents) {
      lines.push(DIV);
      lines.push(`FILE: ${rel}`);
      lines.push(DIV);
      lines.push(content);
      lines.push('');
    }

    lines.push(DIV);
    lines.push(`END OF BUNDLE — ${included.length} files — Paste into Claude, ChatGPT, or any AI`);
    lines.push(DIV);

    bundle = lines.join('\n');
  }

  const tokenEstimate = estimateTokens(bundle);
  const cost = estimateCost(tokenEstimate);

  // Inject token + cost
  bundle = bundle.replace(
    '[calculating]',
    `${tokenEstimate.toLocaleString()} (~${cost.haiku} Haiku · ${cost.sonnet} Sonnet · ${cost.opus} Opus)`
  );

  return { bundle, fileCount: included.length, ignoredCount, tokenEstimate, folderName, fileTypes };
}
