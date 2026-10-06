'use strict';
// Builds dist/Precise_Page_Renamer_v<version>.zip containing page-renamer/ with Windows x64
// dependencies, ready to extract and run on the PlanSwift PC. Works on Windows or Linux.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const base = path.join(__dirname, '..');
const { version } = require('../package.json');
const dist = path.join(base, 'dist');
const work = path.join(dist, 'work');
const stage = path.join(work, 'page-renamer');
const zipName = `Precise_Page_Renamer_v${version}.zip`;
const zipPath = path.join(dist, zipName);

const include = ['server.js', 'package.json', 'package-lock.json', 'README.md', 'TESTING.md',
  'Start Precise Page Renamer.cmd', 'lib', 'bridge', 'ui', 'assets', 'test'];

fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(zipPath, { force: true });
for (const item of include) fs.cpSync(path.join(base, item), path.join(stage, item), { recursive: true });

const win = process.platform === 'win32';
execFileSync(win ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--os=win32', '--cpu=x64', '--ignore-scripts', '--no-audit', '--no-fund'],
  { cwd: stage, stdio: 'inherit', shell: win });

const modules = path.join(stage, 'node_modules');
if (!fs.existsSync(path.join(modules, '@img', 'sharp-win32-x64'))) throw Error('Windows x64 sharp binary missing');
// sharp also ships a WebAssembly fallback (sharp-wasm32) on every platform.
const foreign = fs.readdirSync(path.join(modules, '@img')).filter((d) => /^sharp-(?!win32-x64|wasm32)/.test(d));
if (foreign.length) throw Error(`Unexpected platform packages: ${foreign.join(', ')}`);

if (win) execFileSync('tar', ['-a', '-cf', zipPath, 'page-renamer'], { cwd: work, stdio: 'inherit' });
else execFileSync('zip', ['-qr', '-X', zipPath, 'page-renamer'], { cwd: work, stdio: 'inherit' });
fs.rmSync(work, { recursive: true, force: true });
console.log(`Built ${zipPath} (${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB)`);
