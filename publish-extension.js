// Publish SendToAI to BOTH extension marketplaces.
//
// Why two: Cursor, Windsurf, VSCodium and the other VS Code forks cannot
// install from the Microsoft marketplace — they resolve extensions from
// Open VSX. Publishing only to MS makes SendToAI uninstallable for that
// entire population, which is the same developer buying the same thing.
// Open VSX is free and the publish is one extra command.
//
// Prerequisites (one-time):
//   MS marketplace : npx @vscode/vsce login oxainz
//   Open VSX       : create a publisher at open-vsx.org, sign the Eclipse
//                    publisher agreement, then export OVSX_TOKEN=<token>
//
// NOTE: the README's screenshot is referenced by a relative path, which the
// marketplace rewrites against the repo's DEFAULT branch. Merge to main
// before publishing or the listing image 404s.
const { execFile } = require('child_process');
const fs = require('fs');

const pkg = require('./package.json');
const vsix = `sendtoai-${pkg.version}.vsix`;

if (!fs.existsSync(vsix)) {
    console.error(`❌ ${vsix} not found — run: npx @vscode/vsce package`);
    process.exit(1);
}

const run = (cmd, args, label) => new Promise(resolve => {
    console.log(`\n→ ${label}…`);
    execFile(cmd, args, (error, stdout, stderr) => {
        if (stdout) { console.log(stdout.trim()); }
        if (error) {
            console.log(`❌ ${label} failed: ${error.message}`);
            if (/authentication|401|unauthorized/i.test(`${stderr}${error.message}`)) {
                console.log(label.includes('Open VSX')
                    ? '🔐 Set OVSX_TOKEN (open-vsx.org → your publisher → Access Tokens).'
                    : '🔐 Run: npx @vscode/vsce login oxainz');
            }
            return resolve(false);
        }
        if (stderr && stderr.trim()) { console.log(`⚠️  ${stderr.trim()}`); }
        console.log(`✅ ${label} OK`);
        resolve(true);
    });
});

(async () => {
    console.log(`Publishing SendToAI v${pkg.version}`);
    const ms = await run('npx', ['@vscode/vsce', 'publish', '--packagePath', vsix],
                         'VS Code Marketplace');

    let ovsx = false;
    if (!process.env.OVSX_TOKEN) {
        console.log('\n⏭️  Open VSX skipped — OVSX_TOKEN not set.');
        console.log('   This is the marketplace Cursor/Windsurf/VSCodium users install from;');
        console.log('   publishing there is free and permanent. Worth the one-time setup.');
    } else {
        ovsx = await run('npx', ['ovsx', 'publish', vsix, '-p', process.env.OVSX_TOKEN],
                         'Open VSX');
    }

    console.log('\n— summary —');
    console.log(`  VS Code Marketplace : ${ms ? 'published' : 'FAILED'}`);
    console.log(`  Open VSX            : ${ovsx ? 'published' : (process.env.OVSX_TOKEN ? 'FAILED' : 'skipped')}`);
    console.log('\nAfter publishing, verify the listing renders its screenshot');
    console.log('(relative image paths resolve against the DEFAULT branch).');
    process.exit(ms ? 0 : 1);
})();
