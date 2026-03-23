import * as vscode from 'vscode';
import { buildBundle, scanProjectTree } from './bundler';
import { estimateCost } from './costEstimator';
import { SendToAIPanel, PanelRequest } from './panel';

// ── License / Pro check ───────────────────────────────────────────────────────

const LICENSE_SECRET_KEY = 'sendtoai.licenseKey';

async function isProUser(context: vscode.ExtensionContext): Promise<boolean> {
  const key = (await context.secrets.get(LICENSE_SECRET_KEY)) ?? '';
  return key.trim().toUpperCase().startsWith('STAI-');
}

// ── Preset helpers ────────────────────────────────────────────────────────────

interface Preset { name: string; paths: string[]; }

function presetKey(uri: vscode.Uri): string {
  return `sendtoai.presets.${uri.fsPath}`;
}

function getPresets(context: vscode.ExtensionContext, uri: vscode.Uri): Preset[] {
  return context.globalState.get<Preset[]>(presetKey(uri)) ?? [];
}

function savePresets(context: vscode.ExtensionContext, uri: vscode.Uri, presets: Preset[]): void {
  context.globalState.update(presetKey(uri), presets);
}

// ── Activate ──────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // ── Sidebar panel ────────────────────────────────────────────────────────────
  const panel = new SendToAIPanel(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SendToAIPanel.viewType, panel)
  );

  // ── Status bar ───────────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'sendtoai.bundle';
  statusBar.text = '$(file-zip) SendToAI';
  statusBar.tooltip = 'SendToAI: Bundle project to clipboard (Ctrl+Shift+A)';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ── License key commands ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sendtoai.enterLicenseKey', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter your SendToAI Pro license key',
        placeHolder: 'STAI-XXXX-XXXX-XXXX',
        password: true,
        validateInput: val => {
          if (!val?.trim()) { return 'License key cannot be empty'; }
          if (!val.trim().toUpperCase().startsWith('STAI-')) {
            return 'Invalid key — SendToAI Pro keys start with STAI-';
          }
          return undefined;
        },
      });
      if (!input) { return; }
      await context.secrets.store(LICENSE_SECRET_KEY, input.trim());
      vscode.window.showInformationMessage('✅ SendToAI Pro license key saved securely.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sendtoai.clearLicenseKey', async () => {
      await context.secrets.delete(LICENSE_SECRET_KEY);
      vscode.window.showInformationMessage('SendToAI: License key cleared.');
    })
  );

  // ── Context memory (project notes) ───────────────────────────────────────────
  interface SavedContext { notes: string; savedAt: string; }
  const ctxKey = (uri: vscode.Uri) => `sendtoai.ctx.${uri.fsPath}`;

  panel.onLoadContext(() => {
    const folders = vscode.workspace.workspaceFolders;
    const notes = folders?.length
      ? (context.globalState.get<SavedContext>(ctxKey(folders[0].uri))?.notes ?? '')
      : '';
    panel.sendContextLoaded(notes);
  });

  panel.onSaveContext((notes: string) => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { return; }
    context.globalState.update(ctxKey(folders[0].uri), { notes, savedAt: new Date().toISOString() });
    panel.sendContextSaved();
  });

  // ── Named presets ─────────────────────────────────────────────────────────────
  panel.onLoadPresets(() => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { panel.sendPresetsLoaded([]); return; }
    panel.sendPresetsLoaded(getPresets(context, folders[0].uri));
  });

  panel.onSavePreset((name: string, paths: string[]) => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { return; }
    const presets = getPresets(context, folders[0].uri);
    const existingIdx = presets.findIndex(p => p.name === name);
    if (existingIdx >= 0) {
      presets[existingIdx] = { name, paths };
    } else {
      if (presets.length >= 10) {
        vscode.window.showWarningMessage('SendToAI: Maximum 10 presets per workspace.');
        return;
      }
      presets.push({ name, paths });
    }
    savePresets(context, folders[0].uri, presets);
    panel.sendPresetsLoaded(presets);
  });

  panel.onDeletePreset((name: string) => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { return; }
    const updated = getPresets(context, folders[0].uri).filter(p => p.name !== name);
    savePresets(context, folders[0].uri, updated);
    panel.sendPresetsLoaded(updated);
  });

  // ── Scan request from panel (file-tree picker) ───────────────────────────────
  panel.onScanRequest(async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { return; }
    try {
      const tree = await scanProjectTree(folders[0].uri);
      panel.updateTree(tree);
    } catch (e: unknown) {
      vscode.window.showErrorMessage(
        `SendToAI: Scan failed — ${e instanceof Error ? e.message : String(e)}`
      );
    }
  });

  // ── Panel bundle request (from sidebar UI) ───────────────────────────────────
  panel.onBundleRequest((req: PanelRequest) => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      vscode.window.showErrorMessage('SendToAI: No workspace folder is open.');
      return;
    }
    runBundle(folders[0].uri, panel, statusBar, req, context);
  });

  // ── Bundle workspace (keyboard shortcut / command palette) ───────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sendtoai.bundle', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) {
        vscode.window.showErrorMessage('SendToAI: No workspace folder is open.');
        return;
      }
      await runBundle(folders[0].uri, panel, statusBar, { mode: 'project', format: 'standard', prompt: '', includeContext: false }, context);
    })
  );

  // ── Bundle folder (right-click in explorer) ──────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sendtoai.bundleFolder', async (uri?: vscode.Uri) => {
      if (!uri) {
        vscode.window.showErrorMessage('SendToAI: No folder provided.');
        return;
      }
      await runBundle(uri, panel, statusBar, { mode: 'project', format: 'standard', prompt: '', includeContext: false }, context);
    })
  );
}

