// Quick sanity check with no dependencies installed: every file parses, and
// every relative require() points at a file that exists.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const files = [];
(function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
    }
})(path.join(__dirname, '..', 'src'));

let failed = 0;
for (const file of files) {
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
    catch (error) { failed++; console.error(`Syntax error in ${file}\n${error.stderr}`); }
    for (const [, target] of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
        const base = path.resolve(path.dirname(file), target);
        if (![base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')].some(p => fs.existsSync(p) && fs.statSync(p).isFile())) {
            failed++; console.error(`${path.relative(process.cwd(), file)}: cannot resolve ${target}`);
        }
    }
}
console.log(`${files.length} files checked, ${failed} problem(s).`);
process.exit(failed ? 1 : 0);
