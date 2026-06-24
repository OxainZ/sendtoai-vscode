# Changelog

All notable changes to **Send to AI** are documented here.
This project follows [Semantic Versioning](https://semver.org/).

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
