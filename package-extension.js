const { exec } = require('child_process');

// Try to install vsce locally first
console.log('Installing vsce...');
exec('npm install @vscode/vsce', (error, stdout, stderr) => {
    if (error) {
        console.log('Error installing vsce:', error);
        console.log('Trying to use global vsce...');
        packageExtension();
        return;
    }
    console.log('VSCE installed:', stdout);
    packageExtension();
});

function packageExtension() {
    console.log('Packaging extension...');
    exec('npx @vscode/vsce package', (error, stdout, stderr) => {
        if (error) {
            console.log('Error packaging:', error);
            console.log('stderr:', stderr);
            return;
        }
        console.log('Success!');
        console.log(stdout);
    });
}