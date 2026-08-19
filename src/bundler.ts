import * as vscode from 'vscode';
import * as path from 'path';
import { estimateCost } from './costEstimator';
import { BundleMode, OutputFormat } from './panel';

// ── Ignore rules ──────────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.expo', 'out',
  '.vscode-test', 'coverage', '.nyc_output', '__pycache__',
  '.pytest_cache', '.tox', 'target', 'vendor',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.vercel',
  'site-packages', 'dist-packages', 'lib64',
]);

// Dir name prefixes/suffixes that are always ignored (checked in shouldIgnore)
const IGNORE_DIR_PREFIXES = ['venv', '.venv'];
const IGNORE_DIR_SUFFIXES = ['.dist-info', '.egg-info', '.egg-link'];

const IGNORE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.tiff', '.webp', '.avif',
  '.svg', '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.webm',
  '.bin', '.exe', '.dll', '.so', '.dylib', '.a', '.o',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.vsix', '.wasm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.map',
  // Python compiled / binary artifacts
  '.pyc', '.pyo', '.pyd',
  // Data / model artifacts
  '.pkl', '.pickle', '.joblib', '.npy', '.npz', '.h5', '.hdf5', '.parquet', '.feather',
  // Database files
  '.db', '.sqlite', '.sqlite3',
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
      .filter(l => l && !l.startsWith('#')); // keep negation lines (!) — handled in matchesGitignore
  } catch { return []; }
}

// A compiled gitignore rule — regex built once at load time.
interface CompiledRule {
  rx:          RegExp;
  isNeg:       boolean;
  anchored:    boolean;
  hasGlobstar: boolean; // whether ** appears (needs bare-name fallback)
  needsPath:   boolean; // anchored or has slash/globstar → match against relPath
}

