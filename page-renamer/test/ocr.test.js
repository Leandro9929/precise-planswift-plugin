'use strict';
// OCR and title-block detection on synthetic sheets (rendered locally, nothing is downloaded).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');
const { sheetSvg } = require('./helpers/fixtures');
const { tempDir } = require('./helpers/env');
const ocr = require('../lib/ocr');
const { detectTitleBlock } = require('../lib/detect');
const { normalizeNumber, cleanTitle } = require('../lib/naming');

const dir = tempDir('precise-ocr-');
test.after(async () => { await ocr.closeWorker(); fs.rmSync(dir, { recursive: true, force: true }); });

async function sheet(name, options, effect) {
  let img = sharp(Buffer.from(sheetSvg(options)), { limitInputPixels: false }).flatten({ background: '#fff' }).greyscale();
  if (effect === 'blur') img = sharp(await img.blur(1.6).png().toBuffer());
  if (effect === 'skew') img = sharp(await img.rotate(0.6, { background: '#fff' }).png().toBuffer());
  if (effect === 'bilevel') img = sharp(await img.threshold(160).png().toBuffer());
  const file = path.join(dir, `${name}.tif`);
  await img.tiff({ compression: 'lzw' }).toFile(file);
  return file;
}

const letters = (s) => s.replace(/[^A-Z0-9&]/gi, '').toUpperCase();

const cases = [
  ['stamp strip: issue stamp above the title, drawing up to the strip', { layout: 'stamp', number: 'A3.3', title: ['BUILDING', 'SECTIONS'], width: 7200, height: 4800 }],
  ['"CHECK SET" stamp, mixed-case title, cabinet doors', { layout: 'check', number: 'A5.2', title: ['Interior', 'Elevations'], width: 7200, height: 4800 }],
  ['vertical strip, two-line title', { layout: 'vertical', number: 'A1.1', title: ['FIRST FLOOR', 'PLAN'] }],
  ['bottom strip', { layout: 'bottom', number: 'M2.01', title: 'MECHANICAL ROOF PLAN' }],
  ['corner box without labels', { layout: 'corner', number: 'E-3', title: 'LIGHTING PLAN LEVEL 2' }],
  ['O/0 look-alike at 200 dpi', { layout: 'vertical', number: 'A0.2', title: ['COVER SHEET'], width: 7200, height: 4800 }],
  ['blurred scan', { layout: 'vertical', number: 'A5.2', title: ['ENLARGED RESTROOM', 'PLANS AND ELEVATIONS'] }, 'blur'],
  ['skewed scan', { layout: 'bottom', number: 'A-101', title: 'DOOR & WINDOW SCHEDULES' }, 'skew'],
  ['1-bit scan, number beside a border', { layout: 'corner', number: 'FP-1.01', title: 'FIRE PROTECTION PLAN' }, 'bilevel'],
  ['1-bit 200 dpi', { layout: 'vertical', number: 'E0.01', title: ['ELECTRICAL', 'SYMBOLS LEGEND'], width: 7200, height: 4800 }, 'bilevel']
];

for (const [label, options, effect] of cases) {
  test(`detects number and title: ${label}`, { timeout: 120000 }, async () => {
    const page = await ocr.loadPage(await sheet(label.replace(/\W+/g, '-'), options, effect));
    const found = await detectTitleBlock(page);
    const title = [].concat(options.title).join(' ');
    assert.equal(found.number, options.number);
    assert.equal(letters(found.title), letters(title));
    // Zeros read as letter O are corrected but left for review on purpose.
    if (!/O/.test(found.numberRaw)) assert.ok(found.numberConfidence >= 60, `number confidence ${found.numberConfidence}`);
    assert.ok(found.numberZone && found.titleZone);
  });
}

test('reads user-drawn boxes, including a vertical number', { timeout: 120000 }, async () => {
  const file = await sheet('zones', { layout: 'vertical', number: 'S-201', title: ['FOUNDATION PLAN'] });
  const page = await ocr.loadPage(file);
  const number = await ocr.recognizeZone(page, { x: 0.866, y: 0.928, w: 0.11, h: 0.05 }, 'number');
  assert.equal(normalizeNumber(number.text).number, 'S-201');
  const title = await ocr.recognizeZone(page, { x: 0.866, y: 0.79, w: 0.12, h: 0.035 }, 'title');
  assert.equal(cleanTitle(title.text), 'FOUNDATION PLAN');
  // Same sheet rotated a quarter turn: the number now runs vertically.
  const turned = path.join(dir, 'turned.tif');
  await sharp(file).rotate(270).tiff({ compression: 'lzw' }).toFile(turned);
  const sideways = await ocr.loadPage(turned);
  const vertical = await ocr.recognizeZone(sideways, { x: 0.928, y: 0.024, w: 0.05, h: 0.11 }, 'number');
  assert.equal(normalizeNumber(vertical.text).number, 'S-201');
  assert.notEqual(vertical.rotation, 0);
});

test('reads a sheet number inside a revision cloud with a delta tag', { timeout: 180000 }, async () => {
  const file = await sheet('cloud', { layout: 'cloud', number: 'A2.6', title: ['FIRST FLOOR', 'LIGHTING PLAN'], width: 7200, height: 4800 });
  const page = await ocr.loadPage(file);
  // Boxes drawn around the cloud, tight on the number, loose, and shifted as on another page.
  for (const z of [{ x: 0.875, y: 0.895, w: 0.11, h: 0.07 }, { x: 0.895, y: 0.91, w: 0.07, h: 0.035 },
    { x: 0.87, y: 0.88, w: 0.12, h: 0.095 }, { x: 0.88, y: 0.905, w: 0.11, h: 0.07 }]) {
    const read = await ocr.recognizeZone(page, z, 'number');
    assert.equal(normalizeNumber(read.text).number, 'A2.6', JSON.stringify(z));
    assert.ok(read.confidence >= 60, `confidence ${read.confidence}`);
  }
  const found = await detectTitleBlock(page);
  assert.equal(found.number, 'A2.6');
  assert.equal(found.title, 'FIRST FLOOR LIGHTING PLAN');
});

test('a box that misses is searched around, never across the drawing', { timeout: 180000 }, async () => {
  const { readPage } = require('../lib/scan');
  const file = await sheet('cloud-shift', { layout: 'cloud', number: 'E1.1', title: ['FIRST FLOOR', 'LIGHTING PLAN'], width: 7200, height: 4800 }, 'bilevel');
  const options = { mode: 'zones', titleZone: null, autoFallback: true, naming: {} };
  const near = await readPage(file, { ...options, numberZone: { x: 0.887, y: 0.885, w: 0.11, h: 0.07 } });
  assert.equal(near.number, 'E1.1');
  // A box over the drawing, next to feet-inch dimensions: nothing is better than a dimension.
  const off = await readPage(file, { ...options, numberZone: { x: 0.6, y: 0.6, w: 0.06, h: 0.03 } });
  assert.ok(!/^[A-Z]{1,3}-?\d/.test(off.number), `read "${off.number}" from the drawing`);
});

test('rejects malformed zones', () => {
  assert.throws(() => ocr.validateZone(null), /Draw/);
  assert.throws(() => ocr.validateZone({ x: 0.9, y: 0.9, w: 0.5, h: 0.05 }), /Invalid/);
});
