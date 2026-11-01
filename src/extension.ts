import * as vscode from 'vscode';
import * as https from 'https';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { SendToAIPanel, PanelRequest } from './panel';
import { buildBundle, scanProjectTree } from './bundler';
import { estimateCost } from './costEstimator';

const PRO_FILE_LIMIT = 50;
// Accept a SET of product ids, not one hardcoded number (2026-08-19 audit #13):
// creating a new LemonSqueezy product/variant for a price change would otherwise
// make every new buyer's key fail to activate, silently, on the day of the change.
// Add the new id here BEFORE changing pricing; keep the old one so existing
// customers keep validating forever.
const PRODUCT_IDS = new Set<number>([926714]);
const isOurProduct = (id: unknown): boolean =>
  typeof id === 'number' && PRODUCT_IDS.has(id);
const CACHE_TTL_MS        = 24 * 60 * 60 * 1000;
// Offline grace: a refunded or revoked key is caught at the next online check
// (24h). These windows only matter when the machine stays offline. 14 days of
// warnings, then Pro switches off at 90 days until the key is re-verified.
const WARN_AFTER_MS       = 14 * 24 * 60 * 60 * 1000;
const HARD_BLOCK_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
const SECRETS_KEY         = 'sendtoai.activation';
const CACHE_SECRET_KEY    = 'sendtoai.cacheSecret';   // HMAC key for the validity cache (SecretStorage)
const INSTANCE_UUID_KEY   = 'sendtoai.instanceUuid';  // stable per-install id (globalState, not synced)
const LICENSE_LOG_KEY     = 'sendtoai.licenseLog';
const LICENSE_LOG_MAX     = 200;
const MAX_RESPONSE_BYTES  = 256 * 1024;
// Files that execute on install / open / commit. An AI reply can be steered by
// prompt injection hidden in a bundled file, so edits to these are never
// pre-ticked in the Apply AI Reply picker.
const SENSITIVE_WRITE_RE = /(^|\/)(package\.json|\.npmrc|\.yarnrc(?:\.yml)?|Makefile)$|(^|\/)(\.husky|\.github|\.vscode|\.git)\/|\.(sh|ps1|bat|cmd)$/i;

const LICENSE_RE = /^[A-Z0-9]{8}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{12}$/i;

interface LicenseCache {
  key: string;
  valid: boolean;
  checkedAt: number;
  lastValidAt: number;
  sig?: string;
}

// ── Cache signing ─────────────────────────────────────────────────────────────
// globalState is plain JSON in a user-readable SQLite file. Signing the cache
// with a secret that lives in SecretStorage (OS keychain) means a hand-edited
// "valid: true" is ignored and the key is simply re-verified online.
export function cacheSignature(secret: string, c: Omit<LicenseCache, 'sig'>): string {
  return crypto.createHmac('sha256', secret)
    .update(`${c.key}|${c.valid ? 1 : 0}|${c.checkedAt}|${c.lastValidAt}`)
    .digest('hex');
}
export function cacheIsAuthentic(secret: string, c: LicenseCache): boolean {
  if (!c.sig) { return false; }
  const expected = cacheSignature(secret, c);
  return expected.length === c.sig.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c.sig));
}

async function getCacheSecret(context: vscode.ExtensionContext): Promise<string | null> {
  try {
    let s = await context.secrets.get(CACHE_SECRET_KEY);
    if (!s) {
      s = crypto.randomBytes(32).toString('hex');
      await context.secrets.store(CACHE_SECRET_KEY, s);
    }
    return s;
  } catch { return null; } // keychain unavailable: caller treats cache as absent
}

// ── Activation identity ───────────────────────────────────────────────────────
// vscode.env.machineId is derived from a MAC address: it changes with docking
// stations and VMs and differs in every WSL/SSH/Codespaces host, each change
// silently burning one of the 5 activation slots. A UUID generated once per
// install is stable, and the hostname prefix makes the instance recognisable
// in the Lemon Squeezy dashboard ("deactivate the old laptop").
function getInstanceName(context: vscode.ExtensionContext): string {
  let uuid = context.globalState.get<string>(INSTANCE_UUID_KEY);
  if (!uuid) {
    uuid = crypto.randomUUID();
    void context.globalState.update(INSTANCE_UUID_KEY, uuid);
  }
  const host = os.hostname().replace(/[^A-Za-z0-9-]/g, '').slice(0, 24) || 'vscode';
  return `${host}-${uuid.slice(0, 8)}`;
}

