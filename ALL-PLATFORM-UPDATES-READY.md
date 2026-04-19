# SendToAI — All Platform Updates Ready

## VS Code Marketplace
- **Version**: 3.3.15
- **Status**: ✅ Published — live at OxainZ.sendtoai
- **Installs**: 8 (135 downloads)

## What Changed (3.3.8 → 3.3.15)

### Critical fixes
- Fit-to-window now actually respects token limits (was producing 400K+ on 200K target)
- Python venv/dist-info junk no longer pollutes bundles
- Upgrade button points to live Lemon Squeezy checkout (was broken Vercel link)
- Product ID corrected to 926714

### Format
- Minimal format added — short headers, comment stripping, max token savings
- Binary detection scans full file (not just first 8192 bytes)

### Gitignore
- Negation patterns (!important.ts) now supported
- Path patterns, **, ?, [abc] character classes all work correctly
- Patterns compiled once per scan (was recompiling per file — 25K regex builds → 0)

### File picker
- Tree renders all depths (was cutting off at depth 3)
- Checkbox token sum is O(1) via running delta (was O(n) per click)
- Collapsed state cleared on rescan
- "Files ignored" counts actual files, including inside ignored directories

### License / freemium
- Git mode freemium gate works (was bypassed)
- Pre-scan bundle no longer bypasses gate
- Old license slot only released after new activation succeeds
- Clipboard failures surface as error messages

### Windows
- Preset keys use forward-slash paths (backslash keys broke on path changes)
- Project notes key also normalized

## Lemon Squeezy
- **Mode**: ✅ Live
- **Checkout**: https://sendtoai.lemonsqueezy.com/checkout
- **Product ID**: 926714

## Next step
Run the full purchase flow end to end — buy with a real card, confirm key email arrives, activate in VS Code, verify PRO badge appears.
