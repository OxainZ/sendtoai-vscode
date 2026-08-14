import * as vscode from 'vscode';
import * as https from 'https';
import * as path from 'path';
import { SendToAIPanel, PanelRequest } from './panel';
import { buildBundle, scanProjectTree } from './bundler';
import { estimateCost } from './costEstimator';

const PRO_FILE_LIMIT = 50;
const PRODUCT_ID = 926714;
const CACHE_TTL_MS        = 24 * 60 * 60 * 1000;
const WARN_AFTER_MS       = 30 * 24 * 60 * 60 * 1000;
const HARD_BLOCK_AFTER_MS = 365 * 24 * 60 * 60 * 1000;
const SECRETS_KEY         = 'sendtoai.activation';

const LICENSE_RE = /^[A-Z0-9]{8}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{12}$/i;

interface LicenseCache {
  key: string;
  valid: boolean;
  checkedAt: number;
  lastValidAt: number;
}

interface StoredActivation {
  instanceId: string;
  activatedAt: number;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('error', reject);
      res.on('end', () => {
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
    const instanceName = `vscode-${vscode.env.machineId.slice(0, 16)}`;
    const json = await lsPost('/v1/licenses/activate', { license_key: key, instance_name: instanceName });

    if (json.activated !== true || json.meta?.product_id !== PRODUCT_ID) {
      const limitReached = typeof json.error === 'string' && json.error.toLowerCase().includes('activation limit');
      return { ok: false, limitReached };
    }

    const activation: StoredActivation = { instanceId: json.instance.id, activatedAt: Date.now() };
    await context.secrets.store(SECRETS_KEY, JSON.stringify(activation));
    return { ok: true, instanceId: json.instance.id };
  } catch {
    return null; // network error
  }
}

// Returns true=valid, false=invalid/limit, null=network error
async function checkLicenseRemote(key: string, context: vscode.ExtensionContext): Promise<boolean | null> {
  const storedStr = await context.secrets.get(SECRETS_KEY);

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

    if (json.valid !== true || json.meta?.product_id !== PRODUCT_ID) {
      // Instance no longer exists (secrets from old install, etc.) — re-activate
      if (typeof json.error === 'string' && json.error.toLowerCase().includes('instance')) {
        await context.secrets.delete(SECRETS_KEY);
        const result = await activateLicense(key, context);
        if (result === null) { return null; }
        return result.ok;
      }
      return false;
    }
    return true;
  } catch {
    return null; // network error
  }
}

let cachedProStatus = false;

function getLicenseKey(): string {
  return vscode.workspace.getConfiguration('sendtoai').get<string>('licenseKey') ?? '';
}