function compilePattern(raw: string): CompiledRule | null {
  const isNeg    = raw.startsWith('!');
  const stripped = (isNeg ? raw.slice(1) : raw).replace(/\/$/, '');
  if (!stripped) { return null; }

  const anchored = stripped.startsWith('/');
  const p = anchored ? stripped.slice(1) : stripped;
  if (!p) { return null; }

  const hasGlobstar = p.includes('**');
  const needsPath   = anchored || hasGlobstar || p.includes('/');

  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) {
      re += p[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (c === '*' && p[i + 1] === '*') {
      re += '.*'; i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      let cls = '[';
      i++;
      if (i < p.length && p[i] === '!') { cls += '^'; i++; }
      if (i < p.length && p[i] === ']') { cls += ']'; i++; }
      while (i < p.length && p[i] !== ']') { cls += p[i++]; }
      cls += ']';
      re += cls;
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  try {
    return { rx: new RegExp(`^${re}$`), isNeg, anchored, hasGlobstar, needsPath };
  } catch { return null; }
}

async function loadGitignorePatterns(rootUri: vscode.Uri): Promise<CompiledRule[]> {
  const [git, sendtoai] = await Promise.all([
    loadIgnoreFile(rootUri, '.gitignore'),
    loadIgnoreFile(rootUri, '.sendtoaiignore'),
  ]);
  return [...git, ...sendtoai]
    .map(compilePattern)
    .filter((r): r is CompiledRule => r !== null);
}

function matchesGitignore(name: string, rules: CompiledRule[], relPath = ''): boolean {
  let ignored = false;
  for (const { rx, isNeg, hasGlobstar, needsPath } of rules) {
    if (needsPath && !relPath) { continue; }
    const subject = needsPath ? relPath : name;
    let hit = rx.test(subject);
    // **-patterns also match root-level bare names (e.g. **/*.log matches debug.log)
    if (!hit && hasGlobstar && subject === relPath) { hit = rx.test(name); }
    if (hit) { ignored = !isNeg; }
  }
  return ignored;
}

// ── Core ignore logic ─────────────────────────────────────────────────────────

function shouldIgnore(name: string, isDir: boolean, gitignore: CompiledRule[], relPath = ''): boolean {
  for (const prefix of IGNORE_PREFIXES) {
    if (name.startsWith(prefix)) { return true; }
  }
  if (matchesGitignore(name, gitignore, relPath)) { return true; }
  if (isDir) {
    if (IGNORE_DIRS.has(name)) { return true; }
    const lower = name.toLowerCase();
    if (IGNORE_DIR_PREFIXES.some(p => lower.startsWith(p))) { return true; }
    if (IGNORE_DIR_SUFFIXES.some(s => lower.endsWith(s))) { return true; }
    return false;
  }
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

function renderTree(node: TreeNode, indent = ''): string {
  const lines: string[] = [];
  for (const [dir] of [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${indent}📁 ${dir}/`);
    const sub = renderTree(node.dirs.get(dir)!, indent + '  ');
    if (sub) { lines.push(sub); }
  }
  for (const file of [...node.files].sort()) {
    lines.push(`${indent}📄 ${file}`);
  }
  return lines.join('\n');
}

// ── Compact: JS/TS comment stripper ──────────────────────────────────────────
//
// Single-pass state machine that correctly handles:
//   • String literals  "…"  '…'  (with escape sequences)
//   • Template literals `…`  (including ${} expressions — treats them as opaque)
//   • Regex literals  /…/  (detected by context, handles [character classes] inside)
//   • Line comments   // …
//   • Block comments  /* … */  (newlines preserved to keep line numbers stable)
//
// "Correctly" means none of the above is misidentified as another:
//   /['"]/      — regex containing quote chars, not a string open
//   /\/*foo/    — regex containing /* sequence, not a block comment
//   `// not a comment`  — template literal content, not stripped
//
// Keywords after which a / must be a regex literal, not division.
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'new', 'delete',
  'throw', 'case', 'void', 'yield', 'await', 'of',
]);

function stripJSComments(src: string): string {
  let out = '';
  let i   = 0;
  const n = src.length;
  // Track last non-whitespace char AND last word (to catch keywords like typeof, return).
  let lastNonWs = '';
  let lastWord  = ''; // accumulates current/last word token

  while (i < n) {
    const c = src[i];

    // ── String literals (' or ") ─────────────────────────────────────────────
    if (c === '"' || c === "'") {
      const q = c;
      out += c; lastNonWs = c; lastWord = ''; i++;
      while (i < n) {
        const s = src[i];
        if (s === '\\') { out += s; i++; if (i < n) { out += src[i]; i++; } continue; }
        out += s; i++;
        if (s === q || s === '\n') { if (s === q) { lastNonWs = s; } break; }
      }
      continue;
    }

    // ── Template literals (`) — preserve all content including // lines ──────
    if (c === '`') {
      out += c; lastNonWs = c; lastWord = ''; i++;
      while (i < n) {
        const s = src[i];
        if (s === '\\') { out += s; i++; if (i < n) { out += src[i]; i++; } continue; }
        // ${} interpolation — scan properly, tracking strings so "}" inside a
        // string doesn't prematurely close the interpolation (Bug 43).
        if (s === '$' && i + 1 < n && src[i + 1] === '{') {
          out += s + '{'; i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            const t = src[i];
            // Handle string literals inside interpolation
            if (t === '"' || t === "'" || t === '`') {
              const q = t;
              out += t; i++;
              while (i < n) {
                const u = src[i];
                if (u === '\\') { out += u; i++; if (i < n) { out += src[i]; i++; } continue; }
                out += u; i++;
                if (u === q || (u === '\n' && q !== '`')) { break; }
              }
              continue;
            }
            if (t === '{') { depth++; } else if (t === '}') { depth--; }
            out += t; i++;
          }
          continue;
        }
        out += s; i++;
        if (s === '`') { lastNonWs = s; break; }
      }
      continue;
    }

    // ── Line comment // ──────────────────────────────────────────────────────
    if (c === '/' && i + 1 < n && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { i++; }
      // leave the \n to be emitted normally on next iteration
      continue;
    }

    // ── Block comment /* … */ ────────────────────────────────────────────────
    if (c === '/' && i + 1 < n && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end   = close === -1 ? n : close + 2;
      const nl    = (src.slice(i, end).match(/\n/g) ?? []).length;
      out += '\n'.repeat(nl);
      i = end;
      continue;
    }

    // ── Regex literals /…/ ──────────────────────────────────────────────────
    // A / is a regex start when:
    //   (a) last word was a keyword that can precede a regex (return, typeof…), OR
    //   (b) last non-ws is not a char that ends a value expression ()/]\w$_'"`).
    if (c === '/' && (REGEX_KEYWORDS.has(lastWord) || !/[\w$)\]'"_`]/.test(lastNonWs))) {
      out += c; i++;
      let inClass = false;
      while (i < n && src[i] !== '\n') {
        const s = src[i];
        if (s === '\\') { out += s; i++; if (i < n) { out += src[i]; i++; } continue; }
        if (s === '[') { inClass = true;  out += s; i++; continue; }
        if (s === ']') { inClass = false; out += s; i++; continue; }
        if (s === '/' && !inClass) { out += s; i++; lastNonWs = '/'; break; }
        out += s; i++;
      }
      continue;
    }

    out += c;
    if (!/\s/.test(c)) {
      lastNonWs = c;
      if (/\w/.test(c)) { lastWord += c; } else { lastWord = ''; }
    }
    i++;
  }
  return out;
}

// ── Compact: strip comments + trailing whitespace ─────────────────────────────

function compactSource(text: string, ext: string): string {
  const jsExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  const codeExts = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.cs',
  ]);
  if (!codeExts.has(ext)) { return text; }

  const isJs = jsExts.has(ext);
  // For JS/TS: stripJSComments handles both // and /* */ correctly, including
  // inside template literals and regex literals. Don't re-check // below.
  const src = isJs ? stripJSComments(text) : text;

  return src
    .split('\n')
    .map(line => {
      // For non-JS languages (Python, Ruby, etc.) strip full-line # comments
      if (!isJs && line.trimStart().startsWith('#')) { return null; }
      return line.trimEnd();
    })
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// ── Smart selection: relevance scoring ───────────────────────────────────────
// When a bundle must be trimmed to fit a token budget, rank files by how
// relevant they are to the user's task instead of blindly cutting the largest.
// This is the differentiator vs dumb glob/size-based bundlers: keep what matters
// for what you're actually doing.

const SOURCE_EXTS = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.java', '.go', '.rs', '.rb', '.php', '.cs', '.cpp', '.c', '.h', '.swift', '.kt',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sql', '.graphql', '.proto',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.sh', '.bash', '.zsh', '.ps1',
]);

const QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'what', 'why',
  'how', 'fix', 'bug', 'issue', 'error', 'errors', 'code', 'file', 'files', 'help',
  'need', 'want', 'make', 'add', 'please', 'can', 'you', 'your', 'its', 'is', 'are',
  'was', 'were', 'the', 'to', 'in', 'of', 'on', 'at', 'it', 'an', 'my', 'me', 'do',
  'does', 'not', 'but', 'or', 'if', 'so', 'get', 'set', 'use', 'using', 'where',
  'when', 'which', 'about', 'into', 'out', 'all', 'function', 'class', 'const',
]);

function extractQueryTerms(prompt: string): string[] {
  if (!prompt) { return []; }
  const raw = prompt.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [];
  return [...new Set(raw)].filter(t => !QUERY_STOPWORDS.has(t)).slice(0, 40);
}

// Higher = more relevant. Task-query overlap (filename/path/content mentions)
// plus structural priors (entry points, docs, config kept; tests/generated demoted).
function scoreRelevance(rel: string, content: string, terms: string[]): number {
  const lowerRel = rel.toLowerCase();
  const base = path.basename(lowerRel);
  const ext = path.extname(lowerRel);
  let score = 0;

  if (SOURCE_EXTS.has(ext)) { score += 5; }
  if (/(^|\/)(index|main|app|__init__|mod|lib)\.[a-z]+$/.test(lowerRel)) { score += 6; }
  if (/readme|architecture|design|contributing/.test(base)) { score += 4; }
  if (/(package\.json|pyproject\.toml|cargo\.toml|go\.mod|tsconfig\.json|requirements\.txt|dockerfile)$/.test(base)) { score += 3; }
  if (/(test|spec|\.min\.|generated|mock|fixture|snapshot|\.lock)/.test(lowerRel)) { score -= 4; }

  if (terms.length) {
    const lc = content.toLowerCase();
    for (const t of terms) {
      if (base.includes(t)) { score += 12; }          // filename matches the task — strongest signal
      else if (lowerRel.includes(t)) { score += 8; }   // path/dir matches
      const occ = lc.split(t).length - 1;              // content mentions (capped so one huge file can't dominate)
      if (occ) { score += Math.min(occ, 5) * 2; }
    }
  }
  return score;
}

