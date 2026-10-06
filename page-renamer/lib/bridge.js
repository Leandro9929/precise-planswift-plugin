'use strict';
// Runs the PowerShell bridge scripts. Every script writes its JSON result to a file (UTF-8),
// so page names never pass through the console code page.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const scripts = path.join(__dirname, '..', 'bridge');

// PlanSwift is a 32-bit program, so its COM registration lives in the 32-bit registry view.
// 32-bit Windows PowerShell sees it directly.
function powershellPath() {
  if (process.env.PRECISE_POWERSHELL) return process.env.PRECISE_POWERSHELL;
  if (process.platform !== 'win32') return 'pwsh';
  const root = process.env.SystemRoot || 'C:\\Windows';
  const wow = path.join(root, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(wow)) return wow;
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l.replace(/^\uFEFF/, '')); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function stderrText(stderr) {
  return String(stderr || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 6).join(' ');
}

class Bridge {
  constructor({ tmpDir }) {
    this.tmpDir = tmpDir;
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  temp(name) {
    return path.join(this.tmpDir, `${name}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  }

  // Resolves with { report, error } and never rejects for script failures.
  run(script, args, timeout) {
    const outFile = this.temp(script) + '.out.json';
    const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(scripts, script), '-OutFile', outFile, ...args];
    return new Promise((resolve) => {
      execFile(powershellPath(), argv, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        const report = readJson(outFile);
        fs.rmSync(outFile, { force: true });
        let message = '';
        if (error && error.killed) message = `PlanSwift did not answer within ${Math.round(timeout / 1000)} seconds.`;
        else if (error && error.code === 'ENOENT') message = 'Windows PowerShell was not found on this PC.';
        else if (!report) message = stderrText(stderr) || (error ? error.message : 'The PlanSwift bridge returned no result.');
        resolve({ report, error: message });
      });
    });
  }

  async manifest(planSwiftRoot, { liveNames = true } = {}) {
    const args = planSwiftRoot ? ['-PlanSwiftRoot', planSwiftRoot] : [];
    if (liveNames) args.push('-LiveNames');
    const { report, error } = await this.run('manifest.ps1', args, 60000);
    if (!report || !report.ok) throw Error((report && report.error) || error || 'PlanSwift job could not be read.');
    report.pages = Array.isArray(report.pages) ? report.pages : (report.pages ? [report.pages] : []);
    return report;
  }

  // entries: [{ id, oldName, newName }]. Returns { report, progress, error } where progress is
  // the list of page names PlanSwift confirmed, available even if the script was cut short.
  async apply(entries, { label, checkTakeoff = true } = {}) {
    const base = this.temp('apply');
    const requestFile = base + '.request.json';
    const progressFile = base + '.progress.jsonl';
    fs.writeFileSync(requestFile, JSON.stringify({ label, checkTakeoff, entries }), 'utf8');
    const timeout = Math.min(15 * 60000, 90000 + entries.length * 3000);
    try {
      const { report, error } = await this.run('apply.ps1', ['-InputFile', requestFile, '-ProgressFile', progressFile], timeout);
      return { report, progress: readLines(progressFile), error: (report && report.error) || error };
    } finally {
      fs.rmSync(requestFile, { force: true });
      fs.rmSync(progressFile, { force: true });
    }
  }

  async probe(pages) {
    const guidsFile = this.temp('probe') + '.guids.json';
    fs.writeFileSync(guidsFile, JSON.stringify(pages.map((p) => ({ id: p.id, name: p.name }))), 'utf8');
    try {
      const { report, error } = await this.run('probe.ps1', ['-GuidsFile', guidsFile], 120000);
      return report || { ok: false, error, steps: [{ name: 'Error', ok: false, detail: error }] };
    } finally {
      fs.rmSync(guidsFile, { force: true });
    }
  }
}

module.exports = { Bridge, powershellPath };
