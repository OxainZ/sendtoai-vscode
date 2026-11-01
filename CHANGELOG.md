# Changelog

All notable changes to **Send to AI** are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [3.15.3] — 2026-11-02

### Changed
- Pro is $14.99 one-time (was $9.99). Nothing changes for existing keys: same
  product, same five machines, same lifetime updates, same 30-day refund.
- README points teams at the new Team pack ($39 once, 5 developers, 25
  activations on one key), sold as a variant of the same product so the
  extension validates it with no code change.

## [3.15.2] — 2026-11-02

**Second independent audit; everything it found is fixed.**

### Fixed
- Free users who picked Git Changes or a Fit to AI Window preset once were
  told "a bundle is already in progress" on every later click until reload.
- **Apply AI Reply now saves the files it changes.** It used to leave them as
  unsaved editor buffers (and a 0-byte new file on disk), so "visible in git
  diff" was not true until you saved by hand. It also bases SEARCH/REPLACE on
  the editor buffer instead of the disk, so unsaved edits are never discarded,
  keeps each file's own line endings, applies SEARCH/REPLACE blocks that
  follow a full-file block of the same file, relativises absolute or
  machine-specific paths from the reply, leaves replies that were cut off
  before a closing fence unticked, and names the file if a write did not
  land.
- Fit to AI Window measured files with the old 4-chars-per-token rule while
  the rest of the extension uses 3.3, so a "27K" bundle could show as OVER.
- If VS Code's secret storage is unavailable, a fresh activation is released
  immediately instead of being orphaned on every retry.
- Re-entering a key after the setting was blanked re-uses the stored
  activation instead of taking a new slot.
- Adding or removing a workspace folder reloads notes and presets, not just
  the tree.
- The panel said Ctrl+Alt+A bundles; that shortcut copies the current file.
  Ctrl+Alt+B is the bundle shortcut. README matched.
- The `_test` hooks used by the test runner are no longer exported in normal
  installs.

## [3.15.1] — 2026-11-01

### Changed
- README opens with a 15-second demo GIF of the full loop (scan, bundle, apply with diff preview). The GIF is recorded by a script (`npm run demo:record`) that drives a real VS Code, so it stays current with the UI.

## [3.15.0] — 2026-11-01

### Added
- **Apply AI Reply understands more reply shapes**: fences of any length (```` or ~~~),
  the path in the fence line, on the line above, or as a first-line comment,
  and **SEARCH/REPLACE blocks** (the format aider, Brud and most agents use),
  matched exactly first and then with whitespace and line-ending differences
  ignored. Ambiguous or missing matches are reported per file, never guessed.
- **Preview diffs first**: an optional step opens a side-by-side diff for each
  file before anything is written.
- **Save Bundle as .txt**: button and command. ChatGPT and Claude turn large
  pastes into attachments anyway; now you pick the filename.
- Every bundle ends with a short instruction telling the AI how to format
  changes so they apply cleanly.
- The stats card shows "N of your M relevant files included" when the free
  tier trimmed a bundle.
- **Rate Send to AI** command; the review ask now happens after the fifth
  successful bundle or apply, with plain wording.

### Changed
- **Context presets match late-2026 reality**: ChatGPT Free 27K, Plus/Go 54K
  instant or 256K thinking, Pro 128K; Gemini Free 32K, AI Pro 1M; Claude 200K
  or 1M by model; DeepSeek 1M. The old 8K/32K ChatGPT figures were a year
  stale. Context bars updated to match.
- The panel notes that long pastes become attachments in ChatGPT and Claude,
  which is expected behaviour, not an error.
- **Token estimates lean high for code** (3.3 chars per token instead of 4),
  reflecting current tokenizers; Fit to AI Window is safer as a result.
- Listing: shorter title ("Copy Codebase to ChatGPT, Claude & Gemini"),
  hook-first description, keywords reallocated to the phrases people search.
- Money-back guarantee lengthened from 14 to 30 days.

## [3.14.0] — 2026-11-01

### Fixed
- **Git Changes mode** now picks the deepest repository containing the folder
  (a nested repo beats its parent), ignores changes outside the folder, skips
  deleted files instead of bundling "[Error: …]" placeholders, and explains
  itself when the Git extension is disabled or the folder is not a repo.
- **UTF-16 files** are decoded (by byte-order mark) instead of being reported
  as binary. UTF-8 byte-order marks are stripped.
- A file open in two editor groups is bundled once in Open Tabs mode.

### Internal
- End-to-end test in a real VS Code on every pull request: scan, bundle to
  clipboard, and the side panel must actually respond. Dependabot keeps
  dependencies and Actions current.

## [3.13.1] — 2026-11-01

**Hotfix: the side panel did not load in 3.11.1, 3.12.0 and 3.13.0.**

### Fixed
- The panel's script contained a regex that, once rendered through the
  TypeScript template literal, was a JavaScript syntax error, so the whole
  panel was inert (no file tree, no bundle button). Commands from the Command
  Palette and keyboard shortcuts were unaffected. Introduced in the
  unpublished 3.10.0; shipped today; fixed within hours.

