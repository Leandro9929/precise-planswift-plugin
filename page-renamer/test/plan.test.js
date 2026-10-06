'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { orderRenames, undoPlan, restoreAllPlan } = require('../lib/plan');

const pages = [{ id: 'a', name: 'A1' }, { id: 'b', name: 'A2' }, { id: 'c', name: 'A3' }, { id: 'd', name: 'Cover' }];

test('orders renames so a freed name can be reused in the same batch', () => {
  const ordered = orderRenames([
    { id: 'a', oldName: 'A1', newName: 'A2' },
    { id: 'b', oldName: 'A2', newName: 'A3' },
    { id: 'c', oldName: 'A3', newName: 'A4' }
  ], pages);
  assert.deepEqual(ordered.map((c) => c.id), ['c', 'b', 'a']);
});

test('refuses swaps, duplicates, taken names and invalid names', () => {
  assert.throws(() => orderRenames([{ id: 'a', oldName: 'A1', newName: 'A2' }, { id: 'b', oldName: 'A2', newName: 'A1' }], pages), /swap/);
  assert.throws(() => orderRenames([{ id: 'a', oldName: 'A1', newName: 'X' }, { id: 'b', oldName: 'A2', newName: 'x' }], pages), /both be named/);
  assert.throws(() => orderRenames([{ id: 'a', oldName: 'A1', newName: 'cover' }], pages), /already the name/);
  assert.throws(() => orderRenames([{ id: 'a', oldName: 'A1', newName: 'A/1' }], pages), /contains/);
  assert.deepEqual(orderRenames([{ id: 'a', oldName: 'A1', newName: 'a1' }], pages).map((c) => c.id), ['a']);
});

test('undo plan restores only pages that still carry the run name', () => {
  const run = { changes: [
    { id: 'a', oldName: 'Page 1', newName: 'A1', currentName: 'A1' },
    { id: 'b', oldName: 'Page 2', newName: 'A2', currentName: 'A2' },
    { id: 'c', oldName: 'Page 3', newName: 'A3', currentName: 'Page 3' },
    { id: 'z', oldName: 'Gone', newName: 'Z', currentName: 'Z' }
  ] };
  const live = [{ id: 'a', name: 'A1' }, { id: 'b', name: 'A2 edited' }, { id: 'c', name: 'Page 3' }, { id: 'e', name: 'Page 1' }];
  const plan = undoPlan(run, live);
  assert.deepEqual(plan.map((i) => [i.id, i.action]), [['a', 'skip'], ['b', 'skip'], ['z', 'skip']]);
  assert.match(plan[0].reason, /now used by another page/);
  assert.match(plan[1].reason, /Renamed since/);
  assert.match(plan[2].reason, /no longer exists/);
});

test('restore-all plan uses the original-name ledger', () => {
  const ledger = { pages: { a: { original: 'Page 1', current: 'A1' }, b: { original: 'Page 2', current: 'A2' }, c: { original: 'Page 3', current: 'A3' } } };
  const live = [{ id: 'a', name: 'A1' }, { id: 'b', name: 'Page 2' }, { id: 'c', name: 'Manual' }];
  const plan = restoreAllPlan(ledger, live);
  assert.deepEqual(plan.map((i) => [i.id, i.action, i.target]), [['a', 'restore', 'Page 1'], ['c', 'skip', 'Page 3']]);
});
