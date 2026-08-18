# Changelog

All notable changes to **Send to AI** are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [3.10.0] — 2026-08-16

**Honest tiers, clearer upgrade path.**

### Fixed
- **Fit to AI Window** and **Named presets** are now actually Pro-gated. Both
  were always labeled PRO (panel, website, listing) but the license check was
  missing, so the free tier silently included them. Loading and deleting
  presets saved before this release stays free — only saving new ones needs Pro.
- The free-tier file limit now fails fast: selecting more than 50 files shows
  the upgrade prompt immediately instead of after the full bundle is built.
- License-limit messages no longer hardcode a machine count.

### Changed
- The upgrade prompt is contextual — it names the feature that triggered it and
  shows your actual file count instead of one generic banner.
- Preset count is capped at 10 (matching what the listing has always said).
- "Upgrade to Pro" now follows up with a one-click "I have my key — activate"
  path once checkout opens.
- Marketplace metadata: `AI` category, explicit Free pricing label.

## [3.9.1] — 2026-08-14

- Marketplace listing: real screenshot of the panel in the README.

## [3.9.0] — 2026-08-14

- Honest marketplace listing: descriptive display name and keywords users
  actually search; replaced the false Copilot comparison with a real one
  (manual copy-paste, web bundlers).
- One-time review ask after the 5th successful bundle/apply — dismissible,
  "don't ask again" honored, and it can never break a bundle.
- Entering a license key no longer burns an activation slot on re-entry
  (the old instance is deactivated first, best-effort).
- Hardened webview lifecycle, `applyResponse` paths, and license error paths;
  resolved 5 high-severity npm advisories (lockfile only).

## [3.8.1] — 2026-07-15

**Security hardening.** Locked down the sidebar webview's Content-Security-Policy
to eliminate `script-src 'unsafe-inline'` — the standard webview-XSS enabler
flagged by extension security reviews.

- Webview now uses a per-render **nonce**; `script-src` is `'nonce-…'`, so only
  the extension's own script can execute (any injected `<script>` is blocked).
- Converted all inline `onclick`/`onchange`/`onkeydown` handlers to a single
  delegated event listener (nonces don't cover inline handlers). No UI or
  behavior change — same actions, same functions.
- No data-flow change was needed: file names, presets, and types were already
  rendered via `textContent`/`createElement`, never raw `innerHTML`.

## [3.8.0] — 2026-06-23

The release that makes SendToAI **task-aware and round-trip** — bundle the code
that matters for what you're actually doing, then paste the AI's answer straight
back into your files. Four editor-native features that no API-key-free web tool
offers.

### Added
- **🐛 Bundle Errors** — one click bundles every file VS Code is reporting an
  error or warning on, plus the exact diagnostic messages (`file:line:col [ERROR] …`),
  with a ready-to-paste "please fix these" prompt. Web bundlers can't see your
  Problems panel — this is editor-native.
- **📥 Apply AI Reply** — copy the AI's response (code blocks labelled with file
  paths), run the command, and pick which file edits to apply. Writes are a single
  `WorkspaceEdit`: reviewable in the editor, visible in git diff, and undoable with
  `Ctrl+Z`. Creates new files or replaces existing ones.
- **Relevance ranking** — when a bundle must be trimmed to fit a token budget,
  files are ranked by how relevant they are to your task (filename/path/content
  overlap with your prompt, plus structural priors that keep entry points, READMEs
  and config and demote tests/generated/lockfiles) instead of blindly cutting the
  largest files.
- **Dependency-graph awareness** — a file imported by a relevant file inherits part
  of that relevance, so the local dependencies of what you're working on survive the
  fit-to-window cut alongside it. Follows relative `import`/`require`/`from` edges in
  JS/TS and Python. The result is complete, connected context instead of orphaned
  snippets.
- Both new commands are wired into the sidebar panel as buttons (**🐛 Bundle Errors**,
  **📥 Apply AI Reply**), not just the Command Palette.
- `.vscode/launch.json` + `tasks.json` — F5 "Run SendToAI Extension" debug config for
  contributors.

### Security
- Resolved all 8 Dependabot advisories. `undici`, `form-data` and `markdown-it`
  patched and pinned via `overrides`. `npm audit` reports **0 vulnerabilities**.

### Changed
- Version bumped 3.7.4 → 3.8.0.
- Repository is now fully standalone (own folder, own git remote, own VS Code window).

---

## [3.7.4] and earlier

Project bundling, single-file send, token estimation, multiple output formats
(Standard / XML / Compact / Minimal), git integration, `.sendtoaiignore` support,
and the Pro license flow ($9 lifetime). See git history for details.
