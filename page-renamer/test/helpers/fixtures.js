'use strict';
// Synthetic plan sheets and a fake PlanSwift data folder for tests.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function text(x, y, size, value, extra = '') {
  return `<text x="${x}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${size}" ${extra}>${esc(value)}</text>`;
}

// Drawing-area clutter that must not be mistaken for the title block.
function drawingNoise(W, H) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const x = W * (0.08 + i * 0.11);
    out.push(`<line x1="${x}" y1="${H * 0.08}" x2="${x}" y2="${H * 0.7}" stroke="#000" stroke-width="2" stroke-dasharray="40 12 8 12"/>`);
    out.push(`<circle cx="${x}" cy="${H * 0.05}" r="${H * 0.018}" fill="none" stroke="#000" stroke-width="3"/>`);
    out.push(text(x - H * 0.008, H * 0.058, H * 0.02, String.fromCharCode(65 + i)));
  }
  out.push(`<rect x="${W * 0.12}" y="${H * 0.2}" width="${W * 0.45}" height="${H * 0.4}" fill="none" stroke="#000" stroke-width="6"/>`);
  out.push(text(W * 0.15, H * 0.3, H * 0.012, 'SEE DETAIL 3/A5.1 FOR TYPICAL WALL'));
  out.push(text(W * 0.15, H * 0.75, H * 0.016, 'GENERAL NOTES'));
  for (let i = 0; i < 5; i++) out.push(text(W * 0.15, H * (0.78 + i * 0.02), H * 0.009, `${i + 1}. CONTRACTOR SHALL VERIFY ALL DIMENSIONS PRIOR TO WORK REF A2.${i}`));
  return out.join('');
}

function verticalStrip(W, H, number, title) {
  const x = W * 0.865;
  const s = H / 2400;
  const titleLines = Array.isArray(title) ? title : [title];
  return [
    `<rect x="${x}" y="${H * 0.02}" width="${W * 0.125}" height="${H * 0.96}" fill="none" stroke="#000" stroke-width="5"/>`,
    text(x + 20 * s, H * 0.06, 34 * s, 'PRECISE ARCHITECTS', 'font-weight="bold"'),
    text(x + 20 * s, H * 0.075, 18 * s, '1234 MAIN STREET SUITE 200'),
    text(x + 20 * s, H * 0.15, 16 * s, 'PROJECT'),
    text(x + 20 * s, H * 0.17, 28 * s, 'SMITH RESIDENCE'),
    text(x + 20 * s, H * 0.25, 16 * s, 'REV   DATE        DESCRIPTION'),
    text(x + 20 * s, H * 0.27, 16 * s, '1     03/04/2026  PERMIT SET'),
    `<line x1="${x}" y1="${H * 0.76}" x2="${x + W * 0.125}" y2="${H * 0.76}" stroke="#000" stroke-width="3"/>`,
    text(x + 20 * s, H * 0.78, 16 * s, 'SHEET TITLE'),
    ...titleLines.map((line, i) => text(x + 20 * s, H * 0.81 + i * 40 * s, (line.length > 16 ? 26 : 32) * s, line, 'font-weight="bold"')),
    text(x + 20 * s, H * 0.87, 16 * s, 'DATE: 05/12/2026'),
    text(x + 20 * s, H * 0.885, 16 * s, 'PROJECT NO: 2026-041'),
    `<line x1="${x}" y1="${H * 0.9}" x2="${x + W * 0.125}" y2="${H * 0.9}" stroke="#000" stroke-width="3"/>`,
    text(x + 20 * s, H * 0.915, 16 * s, 'SHEET NUMBER'),
    text(x + 40 * s, H * 0.965, 90 * s, number, 'font-weight="bold"')
  ].join('');
}

function bottomStrip(W, H, number, title) {
  const y = H * 0.875;
  const s = H / 2400;
  return [
    `<rect x="${W * 0.01}" y="${y}" width="${W * 0.98}" height="${H * 0.115}" fill="none" stroke="#000" stroke-width="5"/>`,
    ...[0.22, 0.45, 0.75, 0.88].map((f) => `<line x1="${W * f}" y1="${y}" x2="${W * f}" y2="${y + H * 0.115}" stroke="#000" stroke-width="3"/>`),
    text(W * 0.02, y + 60 * s, 34 * s, 'PRECISE ENGINEERING', 'font-weight="bold"'),
    text(W * 0.02, y + 100 * s, 18 * s, 'WWW.PRECISE.EXAMPLE'),
    text(W * 0.23, y + 40 * s, 16 * s, 'PROJECT'),
    text(W * 0.23, y + 90 * s, 30 * s, 'LAKESIDE CLINIC'),
    text(W * 0.46, y + 40 * s, 16 * s, 'DRAWING TITLE'),
    text(W * 0.46, y + 110 * s, 40 * s, title, 'font-weight="bold"'),
    text(W * 0.76, y + 50 * s, 16 * s, 'SCALE: AS NOTED'),
    text(W * 0.76, y + 90 * s, 16 * s, 'DATE: 2026-06-01'),
    text(W * 0.76, y + 130 * s, 16 * s, 'JOB NO. 1187'),
    text(W * 0.89, y + 40 * s, 16 * s, 'SHEET'),
    text(W * 0.9, y + 170 * s, 100 * s, number, 'font-weight="bold"')
  ].join('');
}

