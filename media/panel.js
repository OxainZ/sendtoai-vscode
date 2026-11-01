// Send to AI side panel script. Loaded by panel.ts via asWebviewUri under a
// nonce-locked CSP. Talks to the extension host only through postMessage.
  const vscode = acquireVsCodeApi();
  let currentMode = 'project';

  // ── Core helpers ──────────────────────────────────────────────────────────────
  function send(cmd, extra) { vscode.postMessage({ command: cmd, ...extra }); }
  function openUrl(url)      { vscode.postMessage({ command: 'openUrl', url }); }

  // ── CSP-safe event wiring (replaces inline handlers; script-src is nonce-locked) ──
  const ACTIONS = { setMode, onPromptChange, onPresetChange, deletePreset,
    pickerAll, pickerNone, requestScan, confirmSavePreset, cancelSavePreset,
    showSavePreset, saveContext, doBundle, send, openUrl };
  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-act]');
    if (!el) { return; }
    if (el.tagName === 'A') { e.preventDefault(); }
    const fn = ACTIONS[el.dataset.act];
    if (fn) { fn(el.dataset.arg); }
  });
  document.getElementById('presetSelect').addEventListener('change', onPresetChange);
  document.getElementById('promptSelect').addEventListener('change', onPromptChange);
  document.getElementById('presetNameInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter')  { confirmSavePreset(); }
    if (e.key === 'Escape') { cancelSavePreset(); }
  });

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
    const targetWindow = parseInt(document.getElementById('windowSelect').value || '0', 10);
    const extra = { mode: currentMode, format: getFormat(), prompt: getPromptText(), notes, includeContext, targetWindow };
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
  let pendingPreselect = null;   // folder rel-path from an explorer right-click
  const collapsed = new Set();   // dir paths that are collapsed
  const checked   = new Set();   // file paths that are checked

  function requestScan() {
    treeBuilt = false;
    collapsed.clear(); // Bug 39: stale dir paths from previous tree cause wrong visual state
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

  // WeakMap caches: keyed by node object, so entries are GC'd when treeData is replaced.
  // Avoids mutating the postMessage-received plain objects (Bug 44).
  const descCache  = new WeakMap(); // node → string[] of descendant file paths
  const countCache = new WeakMap(); // node → total file count
  let   totalCount    = 0;  // root total, cached after precompute
  let   selectedTokSum = 0; // running sum — O(1) via pathToTok deltas
  const pathToTok = new Map(); // file path → tokenEst, built at scan time

  // Builds descCache and countCache bottom-up in O(n) total (Bug 33, 44).
  function precomputeDescendants(node) {
    if (!node.isDir) {
      countCache.set(node, 1);
      pathToTok.set(node.path, node.tokenEst || 0);
      return;
    }
    const paths = [];
    let   cnt   = 0;
    for (const c of node.children) {
      precomputeDescendants(c);
      cnt += countCache.get(c) ?? 0;
      if (!c.isDir) { paths.push(c.path); }
      else { for (const p of descCache.get(c)) { paths.push(p); } }
    }
    descCache.set(node, paths);
    countCache.set(node, cnt);
  }

  function fileDescendants(node) { return descCache.get(node) ?? []; }

  function totalFileCount(node) { return countCache.get(node) ?? 0; }

  // Delta-update selectedTokSum when paths are added/removed from checked.
  function checkPaths(paths, add) {
    for (const p of paths) {
      if (add && !checked.has(p))  { checked.add(p);    selectedTokSum += (pathToTok.get(p) ?? 0); }
      if (!add && checked.has(p))  { checked.delete(p); selectedTokSum -= (pathToTok.get(p) ?? 0); }
    }
  }

  // Scope the selection to one folder (explorer right-click). Falls back to
  // select-all when the folder yields nothing, so the picker is never empty.
  function applyPreselect() {
    const rel = pendingPreselect;
    pendingPreselect = null;
    if (!rel) { return; }
    const all = fileDescendants(treeData);
    const prefix = rel.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    const inFolder = all.filter(p => p === rel || p.indexOf(prefix) === 0);
    checked.clear();
    selectedTokSum = 0;
    checkPaths(inFolder.length ? inFolder : all, true);
  }

  function updateSummary() {
    const sel   = checked.size;
    const total = totalCount;
    const toks  = selectedTokSum;
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
          checkPaths(descs, cb.checked);
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
          checkPaths([node.path], cb.checked);
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
    checkPaths(fileDescendants(treeData), true);
    renderTree();
    updateSummary();
  }

  function pickerNone() {
    checked.clear();
    selectedTokSum = 0;
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
    selectedTokSum = 0;
    checkPaths(preset.paths, true);
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
      // Contextual copy — say why THIS action needs Pro, with the user's real numbers
      const msgs = {
        files:   '⚡ <strong>That\'s a Pro-size bundle</strong> — ' +
                 (typeof d.fileCount === 'number' ? 'you selected <strong>' + d.fileCount + ' files</strong>; the' : 'the') +
                 ' Free tier bundles up to 50.<br>Pro removes the limit — $9.99, once, yours forever.',
        git:     '🔀 <strong>Git Changes is a Pro feature</strong> — bundle only what you changed, perfect for AI code review.<br>$9.99 once unlocks it (plus unlimited files, presets, and Fit to AI Window).',
        window:  '🎯 <strong>Fit to AI Window is a Pro feature</strong> — auto-trims the bundle to your AI\'s context, keeping the most relevant files.<br>$9.99 once unlocks it (plus unlimited files, git diff, and presets).',
        presets: '📋 <strong>Named presets are a Pro feature</strong> — save this selection and reload it in one click.<br>$9.99 once unlocks presets, unlimited files, git diff, and Fit to AI Window.',
      };
      document.getElementById('upgradeMsg').innerHTML = (msgs[d.reason] || msgs.files) +
        '<br><span style="opacity:.75">14-day money-back guarantee · one license works on up to 5 machines</span>';
      document.getElementById('upgradeBanner').classList.add('show');
      document.getElementById('upgradeBanner').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    if (d.command === 'proStatus') {
      const badge = document.getElementById('proBadge');
      const activateRow = document.getElementById('activateRow');
      badge.style.display = d.isPro ? 'inline' : 'none';
      if (activateRow) { activateRow.style.display = d.isPro ? 'none' : 'block'; }
      // Hide PRO tags once licensed — the labels are an upsell, not a decoration
      document.querySelectorAll('.pro-tag').forEach(t => { t.style.display = d.isPro ? 'none' : ''; });
      if (d.isPro) { document.getElementById('upgradeBanner').classList.remove('show'); }
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
    if (d.command === 'preselectFolder') {
      pendingPreselect = d.rel || null;
      if (treeBuilt) { applyPreselect(); renderTree(); updateSummary(); }
      return;
    }
    if (d.command === 'scanResult') {
      treeData  = d.tree;
      if (d.tree && d.tree.name) { document.getElementById('projName').textContent = '📁 ' + d.tree.name; }
      pathToTok.clear();
      precomputeDescendants(treeData); // builds descCache, countCache, pathToTok in O(n)
      totalCount = totalFileCount(treeData);
      treeBuilt = true;
      checked.clear();
      selectedTokSum = 0;
      if (pendingPreselect) {
        applyPreselect();
      } else {
        // Default: select all files
        checkPaths(fileDescendants(treeData), true);
      }
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

    function setBar(barId, pctId, limit) {
      const pct = Math.min((d.tokenEstimate / limit) * 100, 100);
      const bar = document.getElementById(barId);
      bar.style.width = pct + '%';
      bar.style.background = pct < 70 ? '#4caf80' : pct < 95 ? '#e0a039' : '#e05c5c';
      document.getElementById(pctId).textContent = pct >= 100 ? 'OVER' : pct.toFixed(0) + '%';
      document.getElementById(pctId).style.color = pct >= 100 ? '#e05c5c' : '';
    }
    // Context windows as of Nov 2026 (chatgpt.com/pricing, Anthropic help 8606394, Google help 14903178)
    setBar('barGptFree', 'pctGptFree', 27000);
    setBar('barGptPlus', 'pctGptPlus', 54000);
    setBar('barClaude',  'pctClaude',  200000);
    setBar('barGemini',  'pctGemini',  32000);
    setBar('barPaid',    'pctPaid',    1000000);

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
    const copyAgainBtn = document.querySelector('.btn-copy');
    if (copyAgainBtn) {
      copyAgainBtn.disabled = !!d.bundleTooBig;
      copyAgainBtn.title = d.bundleTooBig ? 'Bundle too large to re-copy (>2 MB)' : '';
    }
    document.getElementById('stats').classList.add('show');
  });
