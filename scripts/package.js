const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const archiver = require('archiver');

// Read package.json to get the package name
const packageJsonPath = path.join(__dirname, '../package.json');
if (!fs.existsSync(packageJsonPath)) {
    console.error('package.json not found!');
    process.exit(1);
}

const packageJson = require(packageJsonPath);
const packageName = packageJson.name; // cocos-code-mode-ai
const zipFileName = `${packageName}.zip`;

// List of files/folders to include in the list
const filesToInclude = [
    '@types',
    'dist',
    'i18n',
    'node_modules',
    'static',
    'package-lock.json',
    'package.json',
    'README.md'
];

const projectRoot = path.join(__dirname, '..');

console.log(`Packaging project into ${zipFileName}...`);

// The project's own node_modules mixes runtime deps with devDependencies
// (typescript, @cocos/creator-types, @types/*, archiver's own tree, ...).
// None of that is needed at runtime, so we materialize a throwaway
// production-only node_modules in a temp dir and zip that instead —
// the real node_modules is never touched, so a mid-script failure here
// can't leave the local dev environment without its build tooling.
function stageProductionNodeModules(root) {
    const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-code-mode-pkg-'));
    fs.copyFileSync(path.join(root, 'package.json'), path.join(stageDir, 'package.json'));
    fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(stageDir, 'package-lock.json'));

    console.log('Installing production-only dependencies for packaging...');
    // --ignore-scripts: skips this project's own preinstall.js (an npm-registry
    // version check for the @cocos/creator-types devDependency) — irrelevant to
    // a production-only install. No current production dependency has its own
    // install/postinstall script, so nothing else is lost by skipping scripts.
    execSync('npm ci --omit=dev --ignore-scripts', { cwd: stageDir, stdio: 'inherit' });

    return stageDir;
}

function createPackage(root, zipName, items, pathOverrides) {
    const outputPath = path.join(root, zipName);

    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip');

        output.on('close', () => resolve(outputPath));
        output.on('error', (error) => reject(error));
        archive.on('error', (error) => reject(error));
        archive.pipe(output);

        for (const item of items) {
            const fullPath = (pathOverrides && pathOverrides[item]) || path.join(root, item);
            fs.statSync(fullPath).isDirectory()
                ? archive.directory(fullPath, item)
                : archive.file(fullPath, { name: item });
        }

        archive.finalize();
    });
}

async function main() {
    let stageDir;
    try {
        stageDir = stageProductionNodeModules(projectRoot);
        const pathOverrides = { node_modules: path.join(stageDir, 'node_modules') };

        // Check for missing items (optional, but good for feedback)
        const missingItems = filesToInclude.filter(
            item => !fs.existsSync((pathOverrides && pathOverrides[item]) || path.join(projectRoot, item)),
        );
        if (missingItems.length > 0) {
            console.warn('Warning: The following items to be packaged were not found:');
            missingItems.forEach(item => console.warn(` - ${item}`));
            // We proceed anyway, zip will just skip or fail depending on strictness, but usually it warns.
            // If 'dist' is missing, it's significant.
        }

        const outputPath = await createPackage(projectRoot, zipFileName, filesToInclude, pathOverrides);
        console.log(`\nPackage created successfully: ${outputPath}`);
    } catch (error) {
        console.error('Error creating package:', error.message);
        process.exitCode = 1;
    } finally {
        if (stageDir) {
            fs.rmSync(stageDir, { recursive: true, force: true });
        }
    }
}

main();