function workspaceKey(suffix: string): string {
  const root = (vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? 'global').replace(/\\/g, '/');
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

  const cache = context.globalState.get<LicenseCache>('sendtoai.licenseCache');
  const now = Date.now();

  if (!force && cache && cache.key === key && (now - cache.checkedAt) < CACHE_TTL_MS) {
    cachedProStatus = cache.valid;
    return cache.valid;
  }

  const remote = await checkLicenseRemote(key, context);

  if (remote === null) {
    // Network error — keep Pro if previously confirmed valid
    if (cache && cache.key === key && cache.valid) {
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

  await context.globalState.update('sendtoai.licenseCache', {
    key,
    valid: remote,
    checkedAt: now,
    lastValidAt: remote ? now : (cache?.lastValidAt ?? 0),
  } satisfies LicenseCache);

  cachedProStatus = remote;
  return remote;
}

// ── Round-trip: parse an AI chat reply into editable file blocks ──────────────
// Recognizes a file path from the fence info string (```ts src/a.ts) or a line
// just before the fence (**src/a.ts**, `src/a.ts`, File: src/a.ts, // src/a.ts).
function extractPathToken(s: string): string {
  const cleaned = s.replace(/[*`>#]/g, '').replace(/^\s*(?:file|path)\s*:/i, '').trim();
  const m = cleaned.match(/([\w][\w./-]*\.[A-Za-z][A-Za-z0-9]{0,7})\b/);
  return m ? m[1].replace(/\\/g, '/') : '';
}

function parseFileBlocks(text: string): { path: string; content: string }[] {
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
    const tok = extractPathToken(lines[i]);
    if (tok) { pending = tok; }
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
    const askAt = context.globalState.get<number>('reviewAskAt') ?? 5;
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
  panel.onScanRequest(async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { return; }
    try {
      const tree = await scanProjectTree(root);
      panel.updateTree(tree);
    } catch (e) {
      vscode.window.showErrorMessage(`SendToAI: scan failed — ${e}`);
    }
  });

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
    const presets = getPresets();
    const idx = presets.findIndex(p => p.name === name);
    if (idx >= 0) { presets[idx] = { name, paths }; } else { presets.push({ name, paths }); }
    await context.globalState.update(presetsKey(), presets);
    panel.sendPresetsLoaded(presets);
  });

  panel.onDeletePreset(async (name) => {
    const presets = getPresets().filter(p => p.name !== name);
    await context.globalState.update(presetsKey(), presets);
    panel.sendPresetsLoaded(presets);
  });

  // ── Bundle ────────────────────────────────────────────────────────────────
  panel.onBundleRequest(async (req: PanelRequest) => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      vscode.window.showErrorMessage('SendToAI: No workspace folder open.');
      return;
    }

    const isPro = cachedProStatus;
    if (req.mode === 'git' && !isPro) {
      panel.showUpgradePrompt();
      return;
    }

    panel.setBusy(true);
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'SendToAI: bundling…', cancellable: true },
        async (progress, token) => {
          const contextBlock = req.includeContext
            ? (context.globalState.get<string>(workspaceKey('notes')) ?? '')
            : undefined;

          const res = await buildBundle(
            root, progress, token,
            req.mode, req.format, req.prompt,
            req.selectedPaths, contextBlock, req.targetWindow,
          );

          if (!isPro && res.fileCount > PRO_FILE_LIMIT) {
            panel.showUpgradePrompt();
            return null;
          }
          return res;
        }
      );

      if (!result) { return; }

      await vscode.env.clipboard.writeText(result.bundle);
      panel.updateStats(result, estimateCost(result.tokenEstimate));
      vscode.window.showInformationMessage(
        `\u2705 Copied! ${result.fileCount} files \u00b7 ~${result.tokenEstimate.toLocaleString()} tokens`
      );
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
  });

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sendtoai.sendToAI', () => {
      vscode.commands.executeCommand('sendtoai.panel.focus');
    }),
    vscode.commands.registerCommand('sendtoai.bundleProject', () => {
      vscode.commands.executeCommand('sendtoai.panel.focus');
    }),

    // ── #3 Error-driven bundling — uses VS Code's diagnostics (web bundlers can't) ──
    vscode.commands.registerCommand('sendtoai.bundleErrors', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
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
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) { vscode.window.showErrorMessage('SendToAI: No workspace folder open.'); return; }
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
      const items = await Promise.all([...byPath.entries()].map(async ([p, c]) => {
        let exists = true;
        try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, p)); } catch { exists = false; }
        return { label: p, description: `${c.split('\n').length} lines · ${exists ? 'modify' : 'new file'}`, picked: true, p, c };
      }));
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

    vscode.commands.registerCommand('sendtoai.upgradeToPro', () => {
      vscode.env.openExternal(vscode.Uri.parse('https://sendtoai.lemonsqueezy.com/checkout/buy/e8764352-b784-409e-8d59-c44fd9aad90c'));
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
        // Free the old slot first (best-effort): re-activating creates a NEW
        // instance server-side, so deleting the old one without deactivating
        // burned one of the 5 activation slots on every key re-entry.
        const oldStr = await context.secrets.get(SECRETS_KEY);
        if (oldStr) {
          try {
            const old: StoredActivation = JSON.parse(oldStr);
            await lsPost('/v1/licenses/deactivate', {
              license_key: inputKey, instance_id: old.instanceId,
            });
          } catch { /* wrong key for that instance, or offline — nothing to free */ }
        }
        await context.secrets.delete(SECRETS_KEY);
        const result = await activateLicense(inputKey, context);
        validating.dispose();

        if (result === null) {
          vscode.window.showWarningMessage(
            'SendToAI: Could not reach activation server. License saved — will activate when online.'
          );
        } else if (!result.ok) {
          if (result.limitReached) {
            vscode.window.showErrorMessage(
              'SendToAI: This license is already active on 5 machines. ' +
              'Run "Deactivate License on This Machine" on another machine first.'
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

    vscode.commands.registerCommand('sendtoai.deactivateLicense', async () => {
      const key = getLicenseKey();
      if (!LICENSE_RE.test(key)) {
        vscode.window.showInformationMessage('SendToAI: No Pro license configured on this machine.');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        'Deactivate SendToAI Pro on this machine? This frees up one of your 5 activation slots.',
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
