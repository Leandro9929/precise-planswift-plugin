'use strict';
// Reads sheet numbers and titles for a list of pages and proposes PlanSwift names.
const crypto = require('node:crypto');
const ocr = require('./ocr');
const { detectTitleBlock, findNumberIn } = require('./detect');
const { normalizeNumber, isSheetNumber, isNumericSheet, cleanTitle, buildName, validateName, nameKey, clean } = require('./naming');

const LOW = 60;

// The box grown by its own size on every side, kept on the sheet.
function around(z) {
  const x = Math.max(0, z.x - z.w);
  const y = Math.max(0, z.y - z.h);
  return { x, y, w: Math.min(1, z.x + 2 * z.w) - x, h: Math.min(1, z.y + 2 * z.h) - y };
}

function validNumber(n) {
  return isSheetNumber(n) || isNumericSheet(n);
}

// options: { mode: 'auto' | 'zones', numberZone, titleZone, autoFallback, titles, naming }
async function readPage(file, options) {
  const page = await ocr.loadPage(file);
  const out = { raw: '', number: '', title: '', numberConfidence: 0, titleConfidence: 0, numberZone: null, titleZone: null, source: options.mode };
  if (options.mode === 'zones') {
    const num = await ocr.recognizeZone(page, options.numberZone, 'number');
    out.raw = num.text;
    out.number = normalizeNumber(num.text).number;
    out.numberConfidence = num.confidence;
    out.numberZone = options.numberZone;
    if (options.titleZone) {
      const title = await ocr.recognizeZone(page, options.titleZone, 'title');
      out.title = cleanTitle(title.text);
      out.titleConfidence = title.confidence;
      out.titleZone = options.titleZone;
    }
    const weak = !validNumber(out.number) || out.numberConfidence < LOW;
    if (!(weak && options.autoFallback)) return out;
    // Search only around the box (the same title block, shifted or partly covered); the rest of
    // the sheet is full of dimensions and callouts that look like sheet numbers.
    const found = await findNumberIn(page, around(options.numberZone));
    if (!found) return out;
    if (found.number === out.number) {
      // The box was right; the second look only confirms it.
      out.numberConfidence = Math.max(out.numberConfidence, found.numberConfidence);
      return out;
    }
    if (validNumber(out.number) && found.numberConfidence <= out.numberConfidence) return out;
    out.source = 'found near the box';
    out.boxZone = options.numberZone;
    out.raw = found.numberRaw || found.number;
    out.number = found.number;
    out.numberConfidence = found.numberConfidence;
    out.numberZone = found.numberZone;
    return out;
  }
  const found = await detectTitleBlock(page);
  return { ...out, ...found, raw: found.numberRaw || found.number, source: 'auto' };
}

// Warnings leave a row unchecked for review; notes are shown but do not block.
function rowWarnings(row, read, options, notes = []) {
  const warnings = [];
  if (!row.number) warnings.push('Sheet number not found');
  else if (!isSheetNumber(row.number)) warnings.push('Unusual sheet number');
  const { corrected } = normalizeNumber(read.raw);
  if (row.number && corrected) {
    const text = `OCR read "${clean(read.raw)}"; corrected to ${row.number}`;
    if (read.numberConfidence >= 75) notes.push(text);
    else warnings.push(`${text}; check it`);
  }
  if (row.number && read.numberConfidence < LOW) warnings.push('Low confidence sheet number');
  if (options.titles && !row.title) warnings.push('Title not found');
  else if (options.titles && row.title && read.titleConfidence < LOW) warnings.push('Low confidence title');
  if (read.source === 'found near the box') warnings.push('Box missed; number found next to it');
  const reason = row.newName ? validateName(row.newName) : 'No name proposed';
  if (reason) warnings.push(reason);
  return warnings;
}

function markDuplicates(rows, pages) {
  const counts = new Map();
  for (const r of rows) if (r.newName) counts.set(nameKey(r.newName), (counts.get(nameKey(r.newName)) || 0) + 1);
  // Two sheets with one number is almost always a misread, even when the titles differ.
  const numbers = new Map();
  for (const r of rows) if (r.number) numbers.set(r.number, (numbers.get(r.number) || 0) + 1);
  const scanned = new Set(rows.map((r) => r.id));
  const others = new Map(pages.filter((p) => !scanned.has(p.id)).map((p) => [nameKey(p.name), p]));
  for (const r of rows) {
    if (!r.newName) continue;
    const key = nameKey(r.newName);
    const dupes = r.warnings.filter((w) => !/^Duplicate|^Already used|^Same sheet number/.test(w));
    if (counts.get(key) > 1) dupes.push('Duplicate proposed name');
    else if (r.number && numbers.get(r.number) > 1) dupes.push('Same sheet number as another sheet');
    else if (others.has(key)) dupes.push(`Already used by page "${others.get(key).name}"`);
    r.warnings = dupes;
    r.apply = !r.error && !r.warnings.length && r.newName !== r.oldName;
  }
}

class ScanJob {
  constructor(manifest, pages, options) {
    this.id = crypto.randomUUID();
    this.manifest = manifest;
    this.pages = pages;
    this.options = options;
    this.state = 'running';
    this.done = 0;
    this.total = pages.length;
    this.rows = [];
    this.error = '';
    this.cancelled = false;
    this.created = Date.now();
  }

  async run() {
    const { options } = this;
    try {
      for (const p of this.pages) {
        if (this.cancelled) break;
        const row = { id: p.id, oldName: p.name, order: p.order, number: '', title: '', newName: '', warnings: [], apply: false };
        try {
          if (!p.image) throw Error('This page has no image file in the job folder');
          const read = await readPage(p.image, options);
          row.number = read.number;
          row.title = read.title;
          row.numberConfidence = read.numberConfidence;
          row.titleConfidence = read.titleConfidence;
          row.numberZone = read.numberZone;
          row.titleZone = read.titleZone;
          row.source = read.source;
          row.boxZone = read.boxZone || null;
          row.newName = buildName(row.number, options.titles ? row.title : '', options.naming);
          row.notes = [];
          row.warnings = rowWarnings(row, read, options, row.notes);
        } catch (e) {
          row.error = /unsupported image format|Input file contains unsupported|pdf/i.test(e.message)
            ? 'Page image format not supported (PDF page?)'
            : e.message;
        }
        this.rows.push(row);
        this.done++;
      }
      markDuplicates(this.rows, this.manifest.pages);
      this.state = this.cancelled ? 'cancelled' : 'done';
    } catch (e) {
      this.state = 'error';
      this.error = e.message;
    }
  }

  view(since = 0) {
    return {
      scanId: this.id, state: this.state, done: this.done, total: this.total, error: this.error,
      job: this.manifest.job, rows: this.state === 'running' ? this.rows.slice(since) : this.rows,
      partial: this.state === 'running'
    };
  }
}

module.exports = { ScanJob, readPage, markDuplicates, rowWarnings };
