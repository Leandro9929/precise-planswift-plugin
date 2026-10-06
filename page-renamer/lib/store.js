'use strict';
// Local run journal and original-name ledger, one folder per PlanSwift job.
//   data/jobs/<jobKey>/runs/<runId>.json  every rename or restore, with per-page outcome
//   data/jobs/<jobKey>/originals.json     the name each page had before this tool first renamed it
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function jobKey(manifest) {
  const guid = String(manifest.jobGuid || '').replace(/[^0-9A-Za-z-]/g, '');
  if (guid) return `job-${guid.toUpperCase()}`;
  return 'link-' + crypto.createHash('sha1').update(String(manifest.link || '')).digest('hex').slice(0, 16);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  }

  jobDir(key) {
    if (!/^[A-Za-z0-9-]+$/.test(key)) throw Error('Invalid job key');
    return path.join(this.dir, 'jobs', key);
  }

  runFile(key, runId) {
    if (!/^[0-9TZ-]+-[0-9a-f]{6}$/.test(runId)) throw Error('Invalid run id');
    return path.join(this.jobDir(key), 'runs', `${runId}.json`);
  }

  createRun(manifest, { kind, label, changes, undoes }) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-(\d{3})Z$/, '$1Z');
    const run = {
      runId: `${stamp}-${crypto.randomBytes(3).toString('hex')}`,
      kind, label, undoes: undoes || null,
      created: new Date().toISOString(), finished: null,
      job: manifest.job, jobKey: jobKey(manifest), link: manifest.link,
      status: 'prepared', error: '', undone: null,
      changes: changes.map((c) => ({ id: c.id, oldName: c.oldName, newName: c.newName, status: 'pending', currentName: c.oldName })),
      checks: null
    };
    this.saveRun(run);
    return run;
  }

  saveRun(run) {
    writeAtomic(this.runFile(run.jobKey, run.runId), run);
  }

  getRun(key, runId) {
    return readJson(this.runFile(key, runId), null);
  }

  listRuns(key) {
    const dir = path.join(this.jobDir(key), 'runs');
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
    return names.map((n) => readJson(path.join(dir, n), null)).filter(Boolean)
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  originals(key) {
    return readJson(path.join(this.jobDir(key), 'originals.json'), { pages: {} });
  }

  // Applies the bridge outcome to the run and to the original-name ledger.
  finishRun(run, { report, progress, error }) {
    const final = new Map();
    for (const line of progress || []) if (line && line.id) final.set(line.id, line.name);
    const results = new Map(((report && report.results) || []).map((r) => [r.id, r]));
    for (const change of run.changes) {
      const r = results.get(change.id);
      if (r) {
        change.status = r.status;
        change.currentName = r.currentName;
        if (r.message) change.message = r.message;
      } else if (final.has(change.id)) {
        change.status = final.get(change.id) === change.newName ? 'renamed' : 'unknown';
        change.currentName = final.get(change.id);
      } else {
        change.status = report ? 'not-attempted' : 'unknown';
      }
    }
    const changed = run.changes.filter((c) => c.currentName !== c.oldName);
    if (report && report.ok) run.status = 'applied';
    else if (!report) run.status = changed.length || run.changes.some((c) => c.status === 'unknown') ? 'uncertain' : 'failed';
    else if (changed.length) run.status = 'partial';
    else run.status = report.rolledBack ? 'rolled-back' : 'failed';
    run.error = report && report.ok ? '' : (error || 'PlanSwift did not confirm the changes.');
    run.checks = report ? {
      connection: report.connection, propertyChanges: report.propertyChanges || [],
      takeoffChanges: report.takeoffChanges || [], takeoffItems: report.takeoffItems || 0,
      takeoffComplete: !!report.takeoffComplete
    } : null;
    run.finished = new Date().toISOString();
    this.saveRun(run);
    this.recordOriginals(run, changed);
    return run;
  }

  recordOriginals(run, changed) {
    if (!changed.length) return;
    const file = path.join(this.jobDir(run.jobKey), 'originals.json');
    const ledger = readJson(file, { pages: {} });
    for (const c of changed) {
      const entry = ledger.pages[c.id] || { original: c.oldName, firstRun: run.runId };
      entry.current = c.currentName;
      entry.lastRun = run.runId;
      entry.updated = run.finished;
      if (entry.current === entry.original) delete ledger.pages[c.id];
      else ledger.pages[c.id] = entry;
    }
    writeAtomic(file, ledger);
  }

  markUndone(key, runId, byRunId) {
    const run = this.getRun(key, runId);
    if (!run) return;
    run.undone = { runId: byRunId, at: new Date().toISOString() };
    this.saveRun(run);
  }
}

module.exports = { Store, jobKey };