// ── Activity log ──────────────────────────────────────────────────────────────
// Timestamped activation / validation history. Stripe lists "a system log
// proving the customer used your software" as the evidence that wins digital
// goods disputes; this is that log, exportable via the Show License Activity
// command.
interface LicenseLogEntry { t: number; event: string; detail?: string }
async function logLicense(context: vscode.ExtensionContext, event: string, detail?: string): Promise<void> {
  try {
    const log = context.globalState.get<LicenseLogEntry[]>(LICENSE_LOG_KEY) ?? [];
    log.push({ t: Date.now(), event, detail });
    if (log.length > LICENSE_LOG_MAX) { log.splice(0, log.length - LICENSE_LOG_MAX); }
    await context.globalState.update(LICENSE_LOG_KEY, log);
  } catch { /* never let logging break licensing */ }
}
const keyTail = (key: string) => key ? `…${key.slice(-4)}` : '(none)';

interface StoredActivation {
  instanceId: string;
  activatedAt: number;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function lsPost(path: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.lemonsqueezy.com',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res: import('http').IncomingMessage) => {
      const status = res.statusCode ?? 0;
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk;
        if (data.length > MAX_RESPONSE_BYTES) { req.destroy(new Error('Response too large')); }
      });
      res.on('error', reject);
      res.on('end', () => {
        // 5xx / 429 are server-side trouble, not a verdict on the key. Surface
        // them as a network error so the caller falls back to the cached state
        // instead of caching valid:false for a day.
        if (status >= 500 || status === 429) { reject(new Error(`HTTP ${status}`)); return; }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

// ── License API ───────────────────────────────────────────────────────────────

type ActivateResult =
  | { ok: true;  instanceId: string }
  | { ok: false; limitReached: boolean };

async function activateLicense(key: string, context: vscode.ExtensionContext): Promise<ActivateResult | null> {
  try {
    const instanceName = getInstanceName(context);
    const json = await lsPost('/v1/licenses/activate', { license_key: key, instance_name: instanceName });

    if (json.activated !== true || !isOurProduct(json.meta?.product_id)) {
      const limitReached = typeof json.error === 'string' && json.error.toLowerCase().includes('activation limit');
      void logLicense(context, limitReached ? 'activate.limit' : 'activate.rejected',
        `key ${keyTail(key)} as ${instanceName}${typeof json.error === 'string' ? ': ' + json.error : ''}`);
      return { ok: false, limitReached };
    }

    const activation: StoredActivation = { instanceId: json.instance.id, activatedAt: Date.now() };
    await context.secrets.store(SECRETS_KEY, JSON.stringify(activation));
    void logLicense(context, 'activate.ok', `key ${keyTail(key)} as ${instanceName}, instance ${json.instance.id}`);
    return { ok: true, instanceId: json.instance.id };
  } catch (e) {
    void logLicense(context, 'activate.offline', e instanceof Error ? e.message : String(e));
    return null; // network error
  }
}

// Returns true=valid, false=invalid/limit, null=network error
async function checkLicenseRemote(key: string, context: vscode.ExtensionContext): Promise<boolean | null> {
  let storedStr: string | undefined;
  try { storedStr = await context.secrets.get(SECRETS_KEY); }
  catch { return null; } // keychain unavailable: treat like offline, never as "invalid"

  if (!storedStr) {
    // No stored activation — activate this machine
    const result = await activateLicense(key, context);
    if (result === null) { return null; }
    return result.ok;
  }

  try {
    const stored: StoredActivation = JSON.parse(storedStr);
    const json = await lsPost('/v1/licenses/validate', {
      license_key: key,
      instance_id: stored.instanceId,
    });

    if (json.valid !== true || !isOurProduct(json.meta?.product_id)) {
      // Instance no longer exists (secrets from old install, etc.) — re-activate
      if (typeof json.error === 'string' && json.error.toLowerCase().includes('instance')) {
        void logLicense(context, 'validate.instance-gone', `instance ${stored.instanceId}; re-activating`);
        await context.secrets.delete(SECRETS_KEY);
        const result = await activateLicense(key, context);
        if (result === null) { return null; }
        return result.ok;
      }
      void logLicense(context, 'validate.invalid',
        `key ${keyTail(key)}, status ${json.license_key?.status ?? '?'}${typeof json.error === 'string' ? ': ' + json.error : ''}`);
      return false;
    }
    void logLicense(context, 'validate.ok', `key ${keyTail(key)}, instance ${stored.instanceId}`);
    return true;
  } catch (e) {
    void logLicense(context, 'validate.offline', e instanceof Error ? e.message : String(e));
    return null; // network error
  }
}

let cachedProStatus = false;

// ── Workspace root ────────────────────────────────────────────────────────────
// Multi-root workspaces used to be silently reduced to the first folder. Now:
// one folder → that folder; several → the folder that owns the active editor,
// else the folder used last, else the first. Notes and presets follow the root.
let lastRoot: vscode.Uri | undefined;
function resolveRoot(): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) { lastRoot = undefined; return undefined; }
  if (folders.length === 1) { lastRoot = folders[0].uri; return lastRoot; }
  const active = vscode.window.activeTextEditor?.document.uri;
  const owner = active && active.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(active)?.uri : undefined;
  const previous = lastRoot && folders.some(f => f.uri.toString() === lastRoot?.toString()) ? lastRoot : undefined;
  lastRoot = owner ?? previous ?? folders[0].uri;
  return lastRoot;
}

