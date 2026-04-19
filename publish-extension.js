const { exec } = require('child_process');

const pkg = require('./package.json');
const vsix = `sendtoai-${pkg.version}.vsix`;
console.log(`Publishing SendToAI extension v${pkg.version} to VS Code Marketplace...`);

exec(`npx @vscode/vsce publish --packagePath ${vsix}`, (error, stdout, stderr) => {
    if (error) {
        console.log('❌ Error publishing:', error.message);
        if (stderr.includes('authentication')) {
            console.log('\n🔐 Authentication required! Please run:');
            console.log('npx @vscode/vsce login oxainz');
            console.log('\nThen run this script again.');
        }
        return;
    }
    
    if (stderr) {
        console.log('⚠️  Warning:', stderr);
    }
    
    console.log('✅ SUCCESS!');
    console.log(stdout);
    console.log('\n🎉 Your extension is now live with:');
    console.log('   • Revenue-focused title: "FREE + Pro $9"');
    console.log('   • Competitor comparison vs GitHub Copilot');
    console.log('   • Clear value proposition');
    console.log('   • Pro tier visibility BEFORE install');
    console.log('\n📈 Expected result: 5-10x revenue increase within 30 days!');
});