function cornerBox(W, H, number, title) {
  const x = W * 0.7;
  const y = H * 0.84;
  const s = H / 2400;
  return [
    `<rect x="${x}" y="${y}" width="${W * 0.29}" height="${H * 0.15}" fill="none" stroke="#000" stroke-width="5"/>`,
    text(x + 30 * s, y + 70 * s, 24 * s, 'OAK STREET TOWNHOMES'),
    text(x + 30 * s, y + 150 * s, 44 * s, title, 'font-weight="bold"'),
    text(x + 30 * s, y + 210 * s, 18 * s, 'SCALE: 1/8" = 1\'-0"'),
    text(x + W * 0.28, y + 250 * s, 110 * s, number, 'font-weight="bold" text-anchor="end"')
  ].join('');
}

const LAYOUTS = { vertical: verticalStrip, bottom: bottomStrip, corner: cornerBox };

function sheetSvg({ layout = 'vertical', number, title, width = 3600, height = 2400 }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="100%" height="100%" fill="#fff"/>`
    + `<rect x="${width * 0.005}" y="${height * 0.005}" width="${width * 0.99}" height="${height * 0.99}" fill="none" stroke="#000" stroke-width="6"/>`
    + drawingNoise(width, height)
    + LAYOUTS[layout](width, height, number, title)
    + '</svg>';
}

async function renderSheet(file, options) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const img = sharp(Buffer.from(sheetSvg(options)), { limitInputPixels: false }).flatten({ background: '#fff' }).greyscale();
  if (file.endsWith('.png')) await img.png().toFile(file);
  else await img.tiff({ compression: 'lzw' }).toFile(file);
  return file;
}

function pageXml(guid, name, order, extra = '') {
  return `<?xml version="1.0" encoding="utf-8"?>\n<Item Class="Page" GUID="${guid}"><Properties>`
    + `<Property Name="Name">${esc(name)}</Property><Property Name="OrderIndex">${order}</Property>`
    + `<Property Name="Scale">1/4" = 1'-0"</Property>${extra}</Properties></Item>`;
}

// Creates <root>/Data with the alias, storage, job and page folders the manifest script reads.
async function makePlanSwiftRoot(root, pages, { jobName = 'Fixture Job' } = {}) {
  const data = path.join(root, 'Data');
  const jobDir = path.join(data, 'Storages', 'Local', 'Jobs', jobName);
  fs.mkdirSync(path.join(data, 'Job'), { recursive: true });
  fs.mkdirSync(path.join(jobDir, 'Pages'), { recursive: true });
  fs.writeFileSync(path.join(data, 'Job', 'Data.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<Item Class="Alias" GUID="{ALIAS}"><Properties><Property Name="Link">\\Storages\\Local\\Jobs\\${esc(jobName)}</Property></Properties></Item>`);
  fs.writeFileSync(path.join(data, 'Storages', 'Local', 'Data.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<Item Class="Storage" GUID="{STORAGE}"><Properties><Property Name="Folder"></Property></Properties></Item>');
  fs.writeFileSync(path.join(jobDir, 'Data.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<Item Class="Job" GUID="{0B0B0B0B-1111-2222-3333-444444444444}"><Properties><Property Name="Name">${esc(jobName)}</Property></Properties></Item>`);
  const out = [];
  for (const [i, p] of pages.entries()) {
    const guid = p.guid || `{${String(i + 1).padStart(8, '0')}-AAAA-BBBB-CCCC-DDDDDDDDDDDD}`;
    const dir = path.join(jobDir, 'Pages', p.folder || p.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Data.xml'), pageXml(guid, p.name, i));
    if (p.sheet) await renderSheet(path.join(dir, 'Page.tif'), p.sheet);
    out.push({ id: guid, name: p.name, dir });
  }
  return { root, data, jobDir, pagesDir: path.join(jobDir, 'Pages'), pages: out };
}

function readPageName(dir) {
  const xml = fs.readFileSync(path.join(dir, 'Data.xml'), 'utf8');
  return xml.match(/<Property Name="Name">([^<]*)<\/Property>/)[1]
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

module.exports = { sheetSvg, renderSheet, makePlanSwiftRoot, readPageName };
