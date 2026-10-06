'use strict';
// Local OCR: page decoding with sharp and text recognition with tesseract.js.
const path = require('node:path');
const sharp = require('sharp');
const { createWorker, PSM } = require('tesseract.js');
const { clean, normalizeNumber, isSheetNumber } = require('./naming');

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

function rawImage(page) {
  return sharp(page.data, { raw: { width: page.width, height: page.height, channels: page.channels } });
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

// Crops a zone, rotates it and scales it so text lands in the size range tesseract reads best.
// Extraction and rotation run as separate pipelines because sharp applies a 90-degree rotate
// ahead of extract within one pipeline.
async function cropForOcr(page, z, { mode = 'title', rotate = 0, maxSide = 3000 } = {}) {
  const r = region(page, z);
  let pipeline = rawImage(page).extract(r);
  if (rotate) {
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    pipeline = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).rotate(rotate);
  }
  const [w, h] = rotate % 180 ? [r.height, r.width] : [r.width, r.height];
  let scale;
  if (mode === 'number') scale = Math.min(4, Math.max(90, Math.min(h, 220)) / h);
  else if (mode === 'words') scale = Math.min(1, maxSide / Math.max(w, h));
  else scale = Math.min(3, Math.max(1, 900 / w), 1200 / h);
  scale = Math.min(scale, maxSide / w, maxSide / h);
  const png = await pipeline
    .resize({ width: Math.max(8, Math.round(w * scale)), kernel: scale < 1 ? 'lanczos3' : 'cubic' })
    .normalise()
    .extend({ top: 24, bottom: 24, left: 24, right: 24, background: { r: 255, g: 255, b: 255 } })
    .png({ compressionLevel: 1 })
    .toBuffer();
  return { png, scale, rect: r, pad: 24 };
}

// Tesseract reports 0 confidence whenever a character whitelist is active, so numbers are read
// plainly first and the whitelist read is used as a cross-check and fallback.
async function readNumber(png) {
  const plain = await ocr(png, { tessedit_pageseg_mode: PSM.SINGLE_LINE });
  const plainText = clean(plain.text);
  const plainNumber = normalizeNumber(plainText).number;
  const plainConfidence = Math.round(plain.confidence || 0);
  if (isSheetNumber(plainNumber) && plainConfidence >= 70) return { text: plainText, confidence: plainConfidence };
  const strict = await ocr(png, { tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: NUMBER_CHARS });
  const strictText = clean(strict.text);
  const strictNumber = normalizeNumber(strictText).number;
  if (isSheetNumber(strictNumber)) {
    if (strictNumber === plainNumber) return { text: plainText, confidence: Math.max(plainConfidence, 75) };
    return { text: strictText, confidence: Math.min(plainConfidence, 55) };
  }
  return { text: plainText || strictText, confidence: plainConfidence };
}

function scoreNumber(text, confidence) {
  const { number } = normalizeNumber(text);
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
    const { png } = await cropForOcr(page, z, { mode, rotate });
    let text;
    let confidence;
    if (isNumber) {
      ({ text, confidence } = await readNumber(png));
    } else {
      const data = await ocr(png, { tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      text = clean(data.text);
      confidence = Math.round(data.confidence || 0);
      if (!text) {
        const auto = await ocr(png, { tessedit_pageseg_mode: PSM.AUTO });
        text = clean(auto.text);
        confidence = Math.round(auto.confidence || 0);
      }
    }
    const score = isNumber ? scoreNumber(text, confidence) : (text ? 100 : 0) + confidence;
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
  loadPage, recognizeZone, recognizeWords, cropPreview, previewImage, validateZone, region, closeWorker, getWorker
};
