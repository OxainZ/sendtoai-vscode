import * as vscode from 'vscode';
import * as https from 'https';
import { SendToAIPanel, PanelRequest } from './panel';
import { buildBundle, scanProjectTree } from './bundler';
import { estimateCost } from './costEstimator';

const PRO_FILE_LIMIT = 50;
const PRODUCT_ID = 926714;
const CACHE_TTL_MS        = 24 * 60 * 60 * 1000;         // 24 h  — re-validate when online
const WARN_AFTER_MS       = 30 * 24 * 60 * 60 * 1000;    // 30 d  — start nudging user
const HARD_BLOCK_AFTER_MS = 365 * 24 * 60 * 60 * 1000;   // 1 yr  — absolute offline limit

const LICENSE_RE = /^SNDAI-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

interface LicenseCache {
  key: string;
  valid: boolean;
  checkedAt: number;    // last time we attempted a remote check
  lastValidAt: number;  // last time remote confirmed valid === true
}

let cachedProStatus = false;

function getLicenseKey(): string {
  return vscode.workspace.getConfiguration('sendtoai').get<string>('licenseKey') ?? '';
}

function workspaceKey(suffix: string): string {
  const root = (vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? 'global').replace(/\\/g, '/');
  return `sendtoai.${root}.${suffix}`;
}

// Returns true=valid, false=invalid, null=network error
function validateLicenseRemote(key: string): Promise<boolean | null> {
  return new Promise(resolve => {
    const body = JSON.stringify({ license_key: key, instance_name: 'vscode-sendtoai' });
    const options = {
      hostname: 'api.lemonsqueezy.com',
      path: '/v1/licenses/validate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res: import('http').IncomingMessage) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const valid = json.valid === true &&
            json.meta?.product_id === PRODUCT_ID;
          resolve(valid);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
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

  // Use cache if fresh and same key
  if (!force && cache && cache.key === key && (now - cache.checkedAt) < CACHE_TTL_MS) {
    cachedProStatus = cache.valid;
    return cache.valid;
  }

  const remote = await validateLicenseRemote(key);

  if (remote === null) {
    // Network error — never punish a key that was previously confirmed valid
    if (cache && cache.key === key && cache.valid) {
      const offlineMs = now - (cache.lastValidAt ?? cache.checkedAt);
      cachedProStatus = true;
      // Warn after 30 days offline but still allow; hard-block after 1 year
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
      return cachedProStatus;
    }
    // No prior valid confirmation — deny
    cachedProStatus = false;
    return false;
  }

  // Server responded — persist result; only update lastValidAt when confirmed valid
  await context.globalState.update('sendtoai.licenseCache', {
    key,
    valid: remote,
    checkedAt: now,
    lastValidAt: remote ? now : (cache?.lastValidAt ?? 0),
  } satisfies LicenseCache);

  cachedProStatus = remote;
  return remote;
}

export function activate(context: vscode.ExtensionContext) {
  const panel = new SendToAIPanel(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SendToAIPanel.viewType, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Validate license in background on startup
  const key = getLicenseKey();
  refreshLicense(key, context).then(valid => panel.sendProStatus(valid));

  const broadcastPro = () => panel.sendProStatus(cachedProStatus);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async e => {
      if (e.affectsConfiguration('sendtoai.licenseKey')) {
        const newKey = getLicenseKey();
        const valid = await refreshLicense(newKey, context, true);
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
    vscode.commands.registerCommand('sendtoai.upgradeToPro', () => {
      vscode.env.openExternal(vscode.Uri.parse('https://sendtoai.lemonsqueezy.com/checkout'));
    }),
    vscode.commands.registerCommand('sendtoai.enterLicenseKey', async () => {
      const inputKey = await vscode.window.showInputBox({
        prompt: 'Enter your SendToAI Pro license key',
        placeHolder: 'SNDAI-XXXX-XXXX-XXXX-XXXX',
        ignoreFocusOut: true,
      });
      if (!inputKey) { return; }

      if (!LICENSE_RE.test(inputKey)) {
        vscode.window.showErrorMessage('SendToAI: Invalid license key format.');
        return;
      }

      // Validate with Lemon Squeezy before saving
      const validating = vscode.window.setStatusBarMessage('SendToAI: Validating license…');
      try {
        const remote = await validateLicenseRemote(inputKey);
        validating.dispose();

        if (remote === false) {
          vscode.window.showErrorMessage('SendToAI: License key is invalid or expired.');
          return;
        }
        if (remote === null) {
          vscode.window.showWarningMessage(
            'SendToAI: Could not reach validation server. License saved — will verify when online.'
          );
        }

        await vscode.workspace.getConfiguration('sendtoai').update(
          'licenseKey', inputKey, vscode.ConfigurationTarget.Global
        );
        const valid = await refreshLicense(inputKey, context, true);
        panel.sendProStatus(valid);

        if (remote !== null) {
          vscode.window.showInformationMessage('\uD83C\uDF89 License activated! PRO features enabled.');
        }
      } catch {
        validating.dispose();
        vscode.window.showErrorMessage('SendToAI: Validation failed. Please try again.');
      }
    }),
  );
}

export function deactivate() {}