export function deactivate(): void {}

// ── Core bundling flow ────────────────────────────────────────────────────────

async function runBundle(
  rootUri: vscode.Uri,
  panel: SendToAIPanel,
  statusBar: vscode.StatusBarItem,
  req: PanelRequest,
  context: vscode.ExtensionContext,
): Promise<void> {
  statusBar.text = '$(loading~spin) Bundling…';
  panel.setBusy(true);

  // ── Freemium gate ─────────────────────────────────────────────────────────────
  if (req.selectedPaths && req.selectedPaths.size > 50) {
    const pro = await isProUser(context);
    if (!pro) {
      panel.setBusy(false);
      statusBar.text = '$(file-zip) SendToAI';
      panel.showUpgradePrompt();
      return;
    }
  }

  const modeLabel = req.mode === 'tabs' ? 'Open Tabs' : req.mode === 'git' ? 'Git Changes' : 'Project';

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `SendToAI — ${modeLabel}`,
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ increment: 0, message: 'Scanning…' });

      try {
        const contextBlock = (req.includeContext && req.notes) ? req.notes : undefined;
        const result = await buildBundle(rootUri, progress, token, req.mode, req.format, req.prompt, req.selectedPaths, contextBlock);
        if (token.isCancellationRequested) { return; }

        progress.report({ increment: 95, message: 'Copying to clipboard…' });
        await vscode.env.clipboard.writeText(result.bundle);

        const cost = estimateCost(result.tokenEstimate);
        panel.updateStats(result, cost);
        panel.setBusy(false);

        const tk = result.tokenEstimate >= 1000
          ? `~${(result.tokenEstimate / 1000).toFixed(1)}k`
          : `~${result.tokenEstimate}`;

        statusBar.text = `$(file-zip) ${tk} tokens`;
        statusBar.tooltip = `SendToAI: Last bundle — ${result.fileCount} files, ${tk} tokens (${cost.haiku} Haiku)`;

        if (result.tokenEstimate > 180_000) {
          vscode.window.showWarningMessage(
            `⚠️ Large bundle (${tk} tokens) — consider Sonnet 4.6 or Opus which support 1M context`
          );
        }

        vscode.window.showInformationMessage(
          `✅ ${result.fileCount} files bundled — ${tk} tokens — copied to clipboard`
        );

        progress.report({ increment: 100 });
      } catch (e: unknown) {
        panel.setBusy(false);
        statusBar.text = '$(file-zip) SendToAI';
        if (e instanceof Error && e.message === 'Cancelled') { return; }
        vscode.window.showErrorMessage(
          `SendToAI: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  );
}
