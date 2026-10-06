'use strict';
// Precise Page Renamer: local web UI + API on 127.0.0.1. Reads the open PlanSwift job,
// proposes page names from title-block OCR, and renames pages through PlanSwift's COM interface.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const ocr = require('./lib/ocr');
const { detectTitleBlock } = require('./lib/detect');
const { Bridge } = require('./lib/bridge');
const { Store, jobKey } = require('./lib/store');
const { ScanJob } = require('./lib/scan');
const { orderRenames, undoPlan, restoreAllPlan } = require('./lib/plan');
const { clean, validateName, TEMPLATES } = require('./lib/naming');

const base = __dirname;
const VERSION = require('./package.json').version;

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return true;
  } catch { return false; }
}

function resolveDataDir() {
  if (process.env.PRECISE_DATA_DIR) return process.env.PRECISE_DATA_DIR;
  const local = path.join(base, 'data');
  if (writable(local)) return local;
  const appData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(appData, 'Precise Page Renamer');
}

const DEFAULT_SETTINGS = { planSwiftRoot: '', template: 'number-title', titleCase: 'asis', checkTakeoff: true };

function createApp({ dataDir = resolveDataDir(), token = crypto.randomBytes(24).toString('hex') } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const bridge = new Bridge({ tmpDir: path.join(dataDir, 'tmp') });
  const settingsFile = path.join(dataDir, 'settings.json');
  const scans = new Map();
  const plans = new Map();
  let manifest = null;
  let writing = false;

  const settings = () => {
    try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { return { ...DEFAULT_SETTINGS }; }
  };

  async function loadManifest() {
    manifest = await bridge.manifest(settings().planSwiftRoot);
    manifest.jobKey = jobKey(manifest);
    return manifest;
  }

  function pageById(id) {
    return manifest && manifest.pages.find((p) => p.id === id);
  }

  function scanRunning() {
    return [...scans.values()].some((s) => s.state === 'running');
  }

  function publicManifest(m) {
    return {
      job: m.job, jobKey: m.jobKey, link: m.link, version: VERSION, namesFrom: m.namesFrom, liveError: m.liveError,
      pages: m.pages.map((p) => ({ id: p.id, name: p.name, order: p.order, hasImage: !!p.image }))
    };
  }

  // Shared by apply, undo and restore: journal first, then PlanSwift, then journal outcome.
  async function execute(changes, { kind, label, undoes }) {
    if (writing) throw Error('Another rename is in progress.');
    if (scanRunning()) throw Error('Wait for the sheet reading to finish (or cancel it) before renaming.');
    writing = true;
    try {
      const latest = await loadManifest();
      const ordered = orderRenames(changes, latest.pages);
      const run = store.createRun(latest, { kind, label, changes: ordered, undoes });
      let outcome;
      try {
        outcome = await bridge.apply(ordered.map((c) => ({ id: c.id, oldName: c.oldName, newName: c.newName })), {
          label: `Precise Page Renamer: ${label}`,
          checkTakeoff: settings().checkTakeoff !== false
        });
      } catch (e) {
        outcome = { report: null, progress: [], error: e.message };
      }
      store.finishRun(run, outcome);
      if (undoes && run.status === 'applied') store.markUndone(latest.jobKey, undoes, run.runId);
      try { await loadManifest(); } catch { /* keep the outcome even if the refresh fails */ }
      return { run, ok: run.status === 'applied' };
    } finally {
      writing = false;
    }
  }

  function runSummary(run) {
    const counts = {};
    for (const c of run.changes) counts[c.status] = (counts[c.status] || 0) + 1;
    return {
      runId: run.runId, kind: run.kind, label: run.label, created: run.created, status: run.status,
      error: run.error, undone: run.undone, undoes: run.undoes, count: run.changes.length, counts,
      changes: run.changes, checks: run.checks
    };
  }

  const routes = {
    'GET /api/manifest': async () => publicManifest(await loadManifest()),

    'GET /api/settings': async () => ({ ...settings(), templates: TEMPLATES, dataDir }),

    'POST /api/settings': async (body) => {
      const next = { ...settings() };
      if (typeof body.planSwiftRoot === 'string') next.planSwiftRoot = clean(body.planSwiftRoot);
      if (typeof body.template === 'string' && (TEMPLATES[body.template] || /\{(number|title)\}/.test(body.template))) next.template = body.template;
      if (['asis', 'upper', 'title'].includes(body.titleCase)) next.titleCase = body.titleCase;
      if (typeof body.checkTakeoff === 'boolean') next.checkTakeoff = body.checkTakeoff;
      fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2));
      return next;
    },

    'POST /api/detect': async (body) => {
      if (!manifest) await loadManifest();
      const p = pageById(body.id);
      if (!p || !p.image) throw Error('Page image unavailable.');
      const page = await ocr.loadPage(p.image);
      return detectTitleBlock(page);
    },

    'POST /api/scan': async (body) => {
      if (writing) throw Error('A rename is in progress.');
      if (scanRunning()) throw Error('Sheets are already being read.');
      const mode = body.mode === 'zones' ? 'zones' : 'auto';
      if (mode === 'zones') {
        ocr.validateZone(body.numberZone);
        if (body.titleZone) ocr.validateZone(body.titleZone);
      }
      const s = settings();
      const naming = { template: body.template || s.template, titleCase: body.titleCase || s.titleCase };
      const wantsTitle = /\{title\}/.test(TEMPLATES[naming.template] || naming.template);
      const latest = await loadManifest();
      const ids = Array.isArray(body.ids) && body.ids.length ? new Set(body.ids) : null;
      const pages = latest.pages.filter((p) => !ids || ids.has(p.id));
      if (!pages.length) throw Error('Select at least one sheet.');
      const job = new ScanJob(latest, pages, {
        mode, naming,
        numberZone: body.numberZone, titleZone: body.titleZone || null,
        autoFallback: body.autoFallback !== false,
        titles: wantsTitle && (mode === 'auto' || !!body.titleZone)
      });
      for (const [id, old] of scans) if (Date.now() - old.created > 2 * 3600 * 1000) scans.delete(id);
      scans.set(job.id, job);
      job.run();
      return { scanId: job.id, total: job.total };
    },

    'GET /api/scan': async (body, url) => {
      const job = scans.get(url.searchParams.get('id'));
      if (!job) throw Error('That reading session expired. Read the sheets again.');
      return job.view(Number(url.searchParams.get('since')) || 0);
    },

    'POST /api/scan/cancel': async (body) => {
      const job = scans.get(body.scanId);
      if (job) job.cancelled = true;
      return { ok: true };
    },

    'POST /api/apply': async (body) => {
      const job = scans.get(body.scanId);
      if (!job || job.state === 'running') throw Error('Read the sheets again before applying.');
      const rows = new Map(job.rows.map((r) => [r.id, r]));
      const latest = await loadManifest();
      if (latest.jobKey !== job.manifest.jobKey || latest.link !== job.manifest.link) {
        throw Error('A different job is open in PlanSwift now. Reload and read the sheets again.');
      }
      const changes = [];
      for (const entry of Array.isArray(body.entries) ? body.entries : []) {
        const row = rows.get(entry.id);
        const page = latest.pages.find((p) => p.id === entry.id);
        if (!row || !page) throw Error('A page is no longer in the job. Reload and read the sheets again.');
        if (page.name !== row.oldName) throw Error(`"${row.oldName}" was renamed to "${page.name}" since it was read. Read it again.`);
        const newName = clean(entry.newName);
        const problem = validateName(newName);
        if (problem) throw Error(`${problem}: "${newName}"`);
        if (newName !== page.name) changes.push({ id: page.id, oldName: page.name, newName });
      }
      if (!changes.length) throw Error('Check at least one page whose name changes.');
      const { run, ok } = await execute(changes, { kind: 'rename', label: `Rename ${changes.length} page(s)` });
      // Keep the review session usable for further corrections.
      for (const c of run.changes) if (rows.has(c.id)) rows.get(c.id).oldName = c.currentName;
      return { ok, run: runSummary(run) };
    },

    'GET /api/history': async () => {
      const latest = manifest || await loadManifest();
      const ledger = store.originals(latest.jobKey);
      return {
        job: latest.job,
        runs: store.listRuns(latest.jobKey).slice(0, 50).map(runSummary),
        originals: Object.keys(ledger.pages).length
      };
    },

    'POST /api/restore/preview': async (body) => {
      const latest = await loadManifest();
      let items;
      let title;
      if (body.runId) {
        const run = store.getRun(latest.jobKey, body.runId);
        if (!run) throw Error('That run is not in the journal for this job.');
        items = undoPlan(run, latest.pages);
        title = `Undo "${run.label}" from ${new Date(run.created).toLocaleString()}`;
      } else {
        items = restoreAllPlan(store.originals(latest.jobKey), latest.pages);
        title = 'Restore every page renamed by this tool to its original name';
      }
      const plan = { planId: crypto.randomUUID(), runId: body.runId || null, title, items, jobKey: latest.jobKey, created: Date.now() };
      plans.set(plan.planId, plan);
      return plan;
    },

    'POST /api/restore/apply': async (body) => {
      const plan = plans.get(body.planId);
      if (!plan) throw Error('The restore preview expired. Preview it again.');
      plans.delete(body.planId);
      const latest = await loadManifest();
      if (latest.jobKey !== plan.jobKey) throw Error('A different job is open in PlanSwift now.');
      const changes = [];
      for (const item of plan.items.filter((i) => i.action === 'restore')) {
        const page = latest.pages.find((p) => p.id === item.id);
        if (!page || page.name !== item.currentName) throw Error(`"${item.currentName}" changed after the preview. Preview again.`);
        changes.push({ id: page.id, oldName: page.name, newName: item.target });
      }
      if (!changes.length) throw Error('Nothing to restore.');
      const label = plan.runId ? 'Undo run' : 'Restore original names';
      const { run, ok } = await execute(changes, { kind: 'restore', label, undoes: plan.runId });
      return { ok, run: runSummary(run) };
    },

    'GET /api/diagnostics': async () => {
      const report = { version: VERSION, node: process.version, platform: `${process.platform}-${process.arch}`, dataDir, steps: [] };
      let latest = null;
      try {
        latest = await loadManifest();
        report.steps.push({ name: 'Job folder', ok: true, detail: `${latest.job}: ${latest.pages.length} pages, ${latest.pages.filter((p) => p.image).length} with images (${latest.planSwiftRoot})` });
        report.steps.push({ name: 'Live page names', ok: latest.namesFrom === 'planswift', detail: latest.namesFrom === 'planswift' ? 'Names read from PlanSwift' : `Names from the job folder. ${latest.liveError}` });
      } catch (e) {
        report.steps.push({ name: 'Job folder', ok: false, detail: e.message });
      }
      try {
        await ocr.getWorker();
        report.steps.push({ name: 'OCR engine', ok: true, detail: 'Tesseract loaded with the bundled English model' });
      } catch (e) {
        report.steps.push({ name: 'OCR engine', ok: false, detail: e.message });
      }
      let filePages = [];
      try { filePages = (await bridge.manifest(settings().planSwiftRoot, { liveNames: false })).pages; } catch { /* reported above */ }
      const probe = await bridge.probe(filePages);
      report.steps.push(...(probe.steps || []));
      report.samplePages = probe.samplePages || [];
      report.firstPageProperties = probe.firstPageProperties || null;
      report.ok = report.steps.every((s) => s.ok);
      return report;
    }
  };

  async function readBody(req) {
    let data = '';
    for await (const chunk of req) {
      data += chunk;
      if (data.length > 4 * 1024 * 1024) throw Error('Request too large');
    }
    return data ? JSON.parse(data) : {};
  }

  function send(res, status, body, type = 'application/json; charset=utf-8') {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, {
      'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
    });
    res.end(data);
  }

  const assets = {
    '/ui.js': ['ui.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8']
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, { error: 'Forbidden' });
      if (req.headers['x-page-renamer-token'] !== token && url.searchParams.get('token') !== token) {
        return send(res, 403, { error: 'Forbidden' });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        const html = fs.readFileSync(path.join(base, 'ui', 'index.html'), 'utf8').replaceAll('__TOKEN__', token);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'"
        });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/naming.js') {
        // The browser uses the same naming rules as the server.
        const code = fs.readFileSync(path.join(base, 'lib', 'naming.js'), 'utf8');
        return send(res, 200, `(function () {\nconst module = { exports: {} };\n${code}\nwindow.Naming = module.exports;\n})();\n`, 'text/javascript; charset=utf-8');
      }
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        return send(res, 200, fs.readFileSync(path.join(base, 'ui', file)), type);
      }
      if (req.method === 'GET' && (url.pathname.startsWith('/api/image/') || url.pathname.startsWith('/api/crop/'))) {
        if (!manifest) await loadManifest();
        const id = decodeURIComponent(url.pathname.split('/')[3] || '');
        const p = pageById(id);
        if (!p || !p.image) return send(res, 404, { error: 'Image unavailable' });
        if (url.pathname.startsWith('/api/image/')) {
          const width = Math.min(6000, Math.max(200, Number(url.searchParams.get('w')) || 1800));
          return send(res, 200, await ocr.previewImage(p.image, width), 'image/png');
        }
        const z = ['x', 'y', 'w', 'h'].reduce((o, k) => ({ ...o, [k]: Number(url.searchParams.get(k)) }), {});
        return send(res, 200, await ocr.cropPreview(p.image, z), 'image/png');
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return send(res, 404, { error: 'Not found' });
      const body = req.method === 'POST' ? await readBody(req) : {};
      return send(res, 200, await route(body, url));
    } catch (e) {
      return send(res, 400, { error: e.message || String(e) });
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60000;

  return { server, token, dataDir, store, close: async () => { server.close(); await ocr.closeWorker(); } };
}

function openBrowser(url) {
  if (process.env.PRECISE_NO_BROWSER) return;
  if (process.platform === 'win32') execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => {});
}

if (require.main === module) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 9)) {
    console.error(`Node.js 20.9 or newer is required (this PC has ${process.version}). Install the current LTS from https://nodejs.org/`);
    process.exit(1);
  }
  const app = createApp();
  const port = Number(process.env.PRECISE_PORT) || 0;
  app.server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${app.server.address().port}/?token=${app.token}`;
    console.log(`Precise Page Renamer ${VERSION}`);
    console.log(`Open: ${url}`);
    console.log(`Journal folder: ${app.dataDir}`);
    console.log('Close this window to stop the tool.');
    openBrowser(url);
  });
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createApp };