function getLicenseKey(): string {
  return vscode.workspace.getConfiguration('sendtoai').get<string>('licenseKey') ?? '';
}

function workspaceKey(suffix: string): string {
  const root = (resolveRoot()?.fsPath ?? 'global').replace(/\\/g, '/');
  return `sendtoai.${root}.${suffix}`;
}

async function refreshLicense(
  key: string,
  context: vscode.ExtensionContext,
  force = false,
): Promise<boolean> {
  if (!LICENSE_RE.test(key)) {
    cachedProStatus = false;
    return false;
  }

  const secret = await getCacheSecret(context);
  const raw = context.globalState.get<LicenseCache>('sendtoai.licenseCache');
  // An unsigned or mis-signed cache is treated as no cache at all: the key gets
  // re-verified online, and offline the user stays on the free tier until then.
  const cache = raw && secret && cacheIsAuthentic(secret, raw) ? raw : undefined;
  const now = Date.now();
  // A cache stamped in the future means the clock was rolled back (or the cache
  // was hand-edited). Don't trust it: re-verify now, and fail closed if offline.
  const clockRolledBack = !!cache && cache.checkedAt > now + 60_000;

  const cacheUsable = !clockRolledBack && !!cache && cache.key === key;
  if (!force && cacheUsable && (now - cache.checkedAt) < CACHE_TTL_MS) {
    cachedProStatus = cache.valid;
    return cache.valid;
  }
  // The online check can take up to 8 s. Until it answers, act on the last
  // verdict so a paying user who bundles right after startup is not shown the
  // upgrade banner (the verdict is corrected below if the server disagrees).
  if (cacheUsable) { cachedProStatus = cache.valid; }

  const remote = await checkLicenseRemote(key, context);

  if (remote === null) {
    // Network error — keep Pro if previously confirmed valid
    if (cache && cache.key === key && cache.valid && !clockRolledBack) {
      const offlineMs = now - (cache.lastValidAt ?? cache.checkedAt);
      if (offlineMs > HARD_BLOCK_AFTER_MS) {
        cachedProStatus = false;
        return false;
      }
      if (offlineMs > WARN_AFTER_MS) {
        const days = Math.floor(offlineMs / (24 * 60 * 60 * 1000));
        vscode.window.showWarningMessage(
          `SendToAI: License hasn't been verified in ${days} days. Connect to the internet to keep Pro access.`
        );
      }
      cachedProStatus = true;
      return true;
    }
    cachedProStatus = false;
    return false;
  }

  const fresh: Omit<LicenseCache, 'sig'> = {
    key,
    valid: remote,
    checkedAt: now,
    lastValidAt: remote ? now : (cache?.lastValidAt ?? 0),
  };
  await context.globalState.update('sendtoai.licenseCache',
    { ...fresh, sig: secret ? cacheSignature(secret, fresh) : undefined } satisfies LicenseCache);

  cachedProStatus = remote;
  return remote;
}

