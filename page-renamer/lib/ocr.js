'use strict';
// Local OCR: page decoding with sharp and text recognition with tesseract.js.
const path = require('node:path');
const sharp = require('sharp');
const { createWorker, PSM } = require('tesseract.js');
const { clean, normalizeNumber, isSheetNumber } = require('./naming');
const { isolateNumber } = require('./glyphs');

const base = path.join(__dirname, '..');
const LIMIT_PIXELS = 0x10000000; // 268 MP, enough for 48x36 in sheets at 400 dpi
const NUMBER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-';

sharp.cache({ memory: 256, items: 20 });

let workerPromise = null;
let queue = Promise.resolve();

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      langPath: path.join(base, 'assets'),
      gzip: false,
      cacheMethod: 'none',
      workerPath: require.resolve('tesseract.js/src/worker-script/node/index.js'),
      corePath: path.dirname(require.resolve('tesseract.js-core/package.json'))
    }).catch((error) => { workerPromise = null; throw error; });
  }
  return workerPromise;
}

async function closeWorker() {
  const pending = workerPromise;
  workerPromise = null;
  if (pending) await (await pending).terminate();
}

// One tesseract worker is shared; parameters and recognition must not interleave between callers.
function exclusive(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function ocr(png, params, output) {
  return exclusive(async () => {
    const worker = await getWorker();
    await worker.setParameters({
      tessedit_char_whitelist: '',
      preserve_interword_spaces: '0',
      user_defined_dpi: '300',
      ...params
    });
    const result = await worker.recognize(png, {}, output || { text: true });
    return result.data;
  });
}

// Decodes a page image once to 8-bit greyscale so several regions can be cut cheaply.
async function loadPage(file) {
  const { data, info } = await sharp(file, { limitInputPixels: LIMIT_PIXELS, failOn: 'none' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height) throw Error('Image dimensions unavailable');
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function validateZone(z) {
  if (!z || !['x', 'y', 'w', 'h'].every((k) => Number.isFinite(z[k]))) throw Error('Draw the sheet number box first.');
  if (z.x < 0 || z.y < 0 || z.w < 0.002 || z.h < 0.002 || z.x + z.w > 1.001 || z.y + z.h > 1.001) {
    throw Error('Invalid title block region.');
  }
}

function region(page, z) {
  const left = Math.min(page.width - 1, Math.max(0, Math.floor(z.x * page.width)));
  const top = Math.min(page.height - 1, Math.max(0, Math.floor(z.y * page.height)));
  return {
    left,
    top,
    width: Math.max(1, Math.min(page.width - left, Math.ceil(z.w * page.width))),
    height: Math.max(1, Math.min(page.height - top, Math.ceil(z.h * page.height)))
  };
}

// Cuts a region out of the decoded page as 8-bit greyscale, turned by 0/90/180/270 degrees
// clockwise. Done in JS so the channel count stays 1 (sharp re-encodes raw greyscale as RGB).
function cropGray(page, r, rotate = 0) {
  const { width: W, channels: ch } = page;
  const out = Buffer.alloc(r.width * r.height);
  for (let y = 0; y < r.height; y++) {
    const row = (r.top + y) * W;
    for (let x = 0; x < r.width; x++) out[y * r.width + x] = page.data[(row + r.left + x) * ch];
  }
  if (!rotate) return { data: out, w: r.width, h: r.height };
  const w = r.width;
  const h = r.height;
  if (rotate === 180) {
    const turned = Buffer.alloc(w * h);
    for (let i = 0; i < w * h; i++) turned[w * h - 1 - i] = out[i];
    return { data: turned, w, h };
  }
  const turned = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 90: (x, y) -> (h - 1 - y, x); 270: (x, y) -> (y, w - 1 - x). New width is h.
      const [nx, ny] = rotate === 90 ? [h - 1 - y, x] : [y, w - 1 - x];
      turned[ny * h + nx] = out[y * w + x];
    }
  }
  return { data: turned, w: h, h: w };
}

async function encode(gray, w, h, scale) {
  return sharp(gray, { raw: { width: w, height: h, channels: 1 } })
    .resize({ width: Math.max(8, Math.round(w * scale)), kernel: scale < 1 ? 'lanczos3' : 'cubic' })
    .normalise()
    .extend({ top: 24, bottom: 24, left: 24, right: 24, background: { r: 255, g: 255, b: 255 } })
    .png({ compressionLevel: 1 })
    .toBuffer();
}

// Crops a zone, rotates it and scales it so text lands in the size range tesseract reads best.
async function cropForOcr(page, z, { mode = 'title', rotate = 0, maxSide = 3000 } = {}) {
  const r = region(page, z);
  const { data, w, h } = cropGray(page, r, rotate);
  let scale;
  if (mode === 'number') scale = Math.min(4, Math.max(90, Math.min(h, 220)) / h);
  else if (mode === 'words') scale = Math.min(1, maxSide / Math.max(w, h));
  else scale = Math.min(3, Math.max(1, 900 / w), 1200 / h);
  scale = Math.min(scale, maxSide / w, maxSide / h);
  return { png: await encode(data, w, h, scale), scale, rect: r, pad: 24 };
}

// The number's own glyphs only (no cloud, frame, delta tag or label), cropped to the text row.
async function isolatedNumberPng(page, z, rotate) {
  const { data, w, h } = cropGray(page, region(page, z), rotate);
  const found = isolateNumber(data, w, h);
  if (!found) return null;
  const { top, bottom, left, right } = found.band;
  const bandH = bottom - top + 1;
  const m = Math.round(bandH * 0.3);
  const x0 = Math.max(0, Math.floor(left) - m);
  const y0 = Math.max(0, top - m);
  const x1 = Math.min(w - 1, Math.ceil(right) + m);
  const y1 = Math.min(h - 1, bottom + m);
  const cw = x1 - x0 + 1;
  const chh = y1 - y0 + 1;
  const cut = Buffer.alloc(cw * chh);
  for (let y = 0; y < chh; y++) found.data.copy(cut, y * cw, (y0 + y) * w + x0, (y0 + y) * w + x0 + cw);
  const scale = Math.min(4, Math.max(0.3, 90 / bandH));
  return encode(cut, cw, chh, scale);
}

async function readText(png, whitelist) {
  const data = await ocr(png, whitelist
    ? { tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: NUMBER_CHARS }
    : { tessedit_pageseg_mode: PSM.SINGLE_LINE });
  const text = clean(data.text);
  const number = normalizeNumber(text).number;
  // Tesseract reports 0 confidence whenever a character whitelist is active.
  return { text, number, valid: isSheetNumber(number), confidence: whitelist ? null : Math.round(data.confidence || 0) };
}

// Chooses among several reads of the same box. Reads of the isolated glyphs count more, a
// reading that is the other with a stray leading letter ("CA2.6" vs "A2.6") loses to it, and a
// reading cut short ("A2" vs "A2.6") loses to the complete one.
function chooseNumber(reads) {
  const votes = new Map();
  for (const r of reads) {
    if (!r.valid) continue;
    const v = votes.get(r.number) || { number: r.number, score: 0, confidence: null, text: r.text, isolated: false };
    v.score += (r.confidence ?? 40) + (r.isolated ? 15 : 0);
    if (r.confidence !== null && (v.confidence === null || r.confidence > v.confidence)) { v.confidence = r.confidence; v.text = r.text; }
    v.isolated = v.isolated || r.isolated;
    votes.set(r.number, v);
  }
  const ranked = [...votes.values()].sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  let best = ranked[0];
  for (const other of ranked.slice(1)) {
    if (other.score < best.score * 0.5) continue;
    const longer = other.number.length > best.number.length && other.number.startsWith(best.number) && /^[.\-]?\d/.test(other.number.slice(best.number.length));
    const stray = best.number.length === other.number.length + 1 && best.number.endsWith(other.number) && /^[A-Z]/.test(best.number);
    if (longer || stray) best = other;
  }
  const rivals = ranked.filter((v) => v !== best && v.score >= best.score * 0.5
    && !(best.number.endsWith(v.number) || v.number.endsWith(best.number) || best.number.startsWith(v.number)));
  let confidence = best.confidence ?? 55;
  if (rivals.length) confidence = Math.min(confidence, 59);
  return { text: best.text, number: best.number, confidence };
}

async function readNumber(page, z, rotate) {
  const reads = [];
  const isolated = await isolatedNumberPng(page, z, rotate);
  if (isolated) reads.push({ ...(await readText(isolated, false)), isolated: true });
  const { png } = await cropForOcr(page, z, { mode: 'number', rotate });
  reads.push({ ...(await readText(png, false)), isolated: false });
  const confident = reads.some((r) => r.valid && r.confidence >= 75);
  if (!confident) {
    if (isolated) reads.push({ ...(await readText(isolated, true)), isolated: true });
    reads.push({ ...(await readText(png, true)), isolated: false });
  }
  const chosen = chooseNumber(reads);
  if (chosen) return chosen;
  const fallback = reads.find((r) => r.text) || reads[0];
  return { text: fallback.text, number: fallback.number, confidence: fallback.confidence || 0 };
}

function scoreNumber(number, confidence) {
  return (isSheetNumber(number) ? 100 : 0) + confidence;
}

// Reads one zone. Numbers that do not look like a sheet number are retried on their side
// (title blocks printed vertically).
async function recognizeZone(page, z, mode, { rotations } = {}) {
  validateZone(z);
  const isNumber = mode === 'number';
  const r = region(page, z);
  const tall = r.height > r.width * 1.6;
  const order = rotations || (tall ? [90, 270, 0] : [0, 90, 270]);
  let best = null;
  for (const rotate of order) {
    let text;
    let confidence;
    let score;
    if (isNumber) {
      const read = await readNumber(page, z, rotate);
      ({ text, confidence } = read);
      score = scoreNumber(read.number, confidence);
    } else {
      const { png } = await cropForOcr(page, z, { mode, rotate });
      const data = await ocr(png, { tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      text = clean(data.text);
      confidence = Math.round(data.confidence || 0);
      if (!text) {
        const auto = await ocr(png, { tessedit_pageseg_mode: PSM.AUTO });
        text = clean(auto.text);
        confidence = Math.round(auto.confidence || 0);
      }
      score = (text ? 100 : 0) + confidence;
    }
    if (!best || score > best.score) best = { text, confidence, rotation: rotate, score };
    if (isNumber ? score >= 160 : (score >= 160 || (!tall && text))) break;
  }
  return { text: best.text, confidence: best.confidence, rotation: best.rotation };
}

// Word boxes for a zone, mapped back to page fractions.
async function recognizeWords(page, z, { maxSide = 2600, rotate = 0 } = {}) {
  const { png, scale, rect, pad } = await cropForOcr(page, z, { mode: 'words', maxSide, rotate });
  const data = await ocr(png, { tessedit_pageseg_mode: PSM.SPARSE_TEXT }, { text: true, blocks: true });
  const toPage = (b) => {
    const x0 = (b.x0 - pad) / scale;
    const y0 = (b.y0 - pad) / scale;
    const x1 = (b.x1 - pad) / scale;
    const y1 = (b.y1 - pad) / scale;
    let box;
    if (rotate === 90) box = { x0: y0, y0: rect.height - x1, x1: y1, y1: rect.height - x0 };
    else if (rotate === 270) box = { x0: rect.width - y1, y0: x0, x1: rect.width - y0, y1: x1 };
    else box = { x0, y0, x1, y1 };
    return {
      x: (rect.left + Math.max(0, box.x0)) / page.width,
      y: (rect.top + Math.max(0, box.y0)) / page.height,
      w: Math.max(1, box.x1 - box.x0) / page.width,
      h: Math.max(1, box.y1 - box.y0) / page.height
    };
  };
  const lines = [];
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const words = (line.words || [])
          .filter((w) => clean(w.text))
          .map((w) => ({ text: clean(w.text), confidence: Math.round(w.confidence || 0), box: toPage(w.bbox) }));
        if (words.length) lines.push({ text: words.map((w) => w.text).join(' '), words, box: toPage(line.bbox) });
      }
    }
  }
  return lines;
}

// Small preview of a zone for the review table.
async function cropPreview(file, z, width = 360) {
  validateZone(z);
  const meta = await sharp(file, { limitInputPixels: LIMIT_PIXELS, failOn: 'none' }).metadata();
  const page = { width: meta.width, height: meta.height };
  const r = region(page, z);
  return sharp(file, { limitInputPixels: LIMIT_PIXELS, failOn: 'none' })
    .extract(r)
    .greyscale()
    .resize({ width: Math.min(width, Math.max(40, r.width)), withoutEnlargement: false })
    .png()
    .toBuffer();
}

async function previewImage(file, width) {
  return sharp(file, { limitInputPixels: LIMIT_PIXELS, failOn: 'none' })
    .resize({ width, withoutEnlargement: true })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

module.exports = {
  cropGray, loadPage, recognizeZone, recognizeWords, cropPreview, previewImage, validateZone, region, closeWorker, getWorker
};
