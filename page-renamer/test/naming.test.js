'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const n = require('../lib/naming');

test('normalizes OCR sheet numbers and flags look-alike corrections', () => {
  const cases = [
    ['A1.1', 'A1.1', false], ['AO.2', 'A0.2', true], ['a 1 . 1', 'A1.1', false], ['A-1O1', 'A-101', true],
    ['S-2.0l', 'S-2.01', true], ['FP-2.01', 'FP-2.01', false], ['M2.1A', 'M2.1A', false], ['AI01', 'A101', true],
    ['A1,1', 'A1.1', false], ['PL-1', 'PL-1', false], ['SHEET NO. A-201', 'A-201', false], ['DWG NO: E0.01', 'E0.01', false],
    ['M-401 |', 'M-401', false], ['| A1.1', 'A1.1', false], ['A-101 1', 'A-101', false], ['SHEET 3 OF 10', '3', false],
    ['A — 101', 'A-101', false], ['C 1.0', 'C1.0', false],
    // Feet-inch dimensions are never sheet numbers.
    ["9'-9\"", '', false], ["g'-9!", '', false], ["12'-0\" A2.6", 'A2.6', false], ['A2.6"', 'A2.6', false]
  ];
  for (const [raw, number, corrected] of cases) {
    assert.deepEqual(n.normalizeNumber(raw), { number, corrected }, raw);
  }
});

test('recognizes sheet number shapes', () => {
  for (const s of ['A1.1', 'A-101', 'A101', 'FP-2.01', 'M2.1A', 'E0.01', 'S-1', 'C1.0', 'ID-1.1']) assert.ok(n.isSheetNumber(s), s);
  for (const s of ['1/4', '2026-041', 'SCALE', 'ABCD1', '']) assert.ok(!n.isSheetNumber(s), s);
  assert.ok(n.isNumericSheet('3') && n.isNumericSheet('12.1'));
});

test('cleans titles and builds names from templates', () => {
  assert.equal(n.cleanTitle('SHEET TITLE: FIRST FLOOR PLAN / RCP'), 'FIRST FLOOR PLAN - RCP');
  assert.equal(n.cleanTitle('DRAWING TITLE  "ROOF PLAN"'), 'ROOF PLAN');
  assert.equal(n.buildName('A1.1', 'FIRST FLOOR PLAN'), 'A1.1 - FIRST FLOOR PLAN');
  assert.equal(n.buildName('A1.1', 'first floor plan and hvac level 2', { titleCase: 'title' }), 'A1.1 - First Floor Plan and HVAC Level 2');
  assert.equal(n.buildName('A1.1', 'Floor plan', { titleCase: 'upper', template: 'number-space-title' }), 'A1.1 FLOOR PLAN');
  assert.equal(n.buildName('A1.1', 'FLOOR', { template: 'number' }), 'A1.1');
  assert.equal(n.buildName('', 'FLOOR PLAN'), 'FLOOR PLAN');
  assert.equal(n.buildName('A1.1', ''), 'A1.1');
  assert.equal(n.buildName('A1.1', 'PLAN', { template: '{title} ({number})' }), 'PLAN (A1.1)');
  const long = n.buildName('A1.1', 'WORD '.repeat(40));
  assert.ok(long.length <= n.MAX_NAME && !long.endsWith(' '));
  assert.equal(n.validateName(n.buildName('A1.1', 'NOTES.')), '');
});

test('validates names PlanSwift and Windows can store', () => {
  assert.equal(n.validateName('A1.1 - FLOOR PLAN'), '');
  for (const bad of ['', 'A/B', 'A\\B', 'A:B', 'A*', 'A?', 'A"B', 'A<B', 'A|B', ' A', 'A ', 'A1.', 'CON', 'lpt1', 'x'.repeat(121), 'A\u0007']) {
    assert.notEqual(n.validateName(bad), '', JSON.stringify(bad));
  }
});