// ── Round-trip: parse an AI chat reply into editable file blocks ──────────────
// Recognizes a file path from the fence info string (```ts src/a.ts) or a line
// just before the fence (**src/a.ts**, `src/a.ts`, File: src/a.ts, // src/a.ts).
export function extractPathToken(s: string): string {
  const cleaned = s.replace(/\\/g, '/').replace(/[*`>#]/g, '').replace(/^\s*(?:file|path)\s*:/i, '').trim();
  const m = cleaned.match(/([\w][\w./-]*\.[A-Za-z][A-Za-z0-9]{0,7})\b/);
  return m ? m[1] : '';
}

export function parseFileBlocks(text: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const lines = text.split(/\r?\n/);
  let pending = '';
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^\s*```(.*)$/);
    if (fence) {
      const p = extractPathToken(fence[1]) || pending;
      i++;
      const buf: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      if (p) { out.push({ path: p, content: buf.join('\n') }); }
      pending = '';
      continue;
    }
    const line = lines[i];
    if (line.trim() === '') { continue; } // blank lines keep a pending label alive
    const tok = extractPathToken(line);
    // Only a line that is essentially JUST the path counts as a label
    // (**src/a.ts**, `src/a.ts`, File: src/a.ts). A prose sentence that happens
    // to contain "e.g." or "Node.js" must never become a target file.
    const cleaned = line.replace(/[*`>#]/g, '').replace(/^\s*(?:file|path)\s*:/i, '').trim();
    pending = (tok && cleaned.length <= tok.length + 24) ? tok : '';
  }
  return out;
}

// ── Extension entry point ─────────────────────────────────────────────────────

// ── Review nudge — one polite ask, only after the extension has proven its value ──
const REVIEW_URL = 'https://marketplace.visualstudio.com/items?itemName=oxainz.sendtoai&ssr=false#review-details';
async function maybeAskForReview(context: vscode.ExtensionContext): Promise<void> {
  try {
    if (context.globalState.get<boolean>('reviewAskDone')) { return; }
    const n = (context.globalState.get<number>('successCount') ?? 0) + 1;
    await context.globalState.update('successCount', n);
    const askAt = context.globalState.get<number>('reviewAskAt') ?? 3;
    if (n < askAt) { return; }
    const pick = await vscode.window.showInformationMessage(
      `SendToAI has bundled for you ${n} times — if it's saving you time, a Marketplace review really helps a small extension get found.`,
      '⭐ Rate it', 'Later', "Don't ask again");
    if (pick === '⭐ Rate it') {
      vscode.env.openExternal(vscode.Uri.parse(REVIEW_URL));
      await context.globalState.update('reviewAskDone', true);
    } else if (pick === "Don't ask again") {
      await context.globalState.update('reviewAskDone', true);
    } else {
      // "Later" or dismissed — back off substantially before asking once more
      await context.globalState.update('reviewAskAt', n + 15);
    }
  } catch { /* never let the nudge break a successful bundle */ }
}

export function activate(context: vscode.ExtensionContext) {
  const panel = new SendToAIPanel(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SendToAIPanel.viewType, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Validate license in background on startup
  refreshLicense(getLicenseKey(), context).then(
    valid => panel.sendProStatus(valid),
    () => { /* storage/network failure — stay on free tier */ },
  );

  const broadcastPro = () => panel.sendProStatus(cachedProStatus);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('sendtoai.licenseKey')) {
        const valid = await refreshLicense(getLicenseKey(), context, true).catch(() => false);
        panel.sendProStatus(valid);
      }
    })
  );

  // ── Scan ──────────────────────────────────────────────────────────────────
  const rescan = async () => {
    const root = resolveRoot();
    if (!root) {
      // No folder open: answer with an empty tree so the panel stops spinning
      panel.updateTree({ name: '', path: '', isDir: true, tokenEst: 0, children: [] });
      return;
    }
    try {
      const tree = await scanProjectTree(root);
      panel.updateTree(tree);
    } catch (e) {
      vscode.window.showErrorMessage(`SendToAI: scan failed — ${e}`);
    }
  };
  panel.onScanRequest(rescan);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void rescan(); }));

  // ── Context (project notes) ───────────────────────────────────────────────
  panel.onLoadContext(() => {
    const notes = context.globalState.get<string>(workspaceKey('notes')) ?? '';
    panel.sendContextLoaded(notes);
    broadcastPro();
  });

  panel.onSaveContext(async (notes) => {
    await context.globalState.update(workspaceKey('notes'), notes);
    panel.sendContextSaved();
  });

  // ── Presets ───────────────────────────────────────────────────────────────
  const presetsKey = () => workspaceKey('presets');
  const getPresets = () =>
    context.globalState.get<{ name: string; paths: string[] }[]>(presetsKey()) ?? [];

  panel.onLoadPresets(() => {
    panel.sendPresetsLoaded(getPresets());
  });

  panel.onSavePreset(async (name, paths) => {
    // Named presets are Pro (advertised as such everywhere; the gate was
    // missing). Loading/deleting existing presets stays free — no rug-pull
    // for anyone who saved presets before the gate existed.
    if (!cachedProStatus) {
      panel.showUpgradePrompt('presets');
      return;
    }
    const presets = getPresets();
    const idx = presets.findIndex(p => p.name === name);
    if (idx >= 0) {
      presets[idx] = { name, paths };
    } else {
      if (presets.length >= 10) {
        vscode.window.showWarningMessage('SendToAI: Preset limit reached (10). Delete one to save a new preset.');
        return;
      }
      presets.push({ name, paths });
    }
    await context.globalState.update(presetsKey(), presets);
    panel.sendPresetsLoaded(presets);
  });

  panel.onDeletePreset(async (name) => {
    const presets = getPresets().filter(p => p.name !== name);
    await context.globalState.update(presetsKey(), presets);
    panel.sendPresetsLoaded(presets);
  });

  // In a multi-root workspace, switching to an editor in another folder
  // re-targets the panel: tree, notes and presets all follow that folder.
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    if ((vscode.workspace.workspaceFolders?.length ?? 0) < 2) { return; }
    const before = lastRoot?.toString();
    const after = resolveRoot()?.toString();
    if (before === after) { return; }
    void rescan();
    panel.sendContextLoaded(context.globalState.get<string>(workspaceKey('notes')) ?? '');
    panel.sendPresetsLoaded(getPresets());
  }));

  // ── Bundle ────────────────────────────────────────────────────────────────
  let bundling = false;
  panel.onBundleRequest(async (req: PanelRequest) => {
    const root = resolveRoot();
    if (!root) {
      vscode.window.showErrorMessage('SendToAI: No workspace folder open.');
      return;
    }
    if (bundling) {
      vscode.window.showInformationMessage('SendToAI: A bundle is already in progress.');
      return;
    }
    bundling = true;

    const isPro = cachedProStatus;
    if (req.mode === 'git' && !isPro) {
      panel.showUpgradePrompt('git');
      return;
    }
    // Fit to AI Window is a Pro feature (it was always labeled PRO in the UI,
    // but the gate was missing — free users silently got it).
    if (req.targetWindow > 0 && !isPro) {
      panel.showUpgradePrompt('window');
      return;
    }
    // NOTE (2026-08-19 conversion audit): there used to be a hard paywall here.
    // The file tree defaults to select-all, so on any real repo a brand-new
    // free user's FIRST click produced an upgrade prompt and zero output — the
    // worst possible first run. Now the free tier bundles the PRO_FILE_LIMIT
    // most-relevant files instead (see buildBundle's maxFiles), which delivers
    // a usable bundle AND demonstrates the relevance ranking Pro applies to
    // the whole project. Ask for money after proving value, never before.

    panel.setBusy(true);
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'SendToAI: bundling…', cancellable: true },
        async (progress, token) => {
          // Prefer the notes as they currently read in the panel (unsaved
          // edits included) over the last saved copy.
          const contextBlock = req.includeContext
            ? (req.notes ?? context.globalState.get<string>(workspaceKey('notes')) ?? '')
            : undefined;

          const res = await buildBundle(
            root, progress, token,
            req.mode, req.format, req.prompt,
            req.selectedPaths, contextBlock, req.targetWindow,
            isPro ? 0 : PRO_FILE_LIMIT,
          );
          return res;
        }
      );

      if (!result) { return; }

      await vscode.env.clipboard.writeText(result.bundle);
      panel.updateStats(result, estimateCost(result.tokenEstimate));
      if (result.trimmedFrom) {
        // Value first, then the ask — and state plainly what was done, so the
        // free bundle is never silently partial.
        void vscode.window.showInformationMessage(
          `\u2705 Copied the ${result.fileCount} most relevant of your ${result.trimmedFrom} files ` +
          `\u00b7 ~${result.tokenEstimate.toLocaleString()} tokens. Pro bundles all of them.`,
          'See Pro'
        ).then(pick => { if (pick === 'See Pro') { panel.showUpgradePrompt('files', result.trimmedFrom); } });
      } else {
        vscode.window.showInformationMessage(
          `\u2705 Copied! ${result.fileCount} files \u00b7 ~${result.tokenEstimate.toLocaleString()} tokens`
        );
      }
      void maybeAskForReview(context);

      if (vscode.workspace.getConfiguration('sendtoai').get<boolean>('autoOpenAI')) {
        vscode.env.openExternal(vscode.Uri.parse('https://claude.ai'));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== 'Cancelled') { vscode.window.showErrorMessage(`SendToAI: ${msg}`); }
    } finally {
      bundling = false;
      panel.setBusy(false);
    }
  });

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    // These two are the highest-traffic discovery paths (explorer right-click
    // and the keybinding). Both used to just focus the sidebar and do nothing,
    // while the README and the landing page promised they would bundle — a
    // silent first-run disappointment. They now do the advertised thing.
    vscode.commands.registerCommand('sendtoai.sendToAI', async (uri?: vscode.Uri) => {
      const ed = vscode.window.activeTextEditor;
      const target = uri ?? ed?.document.uri;
      if (!target) { vscode.commands.executeCommand('sendtoai.panel.focus'); return; }
      try {
        const stat = await vscode.workspace.fs.stat(target);
        if (stat.type === vscode.FileType.Directory) {
          vscode.commands.executeCommand('sendtoai.panel.focus');
          return;
        }
        // A non-empty selection means "send just this" — the fastest possible path.
        const sel = ed && !ed.selection.isEmpty && ed.document.uri.toString() === target.toString()
          ? ed.document.getText(ed.selection)
          : Buffer.from(await vscode.workspace.fs.readFile(target)).toString('utf8');
        const rel = vscode.workspace.asRelativePath(target);
        await vscode.env.clipboard.writeText(`FILE: ${rel}\n\n${sel}`);
        vscode.window.showInformationMessage(
          `\u2705 Copied ${rel} \u00b7 ~${Math.ceil(sel.length / 4).toLocaleString()} tokens`);
        void maybeAskForReview(context);
      } catch {
        vscode.commands.executeCommand('sendtoai.panel.focus');
      }
    }),
    vscode.commands.registerCommand('sendtoai.bundleProject', async (uri?: vscode.Uri) => {
      // Right-clicking a folder should scope the picker to that folder.
      if (uri) {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type === vscode.FileType.Directory) {
            panel.preselectFolder(vscode.workspace.asRelativePath(uri));
          }
        } catch { /* fall through to a plain focus */ }
      }
      vscode.commands.executeCommand('sendtoai.panel.focus');
    }),

    // ── #3 Error-driven bundling — uses VS Code's diagnostics (web bundlers can't) ──
    vscode.commands.registerCommand('sendtoai.bundleErrors', async () => {
      const root = resolveRoot();
      if (!root) { vscode.window.showErrorMessage('SendToAI: No workspace folder open.'); return; }
      const rootPath = root.fsPath;
      const errorFiles = new Set<string>();
      const problemLines: string[] = [];
      for (const [uri, diags] of vscode.languages.getDiagnostics()) {
        if (uri.scheme !== 'file') { continue; }
        const fp = uri.fsPath;
        if (fp !== rootPath && !fp.startsWith(rootPath + path.sep)) { continue; }
        const relevant = diags.filter(d =>
          d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning);
        if (relevant.length === 0) { continue; }
        const rel = path.relative(rootPath, fp).replace(/\\/g, '/');
        errorFiles.add(rel);
        for (const d of relevant) {
          const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARN';
          problemLines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1}  [${sev}] ${d.message}`);
        }
      }
      if (errorFiles.size === 0) {
        vscode.window.showInformationMessage('SendToAI: No errors or warnings in the Problems panel. 🎉');
        return;
      }
      const contextBlock = `PROBLEMS REPORTED BY VS CODE (please fix):\n${problemLines.join('\n')}`;
      const prompt = 'Fix the errors and warnings listed in the project context above. For each, explain the root cause and the fix briefly.';
      panel.setBusy(true);
      try {
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'SendToAI: bundling problem files…', cancellable: true },
          (progress, token) => buildBundle(root, progress, token, 'project', 'standard', prompt, errorFiles, contextBlock, 0),
        );
        if (!result) { return; }
        await vscode.env.clipboard.writeText(result.bundle);
        vscode.window.showInformationMessage(
          `✅ Copied! ${errorFiles.size} file(s) with problems + ${problemLines.length} diagnostics · ~${result.tokenEstimate.toLocaleString()} tokens. Paste into your AI.`);
        void maybeAskForReview(context);
        if (vscode.workspace.getConfiguration('sendtoai').get<boolean>('autoOpenAI')) {
          vscode.env.openExternal(vscode.Uri.parse('https://claude.ai'));
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== 'Cancelled') { vscode.window.showErrorMessage(`SendToAI: ${msg}`); }
      } finally {
        panel.setBusy(false);
      }
    }),

    // ── #4 Round-trip — paste the AI's reply back, apply edits as reviewable changes ──
    vscode.commands.registerCommand('sendtoai.applyResponse', async () => {
      const root = resolveRoot();
      if (!root) { vscode.window.showErrorMessage('SendToAI: No workspace folder open.'); return; }
      if (!vscode.workspace.isTrusted) {
        vscode.window.showWarningMessage('SendToAI: Apply AI Reply writes files, so it is disabled in Restricted Mode. Trust this workspace to use it.');
        return;
      }
      const clip = await vscode.env.clipboard.readText();
      const blocks = parseFileBlocks(clip);
      if (blocks.length === 0) {
        vscode.window.showWarningMessage(
          'SendToAI: No file code-blocks found on the clipboard. Copy the AI\'s FULL reply — not just the chat\'s "copy code" button — so the file path and ``` fences are included, then run this again.');
        return;
      }
      const byPath = new Map<string, string>();
      for (const b of blocks) {
        // Clipboard content is untrusted — never let a path escape the workspace root
        const norm = path.posix.normalize(b.path);
        if (path.posix.isAbsolute(norm) || norm === '..' || norm.startsWith('../')) { continue; }
        byPath.set(norm, b.content);
      }
      if (byPath.size === 0) {
        vscode.window.showWarningMessage('SendToAI: All file paths in the reply point outside the workspace — nothing to apply.');
        return;
      }
      const rootFs = root.fsPath.replace(/[\\/]+$/, '');
      const candidates = await Promise.all([...byPath.entries()].map(async ([p, c]) => {
        const uri = vscode.Uri.joinPath(root, p);
        // Belt and braces: the resolved path must still live under the workspace
        const rel = path.relative(rootFs, uri.fsPath);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { return null; }
        let exists = true;
        try { await vscode.workspace.fs.stat(uri); } catch { exists = false; }
        const sensitive = SENSITIVE_WRITE_RE.test(p);
        const flag = sensitive ? ' · ⚠ review before applying' : '';
        return { label: p, description: `${c.split('\n').length} lines · ${exists ? 'modify' : 'new file'}${flag}`, picked: !sensitive, p, c };
      }));
      const items = candidates.filter((it): it is NonNullable<typeof it> => it !== null);
      if (items.length === 0) {
        vscode.window.showWarningMessage('SendToAI: All file paths in the reply point outside the workspace — nothing to apply.');
        return;
      }
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: `SendToAI: apply ${items.length} AI edit(s)?`,
        placeHolder: 'Select files to write — undoable with Ctrl+Z and visible in git',
      });
      if (!picked || picked.length === 0) { return; }
      const edit = new vscode.WorkspaceEdit();
      for (const it of picked) {
        const uri = vscode.Uri.joinPath(root, it.p);
        let exists = true;
        try { await vscode.workspace.fs.stat(uri); } catch { exists = false; }
        if (!exists) {
          edit.createFile(uri, { ignoreIfExists: true });
          edit.insert(uri, new vscode.Position(0, 0), it.c);
        } else {
          const doc = await vscode.workspace.openTextDocument(uri);
          edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), it.c);
        }
      }
      const ok = await vscode.workspace.applyEdit(edit);
      vscode.window.showInformationMessage(ok
        ? `✅ Applied ${picked.length} file(s). Review in the editor or git diff · Ctrl+Z to undo.`
        : 'SendToAI: Could not apply the edits.');
      if (ok) { void maybeAskForReview(context); }
    }),

    vscode.commands.registerCommand('sendtoai.upgradeToPro', async () => {
      await vscode.env.openExternal(vscode.Uri.parse('https://sendtoai.lemonsqueezy.com/checkout/buy/e8764352-b784-409e-8d59-c44fd9aad90c'));
      // Close the purchase→activation gap: the key arrives by email, and the
      // buyer's next step should be one click away, not a Command Palette hunt.
      const pick = await vscode.window.showInformationMessage(
        'SendToAI: After checkout, your license key arrives by email within a minute.',
        'I have my key — activate');
      if (pick) { vscode.commands.executeCommand('sendtoai.enterLicenseKey'); }
    }),

    vscode.commands.registerCommand('sendtoai.enterLicenseKey', async () => {
      const inputKey = await vscode.window.showInputBox({
        prompt: 'Enter your SendToAI Pro license key',
        placeHolder: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',
        ignoreFocusOut: true,
      });
      if (!inputKey) { return; }

      if (!LICENSE_RE.test(inputKey)) {
        vscode.window.showErrorMessage('SendToAI: Invalid license key format.');
        return;
      }

      const validating = vscode.window.setStatusBarMessage('SendToAI: Activating license…');
      try {
        // Order matters: activate the NEW key first, and only then release the
        // old instance. Deleting the old activation before the new one succeeded
        // orphaned this machine's own slot whenever activation failed (limit
        // reached, network blip), and an orphaned slot can never be freed again.
        const oldStr = await context.secrets.get(SECRETS_KEY);
        const oldKey = getLicenseKey();
        if (oldStr && oldKey === inputKey) {
          // Same key re-entered: re-validate the existing activation, don't burn a slot.
          validating.dispose();
          const valid = await refreshLicense(inputKey, context, true);
          panel.sendProStatus(valid);
          vscode.window.showInformationMessage(valid
            ? '\uD83C\uDF89 License verified! PRO features enabled.'
            : 'SendToAI: License key is invalid, expired, or this activation no longer exists.');
          return;
        }
        const result = await activateLicense(inputKey, context);
        if (result !== null && result.ok && oldStr) {
          // New key is active and stored — free the previous key's slot (best-effort)
          try {
            const old: StoredActivation = JSON.parse(oldStr);
            if (LICENSE_RE.test(oldKey)) {
              await lsPost('/v1/licenses/deactivate', { license_key: oldKey, instance_id: old.instanceId });
            }
          } catch { /* offline or already gone — nothing to free */ }
        }
        validating.dispose();

        if (result === null) {
          vscode.window.showWarningMessage(
            'SendToAI: Could not reach activation server. License saved — will activate when online.'
          );
        } else if (!result.ok) {
          if (result.limitReached) {
            vscode.window.showErrorMessage(
              'SendToAI: This license has reached its activation limit. ' +
              'Run "Deactivate License on This Machine" on another machine first, ' +
              'or email support@sendtoai.dev for help.'
            );
          } else {
            vscode.window.showErrorMessage('SendToAI: License key is invalid or expired.');
          }
          return;
        }

        await vscode.workspace.getConfiguration('sendtoai').update(
          'licenseKey', inputKey, vscode.ConfigurationTarget.Global
        );
        const valid = await refreshLicense(inputKey, context, true);
        panel.sendProStatus(valid);

        if (result !== null) {
          vscode.window.showInformationMessage('\uD83C\uDF89 License activated! PRO features enabled.');
        }
      } catch {
        validating.dispose();
        vscode.window.showErrorMessage('SendToAI: Activation failed. Please try again.');
      }
    }),

    // Evidence pack: what to send Lemon Squeezy if a buyer disputes the charge
    // ("an IP address or system log proving the customer used your software").
    vscode.commands.registerCommand('sendtoai.showLicenseActivity', async () => {
      const key = getLicenseKey();
      let instanceId = '(none)';
      try {
        const s = await context.secrets.get(SECRETS_KEY);
        if (s) { instanceId = (JSON.parse(s) as StoredActivation).instanceId; }
      } catch { /* keychain unavailable */ }
      const log = context.globalState.get<LicenseLogEntry[]>(LICENSE_LOG_KEY) ?? [];
      const lines = [
        'SendToAI Pro — license activity on this machine',
        `Generated:     ${new Date().toISOString()}`,
        `Extension:     ${context.extension.packageJSON.version}`,
        `License key:   ${keyTail(key)}`,
        `Instance name: ${getInstanceName(context)}`,
        `Instance id:   ${instanceId}`,
        `Pro active:    ${cachedProStatus ? 'yes' : 'no'}`,
        '',
        `Events (${log.length}, newest last):`,
        ...log.map(e => `${new Date(e.t).toISOString()}  ${e.event.padEnd(24)} ${e.detail ?? ''}`),
        '',
        'Share this with support@sendtoai.dev if you need help with activations or billing.',
      ];
      const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'plaintext' });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand('sendtoai.deactivateLicense', async () => {
      const key = getLicenseKey();
      if (!LICENSE_RE.test(key)) {
        vscode.window.showInformationMessage('SendToAI: No Pro license configured on this machine.');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        'Deactivate SendToAI Pro on this machine? This frees up one of your activation slots.',
        { modal: true },
        'Deactivate',
      );
      if (confirm !== 'Deactivate') { return; }

      const storedStr = await context.secrets.get(SECRETS_KEY);
      if (!storedStr) {
        // No instance_id stored — clear local state anyway
        await context.globalState.update('sendtoai.licenseCache', undefined);
        cachedProStatus = false;
        panel.sendProStatus(false);
        vscode.window.showInformationMessage('SendToAI: Local license cleared.');
        return;
      }

      const deactivating = vscode.window.setStatusBarMessage('SendToAI: Deactivating…');
      try {
        const stored: StoredActivation = JSON.parse(storedStr);
        const json = await lsPost('/v1/licenses/deactivate', {
          license_key: key,
          instance_id: stored.instanceId,
        });
        deactivating.dispose();

        if (json.deactivated === true) {
          void logLicense(context, 'deactivate.ok', `instance ${stored.instanceId}`);
          await context.secrets.delete(SECRETS_KEY);
          await context.globalState.update('sendtoai.licenseCache', undefined);
          cachedProStatus = false;
          panel.sendProStatus(false);
          vscode.window.showInformationMessage(
            'SendToAI: License deactivated on this machine. You can now activate it elsewhere.'
          );
        } else {
          vscode.window.showErrorMessage('SendToAI: Deactivation failed. Contact support@sendtoai.dev.');
        }
      } catch {
        deactivating.dispose();
        vscode.window.showErrorMessage('SendToAI: Could not reach server. Try again when online.');
      }
    }),
  );
}

export function deactivate() {}
