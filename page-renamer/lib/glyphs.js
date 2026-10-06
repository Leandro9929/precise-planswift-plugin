'use strict';
// Connected-component helpers for title blocks. Sheet numbers are often drawn inside revision
// clouds, boxes or grey bands, next to delta tags and labels. OCR reads those shapes as letters
// ("CA2.6>"), so the number's own glyphs are isolated before reading.

// Otsu threshold on an 8-bit greyscale buffer.
function otsu(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = gray.length - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

// 8-connected components of dark pixels. Returns { labels, comps } where comps[i] describes label i+1.
function components(gray, w, h) {
  const t = Math.min(otsu(gray), 200);
  const labels = new Int32Array(w * h);
  const parent = [0];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  let next = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (gray[i] > t) continue;
      let label = 0;
      const neighbours = [];
      if (x > 0 && labels[i - 1]) neighbours.push(labels[i - 1]);
      if (y > 0) {
        if (labels[i - w]) neighbours.push(labels[i - w]);
        if (x > 0 && labels[i - w - 1]) neighbours.push(labels[i - w - 1]);
        if (x < w - 1 && labels[i - w + 1]) neighbours.push(labels[i - w + 1]);
      }
      if (!neighbours.length) {
        label = next++;
        parent.push(label);
      } else {
        label = find(neighbours[0]);
        for (const n of neighbours) {
          const r = find(n);
          if (r !== label) { const [lo, hi] = r < label ? [r, label] : [label, r]; parent[hi] = lo; label = lo; }
        }
      }
      labels[i] = label;
    }
  }
  const stats = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!labels[i]) continue;
      const root = find(labels[i]);
      labels[i] = root;
      let c = stats.get(root);
      if (!c) { c = { id: root, x0: x, y0: y, x1: x, y1: y, area: 0 }; stats.set(root, c); }
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      c.area++;
    }
  }
  const comps = [...stats.values()].map((c) => {
    const cw = c.x1 - c.x0 + 1;
    const ch = c.y1 - c.y0 + 1;
    return { ...c, w: cw, h: ch, fill: c.area / (cw * ch), border: c.x0 === 0 || c.y0 === 0 || c.x1 === w - 1 || c.y1 === h - 1 };
  });
  return { labels, comps };
}

// Glyph-shaped: solid enough to be a stroke of text, not a thin outline (cloud, frame, leader).
function glyphLike(c) {
  const aspect = c.w / c.h;
  return c.fill >= 0.12 && aspect >= 0.08 && aspect <= 4 && !(c.border && c.fill < 0.25);
}

// Keeps only the row of the tallest glyphs (plus the dots and dashes between them) and
// returns a white buffer with those pixels in black. Returns null when nothing glyph-like remains.
function isolateNumber(gray, w, h) {
  const { labels, comps } = components(gray, w, h);
  const usable = comps.filter((c) => c.w < 0.75 * w && c.h < 0.9 * h && c.area >= 6);
  const glyphs = usable.filter(glyphLike);
  if (!glyphs.length) return null;
  const tallest = Math.max(...glyphs.map((c) => c.h));
  const main = glyphs.filter((c) => c.h >= tallest * 0.6).sort((a, b) => b.h - a.h);
  const seed = main[0];
  let top = seed.y0;
  let bottom = seed.y1;
  const row = main.filter((c) => {
    const mid = (c.y0 + c.y1) / 2;
    return mid >= seed.y0 - seed.h * 0.25 && mid <= seed.y1 + seed.h * 0.25;
  });
  for (const c of row) { top = Math.min(top, c.y0); bottom = Math.max(bottom, c.y1); }
  const bandH = bottom - top + 1;
  // Keep the row's glyphs as one cluster; a glyph far from the rest is a different object.
  row.sort((a, b) => a.x0 - b.x0);
  const clusters = [[row[0]]];
  for (const c of row.slice(1)) {
    const last = clusters[clusters.length - 1];
    const gap = c.x0 - Math.max(...last.map((g) => g.x1));
    if (gap > bandH * 1.2) clusters.push([c]); else last.push(c);
  }
  const cluster = clusters.sort((a, b) => b.reduce((s, c) => s + c.area, 0) - a.reduce((s, c) => s + c.area, 0))[0];
  const left = Math.min(...cluster.map((c) => c.x0)) - bandH * 0.35;
  const right = Math.max(...cluster.map((c) => c.x1)) + bandH * 0.35;
  const keep = new Set(cluster.map((c) => c.id));
  for (const c of usable) {
    if (keep.has(c.id)) continue;
    const midY = (c.y0 + c.y1) / 2;
    const small = c.h < bandH * 0.6;
    // Periods, hyphens and lower parts of the number sit inside the band, between its glyphs.
    if (small && midY > top && midY < bottom && c.x0 >= left && c.x1 <= right && c.fill >= 0.2 && !c.border) keep.add(c.id);
  }
  const out = Buffer.alloc(w * h, 255);
  for (let i = 0; i < labels.length; i++) if (labels[i] && keep.has(labels[i])) out[i] = 0;
  return { data: out, band: { top, bottom, left: Math.max(0, left), right: Math.min(w - 1, right) } };
}

// Groups of similar-sized glyphs standing in a row, largest first. Used to find sheet numbers
// that page-level OCR misses (inside clouds or heavy boxes). Sizes are in pixels of the buffer.
function glyphGroups(gray, w, h, { minH, maxH }) {
  const { comps } = components(gray, w, h);
  const glyphs = comps.filter((c) => glyphLike(c) && !c.border && c.h >= minH && c.h <= maxH && c.w <= maxH * 1.6)
    .sort((a, b) => a.x0 - b.x0);
  const groups = [];
  const used = new Set();
  for (const g of glyphs) {
    if (used.has(g)) continue;
    const group = [g];
    used.add(g);
    let right = g.x1;
    for (const c of glyphs) {
      if (used.has(c) || c.x0 < g.x0) continue;
      const overlap = Math.min(c.y1, g.y1) - Math.max(c.y0, g.y0);
      const similar = c.h >= g.h * 0.6 && c.h <= g.h * 1.6;
      if (overlap >= Math.min(c.h, g.h) * 0.5 && similar && c.x0 - right <= g.h * 0.9 && c.x0 - right >= -g.h * 0.2) {
        group.push(c);
        used.add(c);
        right = Math.max(right, c.x1);
      }
    }
    if (group.length < 2 || group.length > 9) continue;
    const x0 = Math.min(...group.map((c) => c.x0));
    const y0 = Math.min(...group.map((c) => c.y0));
    const x1 = Math.max(...group.map((c) => c.x1));
    const y1 = Math.max(...group.map((c) => c.y1));
    groups.push({ x0, y0, x1, y1, h: y1 - y0 + 1, count: group.length });
  }
  return groups.sort((a, b) => b.h - a.h);
}

module.exports = { otsu, components, isolateNumber, glyphGroups };
