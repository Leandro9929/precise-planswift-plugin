'use strict';
// Sheet-number normalisation, title clean-up, name building and validation.
// Kept free of I/O so it can be shared by the server and covered by unit tests.

const MAX_NAME = 120;
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
// A1.1, A-101, A101, FP-2.01, M2.1A, E0.01, S-1, C1.0
const SHEET_RE = /^[A-Z]{1,3}[-.]?\d{1,4}(?:[.\-]\d{1,3}){0,2}[A-Z]?$/;
// Bare numbers are valid on small sets but are flagged for review.
const NUMERIC_RE = /^\d{1,3}(?:[.\-]\d{1,3})?$/;

const TITLE_LABEL = /^(?:(?:SHEET|DRAWING|DWG\.?|PAGE)\s*(?:TITLE|NAME|DESCRIPTION)|TITLE)\s*[:.\-–]?\s*/i;
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
const KEEP_UPPER = new Set(['MEP', 'HVAC', 'RCP', 'ADA', 'FF&E', 'FFE', 'MEZZ', 'TYP', 'NTS', 'UL', 'CMU', 'ID', 'FP', 'FA', 'AV', 'IT', 'EV', 'PV', 'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII']);

const TEMPLATES = {
  'number-title': '{number} - {title}',
  'number-space-title': '{number} {title}',
  number: '{number}',
  title: '{title}'
};

function clean(s) {
  return String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Applies OCR look-alike fixes to one candidate token.
function fixToken(token) {
  const s = token
    .replace(/[–—−_~]/g, '-')
    .replace(/,/g, '.')
    .replace(/\s*([.\-])\s*/g, '$1')
    .replace(/[^A-Z0-9.\-|]/g, '')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 24);
  const match = s.match(/^([A-Z]*)(.*)$/);
  let prefix = match[1];
  let rest = match[2];
  // "AO.2" -> "A0.2", "AI01" -> "A101": a trailing O/I in a multi-letter prefix is usually a digit.
  while (prefix.length > 1 && /[OI]$/.test(prefix) && /^[.\-\d|]/.test(rest)) {
    rest = prefix.slice(-1) + rest;
    prefix = prefix.slice(0, -1);
  }
  if (prefix.length > 3 && /\d/.test(rest)) return { number: s, corrected: false };
  rest = rest.replace(/[OQ]/g, '0').replace(/[I|]/g, '1').replace(/L(?=.)/g, '1');
  const number = (prefix + rest).replace(/\|/g, '1');
  return { number, corrected: number !== s };
}

// Returns { number, corrected } where corrected means OCR look-alikes were changed.
// Label words that slip into the box ("SHEET NO. A2.1") are ignored, and split reads
// ("A 1.1") are joined.
function normalizeNumber(raw) {
  const raw1 = clean(raw);
  const lowerL = /(?<=[\d.\-])l|l(?=[\d.\-])/g;
  const text = raw1
    .replace(lowerL, '1')
    .toUpperCase()
    .replace(/\bOF\s+\d+\b/g, ' ')
    .replace(/\b(?:SHEET|SHT|DWG|DRAWING|NUMBER|NUM|NO)\b\.?\s*:?/g, ' ')
    .replace(/\s*([.\-–—])\s*/g, '$1')
    .trim();
  const lookAlike = lowerL.test(raw1);
  // A lone "|" or "I" beside the number is usually a title-block border line, and anything with a
  // feet mark is a dimension (9'-9", 12'-0"), never a sheet number.
  const tokens = text.split(/\s+/).filter((t) => !/^[|I]$/.test(t) && !/['’′`]/.test(t))
    .map((t) => t.replace(/^\|+|\|+$/g, '')).filter(Boolean);
  let best = null;
  for (let i = 0; i < tokens.length; i++) {
    for (let len = 1; len <= 3 && i + len <= tokens.length; len++) {
      const candidate = fixToken(tokens.slice(i, i + len).join(''));
      const rank = SHEET_RE.test(candidate.number) ? 2 : NUMERIC_RE.test(candidate.number) ? 1 : 0;
      if (!rank) continue;
      // Prefer the fewest joined pieces, then the longest reading.
      const score = rank * 100 - (len - 1) * 10 + candidate.number.length;
      if (!best || score > best.score) best = { ...candidate, score };
    }
  }
  const result = best || fixToken(tokens.join(''));
  return { number: result.number, corrected: result.corrected || lookAlike };
}

function isSheetNumber(s) {
  return SHEET_RE.test(s);
}

function isNumericSheet(s) {
  return NUMERIC_RE.test(s);
}

function cleanTitle(raw) {
  let s = clean(raw).replace(TITLE_LABEL, '');
  s = s
    .replace(/[\\/]/g, '-')
    .replace(/[:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s*-\s*-+\s*/g, ' - ')
    .replace(/[“”«»]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z0-9(]+|[^A-Za-z0-9)]+$/g, '');
  return s.trim();
}

function applyCase(s, mode) {
  if (mode === 'upper') return s.toUpperCase();
  if (mode !== 'title') return s;
  return s.split(' ').map((word, i) => {
    const upper = word.toUpperCase();
    if (KEEP_UPPER.has(upper.replace(/[^A-Z&]/g, '')) || /\d/.test(word)) return upper;
    const lower = word.toLowerCase();
    if (i > 0 && SMALL_WORDS.has(lower)) return lower;
    return lower.replace(/(^|[-(])([a-z])/g, (_, p, c) => p + c.toUpperCase());
  }).join(' ');
}

function templateFor(key) {
  return TEMPLATES[key] || (typeof key === 'string' && key.includes('{') ? key : TEMPLATES['number-title']);
}

// Builds the PlanSwift page name. Missing parts collapse cleanly ("A1.1" or "FLOOR PLAN").
function buildName(number, title, options = {}) {
  const template = templateFor(options.template);
  const n = clean(number);
  let t = applyCase(cleanTitle(title), options.titleCase);
  const fill = (titleText) => {
    let out = template.replace(/\{number\}/g, n).replace(/\{title\}/g, titleText);
    if (!n || !titleText) {
      // Drop separators that were only there to join the missing part.
      out = out.replace(/^[\s\-–_.,]+|[\s\-–_.,]+$/g, '');
    }
    return sanitizeName(out);
  };
  let name = fill(t);
  while (name.length > MAX_NAME && t.includes(' ')) {
    t = t.slice(0, t.lastIndexOf(' '));
    name = fill(t);
  }
  return name.slice(0, MAX_NAME).trim();
}

function sanitizeName(s) {
  return clean(s)
    .replace(/[\\/]/g, '-')
    .replace(/[:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s.]+$/g, '')
    .trim();
}

// Returns '' when the name is safe to send to PlanSwift, otherwise the reason.
function validateName(name) {
  if (typeof name !== 'string' || !name) return 'Name is empty';
  if (name.length > MAX_NAME) return `Name is longer than ${MAX_NAME} characters`;
  if (FORBIDDEN.test(name)) return 'Name contains \\ / : * ? " < > | or a control character';
  if (name !== name.trim()) return 'Name starts or ends with a space';
  if (name.endsWith('.')) return 'Name ends with a period';
  if (RESERVED.test(name)) return 'Name is reserved by Windows';
  return '';
}

function nameKey(name) {
  return String(name).toUpperCase();
}

module.exports = {
  MAX_NAME, SHEET_RE, TEMPLATES,
  clean, normalizeNumber, isSheetNumber, isNumericSheet, cleanTitle, applyCase,
  buildName, sanitizeName, validateName, nameKey, templateFor
};
