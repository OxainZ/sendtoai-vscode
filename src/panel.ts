import * as vscode from 'vscode';
import { BundleResult, FileNode } from './bundler';
import { CostEstimate } from './costEstimator';

export type BundleMode   = 'project' | 'tabs' | 'git';
export type OutputFormat = 'standard' | 'xml' | 'compact';

export interface PanelRequest {
  mode:           BundleMode;
  format:         OutputFormat;
  prompt:         string;
  selectedPaths?: Set<string>;
  notes?:         string;
  includeContext: boolean;
}

export class SendToAIPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sendtoai.panel';

  private _view?: vscode.WebviewView;
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
  public showUpgradePrompt(): void {
    this._view?.webview.postMessage({ command: 'showUpgrade' });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
    webviewView.webview.html = this._html();

    webviewView.webview.onDidReceiveMessage((msg: {
      command: string;
      url?: string;
      mode?: BundleMode;
      format?: OutputFormat;
      prompt?: string;
      selectedPaths?: string[];
      notes?: string;
      includeContext?: boolean;
      presetName?: string;
      presetPaths?: string[];
    }) => {
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
          });
          break;
        case 'copyAgain':
          if (this._lastBundle) {
            vscode.env.clipboard.writeText(this._lastBundle).then(() => {
              vscode.window.showInformationMessage('✅ Copied again — paste into your AI chat!');
            });
          }
          break;
        case 'openUrl':
          if (msg.url) { vscode.env.openExternal(vscode.Uri.parse(msg.url)); }
          break;
      }
    });
  }

  public updateStats(result: BundleResult, cost: CostEstimate): void {
    this._lastBundle = result.bundle;
    this._view?.webview.postMessage({
      command:       'stats',
      folderName:    result.folderName,
      fileCount:     result.fileCount,
      ignoredCount:  result.ignoredCount,
      tokenEstimate: result.tokenEstimate,
      haiku:         cost.haiku,
      sonnet:        cost.sonnet,
      opus:          cost.opus,
      fileTypes:     result.fileTypes,
      timestamp:     new Date().toLocaleTimeString(),
    });
  }

  public updateTree(nodes: FileNode): void {
    this._view?.webview.postMessage({ command: 'scanResult', tree: nodes });
  }

  public setBusy(busy: boolean): void {
    this._view?.webview.postMessage({ command: busy ? 'busy' : 'idle' });
  }

  private _html(): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    padding: 12px;
    font-family: var(--vscode-font-family);
    font-size: 12px;
    color: var(--vscode-foreground);
    background: transparent;
    line-height: 1.5;
  }

  /* ── Header ── */
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .logo { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 5px; }
  .logo-icon { color: #e07b39; font-size: 16px; }
  .tagline { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 1px; }

  /* ── Sections ── */
  .section { margin-bottom: 10px; }
  .section-label {
    font-size: 10px; font-weight: 700; letter-spacing: 0.6px;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase; margin-bottom: 5px;
  }

  /* ── Mode tabs ── */
  .mode-tabs { display: flex; gap: 4px; }
  .mode-tab {
    flex: 1; padding: 5px 4px; border: 1px solid var(--vscode-button-secondaryBackground);
    border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 600;
    font-family: inherit; background: transparent; color: var(--vscode-descriptionForeground);
    transition: all 0.15s;
  }
  .mode-tab:hover { border-color: #e07b39; color: var(--vscode-foreground); }
  .mode-tab.active { background: #e07b39; border-color: #e07b39; color: #fff; }

  /* ── File picker ── */
  #pickerSection { margin-bottom: 10px; display: none; }
  #pickerSection.show { display: block; }

  .picker-toolbar {
    display: flex; align-items: center; gap: 4px; margin-bottom: 5px;
  }
  .picker-lbl {
    flex: 1; font-size: 10px; color: var(--vscode-descriptionForeground);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .btn-sm {
    padding: 2px 7px; border: 1px solid var(--vscode-button-secondaryBackground);
    border-radius: 3px; cursor: pointer; font-size: 10px; font-weight: 600;
    font-family: inherit; background: transparent; color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }
  .btn-sm:hover { border-color: #e07b39; color: var(--vscode-foreground); }

  .tree-scroll {
    max-height: 240px; overflow-y: auto;
    border: 1px solid var(--vscode-input-border, var(--vscode-button-secondaryBackground));
    border-radius: 4px; background: var(--vscode-input-background); padding: 3px 0;
  }
  .tree-row {
    display: flex; align-items: center; gap: 3px;
    padding: 2px 4px; cursor: default; user-select: none;
    font-size: 11px; line-height: 1.6; min-width: 0;
  }
  .tree-row:hover { background: var(--vscode-list-hoverBackground); }
  .tree-row input[type=checkbox] {
    flex-shrink: 0; cursor: pointer; accent-color: #e07b39; width: 12px; height: 12px;
  }
  .dir-toggle {
    flex-shrink: 0; width: 12px; text-align: center;
    font-size: 9px; color: var(--vscode-descriptionForeground); cursor: pointer;
  }
  .node-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
  .tok-badge {
    flex-shrink: 0; font-size: 9px; color: var(--vscode-descriptionForeground);
    opacity: 0.65; margin-left: 2px;
  }
  .tree-loading {
    padding: 10px; font-size: 11px; text-align: center;
    color: var(--vscode-descriptionForeground);
  }
  .picker-summary {
    font-size: 10px; color: var(--vscode-descriptionForeground);
    text-align: right; margin-top: 4px;
  }
  .picker-summary strong { color: var(--vscode-foreground); }

  /* ── Preset bar ── */
  .preset-bar { display: flex; gap: 4px; margin-bottom: 6px; align-items: center; }
  .preset-bar select { flex: 1; }
  .preset-save-area { margin-top: 5px; }
  .preset-save-form {
    display: none; flex-direction: row; gap: 4px; align-items: center; margin-top: 4px;
  }
  .preset-save-form.show { display: flex; }
  .preset-name-input {
    flex: 1; padding: 3px 6px; border-radius: 3px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-button-secondaryBackground));
    font-family: inherit; font-size: 10px;
  }
  .preset-name-input:focus { outline: 1px solid #e07b39; }

  /* ── Select dropdowns ── */
  select {
    width: 100%; padding: 5px 8px; border-radius: 4px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-button-secondaryBackground));
    font-family: inherit; font-size: 11px; cursor: pointer; appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 8px center; padding-right: 24px;
  }
  select:focus { outline: 1px solid #e07b39; }

  /* ── Prompt area ── */
  #customPrompt {
    display: none; width: 100%; margin-top: 5px; padding: 6px 8px; border-radius: 4px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-button-secondaryBackground));
    font-family: inherit; font-size: 11px; resize: vertical; min-height: 52px;
  }
  #customPrompt:focus { outline: 1px solid #e07b39; }

  /* ── Main button ── */
  .btn-bundle {
    width: 100%; padding: 8px 12px; background: #e07b39; color: #fff;
    border: none; border-radius: 5px; cursor: pointer; font-size: 13px; font-weight: 700;
    font-family: inherit; letter-spacing: 0.2px;
    display: flex; align-items: center; justify-content: center; gap: 7px;
    transition: background 0.15s; margin-bottom: 8px;
  }
  .btn-bundle:hover { background: #c96a2e; }
  .btn-bundle:disabled { background: var(--vscode-button-secondaryBackground); color: var(--vscode-descriptionForeground); cursor: not-allowed; }

  /* ── Upgrade banner ── */
  .upgrade-banner {
    background: rgba(224,123,57,0.12);
    border: 1px solid rgba(224,123,57,0.45);
    border-radius: 5px; padding: 9px 11px; margin-bottom: 10px;
    font-size: 11px; color: var(--vscode-foreground); display: none;
  }
  .upgrade-banner.show { display: block; }
  .upgrade-banner p { margin-bottom: 7px; line-height: 1.5; }
  .btn-upgrade {
    width: 100%; padding: 6px 10px; background: #e07b39; color: #fff;
    border: none; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 700;
    font-family: inherit;
  }
  .btn-upgrade:hover { background: #c96a2e; }

  /* ── AI quick-open row ── */
  .ai-row { display: flex; gap: 4px; margin-bottom: 10px; }
  .btn-ai {
    flex: 1; padding: 5px 4px; border: none; border-radius: 4px;
    cursor: pointer; font-size: 10px; font-weight: 600; font-family: inherit;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground); transition: opacity 0.15s;
  }
  .btn-ai:hover { opacity: 0.8; }
  .btn-ai.claude  { background: rgba(210,109,47,0.15); color: #e07b39; }
  .btn-ai.chatgpt { background: rgba(16,163,127,0.15); color: #10a37f; }
  .btn-ai.gemini  { background: rgba(66,133,244,0.15); color: #4285f4; }

  /* ── Divider ── */
  .divider { height: 1px; background: var(--vscode-widget-border, var(--vscode-button-secondaryBackground)); margin: 10px 0; opacity: 0.5; }

  /* ── Stats card ── */
  #stats { display: none; }
  #stats.show { display: block; }
  .project-name { font-size: 12px; font-weight: 700; color: #e07b39; margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stat-card { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 5px; padding: 9px 11px; margin-bottom: 8px; }
  .stat-row { display: flex; justify-content: space-between; padding: 2px 0; font-size: 11px; }
  .stat-lbl { color: var(--vscode-descriptionForeground); }
  .stat-val { font-weight: 600; }
  .progress-wrap { margin-bottom: 8px; }
  .progress-meta { display: flex; justify-content: space-between; font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
  .bar-bg { height: 5px; border-radius: 3px; background: var(--vscode-editor-inactiveSelectionBackground); overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s, background 0.4s; }
  .cost-card { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 5px; padding: 9px 11px; margin-bottom: 8px; }
  .cost-title { font-size: 10px; font-weight: 700; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); text-transform: uppercase; margin-bottom: 5px; }
  .types-wrap { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
  .type-pill { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 10px; padding: 2px 7px; font-size: 10px; color: var(--vscode-descriptionForeground); }
  .btn-copy { width: 100%; padding: 6px 10px; border: none; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 600; font-family: inherit; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-copy:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .timestamp { font-size: 10px; color: var(--vscode-descriptionForeground); text-align: center; margin-top: 5px; opacity: 0.6; }
  .warn { font-size: 11px; color: #e0a039; background: rgba(224,160,57,0.12); border: 1px solid rgba(224,160,57,0.25); border-radius: 4px; padding: 6px 9px; margin-bottom: 8px; }
  .shortcut { font-size: 10px; color: var(--vscode-descriptionForeground); text-align: center; margin-top: 8px; opacity: 0.6; }
  kbd { background: var(--vscode-editor-inactiveSelectionBackground); padding: 1px 5px; border-radius: 3px; font-family: monospace; font-size: 9px; }

  /* ── Project notes ── */
  #projectNotes {
    width: 100%; padding: 6px 8px; border-radius: 4px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-button-secondaryBackground));
    font-family: inherit; font-size: 11px; resize: vertical; min-height: 56px;
  }
  #projectNotes:focus { outline: 1px solid #e07b39; }
  #projectNotes::placeholder { opacity: 0.5; }
  .notes-footer {
    display: flex; align-items: center; gap: 6px; margin-top: 5px;
  }
  .notes-footer label {
    flex: 1; display: flex; align-items: center; gap: 5px; cursor: pointer;
    font-size: 10px; color: var(--vscode-descriptionForeground);
  }
  .notes-footer label input { accent-color: #e07b39; cursor: pointer; }
  .save-ok { font-size: 10px; color: #4caf80; opacity: 0; transition: opacity 0.3s; }
  .save-ok.show { opacity: 1; }

  /* ── Spinner ── */
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; border-radius: 50%; animation: spin 0.7s linear infinite; }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div>
    <div class="logo"><span class="logo-icon">⚡</span> SendToAI</div>
    <div class="tagline">Bundle project → paste into any AI</div>
  </div>
</div>

<!-- Mode -->
<div class="section">
  <div class="section-label">Bundle Mode</div>
  <div class="mode-tabs">
    <button class="mode-tab active" data-mode="project" onclick="setMode('project')">📦 Project</button>
    <button class="mode-tab" data-mode="tabs" onclick="setMode('tabs')">📄 Open Tabs</button>
    <button class="mode-tab" data-mode="git" onclick="setMode('git')">🔀 Git Changes</button>
  </div>
</div>

<!-- File Picker (shown in Full Project mode only) -->
<div id="pickerSection" class="show">
  <div class="section-label">Files</div>

  <!-- Preset dropdown -->
  <div class="preset-bar">
    <select id="presetSelect" onchange="onPresetChange()" style="width:auto;flex:1">
      <option value="">— Load a preset —</option>
    </select>
    <button class="btn-sm" id="deletePresetBtn" onclick="deletePreset()" title="Delete preset" style="display:none">🗑</button>
  </div>

  <div class="picker-toolbar">
    <span class="picker-lbl" id="pickerLabel">Scanning…</span>
    <button class="btn-sm" onclick="pickerAll()">All</button>
    <button class="btn-sm" onclick="pickerNone()">None</button>
    <button class="btn-sm" onclick="requestScan()">↺</button>
  </div>
  <div class="tree-scroll" id="treeScroll">
    <div class="tree-loading">Loading file tree…</div>
  </div>
  <div class="picker-summary" id="pickerSummary"></div>

  <!-- Save preset area -->
  <div class="preset-save-area">
    <div class="preset-save-form" id="savePresetForm">
      <input class="preset-name-input" id="presetNameInput" type="text" placeholder="Preset name…" maxlength="40"
             onkeydown="if(event.key==='Enter')confirmSavePreset();if(event.key==='Escape')cancelSavePreset();">
      <button class="btn-sm" onclick="confirmSavePreset()">Save</button>
      <button class="btn-sm" onclick="cancelSavePreset()">✕</button>
    </div>
    <button class="btn-sm" id="savePresetBtn" onclick="showSavePreset()" style="margin-top:4px">💾 Save Preset</button>
  </div>
</div>

<!-- Prompt Template -->
<div class="section">
  <div class="section-label">Prompt Template</div>
  <select id="promptSelect" onchange="onPromptChange()">
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
  </select>
</div>

<!-- Project Notes (Context Memory) -->
<div class="section">
  <div class="section-label">Project Notes</div>
  <textarea id="projectNotes" placeholder="Persistent context for AI — e.g. 'Auth uses JWT. DB is Postgres. Main API in src/api/'"></textarea>
  <div class="notes-footer">
    <label><input type="checkbox" id="includeCtx"> Include in every bundle</label>
    <button class="btn-sm" onclick="saveContext()">💾 Save <span class="save-ok" id="saveOk">✓ Saved</span></button>
  </div>
</div>

<!-- Upgrade Banner (shown when freemium gate fires) -->
<div class="upgrade-banner" id="upgradeBanner">
  <p>⚡ <strong>Pro feature</strong> — Free tier is limited to 50 files.<br>
  Upgrade for unlimited files, presets, and git diff mode.</p>
  <button class="btn-upgrade" onclick="openUrl('https://sendtoai.dev/pro')">Upgrade at sendtoai.dev/pro →</button>
</div>

<!-- Bundle Button -->
<button class="btn-bundle" id="bundleBtn" onclick="doBundle()">
  <span id="btnIcon">📦</span>
  <span id="btnLabel">Bundle to Clipboard</span>
  <span id="shortcutHint" style="font-size:10px;font-weight:400;opacity:0.7">Ctrl+Shift+A</span>
</button>

<!-- AI Quick Open -->
<div class="ai-row">
  <button class="btn-ai claude"  onclick="openUrl('https://claude.ai')">Claude ↗</button>
  <button class="btn-ai chatgpt" onclick="openUrl('https://chatgpt.com')">ChatGPT ↗</button>
  <button class="btn-ai gemini"  onclick="openUrl('https://gemini.google.com')">Gemini ↗</button>
</div>

<div class="divider"></div>

<!-- Stats (shown after first bundle) -->
<div id="stats">
  <div class="project-name" id="projName"></div>
  <div class="stat-card">
    <div class="stat-row"><span class="stat-lbl">Files included</span><span class="stat-val" id="fc">—</span></div>
    <div class="stat-row"><span class="stat-lbl">Files ignored</span><span class="stat-val" id="ic">—</span></div>
    <div class="stat-row"><span class="stat-lbl">Est. tokens</span><span class="stat-val" id="tk">—</span></div>
  </div>
  <div class="progress-wrap">
    <div class="progress-meta"><span>Claude 200k context</span><span id="pctLabel">0%</span></div>
    <div class="bar-bg"><div class="bar-fill" id="bar" style="width:0%;background:#4caf80"></div></div>
  </div>
  <div class="cost-card">
    <div class="cost-title">Cost per send</div>
    <div class="stat-row"><span class="stat-lbl">Haiku 4.5</span><span class="stat-val" id="ch">—</span></div>
    <div class="stat-row"><span class="stat-lbl">Sonnet 4.6</span><span class="stat-val" id="cs">—</span></div>
    <div class="stat-row"><span class="stat-lbl">Opus 4.6</span><span class="stat-val" id="co">—</span></div>
  </div>
  <div id="typeWrap" style="margin-bottom:8px">
    <div class="section-label">File types</div>
    <div class="types-wrap" id="typePills"></div>
  </div>
  <div id="warnBox" style="display:none" class="warn">⚠️ Large bundle — consider Sonnet 4.6 or Opus (support 1M context)</div>
  <button class="btn-copy" onclick="send('copyAgain')">📋 Copy Again</button>
  <p class="timestamp" id="ts"></p>
</div>

<p class="shortcut"><kbd>Ctrl+Shift+A</kbd> / <kbd>⌘+Shift+A</kbd></p>

<script>
  const vscode = acquireVsCodeApi();
  let currentMode = 'project';

  // ── Core helpers ──────────────────────────────────────────────────────────────
  function send(cmd, extra) { vscode.postMessage({ command: cmd, ...extra }); }
  function openUrl(url)      { vscode.postMessage({ command: 'openUrl', url }); }

  // ── Mode switching ─────────────────────────────────────────────────────────────
  function setMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.mode-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.mode === mode);
    });
    const picker = document.getElementById('pickerSection');
    if (mode === 'project') {
      picker.classList.add('show');
      if (!treeBuilt) { requestScan(); }
    } else {
      picker.classList.remove('show');
    }
  }

  function onPromptChange() {
    const val = document.getElementById('promptSelect').value;
    document.getElementById('customPrompt').style.display = val === 'custom' ? 'block' : 'none';
  }

  function getPromptText() {
    const val = document.getElementById('promptSelect').value;
    if (!val)             { return ''; }
    if (val === 'custom') { return document.getElementById('customPrompt').value.trim(); }
    return document.getElementById('promptSelect').selectedOptions[0].text;
  }

  function getFormat() { return document.getElementById('formatSelect').value; }

  function doBundle() {
    // Hide any previous upgrade banner when user tries again
    document.getElementById('upgradeBanner').classList.remove('show');
    const notes          = document.getElementById('projectNotes').value.trim();
    const includeContext = document.getElementById('includeCtx').checked;
    const extra = { mode: currentMode, format: getFormat(), prompt: getPromptText(), notes, includeContext };
    if (currentMode === 'project' && treeBuilt) {
      extra.selectedPaths = getSelectedPaths();
    }
    send('bundle', extra);
  }

  function saveContext() {
    const notes = document.getElementById('projectNotes').value.trim();
    send('saveContext', { notes });
  }

  // ── File-tree state ────────────────────────────────────────────────────────────
  let treeData   = null;
  let treeBuilt  = false;
  const collapsed = new Set();   // dir paths that are collapsed
  const checked   = new Set();   // file paths that are checked

  function requestScan() {
    treeBuilt = false;
    document.getElementById('treeScroll').innerHTML =
      '<div class="tree-loading">Scanning project…</div>';
    document.getElementById('pickerLabel').textContent = 'Scanning…';
    document.getElementById('pickerSummary').textContent = '';
    send('requestScan');
  }

  function getSelectedPaths() { return [...checked]; }

  // ── Tree helpers ───────────────────────────────────────────────────────────────
  function fmtTok(n) {
    if (!n) { return ''; }
    return n >= 1000 ? '~' + (n / 1000).toFixed(1) + 'k' : '~' + n;
  }

  function fileDescendants(node) {
    const paths = [];
    (function walk(n) {
      if (!n.isDir) { paths.push(n.path); return; }
      for (const c of n.children) { walk(c); }
    })(node);
    return paths;
  }

  function totalFileCount(node) {
    if (!node.isDir) { return 1; }
    let n = 0;
    for (const c of node.children) { n += totalFileCount(c); }
    return n;
  }

  function selectedTokenSum() {
    let t = 0;
    (function walk(n) {
      if (!n.isDir) { if (checked.has(n.path)) { t += (n.tokenEst || 0); } return; }
      for (const c of n.children) { walk(c); }
    })(treeData);
    return t;
  }

  function updateSummary() {
    const sel   = checked.size;
    const total = treeData ? totalFileCount(treeData) : 0;
    const toks  = selectedTokenSum();
    const tkStr = toks >= 1000 ? '~' + (toks / 1000).toFixed(1) + 'k' : '~' + toks;
    document.getElementById('pickerLabel').textContent =
      sel + ' / ' + total + ' files';
    document.getElementById('pickerSummary').innerHTML =
      '<strong>' + sel + '</strong> files &nbsp;·&nbsp; <strong>' + tkStr + '</strong> est. tokens';
  }

  // ── Tree rendering ─────────────────────────────────────────────────────────────
  function buildRows(node, depth, rows) {
    if (node.path === '') {
      // Root: render children only
      for (const c of node.children) { buildRows(c, 0, rows); }
      return;
    }
    rows.push({ node, depth });
    if (node.isDir && !collapsed.has(node.path)) {
      for (const c of node.children) { buildRows(c, depth + 1, rows); }
    }
  }

  function renderTree() {
    if (!treeData) { return; }
    const rows = [];
    buildRows(treeData, 0, rows);

    const scroll = document.getElementById('treeScroll');
    scroll.innerHTML = '';

    for (const { node, depth } of rows) {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.style.paddingLeft = (4 + depth * 14) + 'px';

      if (node.isDir) {
        const toggle = document.createElement('span');
        toggle.className = 'dir-toggle';
        toggle.textContent = collapsed.has(node.path) ? '▶' : '▼';
        row.appendChild(toggle);

        // Dir checkbox = tri-state (all/some/none children checked)
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        const descs = fileDescendants(node);
        const allChk  = descs.length > 0 && descs.every(p => checked.has(p));
        const someChk = descs.some(p => checked.has(p));
        cb.checked       = allChk;
        cb.indeterminate = !allChk && someChk;
        cb.addEventListener('change', () => {
          descs.forEach(p => cb.checked ? checked.add(p) : checked.delete(p));
          renderTree();
          updateSummary();
        });
        row.appendChild(cb);

        const name = document.createElement('span');
        name.className = 'node-name';
        name.textContent = '📁 ' + node.name + '/';
        row.appendChild(name);

        const badge = document.createElement('span');
        badge.className = 'tok-badge';
        badge.textContent = fmtTok(node.tokenEst);
        row.appendChild(badge);

        // Clicking anywhere else on the row toggles collapse
        row.addEventListener('click', e => {
          if (e.target === cb) { return; }
          collapsed.has(node.path) ? collapsed.delete(node.path) : collapsed.add(node.path);
          toggle.textContent = collapsed.has(node.path) ? '▶' : '▼';
          renderTree();
        });
        row.style.cursor = 'pointer';

      } else {
        // Spacer to align with dir toggle
        const spacer = document.createElement('span');
        spacer.className = 'dir-toggle';
        row.appendChild(spacer);

        const cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.checked = checked.has(node.path);
        cb.addEventListener('change', () => {
          cb.checked ? checked.add(node.path) : checked.delete(node.path);
          updateSummary();
          // Re-render only to update parent dir tri-state
          renderTree();
        });
        row.appendChild(cb);

        const name = document.createElement('span');
        name.className = 'node-name';
        name.textContent = node.name;
        row.appendChild(name);

        const badge = document.createElement('span');
        badge.className = 'tok-badge';
        badge.textContent = fmtTok(node.tokenEst);
        row.appendChild(badge);
      }

      scroll.appendChild(row);
    }
  }

  // ── Picker controls ────────────────────────────────────────────────────────────
  function pickerAll() {
    if (!treeData) { return; }
    fileDescendants(treeData).forEach(p => checked.add(p));
    renderTree();
    updateSummary();
  }

  function pickerNone() {
    checked.clear();
    renderTree();
    updateSummary();
  }

  // ── Named presets ──────────────────────────────────────────────────────────────
  let presets = []; // [{ name, paths }]

  function onPresetChange() {
    const sel = document.getElementById('presetSelect').value;
    document.getElementById('deletePresetBtn').style.display = sel ? '' : 'none';
    if (!sel) { return; }
    const preset = presets.find(p => p.name === sel);
    if (!preset) { return; }
    checked.clear();
    preset.paths.forEach(p => checked.add(p));
    renderTree();
    updateSummary();
  }

  function showSavePreset() {
    document.getElementById('savePresetForm').classList.add('show');
    document.getElementById('savePresetBtn').style.display = 'none';
    document.getElementById('presetNameInput').focus();
  }

  function cancelSavePreset() {
    document.getElementById('savePresetForm').classList.remove('show');
    document.getElementById('savePresetBtn').style.display = '';
    document.getElementById('presetNameInput').value = '';
  }

  function confirmSavePreset() {
    const name = document.getElementById('presetNameInput').value.trim();
    if (!name) { return; }
    send('savePreset', { presetName: name, presetPaths: [...checked] });
    cancelSavePreset();
  }

  function deletePreset() {
    const sel = document.getElementById('presetSelect').value;
    if (!sel) { return; }
    send('deletePreset', { presetName: sel });
  }

  // ── Auto-scan and load context/presets on startup ──────────────────────────────
  requestScan();
  send('loadContext');
  send('loadPresets');

  // ── Message handler ────────────────────────────────────────────────────────────
  window.addEventListener('message', ({ data: d }) => {
    if (d.command === 'busy') {
      const btn = document.getElementById('bundleBtn');
      btn.disabled = true;
      document.getElementById('btnIcon').innerHTML = '<span class="spinner"></span>';
      document.getElementById('btnLabel').textContent = 'Bundling…';
      document.getElementById('shortcutHint').style.display = 'none';
      return;
    }
    if (d.command === 'idle') {
      const btn = document.getElementById('bundleBtn');
      btn.disabled = false;
      document.getElementById('btnIcon').textContent = '📦';
      document.getElementById('btnLabel').textContent = 'Bundle to Clipboard';
      document.getElementById('shortcutHint').style.display = '';
      return;
    }
    if (d.command === 'showUpgrade') {
      // Re-enable button and show banner
      const btn = document.getElementById('bundleBtn');
      btn.disabled = false;
      document.getElementById('btnIcon').textContent = '📦';
      document.getElementById('btnLabel').textContent = 'Bundle to Clipboard';
      document.getElementById('shortcutHint').style.display = '';
      document.getElementById('upgradeBanner').classList.add('show');
      document.getElementById('upgradeBanner').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    if (d.command === 'contextLoaded') {
      document.getElementById('projectNotes').value = d.notes || '';
      return;
    }
    if (d.command === 'contextSaved') {
      const badge = document.getElementById('saveOk');
      badge.classList.add('show');
      setTimeout(() => badge.classList.remove('show'), 2000);
      return;
    }
    if (d.command === 'presetsLoaded') {
      presets = d.presets || [];
      const sel = document.getElementById('presetSelect');
      const current = sel.value;
      sel.innerHTML = '<option value="">— Load a preset —</option>';
      presets.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name;
        sel.appendChild(opt);
      });
      // Restore selection if preset still exists
      if (presets.find(p => p.name === current)) { sel.value = current; }
      document.getElementById('deletePresetBtn').style.display = sel.value ? '' : 'none';
      return;
    }
    if (d.command === 'scanResult') {
      treeData  = d.tree;
      treeBuilt = true;
      // Default: select all files
      checked.clear();
      fileDescendants(treeData).forEach(p => checked.add(p));
      renderTree();
      updateSummary();
      return;
    }
    if (d.command !== 'stats') { return; }

    document.getElementById('projName').textContent = '📁 ' + d.folderName;
    document.getElementById('fc').textContent = d.fileCount.toLocaleString();
    document.getElementById('ic').textContent = d.ignoredCount.toLocaleString();
    document.getElementById('tk').textContent = '~' + (d.tokenEstimate >= 1000
      ? (d.tokenEstimate / 1000).toFixed(1) + 'k'
      : d.tokenEstimate.toLocaleString());
    document.getElementById('ch').textContent = d.haiku;
    document.getElementById('cs').textContent = d.sonnet;
    document.getElementById('co').textContent = d.opus;
    document.getElementById('ts').textContent = 'Last bundled ' + d.timestamp;

    const pct = Math.min((d.tokenEstimate / 200000) * 100, 100);
    const bar = document.getElementById('bar');
    bar.style.width = pct + '%';
    bar.style.background = pct < 50 ? '#4caf80' : pct < 85 ? '#e0a039' : '#e05c5c';
    document.getElementById('pctLabel').textContent = pct.toFixed(1) + '%';

    const pills = document.getElementById('typePills');
    pills.innerHTML = '';
    if (d.fileTypes && Object.keys(d.fileTypes).length) {
      const sorted = Object.entries(d.fileTypes).sort((a,b) => b[1] - a[1]).slice(0, 8);
      for (const [ext, count] of sorted) {
        const pill = document.createElement('span');
        pill.className = 'type-pill';
        pill.textContent = ext + ' ' + count;
        pills.appendChild(pill);
      }
      document.getElementById('typeWrap').style.display = 'block';
    } else {
      document.getElementById('typeWrap').style.display = 'none';
    }

    document.getElementById('warnBox').style.display = d.tokenEstimate > 180000 ? 'block' : 'none';
    document.getElementById('stats').classList.add('show');
  });
</script>
</body>
</html>`;
  }
}
