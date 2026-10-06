'use strict';
// Finds the sheet number and sheet title in a title block without user-drawn boxes.
// Strategy: OCR the bottom-right part of the sheet (where US/ANSI/ISO title blocks put the
// number), score sheet-number-shaped words by size, nearby labels and position, then take the
// title from under a "SHEET TITLE"-style label or, failing that, the largest nearby text.
const { recognizeWords, recognizeZone } = require('./ocr');
const { normalizeNumber, isSheetNumber, isNumericSheet, cleanTitle, clean } = require('./naming');

const REGIONS = [
  { x: 0.5, y: 0.55, w: 0.5, h: 0.45 },   // bottom-right corner: vertical strips and corner blocks
  { x: 0.78, y: 0, w: 0.22, h: 1 },       // full right-hand strip
  { x: 0, y: 0.8, w: 1, h: 0.2 }          // full bottom strip
];

const NUMBER_LABEL = /^(SHEET|SHT|DWG|DRAWING|DRAWN|PAGE|NO|NO\.|NUMBER|NUM|#)[:.]?$/i;
const TITLE_LABEL = /\b(SHEET|DRAWING|DWG)\s*(TITLE|NAME|DESCRIPTION)\b|^TITLE[:.]?$/i;
const OTHER_LABEL = /\b(PROJECT|JOB|CLIENT|OWNER|ARCHITECT|ENGINEER|CONSULTANT|ADDRESS|DATE|SCALE|DRAWN|CHECKED|APPROVED|DESIGNED|REVISION|REVISIONS|REV|ISSUE|ISSUED|SEAL|STAMP|PHASE|FILE|PLOT|PERMIT|NORTH|KEY ?PLAN|COPYRIGHT|SUBMITTAL|BID|CONSTRUCTION|SET|NOT FOR)\b/i;
const NOISE_TITLE = /^(?:[\d\s./\-:'"=]+|.*\b(?:SCALE|DATE|DRAWN|CHECKED|PROJECT|JOB|COPYRIGHT|REVISION|PHONE|FAX|EMAIL|WWW\.|SUITE|STREET|AVENUE|AVE\.?|BLVD|ROAD|RD\.?|INC\.?|LLC|SEAL)\b.*)$/i;

function union(boxes) {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// dx and dy are in page-height units (like box.h); aspect = page height / page width.
function pad(box, dx, dy, aspect = 1) {
  const px = dx * aspect;
  const py = dy;
  const x = Math.max(0, box.x - px);
  const y = Math.max(0, box.y - py);
  return { x, y, w: Math.min(1 - x, box.w + 2 * px), h: Math.min(1 - y, box.h + 2 * py) };
}

function area(b) {
  return b.w * b.h;
}

function intersection(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// Overlapping scan regions read the same text twice, and a region edge can cut a line short
// ("ANICAL ROOF PLAN"); keep the most complete reading of each line.
function dedupeLines(lines) {
  const sorted = [...lines].sort((a, b) => area(b.box) - area(a.box));
  const kept = [];
  for (const line of sorted) {
    if (!kept.some((k) => intersection(k.box, line.box) > area(line.box) * 0.6)) kept.push(line);
  }
  return kept;
}

function hOverlap(a, b) {
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
}

// Candidate sheet numbers: single words or up to three adjacent words joined ("A" "1.1").
function numberCandidates(lines) {
  const found = [];
  for (const line of lines) {
    const words = line.words;
    for (let i = 0; i < words.length; i++) {
      for (let len = 1; len <= 3 && i + len <= words.length; len++) {
        const group = words.slice(i, i + len);
        const text = group.map((w) => w.text).join('');
        if (text.length > 14) break;
        const { number } = normalizeNumber(text);
        const strong = isSheetNumber(number);
        if (!strong && !isNumericSheet(number)) continue;
        const box = union(group.map((w) => w.box));
        const before = words.slice(Math.max(0, i - 2), i).map((w) => w.text.toUpperCase()).join(' ');
        found.push({
          number, strong, box, line,
          confidence: Math.min(...group.map((w) => w.confidence)),
          refersElsewhere: /\b(SEE|REF|DETAIL|DET|SIM|ON|REV|SECTION|SECT)\.?$/.test(before)
        });
      }
    }
  }
  return found;
}

function labelNear(candidate, lines, aspect) {
  const c = candidate.box;
  for (const line of lines) {
    for (const word of line.words) {
      if (!NUMBER_LABEL.test(word.text)) continue;
      const b = word.box;
      const above = b.y + b.h <= c.y + c.h * 0.3 && c.y - (b.y + b.h) < c.h * 4 && hOverlap(b, pad(c, c.h * 3, 0, aspect)) > 0;
      const left = Math.abs((b.y + b.h / 2) - (c.y + c.h / 2)) < c.h && b.x + b.w <= c.x + c.h * 0.2 && c.x - (b.x + b.w) < c.h * 6;
      if (above || left) return true;
    }
  }
  return false;
}

function pickNumber(lines, aspect = 1) {
  const candidates = numberCandidates(lines);
  if (!candidates.length) return null;
  const tallest = Math.max(...candidates.map((c) => c.box.h));
  for (const c of candidates) {
    const label = labelNear(c, lines, aspect);
    if (!c.strong && !label) { c.score = -1; continue; }
    c.score = 4 * (c.box.h / tallest)
      + (label ? 2 : 0)
      + (c.strong ? 1 : 0)
      + 1.5 * ((c.box.x + c.box.w) + (c.box.y + c.box.h)) / 2
      + c.confidence / 100
      - (c.refersElsewhere ? 3 : 0)
      - (c.line.words.length > 4 ? 1 : 0);
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].score > 0 ? candidates[0] : null;
}

function isLabelLine(line) {
  const t = line.text.toUpperCase();
  return TITLE_LABEL.test(t) || (OTHER_LABEL.test(t) && line.words.length <= 4) || /:$/.test(t);
}

function usableTitleLine(line, number) {
  const text = clean(line.text);
  if (!text || text.length < 3) return false;
  if (NOISE_TITLE.test(text) || isLabelLine(line)) return false;
  if (line.words.every((w) => NUMBER_LABEL.test(w.text))) return false;
  if (number && line.words.some((w) => w.box === number.box || normalizeNumber(w.text).number === number.number)) return false;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  return letters >= 3 && letters / text.length > 0.5;
}

// Lines that continue a title: stacked under the first one, similar size, no large gap.
function growTitle(first, pool) {
  const picked = [first];
  let last = first;
  for (const line of pool) {
    if (picked.includes(line)) continue;
    const gap = line.box.y - (last.box.y + last.box.h);
    const sameSize = Math.abs(line.box.h - first.box.h) < first.box.h * 0.35;
    if (gap >= -last.box.h * 0.2 && gap < last.box.h * 1.1 && sameSize && hOverlap(line.box, first.box) > 0) {
      picked.push(line);
      last = line;
    }
  }
  return picked;
}

function hasTitleLabel(lines) {
  return lines.some((line) => TITLE_LABEL.test(line.text));
}

function pickTitle(lines, number, aspect = 1) {
  const sorted = [...lines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const usable = sorted.filter((line) => usableTitleLine(line, number));
  // 1. Text under (or right of) a SHEET TITLE label.
  for (const labelLine of sorted) {
    if (!TITLE_LABEL.test(labelLine.text)) continue;
    const l = labelLine.box;
    const below = usable.filter((line) => line.box.y >= l.y + l.h * 0.5
      && line.box.y - (l.y + l.h) < Math.max(l.h * 8, 0.03)
      && hOverlap(line.box, pad(l, l.h * 8, 0, aspect)) > 0);
    if (below.length) {
      const tallest = Math.max(...below.map((line) => line.box.h));
      const first = below.find((line) => line.box.h >= tallest * 0.7);
      return growTitle(first, usable);
    }
    const inline = clean(labelLine.text.replace(TITLE_LABEL, ''));
    if (inline.length >= 3) return [{ ...labelLine, text: inline }];
  }
  // 2. Largest descriptive text close to the sheet number.
  const near = usable.filter((line) => (!number || (
    Math.abs(line.box.x + line.box.w / 2 - (number.box.x + number.box.w / 2)) < 0.3
    && Math.abs(line.box.y - number.box.y) < 0.3)));
  if (!near.length) return [];
  const tallest = Math.max(...near.map((line) => line.box.h));
  const big = near.filter((line) => line.box.h >= tallest * 0.75);
  const first = big.sort((a, b) => {
    if (!number) return a.box.y - b.box.y;
    const da = Math.hypot(a.box.x - number.box.x, a.box.y - number.box.y);
    const db = Math.hypot(b.box.x - number.box.x, b.box.y - number.box.y);
    return da - db;
  })[0];
  // Start from the top of a stacked title.
  let top = first;
  for (;;) {
    const above = near.find((line) => line !== top
      && Math.abs(line.box.h - top.box.h) < top.box.h * 0.35
      && top.box.y - (line.box.y + line.box.h) >= -top.box.h * 0.2
      && top.box.y - (line.box.y + line.box.h) < top.box.h * 1.1
      && hOverlap(line.box, top.box) > 0);
    if (!above) break;
    top = above;
  }
  return growTitle(top, near);
}

// Returns { number, title, numberZone, titleZone, numberConfidence, titleConfidence, source }.
async function detectTitleBlock(page, { regions = REGIONS, refine = true } = {}) {
  const aspect = page.height / page.width;
  let lines = [];
  let number = null;
  for (const zone of regions) {
    lines = dedupeLines(lines.concat(await recognizeWords(page, zone)));
    number = pickNumber(lines, aspect);
    if (number && number.strong && number.score > 4 && hasTitleLabel(lines)) break;
  }
  if (!number || !number.strong) {
    // Title blocks printed sideways along the right edge.
    lines = dedupeLines(lines.concat(await recognizeWords(page, REGIONS[1], { rotate: 90 })));
    number = pickNumber(lines, aspect);
  }
  const titleLines = pickTitle(lines, number, aspect);
  const out = { number: '', title: '', numberZone: null, titleZone: null, numberConfidence: 0, titleConfidence: 0 };
  if (number) {
    out.numberZone = pad(number.box, number.box.h * 0.8, number.box.h * 0.35, aspect);
    out.number = number.number;
    out.numberConfidence = number.confidence;
    if (refine) {
      const read = await recognizeZone(page, out.numberZone, 'number');
      const normalized = normalizeNumber(read.text).number;
      // A shorter re-read ("FP-1" for "FP-1.01") usually means the crop clipped the number.
      const clipped = number.number.startsWith(normalized) && normalized.length < number.number.length;
      const valid = isSheetNumber(normalized) || (!number.strong && isNumericSheet(normalized));
      if (valid && normalized === number.number) {
        out.numberConfidence = Math.max(read.confidence, number.confidence);
      } else if (valid && !clipped && (!number.strong || read.confidence > number.confidence)) {
        // The two reads disagree: take the more confident one but leave it for review.
        out.number = normalized;
        out.numberConfidence = Math.min(read.confidence, 59);
      } else if (valid && !clipped) {
        out.numberConfidence = Math.min(number.confidence, 59);
      }
    }
  }
  if (titleLines.length) {
    const box = union(titleLines.map((line) => line.box));
    const lineH = Math.min(...titleLines.map((line) => line.box.h));
    out.titleZone = pad(box, lineH * 0.8, lineH * 0.35, aspect);
    out.title = cleanTitle(titleLines.map((line) => line.text).join(' '));
    out.titleConfidence = Math.round(titleLines.reduce((sum, line) =>
      sum + line.words.reduce((s, w) => s + w.confidence, 0) / line.words.length, 0) / titleLines.length);
    if (refine) {
      // Full-resolution re-read; keep it only when it is at least as complete as the scan.
      const read = await recognizeZone(page, out.titleZone, 'title', { rotations: [0] });
      const reread = cleanTitle(read.text);
      const letters = (t) => (t.match(/[A-Za-z]/g) || []).length;
      if (reread && letters(reread) >= letters(out.title) && letters(reread) <= letters(out.title) * 1.3) {
        out.title = reread;
        out.titleConfidence = read.confidence;
      }
    }
  }
  return out;
}

module.exports = { detectTitleBlock, pickNumber, pickTitle, hasTitleLabel, dedupeLines, REGIONS };