// ── Smart selection: dependency-graph awareness ──────────────────────────────
// Editor-native edge the web bundlers can't match: follow a file's imports so
// the files your task DEPENDS ON survive the fit-to-window cut alongside it —
// complete, connected context instead of orphaned snippets.

function extractImports(content: string, ext: string): string[] {
  const specs: string[] = [];
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const re = /(?:from\s*['"]([^'"]+)['"])|(?:require\(\s*['"]([^'"]+)['"]\s*\))|(?:import\(\s*['"]([^'"]+)['"]\s*\))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) { specs.push(m[1] || m[2] || m[3]); }
  } else if (ext === '.py') {
    const re = /^\s*from\s+(\.[\w.]*)\s+import|^\s*import\s+(\.[\w.]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) { specs.push(m[1] || m[2]); }
  }
  // local/relative specifiers only — third-party packages aren't in the bundle
  return specs.filter(s => s && s.startsWith('.'));
}

// Resolve a relative import specifier to an actual file in the bundle set.
function resolveImport(fromRel: string, spec: string, known: Set<string>): string | null {
  const dir = path.posix.dirname(fromRel);
  const target = path.posix.normalize(path.posix.join(dir, spec.replace(/\\/g, '/')));
  const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'];
  for (const e of exts) { if (known.has(target + e)) { return target + e; } }
  for (const e of exts.filter(Boolean)) { if (known.has(`${target}/index${e}`)) { return `${target}/index${e}`; } }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface BundleResult {
  bundle:        string;
  fileCount:     number;
  ignoredCount:  number;
  tokenEstimate: number;
  folderName:    string;
  fileTypes:     Record<string, number>;
  /** Set when a free-tier file cap trimmed the selection: how many files the
   *  user actually selected. The bundle still contains the most RELEVANT
   *  `fileCount` of them — never a paywall, always a usable bundle. */
  trimmedFrom?:  number;
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
      const childRel = relBase ? `${relBase}/${childName}` : childName;
      if (shouldIgnore(childName, isDir, gitignore, childRel)) { continue; }
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
        if (p === rootPath || p.startsWith(rootPath + path.sep) || p.startsWith(rootPath + '/')) {
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
  tokenLimit = 0,
  maxFiles = 0,
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
    for (const uri of collectOpenTabs(rootPath)) {
      const rel  = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
      const name = path.basename(uri.fsPath);
      if (shouldIgnore(name, false, gitignore, rel)) { ignoredCount++; } else { included.push(uri); }
    }
  } else if (mode === 'git') {
    const changed = await collectGitChanges(rootPath);
    if (changed.length === 0) {
      throw new Error('No git changes found. Make sure you have staged or modified files.');
    }
    for (const uri of changed) {
      const rel  = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
      const name = path.basename(uri.fsPath);
      if (shouldIgnore(name, false, gitignore, rel)) { ignoredCount++; } else { included.push(uri); }
    }
  } else {
    // Full project scan
    async function scan(uri: vscode.Uri, relBase = ''): Promise<void> {
      if (token.isCancellationRequested) { return; }
      let entries: [string, vscode.FileType][];
      try { entries = await vscode.workspace.fs.readDirectory(uri); }
      catch { return; }

      for (const [name, type] of entries) {
        const isDir = (type & vscode.FileType.Directory) !== 0;
        const relPath = relBase ? `${relBase}/${name}` : name;
        const child = vscode.Uri.joinPath(uri, name);
        if (shouldIgnore(name, isDir, gitignore, relPath)) {
          ignoredCount++;
          continue;
        }
        if (isDir) { await scan(child, relPath); }
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
  let treeRoot: TreeNode = { dirs: new Map(), files: [] };
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
  // Sentinel injected into headers then replaced after token count is known.
  // Uses a null-byte prefix so it can never collide with any real source file content.
  const TOKEN_SENTINEL = '\x00SENDTOAI_TOKENS\x00';

  const fmtLabel  = format === 'xml'     ? 'Claude XML'
                 : format === 'compact' ? 'Compact'
                 : format === 'minimal' ? 'Minimal'
                 : 'Standard';

  const perStep = included.length > 0 ? 80 / included.length : 0;

  // Read file contents in parallel, batched at 20 concurrent reads
  async function readOne(uri: vscode.Uri): Promise<{ rel: string; content: string }> {
    const rel = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
    progress.report({ message: rel, increment: perStep });
    let content: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      // Scan all bytes — file is already in memory, no reason to cap at 8192
      let binary = false;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) { binary = true; break; }
      }
      if (binary) {
        content = `[Binary file — ${bytes.length.toLocaleString()} bytes — skipped]`;
      } else {
        let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        if (format === 'compact' || format === 'minimal') {
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

  // ── Free-tier cap: keep the N MOST RELEVANT files, never a paywall ──────────
  // A free user's first click used to hit an upgrade prompt and produce NOTHING
  // (the tree defaults to select-all, so any real repo trips the cap instantly).
  // Blocking the first bundle is how you lose a user before they see the value.
  // Instead: bundle the most relevant `maxFiles` and say so. The user gets a
  // working bundle AND a live demonstration of the relevance ranking that Pro
  // applies to the whole project.
  let trimmedFrom: number | undefined;
  if (maxFiles > 0 && fileContents.length > maxFiles) {
    trimmedFrom = fileContents.length;
    const terms = extractQueryTerms(userPrompt);
    const known = new Set(fileContents.map(f => f.rel));
    const base = new Map<string, number>(
      fileContents.map(f => [f.rel, scoreRelevance(f.rel, f.content, terms)] as const)
    );
    const finalScore = new Map(base);
    for (const f of fileContents) {
      const imp = base.get(f.rel) ?? 0;
      if (imp <= 0) { continue; }
      for (const spec of extractImports(f.content, path.extname(f.rel).toLowerCase())) {
        const dep = resolveImport(f.rel, spec, known);
        if (dep) { finalScore.set(dep, (finalScore.get(dep) ?? 0) + Math.min(imp, 12) * 0.5); }
      }
    }
    const keptSet = fileContents
      .map(f => ({ f, score: finalScore.get(f.rel) ?? 0 }))
      .sort((a, b) => (b.score - a.score) || (a.f.content.length - b.f.content.length))
      .slice(0, maxFiles);
    ignoredCount += fileContents.length - keptSet.length;
    const keptRelsCap = new Set(keptSet.map(k => k.f.rel));
    const orderedKept = fileContents.filter(f => keptRelsCap.has(f.rel));
    fileContents.splice(0, fileContents.length, ...orderedKept);
    included = included.filter(uri =>
      keptRelsCap.has(path.relative(rootPath, uri.fsPath).replace(/\\/g, '/')));
    treeRoot = { dirs: new Map(), files: [] };
    for (const uri of included) {
      addToTree(treeRoot, path.relative(rootPath, uri.fsPath).replace(/\\/g, '/').split('/'));
    }
  }

  // ── Fit-to-window: trim files largest-first until assembled bundle fits limit ──
  if (tokenLimit > 0) {
    // Overhead varies by format:
    //   standard/compact: two 64-char DIV lines + FILE: path + blank ≈ 240 chars = 60 tok
    //   minimal:          "---path\n" ≈ 35 chars = ~9 tok; header ~80 chars = ~20 tok
    //   xml:              <document>/<source>/</source> tags ≈ 60 chars = ~15 tok
    const PER_FILE_TOKENS = format === 'minimal' ? 10 : format === 'xml' ? 15 : 60;
    const FIXED_OVERHEAD  = format === 'minimal' ? 50 : 3000;

    const withTok = fileContents.map(f => ({
      ...f,
      est: Math.ceil(f.content.length / 4) + PER_FILE_TOKENS,
    }));
    let total = withTok.reduce((s, f) => s + f.est, 0) + FIXED_OVERHEAD;

    if (total > tokenLimit) {
      // SMART SELECTION (the differentiator): rank every file by relevance to
      // the user's task/prompt + structure, then greedily KEEP the most-relevant
      // files that fit the budget — instead of blindly cutting the largest ones.
      // So "fit to window" keeps what matters for what you're doing. With no
      // prompt it falls back to structural relevance (entry points, source, docs).
      const terms = extractQueryTerms(userPrompt);
      // 1) base relevance per file
      const baseScore = new Map<string, number>(
        withTok.map(f => [f.rel, scoreRelevance(f.rel, f.content, terms)] as const)
      );
      // 2) dependency-graph boost: a file imported by a relevant file inherits
      //    part of that relevance, so the dependencies of what you're working on
      //    survive the cut too (complete, connected context).
      const known = new Set(withTok.map(f => f.rel));
      const finalScore = new Map(baseScore);
      for (const f of withTok) {
        const impScore = baseScore.get(f.rel) ?? 0;
        if (impScore <= 0) { continue; }
        for (const spec of extractImports(f.content, path.extname(f.rel).toLowerCase())) {
          const dep = resolveImport(f.rel, spec, known);
          if (dep) { finalScore.set(dep, (finalScore.get(dep) ?? 0) + Math.min(impScore, 12) * 0.5); }
        }
      }
      const scored = withTok
        .map(f => ({ ...f, score: finalScore.get(f.rel) ?? 0 }))
        .sort((a, b) => (b.score - a.score) || (a.est - b.est)); // most relevant; tie → smaller first to pack more

      const kept: Array<{ rel: string; content: string; est: number; score: number }> = [];
      let used = FIXED_OVERHEAD;
      for (const f of scored) {
        if (used + f.est <= tokenLimit) { kept.push(f); used += f.est; }
        else { ignoredCount++; }
      }
      if (kept.length === 0) {
        throw new Error(
          `Token limit (${tokenLimit.toLocaleString()}) is smaller than the fixed bundle overhead. ` +
          `Increase the window size or select fewer files.`
        );
      }
      kept.sort((a, b) => a.rel.localeCompare(b.rel));
      fileContents.splice(0, fileContents.length, ...kept.map(f => ({ rel: f.rel, content: f.content })));

      // Rebuild tree and update included list to reflect trimmed file set
      const keptRels = new Set(fileContents.map(f => f.rel));
      included = included.filter(uri => {
        const rel = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
        return keptRels.has(rel);
      });
      treeRoot = { dirs: new Map(), files: [] };
      for (const uri of included) {
        const rel = path.relative(rootPath, uri.fsPath).replace(/\\/g, '/');
        addToTree(treeRoot, rel.split('/'));
      }
    }
  }

  // ── Assemble by format ──────────────────────────────────────────────────────
  let bundle: string;

  if (format === 'xml') {
    // Claude XML format
    const header = [
      `<!-- SendToAI Bundle -->`,
      `<!-- Project: ${folderName} | Files: ${included.length} | Mode: ${modeLabel} | ${now} -->`,
      `<!-- Est. tokens: ${TOKEN_SENTINEL} -->`,
      contextBlock ? `\n<project_context>\n${contextBlock.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n</project_context>` : '',
      userPrompt ? `\n<task>${userPrompt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</task>` : '',
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

  } else if (format === 'minimal') {
    // Ultra-compact: 1-line header + flat file index + ---path separators, no footer.
    // Source is already compacted via readOne (same path as 'compact').
    const date  = now.slice(0, 10);
    const parts: string[] = [
      `[sendtoai:${folderName} | ${included.length} files | ~${TOKEN_SENTINEL} | ${date}]`,
    ];

    if (contextBlock) {
      parts.push('');
      parts.push('[context]');
      parts.push(contextBlock.trim());
      parts.push('[/context]');
    }

    if (userPrompt) {
      parts.push('');
      parts.push(`[prompt]${userPrompt.trim()}[/prompt]`);
    }

    // Flat file index — gives the AI structural overview at minimal cost
    parts.push('');
    for (const { rel } of fileContents) { parts.push(rel); }

    // Files with short separators (3 chars + path vs ~175 chars in standard format)
    for (const { rel, content } of fileContents) {
      parts.push('');
      parts.push(`---${rel}`);
      parts.push(content.trimEnd());
    }

    bundle = parts.join('\n');

  } else {
    // Standard / Compact (same structure, compact just has stripped content)
    const lines: string[] = [
      DIV,
      `PROJECT: ${folderName}`,
      `MODE: ${modeLabel} | FORMAT: ${fmtLabel}`,
      `FILES INCLUDED: ${included.length} | FILES IGNORED: ${ignoredCount}`,
      `ESTIMATED TOKENS: ${TOKEN_SENTINEL}`,
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
    TOKEN_SENTINEL,
    `${tokenEstimate.toLocaleString()} (~${cost.haiku} Haiku · ${cost.sonnet} Sonnet · ${cost.opus} Opus)`
  );

  return { bundle, fileCount: included.length, ignoredCount, tokenEstimate, folderName, fileTypes, trimmedFrom };
}
