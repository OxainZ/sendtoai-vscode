import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { BundleResult, FileNode } from './bundler';
import { CostEstimate } from './costEstimator';

export type BundleMode   = 'project' | 'tabs' | 'git';
export type OutputFormat = 'standard' | 'xml' | 'compact' | 'minimal';

export interface PanelRequest {
  mode:           BundleMode;
  format:         OutputFormat;
  prompt:         string;
  selectedPaths?: Set<string>;
  notes?:         string;
  includeContext: boolean;
  targetWindow:   number; // 0 = no limit
}

export class SendToAIPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sendtoai.panel';

  private _view?: vscode.WebviewView;
  /** Command names received from the webview, newest last (test hook). */
  public readonly inbound: string[] = [];
  private _lastBundle?: string;
  private _onBundle?:        (req: PanelRequest) => void;
  private _onScan?:          () => void;
  private _onSaveContext?:   (notes: string) => void;
  private _onLoadContext?:   () => void;
  private _onSavePreset?:    (name: string, paths: string[]) => void;
  private _onLoadPresets?:   () => void;
  private _onDeletePreset?:  (name: string) => void;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public onBundleRequest (cb: (req: PanelRequest) => void): void { this._onBundle      = cb; }
  public onScanRequest   (cb: () => void):                   void { this._onScan        = cb; }
  public onSaveContext   (cb: (notes: string) => void):      void { this._onSaveContext = cb; }
  public onLoadContext   (cb: () => void):                   void { this._onLoadContext = cb; }
  public onSavePreset    (cb: (name: string, paths: string[]) => void): void { this._onSavePreset   = cb; }
  public onLoadPresets   (cb: () => void):                               void { this._onLoadPresets  = cb; }
  public onDeletePreset  (cb: (name: string) => void):                   void { this._onDeletePreset = cb; }

  public sendContextLoaded(notes: string): void {
    this._view?.webview.postMessage({ command: 'contextLoaded', notes });
  }
  public sendContextSaved(): void {
    this._view?.webview.postMessage({ command: 'contextSaved' });
  }
  public sendPresetsLoaded(presets: { name: string; paths: string[] }[]): void {
    this._view?.webview.postMessage({ command: 'presetsLoaded', presets });
  }
  public sendProStatus(isPro: boolean): void {
    this._view?.webview.postMessage({ command: 'proStatus', isPro });
  }
  public showUpgradePrompt(reason: 'files' | 'git' | 'window' | 'presets' = 'files', fileCount?: number): void {
    this._view?.webview.postMessage({ command: 'showUpgrade', reason, fileCount });
  }
  /** Right-clicking a folder in the explorer should scope the picker to it
   *  instead of silently selecting the whole workspace (2026-08-19 audit #8). */
  public preselectFolder(rel: string): void {
    this._view?.webview.postMessage({ command: 'preselectFolder', rel });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.onDidDispose(() => {
      if (this._view === webviewView) { this._view = undefined; }
    });
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
    webviewView.webview.html = this._html(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: {
      command: string;
      url?: string;
      mode?: BundleMode;
      format?: OutputFormat;
      prompt?: string;
      selectedPaths?: string[];
      notes?: string;
      includeContext?: boolean;
      targetWindow?: number;
      presetName?: string;
      presetPaths?: string[];
    }) => {
      // Record what the page sends (command names only) so the e2e test can
      // prove the webview script actually ran. Capped; never holds content.
      this.inbound.push(String(msg?.command));
      if (this.inbound.length > 50) { this.inbound.shift(); }
      switch (msg.command) {
        case 'requestScan':
          this._onScan?.();
          break;
        case 'saveContext':
          this._onSaveContext?.(msg.notes ?? '');
          break;
        case 'loadContext':
          this._onLoadContext?.();
          break;
        case 'loadPresets':
          this._onLoadPresets?.();
          break;
        case 'savePreset':
          this._onSavePreset?.(msg.presetName ?? '', msg.presetPaths ?? []);
          break;
        case 'deletePreset':
          this._onDeletePreset?.(msg.presetName ?? '');
          break;
        case 'bundle':
          this._onBundle?.({
            mode:           msg.mode   ?? 'project',
            format:         msg.format ?? 'standard',
            prompt:         msg.prompt ?? '',
            selectedPaths:  msg.selectedPaths ? new Set<string>(msg.selectedPaths) : undefined,
            notes:          msg.notes,
            includeContext: msg.includeContext ?? false,
            targetWindow:   msg.targetWindow   ?? 0,
          });
          break;
        case 'copyAgain':
          if (this._lastBundle) {
            Promise.resolve(vscode.env.clipboard.writeText(this._lastBundle)).then(() => {
              vscode.window.showInformationMessage('✅ Copied again — paste into your AI chat!');
            }, () => {
              vscode.window.showErrorMessage('SendToAI: Failed to copy to clipboard.');
            });
          }
          break;
        case 'openUrl':
          // Only http(s) — never let a webview message launch arbitrary URI handlers
          if (msg.url && /^https?:\/\//i.test(msg.url)) { vscode.env.openExternal(vscode.Uri.parse(msg.url)); }
          break;
        case 'enterLicenseKey':
          vscode.commands.executeCommand('sendtoai.enterLicenseKey');
          break;
        case 'bundleErrors':
          vscode.commands.executeCommand('sendtoai.bundleErrors');
          break;
        case 'applyResponse':
          vscode.commands.executeCommand('sendtoai.applyResponse');
          break;
        case 'saveBundle':
          vscode.commands.executeCommand('sendtoai.saveBundle');
          break;
      }
    });
  }

  public updateStats(result: BundleResult, cost: CostEstimate): void {
    // Cap stored bundle at 2 MB — prevents multi-MB Gemini bundles sitting in memory indefinitely
    const bundleTooBig = result.bundle.length > 2_000_000;
    this._lastBundle = bundleTooBig ? undefined : result.bundle;
    this._view?.webview.postMessage({
      command:       'stats',
      folderName:    result.folderName,
      fileCount:     result.fileCount,
      ignoredCount:  result.ignoredCount,
      tokenEstimate: result.tokenEstimate,
      haiku:         cost.haiku,
      sonnet:        cost.sonnet,
      opus:          cost.opus,
      bundleTooBig,
      fileTypes:     result.fileTypes,
      trimmedFrom:   result.trimmedFrom,
      timestamp:     new Date().toLocaleTimeString(),
    });
  }

  /** Demo/test hook: drive the page the way a user would (pointer + real clicks). */
  public demo(action: { type: 'click'; selector: string } | { type: 'prompt'; text: string }): void {
    this._view?.webview.postMessage({ command: '__demo', ...action });
  }

  public updateTree(nodes: FileNode): void {
    this._view?.webview.postMessage({ command: 'scanResult', tree: nodes });
  }

  public setBusy(busy: boolean): void {
    this._view?.webview.postMessage({ command: busy ? 'busy' : 'idle' });
  }

  private _getNonce(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private _html(webview: vscode.Webview): string {
    const nonce = this._getNonce();
    const media = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', name)).toString();
    const cssUri = media('panel.css');
    const jsUri  = media('panel.js');
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${cssUri}">
</head>
<body>

<!-- Header -->
<div class="header">
  <div>
    <div class="logo"><span class="logo-icon">⚡</span> SendToAI <span id="proBadge" style="display:none;background:linear-gradient(135deg,#f7b733,#e07b39);color:#fff;font-size:9px;font-weight:800;padding:2px 7px;border-radius:10px;letter-spacing:0.6px;vertical-align:middle;margin-left:4px;">PRO</span></div>
    <div class="tagline">Bundle project → paste into any AI</div>
  </div>
</div>

<!-- Mode -->
<div class="section">
  <div class="section-label">Bundle Mode</div>
  <div class="mode-tabs">
    <button class="mode-tab active" data-mode="project" data-act="setMode" data-arg="project">📦 Project</button>
    <button class="mode-tab" data-mode="tabs" data-act="setMode" data-arg="tabs">📄 Open Tabs</button>
    <button class="mode-tab" data-mode="git" data-act="setMode" data-arg="git">🔀 Git Changes</button>
  </div>
</div>

<!-- File Picker (shown in Full Project mode only) -->
<div id="pickerSection" class="show">
  <div class="section-label">Files</div>

  <!-- Preset dropdown -->
  <div class="preset-bar">
    <select id="presetSelect" style="width:auto;flex:1">
      <option value="">— Load a preset —</option>
    </select>
    <button class="btn-sm" id="deletePresetBtn" data-act="deletePreset" title="Delete preset" style="display:none">🗑</button>
  </div>

  <div class="picker-toolbar">
    <span class="picker-lbl" id="pickerLabel">Scanning…</span>
    <button class="btn-sm" data-act="pickerAll">All</button>
    <button class="btn-sm" data-act="pickerNone">None</button>
    <button class="btn-sm" data-act="requestScan">↺</button>
  </div>
  <div class="tree-scroll" id="treeScroll">
    <div class="tree-loading">Loading file tree…</div>
  </div>
  <div class="picker-summary" id="pickerSummary"></div>

  <!-- Save preset area -->
  <div class="preset-save-area">
    <div class="preset-save-form" id="savePresetForm">
      <input class="preset-name-input" id="presetNameInput" type="text" placeholder="Preset name…" maxlength="40">
      <button class="btn-sm" data-act="confirmSavePreset">Save</button>
      <button class="btn-sm" data-act="cancelSavePreset">✕</button>
    </div>
    <button class="btn-sm" id="savePresetBtn" data-act="showSavePreset" style="margin-top:4px">💾 Save Preset <span class="pro-tag" style="font-size:8px;background:linear-gradient(135deg,#f7b733,#e07b39);color:#fff;padding:1px 4px;border-radius:6px;font-weight:800;vertical-align:middle;">PRO</span></button>
  </div>
</div>

<!-- Prompt Template -->
<div class="section">
  <div class="section-label">Prompt Template</div>
  <select id="promptSelect">
    <option value="">— No prompt (paste only) —</option>
    <option value="review">Review this code for bugs, security issues, and improvements</option>
    <option value="explain">Explain what this codebase does and how it's structured</option>
    <option value="bugs">Find all bugs and potential issues in this code</option>
    <option value="tests">Write comprehensive unit tests for this code</option>
    <option value="docs">Add JSDoc documentation to all functions and classes</option>
    <option value="refactor">Suggest refactoring improvements for readability and performance</option>
    <option value="custom">✏️ Custom prompt…</option>
  </select>
  <textarea id="customPrompt" placeholder="Type your prompt here…"></textarea>
</div>

<!-- Output Format -->
<div class="section">
  <div class="section-label">Output Format</div>
  <select id="formatSelect">
    <option value="standard">Standard — plain text with headers</option>
    <option value="xml">Claude XML — structured tags (best for Claude)</option>
    <option value="compact">Compact — strip comments, save ~20% tokens</option>
    <option value="minimal">Minimal — short headers + strip comments (max token savings)</option>
  </select>
</div>

<!-- Target AI Window -->
<div class="section">
  <div class="section-label">Fit to AI Window <span class="pro-tag" style="font-size:9px;background:linear-gradient(135deg,#f7b733,#e07b39);color:#fff;padding:1px 5px;border-radius:8px;font-weight:800;vertical-align:middle;">PRO</span></div>
  <select id="windowSelect">
    <option value="0">No limit (bundle all selected)</option>
    <option value="27000">ChatGPT Free — 27K (instant models)</option>
    <option value="54000">ChatGPT Plus / Go / Business — 54K (instant)</option>
    <option value="256000">ChatGPT Plus / Business — 256K (thinking models)</option>
    <option value="128000">ChatGPT Pro — 128K (instant)</option>
    <option value="400000">ChatGPT Pro — 400K (thinking)</option>
    <option value="200000">Claude — 200K (safe for any model or plan)</option>
    <option value="500000">Claude Pro — 500K (Fable 5, Opus 4.x, Sonnet 4.6)</option>
    <option value="1000000">Claude Pro — 1M (Fable 5.1, Opus 5/5.5, Sonnet 5/5.5, Haiku 5.5)</option>
    <option value="32000">Gemini Free — 32K</option>
    <option value="128000">Gemini AI Plus — 128K</option>
    <option value="1000000">Gemini AI Pro / Ultra — 1M</option>
    <option value="1000000">DeepSeek V4 (free web chat) — 1M</option>
  </select>
  <div class="hint">Long pastes turn into an attachment in ChatGPT and Claude. That is normal; the model still reads all of it.</div>
</div>

<!-- Project Notes (Context Memory) -->
<div class="section">
  <div class="section-label">Project Notes</div>
  <textarea id="projectNotes" placeholder="Persistent context for AI — e.g. 'Auth uses JWT. DB is Postgres. Main API in src/api/'"></textarea>
  <div class="notes-footer">
    <label><input type="checkbox" id="includeCtx"> Include in every bundle</label>
    <button class="btn-sm" data-act="saveContext">💾 Save <span class="save-ok" id="saveOk">✓ Saved</span></button>
  </div>
</div>

<!-- Upgrade Banner (shown when freemium gate fires) -->
<div class="upgrade-banner" id="upgradeBanner">
  <p id="upgradeMsg">⚡ <strong>Pro feature</strong> — Free tier is limited to 50 files.<br>
  Upgrade for unlimited files, presets, and git diff mode.</p>
  <button class="btn-upgrade" data-act="openUrl" data-arg="https://sendtoai.lemonsqueezy.com/checkout/buy/e8764352-b784-409e-8d59-c44fd9aad90c">Upgrade to Pro →</button>
  <button class="btn-upgrade" style="margin-top:6px;background:#444;" data-act="send" data-arg="enterLicenseKey">Already have a key? Activate it →</button>
</div>

<!-- Bundle Button -->
<button class="btn-bundle" id="bundleBtn" data-act="doBundle">
  <span id="btnIcon">📦</span>
  <span id="btnLabel">Bundle to Clipboard</span>
  <span id="shortcutHint" style="font-size:10px;font-weight:400;opacity:0.7">Ctrl+Alt+A</span>
</button>

<!-- Smart actions (editor-native — what web bundlers can't do) -->
<div class="ai-row" style="margin-top:6px;">
  <button class="btn-ai" style="background:#3a3a5a;" data-act="send" data-arg="bundleErrors" title="Bundle every file with an error/warning + the exact messages, ready to paste into your AI">🐛 Bundle Errors</button>
  <button class="btn-ai" style="background:#3a5a3a;" data-act="send" data-arg="applyResponse" title="Paste the AI's reply, then apply its code edits straight to your files (undoable)">📥 Apply AI Reply</button>
</div>

<!-- AI Quick Open -->
<div class="ai-row">
  <button class="btn-ai claude"  data-act="openUrl" data-arg="https://claude.ai">Claude ↗</button>
  <button class="btn-ai chatgpt" data-act="openUrl" data-arg="https://chatgpt.com">ChatGPT ↗</button>
  <button class="btn-ai gemini"  data-act="openUrl" data-arg="https://gemini.google.com">Gemini ↗</button>
</div>

<!-- Pro activation row -->
<div id="activateRow" style="text-align:center;margin-bottom:8px;">
  <span style="font-size:10px;color:var(--vscode-descriptionForeground);">Have a Pro license? </span>
  <a href="#" style="font-size:10px;color:#e07b39;text-decoration:none;" data-act="send" data-arg="enterLicenseKey">Activate it here →</a>
</div>

<div class="divider"></div>

<!-- Stats (shown after first bundle) -->
<div id="stats">
  <div class="project-name" id="projName"></div>
  <div class="stat-card">
    <div class="stat-row"><span class="stat-lbl">Files included</span><span class="stat-val" id="fc">—</span></div>
    <div class="stat-row"><span class="stat-lbl">Files ignored</span><span class="stat-val" id="ic">—</span></div>
    <div class="stat-row"><span class="stat-lbl">Est. tokens</span><span class="stat-val" id="tk">—</span></div>
    <div class="hint" id="trimNote"></div>
  </div>
  <div class="progress-wrap">
    <div class="ctx-row"><span class="ctx-lbl">ChatGPT Free</span><span class="ctx-limit">27K</span><span class="ctx-pct" id="pctGptFree">0%</span></div>
    <div class="bar-bg"><div class="bar-fill" id="barGptFree" style="width:0%"></div></div>
    <div class="ctx-row"><span class="ctx-lbl">ChatGPT Plus</span><span class="ctx-limit">54K</span><span class="ctx-pct" id="pctGptPlus">0%</span></div>
    <div class="bar-bg"><div class="bar-fill" id="barGptPlus" style="width:0%"></div></div>
    <div class="ctx-row"><span class="ctx-lbl">Claude</span><span class="ctx-limit">200K</span><span class="ctx-pct" id="pctClaude">0%</span></div>
    <div class="bar-bg"><div class="bar-fill" id="barClaude" style="width:0%"></div></div>
    <div class="ctx-row"><span class="ctx-lbl">Gemini Free</span><span class="ctx-limit">32K</span><span class="ctx-pct" id="pctGemini">0%</span></div>
    <div class="bar-bg"><div class="bar-fill" id="barGemini" style="width:0%"></div></div>
    <div class="ctx-row"><span class="ctx-lbl">Claude / Gemini paid</span><span class="ctx-limit">1M</span><span class="ctx-pct" id="pctPaid">0%</span></div>
    <div class="bar-bg"><div class="bar-fill" id="barPaid" style="width:0%"></div></div>
  </div>
  <div class="cost-card">
    <div class="cost-title">Cost per send</div>
    <div class="stat-row"><span class="stat-lbl">Haiku 5.5</span><span class="stat-val" id="ch">—</span></div>
    <div class="stat-row"><span class="stat-lbl">Sonnet 5.5</span><span class="stat-val" id="cs">—</span></div>
    <div class="stat-row"><span class="stat-lbl">Opus 5.5</span><span class="stat-val" id="co">—</span></div>
  </div>
  <div id="typeWrap" style="margin-bottom:8px">
    <div class="section-label">File types</div>
    <div class="types-wrap" id="typePills"></div>
  </div>
  <div id="warnBox" style="display:none" class="warn">⚠️ Large bundle — ChatGPT and Claude attach pastes over ~5K characters as a file; 1M context needs a paid Claude (Sonnet/Opus 5.x) or Gemini AI Pro plan, or use Fit to AI Window</div>
  <button class="btn-copy" data-act="send" data-arg="copyAgain">📋 Copy Again</button>
  <button class="btn-copy" data-act="send" data-arg="saveBundle" title="Save the last bundle as a .txt to attach in your AI chat">💾 Save as .txt</button>
  <p class="timestamp" id="ts"></p>
</div>

<p class="shortcut"><kbd>Ctrl+Alt+A</kbd> / <kbd>⌘+Alt+A</kbd></p>

<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}
