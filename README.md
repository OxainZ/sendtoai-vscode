# SendToAI

Bundle your entire project into one smart text block and copy it to clipboard — paste into Claude, ChatGPT, or any AI chat to give it full project context.

## Why

Claude Projects has a 20-file limit. This extension bundles 100+ files into one paste-ready block, so any AI gets your full codebase instantly.

## Usage

- **Sidebar button** — click the ⚡ icon in the activity bar → "Bundle Project to Clipboard"
- **Keyboard shortcut** — `Ctrl+Shift+A` (Windows/Linux) / `Cmd+Shift+A` (Mac)
- **Command palette** — `SendToAI: Bundle Project to Clipboard`
- **Right-click any folder** in the Explorer → "SendToAI: Bundle Folder to Clipboard"

## What gets included / ignored

**Auto-ignored:** `node_modules`, `.git`, `dist`, `build`, `.expo`, lock files, images, fonts, binaries, `.env*`, `.DS_Store`, source maps.

Everything else is included with full content.

## Output format

```
================================================================
PROJECT: my-project
FILES INCLUDED: 42 files | FILES IGNORED: 1,204 files
ESTIMATED TOKENS: 38,421
================================================================

FILE TREE:
📁 src/
  📄 index.ts
  📁 components/
    📄 App.tsx
...

================================================================
FILE: src/index.ts
================================================================
[full file content]
...

================================================================
END OF PROJECT BUNDLE — 42 files — Ready for AI
================================================================
```

## Pricing context

At Claude Haiku 4.5 rates ($1/M input tokens), a typical 40k-token project bundle costs **~$0.04** per send.
