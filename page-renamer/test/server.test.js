'use strict';
// End-to-end: HTTP API -> OCR -> PowerShell bridge scripts -> mock PlanSwift COM object.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { makePlanSwiftRoot, readPageName } = require('./helpers/fixtures');
const { findPowerShell, useMock, tempDir } = require('./helpers/env');

const powershell = findPowerShell();

function request(port, method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path: url,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}), ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const json = /json/.test(res.headers['content-type'] || '') ? JSON.parse(raw.toString('utf8')) : null;
        resolve({ status: res.statusCode, json, raw, type: res.headers['content-type'] });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('read, rename, undo and restore pages through the API', { skip: !powershell && 'PowerShell not available', timeout: 600000 }, async (t) => {
  const root = tempDir('precise-ps-');
  const fixture = await makePlanSwiftRoot(root, [
    { name: 'Page 1', sheet: { layout: 'vertical', number: 'A1.1', title: ['FIRST FLOOR', 'PLAN'] } },
    { name: 'Page 2', sheet: { layout: 'bottom', number: 'M2.01', title: 'MECHANICAL ROOF PLAN' } },
    { name: 'Page 3', sheet: { layout: 'corner', number: 'E-3', title: 'LIGHTING PLAN LEVEL 2' } },
    { name: 'Notes' }
  ]);
  const restoreEnv = useMock(fixture.pagesDir);
  const { createApp } = require('../server');
  const app = createApp({ dataDir: path.join(root, 'data') });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const auth = { 'x-page-renamer-token': app.token };
  const api = async (method, url, body) => {
    const res = await request(port, method, url, body, auth);
    if (res.status !== 200) throw Object.assign(Error(res.json ? res.json.error : `HTTP ${res.status}`), { status: res.status });
    return res.json;
  };
  const names = () => fixture.pages.map((p) => readPageName(p.dir));
  const waitScan = async (scanId) => {
    for (;;) {
      const view = await api('GET', `/api/scan?id=${scanId}`);
      if (view.state !== 'running') return view;
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  t.after(async () => { await app.close(); restoreEnv(); fs.rmSync(root, { recursive: true, force: true }); });

  await t.test('rejects requests without the session token or from another host name', async () => {
    assert.equal((await request(port, 'GET', '/api/manifest')).status, 403);
    assert.equal((await request(port, 'GET', '/api/manifest', undefined, { ...auth, Host: 'evil.example' })).status, 403);
  });

  await api('POST', '/api/settings', { planSwiftRoot: root, template: 'number-title', titleCase: 'asis' });
  const manifest = await api('GET', '/api/manifest');
  assert.equal(manifest.job, 'Fixture Job');
  assert.deepEqual(manifest.pages.map((p) => p.name), ['Page 1', 'Page 2', 'Page 3', 'Notes']);
  const [p1, p2, p3, notes] = manifest.pages;

  await t.test('serves page previews and crops as PNG', async () => {
    const image = await request(port, 'GET', `/api/image/${encodeURIComponent(p1.id)}?w=600&token=${app.token}`);
    assert.equal(image.status, 200);
    assert.equal(image.type, 'image/png');
    const crop = await request(port, 'GET', `/api/crop/${encodeURIComponent(p1.id)}?x=0.8&y=0.9&w=0.2&h=0.1&token=${app.token}`);
    assert.equal(crop.status, 200);
  });

  let firstRun;
  await t.test('automatic reading proposes names and flags the page without an image', async () => {
    const { scanId, total } = await api('POST', '/api/scan', { mode: 'auto' });
    assert.equal(total, 4);
    const view = await waitScan(scanId);
    assert.equal(view.state, 'done');
    const byId = new Map(view.rows.map((r) => [r.id, r]));
    assert.equal(byId.get(p1.id).newName, 'A1.1 - FIRST FLOOR PLAN');
    assert.equal(byId.get(p2.id).newName, 'M2.01 - MECHANICAL ROOF PLAN');
    assert.equal(byId.get(p3.id).newName, 'E-3 - LIGHTING PLAN LEVEL 2');
    assert.match(byId.get(notes.id).error, /no image/);
    const entries = view.rows.filter((r) => r.apply).map((r) => ({ id: r.id, newName: r.newName }));
    assert.equal(entries.length, 3);
    const out = await api('POST', '/api/apply', { scanId, entries });
    assert.equal(out.ok, true, out.run.error);
    assert.equal(out.run.status, 'applied');
    firstRun = out.run;
    assert.deepEqual(names(), ['A1.1 - FIRST FLOOR PLAN', 'M2.01 - MECHANICAL ROOF PLAN', 'E-3 - LIGHTING PLAN LEVEL 2', 'Notes']);
    assert.equal(out.run.checks.takeoffItems, 3);
  });

  let secondRun;
  await t.test('box-based reading with a manual correction', async () => {
    const found = await api('POST', '/api/detect', { id: p1.id });
    assert.equal(found.number, 'A1.1');
    const { scanId } = await api('POST', '/api/scan', {
      mode: 'zones', ids: [p1.id], numberZone: found.numberZone, titleZone: found.titleZone, titleCase: 'title'
    });
    const view = await waitScan(scanId);
    assert.equal(view.rows[0].newName, 'A1.1 - First Floor Plan');
    const out = await api('POST', '/api/apply', { scanId, entries: [{ id: p1.id, newName: 'A1.1 - Level 1 Floor Plan' }] });
    assert.equal(out.ok, true, out.run.error);
    secondRun = out.run;
    assert.equal(names()[0], 'A1.1 - Level 1 Floor Plan');
  });

  await t.test('refuses a name another page already has', async () => {
    const { scanId } = await api('POST', '/api/scan', { mode: 'zones', ids: [p2.id], numberZone: { x: 0.85, y: 0.9, w: 0.14, h: 0.09 } });
    await waitScan(scanId);
    await assert.rejects(api('POST', '/api/apply', { scanId, entries: [{ id: p2.id, newName: 'E-3 - LIGHTING PLAN LEVEL 2' }] }), /already the name of another page/);
    await assert.rejects(api('POST', '/api/apply', { scanId, entries: [{ id: p2.id, newName: 'BAD/NAME' }] }), /contains/);
  });

  await t.test('a PlanSwift failure part-way through is rolled back and journaled', async () => {
    const { scanId } = await api('POST', '/api/scan', { mode: 'auto', ids: [p2.id, p3.id] });
    await waitScan(scanId);
    process.env.PRECISE_MOCK_FAIL_ON = 'E-3 - Lighting';
    try {
      const out = await api('POST', '/api/apply', { scanId, entries: [
        { id: p2.id, newName: 'M2.01 - Mechanical Roof' },
        { id: p3.id, newName: 'E-3 - Lighting' }
      ] });
      assert.equal(out.ok, false);
      assert.equal(out.run.status, 'rolled-back');
      assert.match(out.run.error, /Mock failure/);
    } finally {
      delete process.env.PRECISE_MOCK_FAIL_ON;
    }
    assert.deepEqual(names().slice(1, 3), ['M2.01 - MECHANICAL ROOF PLAN', 'E-3 - LIGHTING PLAN LEVEL 2']);
  });

  await t.test('undo a single run', async () => {
    const plan = await api('POST', '/api/restore/preview', { runId: secondRun.runId });
    assert.deepEqual(plan.items.map((i) => [i.action, i.target]), [['restore', 'A1.1 - FIRST FLOOR PLAN']]);
    const out = await api('POST', '/api/restore/apply', { planId: plan.planId });
    assert.equal(out.ok, true, out.run.error);
    assert.equal(names()[0], 'A1.1 - FIRST FLOOR PLAN');
    const history = await api('GET', '/api/history');
    assert.equal(history.runs.find((r) => r.runId === secondRun.runId).undone.runId, out.run.runId);
  });

  await t.test('restore every original name, skipping pages renamed outside the tool', async () => {
    // Simulate a manual rename in PlanSwift after the tool's run.
    const xml = path.join(fixture.pages[2].dir, 'Data.xml');
    fs.writeFileSync(xml, fs.readFileSync(xml, 'utf8').replace('E-3 - LIGHTING PLAN LEVEL 2', 'E-3 Lighting (edited)'));
    const plan = await api('POST', '/api/restore/preview', {});
    const byId = new Map(plan.items.map((i) => [i.id, i]));
    assert.equal(byId.get(p1.id).action, 'restore');
    assert.equal(byId.get(p2.id).action, 'restore');
    assert.equal(byId.get(p3.id).action, 'skip');
    assert.match(byId.get(p3.id).reason, /outside this tool/);
    const out = await api('POST', '/api/restore/apply', { planId: plan.planId });
    assert.equal(out.ok, true, out.run.error);
    assert.deepEqual(names(), ['Page 1', 'Page 2', 'E-3 Lighting (edited)', 'Notes']);
    const history = await api('GET', '/api/history');
    assert.equal(history.originals, 1);
    assert.ok(history.runs.find((r) => r.runId === firstRun.runId));
  });

  await t.test('diagnostics run the read-only connection check', async () => {
    const report = await api('GET', '/api/diagnostics');
    const steps = new Map(report.steps.map((s) => [s.name, s]));
    assert.equal(steps.get('Job folder').ok, true);
    assert.equal(steps.get('Connect').ok, true);
    assert.equal(steps.get('Match job folder').ok, true, steps.get('Match job folder').detail);
  });
});
