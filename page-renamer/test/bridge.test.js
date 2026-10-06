'use strict';
// Runs the real bridge scripts (manifest.ps1, apply.ps1) against a fixture job folder and the
// mock PlanSwift COM object. Skipped when no PowerShell is installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makePlanSwiftRoot, readPageName } = require('./helpers/fixtures');
const { findPowerShell, useMock, tempDir } = require('./helpers/env');
const { Bridge } = require('../lib/bridge');

const powershell = findPowerShell();

test('bridge scripts', { skip: !powershell && 'PowerShell not available', timeout: 300000 }, async (t) => {
  const root = tempDir('precise-bridge-');
  const fixture = await makePlanSwiftRoot(root, [
    { name: 'Page 1' }, { name: 'Page 2' }, { name: 'Page 3' }, { name: 'Ünïcode – page', folder: 'Unicode page' }
  ]);
  // A thumbnail next to the sheet image must not be picked as the page image.
  fs.writeFileSync(path.join(fixture.pages[0].dir, 'Page.tif'), Buffer.alloc(5000));
  fs.writeFileSync(path.join(fixture.pages[0].dir, 'thumb.png'), Buffer.alloc(100));
  const restoreEnv = useMock(fixture.pagesDir);
  const log = path.join(root, 'mock.log');
  process.env.PRECISE_MOCK_LOG = log;
  const bridge = new Bridge({ tmpDir: path.join(root, 'tmp') });
  const names = () => fixture.pages.map((p) => readPageName(p.dir));
  const ids = fixture.pages.map((p) => p.id);
  t.after(() => { restoreEnv(); fs.rmSync(root, { recursive: true, force: true }); });

  await t.test('manifest lists pages in order with UTF-8 names and the full-size image', async () => {
    const m = await bridge.manifest(root);
    assert.equal(m.job, 'Fixture Job');
    assert.equal(m.jobGuid, '{0B0B0B0B-1111-2222-3333-444444444444}');
    assert.deepEqual(m.pages.map((p) => p.name), ['Page 1', 'Page 2', 'Page 3', 'Ünïcode – page']);
    assert.match(m.pages[0].image, /Page\.tif$/);
    assert.equal(m.pages[1].image, '');
  });

  await t.test('manifest explains a missing PlanSwift data folder', async () => {
    await assert.rejects(bridge.manifest(path.join(root, 'nowhere')), /PlanSwift data not found in .*nowhere/);
  });

  await t.test('renames through COM with a change group and confirms each page', async () => {
    fs.rmSync(log, { force: true });
    const out = await bridge.apply([
      { id: ids[0], oldName: 'Page 1', newName: 'A1.1 - PLAN' },
      { id: ids[3], oldName: 'Ünïcode – page', newName: 'A9 – Ünïcode' }
    ], { label: 'Test' });
    assert.equal(out.report.ok, true, out.error);
    assert.deepEqual(out.report.results.map((r) => r.status), ['renamed', 'renamed']);
    assert.deepEqual(out.progress.filter((p) => p.id).map((p) => p.name), ['A1.1 - PLAN', 'A9 – Ünïcode']);
    assert.deepEqual(out.progress.filter((p) => p.phase).map((p) => p.phase).slice(0, 2), ['connecting to PlanSwift', 'finding the pages in the open job']);
    assert.deepEqual(names(), ['A1.1 - PLAN', 'Page 2', 'Page 3', 'A9 – Ünïcode']);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls[0], 'NewChangeGroup Test');
    assert.equal(calls.at(-1), 'PostChanges');
  });

  const rollbackCases = [
    ['PlanSwift error on the last page', { PRECISE_MOCK_FAIL_ON: 'B3' }, /Mock failure renaming to B3/],
    ['PlanSwift stores a different name', { PRECISE_MOCK_ALTER_ON: 'B2' }, /stored 'B2 \(2\)' instead of 'B2'/],
    ['the page scale changes', { PRECISE_MOCK_MUTATE_ON: 'B2' }, /Scale/],
    ['takeoff quantities change', { PRECISE_MOCK_QTY_ON: 'B2' }, /Takeoff quantities changed/]
  ];
  for (const [label, env, message] of rollbackCases) {
    await t.test(`rolls back when ${label}`, async () => {
      Object.assign(process.env, env);
      try {
        const out = await bridge.apply([
          { id: ids[1], oldName: 'Page 2', newName: 'B2' },
          { id: ids[2], oldName: 'Page 3', newName: 'B3' }
        ]);
        assert.equal(out.report.ok, false);
        assert.equal(out.report.rolledBack, true);
        assert.match(out.error, message);
        assert.deepEqual(names().slice(1, 3), ['Page 2', 'Page 3']);
        assert.ok(out.report.results.every((r) => ['restored', 'not-attempted'].includes(r.status)));
      } finally {
        for (const k of Object.keys(env)) delete process.env[k];
      }
    });
  }

  await t.test('refuses to write when a page name changed since the preview', async () => {
    fs.rmSync(log, { force: true });
    const out = await bridge.apply([{ id: ids[1], oldName: 'Page 2 (old)', newName: 'B2' }]);
    assert.equal(out.report.ok, false);
    assert.match(out.error, /is now named 'Page 2'/);
    assert.equal(fs.existsSync(log), false, 'no COM writes happened');
  });

  await t.test('refuses unknown pages and unsafe names before connecting', async () => {
    const missing = await bridge.apply([{ id: '{DEADBEEF-0000-0000-0000-000000000000}', oldName: 'X', newName: 'Y' }]);
    assert.match(missing.error, /not found in the job/);
    const unsafe = await bridge.apply([{ id: ids[1], oldName: 'Page 2', newName: 'A/B' }]);
    assert.match(unsafe.error, /cannot store/);
    const dup = await bridge.apply([{ id: ids[1], oldName: 'Page 2', newName: 'Same' }, { id: ids[2], oldName: 'Page 3', newName: 'same' }]);
    assert.match(dup.error, /both be named/);
  });

  await t.test('takeoff checks stay within their time limit on a large, slow job', async () => {
    Object.assign(process.env, { PRECISE_MOCK_TAKEOFF_ITEMS: '3000', PRECISE_MOCK_QTY_DELAY_MS: '5' });
    const started = Date.now();
    try {
      const out = await bridge.apply([{ id: ids[1], oldName: 'Page 2', newName: 'B2' }], { takeoffSeconds: 2 });
      assert.equal(out.report.ok, true, out.error);
      assert.equal(out.report.takeoffComplete, false);
      assert.ok(out.report.takeoffItems > 10);
      assert.ok(out.report.timings.some((s) => s.phase === 'reading takeoff quantities'));
    } finally {
      delete process.env.PRECISE_MOCK_TAKEOFF_ITEMS;
      delete process.env.PRECISE_MOCK_QTY_DELAY_MS;
    }
    assert.ok(Date.now() - started < 30000, `took ${Date.now() - started} ms`);
    await bridge.apply([{ id: ids[1], oldName: 'B2', newName: 'Page 2' }]);
  });

  await t.test('a PlanSwift that stops answering is reported with the step it stopped in', async () => {
    Object.assign(process.env, { PRECISE_MOCK_HANG_ON: 'NewChangeGroup', PRECISE_APPLY_TIMEOUT_MS: '10000' });
    try {
      const out = await bridge.apply([{ id: ids[1], oldName: 'Page 2', newName: 'B2' }]);
      assert.equal(out.report, null);
      assert.match(out.error, /did not answer within 10 seconds\. It stopped while starting the PlanSwift change group\./);
      assert.equal(names()[1], 'Page 2');
    } finally {
      delete process.env.PRECISE_MOCK_HANG_ON;
      delete process.env.PRECISE_APPLY_TIMEOUT_MS;
    }
  });

  await t.test('probe reports a match between COM and the job folder', async () => {
    const m = await bridge.manifest(root);
    const report = await bridge.probe(m.pages);
    assert.equal(report.ok, true, JSON.stringify(report.steps));
    assert.ok(report.firstPageProperties.Scale);
  });
});