### Changed
- The panel's CSS and script now live in `media/panel.css` and
  `media/panel.js` as real files loaded under the same nonce-locked CSP,
  instead of a 900-line template string. A test parses the script and checks
  the CSP wiring on every build, and ESLint now covers the extension, the
  webview script, the Worker and the tests in CI.

## [3.13.0] — 2026-11-01

### Added
- **Getting-started walkthrough** (Help > Get Started > Send to AI in 60 seconds): open the panel, bundle, fix errors, apply the reply.
- **Multi-root workspaces**: the panel follows the folder that owns the active editor; notes and presets are per folder.

### Fixed
- Bundles use **unsaved editor buffers** when a file is dirty, so Bundle Errors line numbers match what is on screen.
- The panel header shows the folder name as soon as the scan finishes.

## [3.12.0] — 2026-11-01

**Licensing that survives real life, plus dispute evidence.**

### Added
- **Show License Activity** command: a timestamped log of every activation,
  validation and deactivation on this machine, with the instance name and id.
  This is the "system log proving the customer used your software" that card
  networks accept as evidence in a dispute, and it is what to send support
  when an activation goes wrong.
- Upgrade prompts now state the 14-day money-back guarantee and the 5-machine
  allowance.
- Restricted Mode support: bundling works in untrusted workspaces; Apply AI
  Reply, which writes files, asks for workspace trust first.

### Changed
- Activations are named after the machine plus a per-install id instead of
  VS Code's machineId, which changes with docking stations, VMs and every
  WSL or SSH host and silently consumed activation slots.
- The license validity cache is signed with a secret kept in the OS keychain.
  A hand-edited cache is ignored and the key is simply re-verified online.
- Offline grace is now 14 days of warnings and a 90-day cut-off (was 30/365).
- A paying user who bundles right after startup no longer sees the upgrade
  banner while the daily online check is still running.
- Unsaved edits to Project Notes are included in the bundle when "include
  notes" is on; previously only the last saved copy was used.
- Two bundles can no longer run at once.

## [3.11.1] — 2026-11-01

### Changed
- Price shown everywhere is now $9.99, matching what checkout actually charges
  (plus VAT where applicable). It was listed as $9.

## [3.11.0] — 2026-11-01

**Security hardening + first-sale fixes.** Driven by a full audit of the code,
the listing and the licensing flow after the first Pro purchase.

### Security
- **Apply AI Reply** now double-checks every target path resolves inside the
  workspace, ignores "paths" that are really prose (`e.g.`, `Node.js`), and
  leaves edits to files that execute on install or open (`package.json`,
  `.github/`, `.vscode/`, `.husky/`, shell scripts) unticked by default so a
  prompt-injected reply cannot silently rewrite them.
- **Symlinks are never followed** when scanning or bundling. A link to
  `~/.ssh` was previously bundled; a link cycle hung the extension host.
- **Credential files are always skipped**: private keys and certificates,
  `.npmrc`/`.yarnrc`/`.netrc`/`.pypirc`, `.git-credentials`, cloud
  service-account JSON, Terraform state and more. `.env.example` is no longer
  hidden by the `.env` rule.
- **Per-file 1 MB ceiling** so a stray log or dataset cannot exhaust memory.
- Open Tabs and Git Changes modes now respect ignored *directories*
  (`node_modules/`, `dist/`, anything in `.gitignore`), not just file names.
- The license key setting is now machine-scoped, so Settings Sync no longer
  copies it to every machine and silently burns activation slots.
- Webview nonce comes from `crypto.randomBytes`.

### Fixed
- A 5xx / 429 from the license server was cached as "key invalid" for a day;
  it is now treated as a network blip and the previous verdict stands.
- Re-entering a license key no longer deletes this machine's activation before
  the new one succeeds, which orphaned a slot on any failure. Re-entering the
  *same* key just re-verifies.
- A system clock rolled backwards no longer extends the offline grace period.
- Compact/Minimal formats no longer strip `#include`, `#define`, `#[derive]`,
  `#region` and shebang lines from C, C++, C#, Rust, Swift, Go, Java or Kotlin
  files. Those languages now drop full-line `//` comments instead.
- Opening the panel with no folder open no longer spins on "Scanning project…".
- `.gitignore` patterns starting with `**/` now match root-level files, and
  `a/**/b` matches `a/b`, as git itself does.
- Apply AI Reply keeps the directory of Windows-style paths (`lib\util.py`).

### Changed
- Cost estimates use current Anthropic list prices (Haiku 5.5 / Sonnet 5.5 /
  Opus 5.5) and the Claude context bar is 1M tokens.
- Repository moved to CI: every push compiles, audits and packages the VSIX;
  tagged releases publish through Marketplace Trusted Publishing (no stored
  token).
- README states exactly what leaves your machine and how refunds work.
- First unit-test suite (`npm test`) covering ignore rules, secret filtering,
  comment stripping, reply parsing and cost estimates.
- New `worker/`: a Cloudflare Worker that disables a license key when its
  order is refunded or charged back (Lemon Squeezy never does this itself).

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
