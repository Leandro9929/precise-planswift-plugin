'use strict';
// Locates a PowerShell to run the bridge scripts against the mock PlanSwift COM object.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function findPowerShell() {
  if (process.env.PRECISE_POWERSHELL) return process.env.PRECISE_POWERSHELL;
  // On Windows test with the same (32-bit) Windows PowerShell the tool uses with PlanSwift.
  const candidates = process.platform === 'win32' ? [require('../../lib/bridge').powershellPath(), 'powershell.exe', 'pwsh.exe'] : ['pwsh'];
  for (const exe of candidates) {
    try {
      execFileSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'pipe', timeout: 30000 });
      return exe;
    } catch { /* try the next one */ }
  }
  return '';
}

const mockScript = path.join(__dirname, '..', 'fixtures', 'mock-planswift.ps1');

// Points the bridge at the mock and returns a function that restores the environment.
function useMock(pagesDir, extra = {}) {
  const saved = { ...process.env };
  process.env.PRECISE_POWERSHELL = findPowerShell();
  process.env.PRECISE_BRIDGE_MOCK = mockScript;
  process.env.PRECISE_MOCK_PAGES = pagesDir;
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
  return () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(require('node:os').tmpdir(), prefix));
}

module.exports = { findPowerShell, useMock, tempDir, mockScript };
