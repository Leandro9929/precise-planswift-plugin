'use strict';
// Finds the sheet number and sheet title in a title block without user-drawn boxes.
// Strategy: OCR the bottom-right part of the sheet (where US/ANSI/ISO title blocks put the
// number), score sheet-number-shaped words by size, nearby labels and position, then take the
// title from under a "SHEET TITLE"-style label or, failing that, the largest nearby text.
const sharp = require('sharp');
const { recognizeWords, recognizeZone, cropGray, region } = require('./ocr');
const { glyphGroups } = require('./glyphs');
const { normalizeNumber, isSheetNumber, isNumericSheet, cleanTitle, clean, lookAlike } = require('./naming');

const REGIONS = [
  { x: 0.5, y: 0.55, w: 0.5, h: 0.45 },   // bottom-right corner: vertical strips and corner blocks
  { x: 0.78, y: 0, w: 0.22, h: 1 },       // full right-hand strip
  { x: 0, y: 0.8, w: 1, h: 0.2 }          // full bottom strip
];

const NUMBER_LABEL = /^(SHEET|SHT|DWG|DRAWING|DRAWN|PAGE|NO|NO\.|NUMBER|NUM|#)[:.]?$/i;
const TITLE_LABEL = /\b(SHEET|DRAWING|DWG)\s*(TITLE|NAME|DESCRIPTION)\b|^TITLE[:.]?$/i;
const OTHER_LABEL = /\b(PROJECT|JOB|CLIENT|OWNER|ARCHITECT|ENGINEER|CONSULTANT|ADDRESS|DATE|SCALE|DRAWN|CHECKED|APPROVED|DESIGNED|REVISION|REVISIONS|REV|ISSUE|ISSUED|SEAL|STAMP|PHASE|FILE|PLOT|PERMIT|NORTH|KEY ?PLAN|COPYRIGHT|SUBMITTAL|BID|CONSTRUCTION|SET|NOT FOR)\b/i;
// Issue stamps printed in title blocks; never a sheet title.
const STATUS = /^(?:(?:CHECK|PERMIT|BID|PROGRESS|REVIEW|ISSUE|PRICING|CONSTRUCTION|CD|DD|SD)\s+SET|PERMIT|RE-?SUBMISSION|(?:NOT\s+)?FOR\s+(?:CONSTRUCTION|PERMIT|REVIEW|BID|PRICING)|PRELIMINARY|DRAFT|ISSUED\s+FOR\b.*|PERMIT\s+RE-?SUBMISSION|CHECK|SET)$/i;
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

// Overlapping scan regions read the same text twice, a region edge can cut a line short
// ("ANICAL ROOF PLAN") and a blurred region can merge two lines into one garbled reading
// ("py DATION"). Confident readings are kept first, larger before smaller, and any reading
// mostly covered by kept ones is dropped.
function dedupeLines(lines) {
  const confidence = (line) => line.words.reduce((s, w) => s + w.confidence, 0) / Math.max(1, line.words.length);
  const tier = (line) => (confidence(line) >= 80 ? 2 : confidence(line) >= 50 ? 1 : 0);
  const sorted = [...lines].sort((a, b) => tier(b) - tier(a) || area(b.box) - area(a.box));
  const kept = [];
  for (const line of sorted) {
    const covered = kept.reduce((sum, k) => sum + intersection(k.box, line.box), 0);
    // A doubtful reading that overlaps confident ones noticeably is a garbled copy of them.
    const limit = tier(line) < 2 && kept.some((k) => tier(k) > tier(line) && intersection(k.box, line.box) > 0) ? 0.3 : 0.6;
    if (covered <= area(line.box) * limit) kept.push(line);
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
          number, strong, box, line, raw: group.map((w) => w.text).join(' '),
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

// extra: candidates found from glyph shapes rather than page OCR (see glyphCandidates).
function pickNumber(lines, aspect = 1, extra = []) {
  const candidates = numberCandidates(lines).concat(extra);
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
      - (c.line.words.length > 4 ? 1 : 0)
      - (c.confidence < 40 ? 3 : 0);
  }
  candidates.sort((a, b) => b.score - a.score);
  let best = candidates[0];
  if (best.score <= 0) return null;
  // The same number read in pieces ("M2.0" + "1"): take the complete reading in the same place.
  const fuller = candidates.find((c) => c.score > 0 && c.number.length > best.number.length
    && c.number.startsWith(best.number) && /^[.\-]?\d/.test(c.number.slice(best.number.length))
    && intersection(c.box, best.box) >= area(best.box) * 0.5);
  if (fuller) best = fuller;
  return best;
}

function isLabelLine(line) {
  const t = line.text.toUpperCase();
  return TITLE_LABEL.test(t) || (OTHER_LABEL.test(t) && line.words.length <= 4) || /:$/.test(t);
}

// relaxed: for lines continuing a title, where a word like "SHEET" ("COVER / SHEET") is part of it.
function lineConfidence(line) {
  return line.words.reduce((s, w) => s + w.confidence, 0) / Math.max(1, line.words.length);
}

function usableTitleLine(line, number, relaxed = false) {
  const text = clean(line.text);
  if (!text || text.length < 3) return false;
  if (NOISE_TITLE.test(text) || STATUS.test(text) || (!relaxed && isLabelLine(line))) return false;
  if (!relaxed && line.words.every((w) => NUMBER_LABEL.test(w.text))) return false;
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

// From one line of a title, climbs to its first line and gathers the lines below it.
function stackTitle(seed, pool, continuation) {
  let top = seed;
  for (;;) {
    const up = pool.concat(continuation).find((line) => line !== top
      && Math.abs(line.box.h - top.box.h) < top.box.h * 0.35
      && top.box.y - (line.box.y + line.box.h) >= -top.box.h * 0.2
      && top.box.y - (line.box.y + line.box.h) < top.box.h * 1.1
      && hOverlap(line.box, top.box) > 0);
    if (!up) break;
    top = up;
  }
  return growTitle(top, continuation);
}

function hasTitleLabel(lines) {
  return lines.some((line) => TITLE_LABEL.test(line.text));
}

function pickTitle(lines, number, aspect = 1) {
  const sorted = [...lines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const usable = sorted.filter((line) => usableTitleLine(line, number));
  const continuation = sorted.filter((line) => usableTitleLine(line, number, true));
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
      return { path: 'label', lines: growTitle(first, continuation) };
    }
    const inline = clean(labelLine.text.replace(TITLE_LABEL, ''));
    if (inline.length >= 3) return { path: 'label', lines: [{ ...labelLine, text: inline }] };
  }
  const readable = usable.filter((line) => lineConfidence(line) >= 55);
  if (number) {
    const nb = number.box;
    const reach = nb.w * 0.6;
    // 2. The nearest text directly above the number in its own column (vertical title strips).
    const above = readable.filter((line) => line.box.y + line.box.h <= nb.y + nb.h * 0.3
      && nb.y - (line.box.y + line.box.h) < 0.12
      && line.box.x >= nb.x - reach && line.box.x + line.box.w <= nb.x + nb.w + reach * 2
      && line.box.h >= nb.h * 0.2);
    if (above.length) return { path: 'above', lines: stackTitle(above.reduce((a, b) => (b.box.y + b.box.h > a.box.y + a.box.h ? b : a)), above, continuation) };
    // 3. The nearest text to its left on the same row (bottom title strips).
    const left = readable.filter((line) => line.box.x + line.box.w <= nb.x + nb.w * 0.1
      && Math.abs((line.box.y + line.box.h / 2) - (nb.y + nb.h / 2)) < nb.h * 2
      && nb.x - (line.box.x + line.box.w) < 0.3
      && line.box.h >= nb.h * 0.35);
    if (left.length) return { path: 'left', lines: stackTitle(left.reduce((a, b) => (b.box.x + b.box.w > a.box.x + a.box.w ? b : a)), left, continuation) };
  }
  // 4. Largest descriptive text close to the sheet number.
  const nearPool = readable.length ? readable : usable;
  const near = nearPool.filter((line) => (!number || (
    Math.abs(line.box.x + line.box.w / 2 - (number.box.x + number.box.w / 2)) < 0.3
    && Math.abs(line.box.y - number.box.y) < 0.3)));
  if (!near.length) return { path: 'none', lines: [] };
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
  const pool = near.concat(continuation.filter((line) => !near.includes(line))).sort((a, b) => a.box.y - b.box.y);
  return { path: 'near', lines: growTitle(top, pool) };
}

// Sheet numbers drawn inside revision clouds, boxes or bands are often skipped by page-level
// OCR. Rows of large, similar glyphs are found from the image itself and read one by one.
async function glyphCandidates(page, zone, { minFrac = 0.012, maxFrac = 0.05, limit = 5 } = {}) {
  const r = region(page, zone);
  const { data, w, h } = cropGray(page, r);
  let gray = data;
  let gw = w;
  let gh = h;
  if (Math.max(w, h) > 1600) {
    const out = await sharp(data, { raw: { width: w, height: h, channels: 1 } })
      .resize({ width: Math.round(w * 1600 / Math.max(w, h)) })
      .extractChannel(0).raw().toBuffer({ resolveWithObject: true });
    gray = out.data;
    gw = out.info.width;
    gh = out.info.height;
  }
  const sx = gw / w;
  const sy = gh / h;
  const groups = glyphGroups(gray, gw, gh, {
    minH: Math.max(6, minFrac * page.height * sy),
    maxH: maxFrac * page.height * sy
  }).slice(0, limit);
  const aspect = page.height / page.width;
  const found = [];
  for (const g of groups) {
    const box = {
      x: (r.left + g.x0 / sx) / page.width,
      y: (r.top + g.y0 / sy) / page.height,
      w: (g.x1 - g.x0 + 1) / sx / page.width,
      h: g.h / sy / page.height
    };
    const read = await recognizeZone(page, pad(box, box.h * 0.6, box.h * 0.3, aspect), 'number', { rotations: [0] });
    const { number } = normalizeNumber(read.text);
    // Rows of drawn shapes (cabinet doors, windows) read as low-confidence letters.
    if (!isSheetNumber(number) || read.confidence < 60) continue;
    found.push({ number, strong: true, box, line: { words: [], text: number }, confidence: read.confidence, refersElsewhere: false, raw: read.text });
  }
  return found;
}

// Re-reads the chosen number at full resolution and reconciles the two reads.
async function refineNumber(page, number, aspect) {
  const out = {
    number: number.number, numberRaw: number.raw, numberConfidence: number.confidence,
    numberZone: pad(number.box, number.box.h * 0.8, number.box.h * 0.35, aspect)
  };
  const read = await recognizeZone(page, out.numberZone, 'number');
  const normalized = normalizeNumber(read.text).number;
  // A shorter re-read ("FP-1" for "FP-1.01") usually means the crop clipped the number.
  const clipped = number.number.startsWith(normalized) && normalized.length < number.number.length;
  const valid = isSheetNumber(normalized) || (!number.strong && isNumericSheet(normalized));
  // ...and a longer re-read ("M2.01" for "M2.0") means the first read was cut short.
  const completes = normalized.length > number.number.length && normalized.startsWith(number.number)
    && /^[.\-]?\d/.test(normalized.slice(number.number.length));
  if (valid && lookAlike(normalized, number.number)) {
    // Same characters up to OCR look-alikes: the more confident reading decides.
    if (read.confidence > number.confidence) {
      out.number = normalized;
      out.numberRaw = read.text;
    }
    out.numberConfidence = Math.max(read.confidence, number.confidence);
  } else if (valid && completes && read.confidence >= 60) {
    out.number = normalized;
    out.numberRaw = read.text;
    out.numberConfidence = read.confidence;
  } else if (valid && normalized === number.number) {
    out.numberConfidence = Math.max(read.confidence, number.confidence);
    out.numberRaw = read.confidence >= number.confidence ? read.text : number.raw;
  } else if (valid && !clipped && read.confidence >= 70 && read.confidence >= number.confidence + 15) {
    // A clearly better full-resolution read wins outright.
    out.number = normalized;
    out.numberRaw = read.text;
    out.numberConfidence = read.confidence;
  } else if (valid && !clipped && (!number.strong || read.confidence > number.confidence)) {
    // The two reads disagree: take the more confident one but leave it for review.
    out.number = normalized;
    out.numberRaw = read.text;
    out.numberConfidence = Math.min(read.confidence, 59);
  } else if (valid && !clipped) {
    out.numberConfidence = Math.min(number.confidence, 59);
  }
  return out;
}

// Looks for the sheet number only inside one area (around a user-drawn box that missed).
async function findNumberIn(page, zone) {
  const aspect = page.height / page.width;
  const lines = await recognizeWords(page, zone);
  const extra = await glyphCandidates(page, zone, { minFrac: 0.004, maxFrac: 0.12 });
  const number = pickNumber(lines, aspect, extra);
  if (!number || !number.strong) return null;
  return refineNumber(page, number, aspect);
}

// Returns { number, title, numberZone, titleZone, numberConfidence, titleConfidence, source }.
async function detectTitleBlock(page, { regions = REGIONS, refine = true } = {}) {
  const aspect = page.height / page.width;
  let lines = [];
  let extra = [];
  let number = null;
  for (const [i, zone] of regions.entries()) {
    lines = dedupeLines(lines.concat(await recognizeWords(page, zone)));
    if (i === 0 || !number || !number.strong) extra = extra.concat(await glyphCandidates(page, zone));
    number = pickNumber(lines, aspect, extra);
    if (number && number.strong && number.score > 4 && hasTitleLabel(lines)) break;
  }
  if (!number || !number.strong) {
    // Title blocks printed sideways along the right edge.
    lines = dedupeLines(lines.concat(await recognizeWords(page, REGIONS[1], { rotate: 90 })));
    number = pickNumber(lines, aspect, extra);
  }
  let pick = pickTitle(lines, number, aspect);
  if (number && (pick.path === 'near' || pick.path === 'none')) {
    // Read the column above the number at full resolution; titles sit right there in most strips.
    const nb = number.box;
    const x = Math.max(0, nb.x - nb.w * 0.6);
    const y = Math.max(0, nb.y - 0.1);
    const column = { x, y, w: Math.min(1, nb.x + nb.w * 1.6) - x, h: Math.min(1, nb.y + nb.h * 0.3) - y };
    const again = pickTitle(dedupeLines(lines.concat(await recognizeWords(page, column))), number, aspect);
    if (again.path === 'above') pick = again;
  }
  const titleLines = pick.lines;
  const out = { number: '', numberRaw: '', title: '', numberZone: null, titleZone: null, numberConfidence: 0, titleConfidence: 0 };
  if (number) {
    if (refine) Object.assign(out, await refineNumber(page, number, aspect));
    else Object.assign(out, {
      number: number.number, numberRaw: number.raw, numberConfidence: number.confidence,
      numberZone: pad(number.box, number.box.h * 0.8, number.box.h * 0.35, aspect)
    });
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
      if (reread === out.title) {
        out.titleConfidence = Math.max(out.titleConfidence, read.confidence);
      } else if (reread && letters(reread) >= letters(out.title) && letters(reread) <= letters(out.title) * 1.3
        && read.confidence >= out.titleConfidence - 5) {
        out.title = reread;
        out.titleConfidence = read.confidence;
      }
    }
  }
  return out;
}

module.exports = { detectTitleBlock, findNumberIn, glyphCandidates, pickNumber, pickTitle, hasTitleLabel, dedupeLines, REGIONS };
