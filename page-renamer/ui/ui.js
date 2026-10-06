'use strict';
/* global Naming */
const token = new URL(location.href).searchParams.get('token');
const $ = (id) => document.getElementById(id);

let job = null;
let selected = new Set();
let currentId = null;
let tool = 'number';
let zones = { number: null, title: null };
let zoom = 1;
let drag = null;
let scanId = null;
let rows = [];
let pollTimer = null;

// ---------- helpers ----------
async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'x-page-renamer-token': token, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw Error(data.error || 'Request failed');
  return data;
}
const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body || {}) });

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

function setStatus(id, text, kind = '') {
  const s = $(id);
  s.textContent = text;
  s.className = 'status' + (kind ? ' ' + kind : '');
}

const mode = () => document.querySelector('input[name=mode]:checked').value;
const key = (s) => Naming.nameKey(s);
const imageUrl = (id, w) => `/api/image/${encodeURIComponent(id)}?w=${w}&token=${token}`;
const cropUrl = (id, z) => `/api/crop/${encodeURIComponent(id)}?x=${z.x}&y=${z.y}&w=${z.w}&h=${z.h}&token=${token}`;

// ---------- dialog ----------
function openDialog({ title, body, ok = null, copy = null, cancel = 'Close' }) {
  const d = $('dialog');
  $('dialogTitle').textContent = title;
  $('dialogBody').replaceChildren(body);
  $('dialogOk').hidden = !ok;
  $('dialogOk').textContent = ok || 'OK';
  $('dialogCancel').textContent = cancel;
  $('dialogCopy').hidden = !copy;
  $('dialogCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(copy); $('dialogCopy').textContent = 'Copied'; } catch { $('dialogCopy').textContent = 'Copy failed'; }
  };
  $('dialogCopy').textContent = 'Copy report';
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

// ---------- job and page list ----------
async function loadJob() {
  try {
    $('jobName').textContent = 'Reading job…';
    job = await api('/api/manifest');
    $('jobName').textContent = `${job.job} · ${job.pages.length} pages`;
    if (job.namesFrom !== 'planswift') {
      setStatus('zoneStatus', `Page names were read from the job folder because PlanSwift did not answer (${job.liveError || 'unknown reason'}). ` +
        'Renaming still checks every page in PlanSwift first.', 'error');
    }
    const ids = new Set(job.pages.map((p) => p.id));
    selected = new Set([...selected].filter((id) => ids.has(id)));
    if (!selected.size) selected = new Set(job.pages.filter((p) => p.hasImage).map((p) => p.id));
    if (!ids.has(currentId)) currentId = (job.pages.find((p) => p.hasImage) || {}).id || null;
    renderPages();
    showPage();
    loadHistory();
  } catch (e) {
    job = null;
    $('jobName').textContent = 'No job';
    $('pageList').replaceChildren(el('p', { class: 'status error', text: e.message }));
    setStatus('zoneStatus', e.message + ' Use "Check PlanSwift connection" if this persists.', 'error');
  }
}

function renderPages() {
  const list = $('pageList');
  const filter = $('pageFilter').value.trim().toLowerCase();
  list.replaceChildren();
  if (!job) return;
  job.pages.forEach((p, i) => {
    if (filter && !p.name.toLowerCase().includes(filter)) return;
    const cb = el('input', { type: 'checkbox', 'aria-label': `Select ${p.name}` });
    cb.checked = selected.has(p.id);
    cb.disabled = !p.hasImage;
    cb.addEventListener('change', () => { cb.checked ? selected.add(p.id) : selected.delete(p.id); countSelected(); });
    const row = el('div', { class: 'page' + (p.id === currentId ? ' selected' : ''), role: 'option', 'aria-selected': String(p.id === currentId) },
      cb, el('b', { text: String(i + 1) }), el('span', { text: p.name, title: p.name }), p.hasImage ? null : el('span', { class: 'noimg', text: 'no image' }));
    row.addEventListener('click', (e) => {
      if (e.target === cb) return;
      currentId = p.id;
      renderPages();
      showPage();
    });
    list.append(row);
  });
  countSelected();
}

function countSelected() {
  $('selectedCount').textContent = `${selected.size} selected`;
  $('scanBtn').textContent = `Read ${selected.size} selected sheet${selected.size === 1 ? '' : 's'}`;
}

// ---------- preview and boxes ----------
function showPage() {
  const p = job && job.pages.find((x) => x.id === currentId);
  const img = $('planImage');
  if (!p) { img.removeAttribute('src'); $('currentPage').textContent = ''; return; }
  $('currentPage').textContent = p.name;
  if (!p.hasImage) { img.removeAttribute('src'); setStatus('zoneStatus', 'This page has no image file.', 'error'); return; }
  img.onerror = () => setStatus('zoneStatus', 'Could not show this page image (PDF-only pages are not supported).', 'error');
  img.src = imageUrl(p.id, Math.min(6000, Math.round(1800 * zoom)));
  drawBoxes();
}

function placeBox(box, z) {
  box.hidden = !z;
  if (!z) return;
  box.style.left = `${z.x * 100}%`;
  box.style.top = `${z.y * 100}%`;
  box.style.width = `${z.w * 100}%`;
  box.style.height = `${z.h * 100}%`;
}

function drawBoxes() {
  placeBox($('numberBox'), zones.number);
  placeBox($('titleBox'), zones.title);
}

function setZoom(value) {
  zoom = Number(value) || 1;
  $('stage').style.width = `${zoom * 100}%`;
  showPage();
}

function pointAt(e) {
  const r = $('stage').getBoundingClientRect();
  return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
}

function rectFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

function setTool(which) {
  tool = which;
  $('numberBtn').classList.toggle('active', which === 'number');
  $('titleBtn').classList.toggle('active', which === 'title');
}

function setMode(value) {
  document.querySelector(`input[name=mode][value=${value}]`).checked = true;
  $('fallbackWrap').hidden = value !== 'zones';
  $('viewer').classList.toggle('drawing', value === 'zones');
  $('previewPanel').classList.toggle('zones-mode', value === 'zones');
}

function scrollToBox(z) {
  if (!z || zoom === 1) return;
  const v = $('viewer');
  const s = $('stage');
  v.scrollLeft = z.x * s.clientWidth - v.clientWidth / 3;
  v.scrollTop = z.y * s.clientHeight - v.clientHeight / 3;
}

$('stage').addEventListener('pointerdown', (e) => {
  if (!$('planImage').getAttribute('src') || e.button !== 0) return;
  drag = pointAt(e);
  $('stage').setPointerCapture(e.pointerId);
  e.preventDefault();
});
$('stage').addEventListener('pointermove', (e) => {
  if (!drag) return;
  placeBox($('draftBox'), rectFrom(drag, pointAt(e)));
});
$('stage').addEventListener('pointerup', (e) => {
  if (!drag) return;
  const z = rectFrom(drag, pointAt(e));
  drag = null;
  $('draftBox').hidden = true;
  if (z.w < 0.003 || z.h < 0.003) return;
  zones[tool] = z;
  drawBoxes();
  setMode('zones');
  if (tool === 'number') setTool('title');
  setStatus('zoneStatus', zones.title
    ? 'Boxes ready. They are read at the same position on every selected sheet.'
    : 'Sheet number box ready. Draw a title box too if you want titles in the names.');
});

// ---------- reading ----------
function namingOptions() {
  return { template: $('template').value, titleCase: $('titleCase').value };
}

async function detectCurrent() {
  if (!currentId) return;
  const btn = $('detectBtn');
  btn.disabled = true;
  setStatus('zoneStatus', 'Looking for the title block on this sheet…');
  try {
    const found = await post('/api/detect', { id: currentId });
    if (!found.number) {
      setStatus('zoneStatus', 'No sheet number found automatically on this sheet. Draw the boxes instead.', 'error');
      return;
    }
    zones = { number: found.numberZone, title: found.titleZone };
    drawBoxes();
    scrollToBox(found.numberZone);
    const name = Naming.buildName(found.number, found.title, namingOptions());
    setStatus('zoneStatus', `Found "${name}" (number ${found.numberConfidence}%${found.title ? `, title ${found.titleConfidence}%` : ''}). ` +
      'Keep "Find automatically" for mixed title blocks, or switch to "Use boxes" to read these positions on every sheet.', 'success');
  } catch (e) {
    setStatus('zoneStatus', e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function startScan() {
  try {
    if (!job) throw Error('Open a job in PlanSwift and reload.');
    if (!selected.size) throw Error('Select at least one sheet.');
    const m = mode();
    if (m === 'zones' && !zones.number) throw Error('Draw the sheet number box first, or choose "Find automatically".');
    const out = await post('/api/scan', {
      ids: [...selected], mode: m, numberZone: zones.number, titleZone: zones.title,
      autoFallback: $('autoFallback').checked, ...namingOptions()
    });
    scanId = out.scanId;
    rows = [];
    renderReview();
    $('reviewPanel').hidden = false;
    $('scanBtn').disabled = true;
    $('cancelScan').hidden = false;
    $('scanProgress').hidden = false;
    $('scanProgress').max = out.total;
    $('scanProgress').value = 0;
    $('scanStatus').textContent = `Reading 0 of ${out.total}…`;
    poll();
  } catch (e) {
    $('scanStatus').textContent = e.message;
    $('scanStatus').className = 'status error';
  }
}

async function poll() {
  clearTimeout(pollTimer);
  try {
    const view = await api(`/api/scan?id=${encodeURIComponent(scanId)}&since=${rows.length}`);
    $('scanProgress').value = view.done;
    if (view.state === 'running') {
      for (const r of view.rows) addRow(r);
      $('scanStatus').textContent = `Reading ${view.done} of ${view.total}… (about ${Math.max(1, Math.round((view.total - view.done) * 2 / 60))} min left)`;
      $('scanStatus').className = 'muted';
      pollTimer = setTimeout(poll, 700);
      return;
    }
    rows = [];
    for (const r of view.rows) addRow(r, false);
    renderReview();
    finishScan(view.state === 'done' ? `Read ${view.total} sheets. Review the names below.` : view.state === 'cancelled' ? 'Reading cancelled; the sheets read so far are listed.' : view.error);
    $('reviewPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    finishScan(e.message, true);
  }
}

function finishScan(message, error = false) {
  $('scanBtn').disabled = false;
  $('cancelScan').hidden = true;
  $('scanProgress').hidden = true;
  $('scanStatus').textContent = message;
  $('scanStatus').className = error ? 'status error' : 'muted';
}

// ---------- review table ----------
function addRow(r, render = true) {
  const row = {
    ...r,
    computed: r.newName || '',
    nameEdited: false,
    touched: false,
    apply: !!r.apply,
    pageIndex: job ? job.pages.findIndex((p) => p.id === r.id) + 1 : 0
  };
  rows.push(row);
  if (render) appendRowElement(row);
  return row;
}

function renderReview() {
  $('results').replaceChildren();
  for (const r of rows) appendRowElement(r);
  validate();
}

function appendRowElement(r) {
  const cb = el('input', { type: 'checkbox', 'aria-label': `Apply ${r.oldName}` });
  cb.checked = r.apply;
  cb.addEventListener('change', () => { r.apply = cb.checked; validate(); });
  const number = el('input', { type: 'text', value: r.number || '', 'aria-label': 'Sheet number', 'data-field': 'number' });
  const title = el('input', { type: 'text', value: r.title || '', 'aria-label': 'Title', 'data-field': 'title' });
  const name = el('input', { type: 'text', value: r.newName || '', 'aria-label': 'New name', 'data-field': 'newName', maxlength: '120' });
  const recompute = () => {
    r.computed = Naming.buildName(r.number, r.title, namingOptions());
    if (!r.nameEdited) { r.newName = r.computed; name.value = r.newName; }
  };
  number.addEventListener('input', () => { r.number = number.value; r.touched = true; recompute(); autoCheck(r, cb); validate(); });
  title.addEventListener('input', () => { r.title = title.value; r.touched = true; recompute(); autoCheck(r, cb); validate(); });
  name.addEventListener('input', () => {
    r.newName = name.value;
    r.nameEdited = name.value !== r.computed;
    r.touched = true;
    name.classList.toggle('edited', r.nameEdited);
    autoCheck(r, cb);
    validate();
  });
  const crops = el('td', { class: 'crops' });
  if (r.boxZone) crops.append(el('img', { loading: 'lazy', alt: 'Your sheet number box', title: 'Your sheet number box', src: cropUrl(r.id, r.boxZone) }));
  if (r.numberZone) crops.append(el('img', { loading: 'lazy', alt: 'Sheet number as read', src: cropUrl(r.id, r.numberZone) }));
  if (r.titleZone) crops.append(el('img', { loading: 'lazy', alt: 'Title as read', src: cropUrl(r.id, r.titleZone) }));
  const check = el('td', { class: 'check' });
  const tr = el('tr', { 'data-id': r.id },
    el('td', {}, cb),
    el('td', { text: String(r.pageIndex || '') }),
    el('td', { text: r.oldName || '—', class: 'old' }),
    el('td', { class: 'num' }, number),
    el('td', { class: 'title' }, title),
    el('td', { class: 'name' }, name),
    crops,
    check);
  r.el = { tr, cb, number, title, name, check, old: tr.querySelector('.old') };
  $('results').append(tr);
}

function autoCheck(r, cb) {
  if (!r.apply && r.newName && r.newName !== r.oldName) { r.apply = true; cb.checked = true; }
}

// Mirrors the server's checks so problems show while typing.
function validate() {
  const checked = rows.filter((r) => r.apply && r.newName !== r.oldName);
  const movingIds = new Set(checked.map((r) => r.id));
  const keep = new Map();
  if (job) for (const p of job.pages) if (!movingIds.has(p.id)) keep.set(key(p.name), p);
  const counts = new Map();
  for (const r of checked) counts.set(key(r.newName), (counts.get(key(r.newName)) || 0) + 1);
  let ready = 0;
  let review = 0;
  let blocked = 0;
  for (const r of rows) {
    const problems = [];
    const invalid = Naming.validateName(r.newName || '');
    if (r.error && !r.touched) problems.push(r.error);
    if (invalid) problems.push(invalid);
    if (r.apply && r.newName && r.newName !== r.oldName) {
      if (counts.get(key(r.newName)) > 1) problems.push('Same name as another checked row');
      const holder = keep.get(key(r.newName));
      if (holder && holder.id !== r.id) problems.push(`Already the name of "${holder.name}"`);
    }
    // OCR warnings stand until the row is edited; duplicates are re-checked live above.
    const ocrWarnings = r.touched ? [] : (r.warnings || []).filter((w) => !/^Duplicate|^Already used/.test(w));
    const unchanged = r.newName === r.oldName;
    r.blocking = r.apply && !unchanged && problems.length > 0;
    r.needsReview = problems.length > 0 || ocrWarnings.length > 0;
    if (r.blocking) blocked++;
    if (r.apply && !unchanged && !problems.length) ready++;
    if (r.needsReview) review++;
    if (!r.el) continue;
    r.el.name.classList.toggle('invalid', !!invalid || (r.apply && problems.length > 0));
    r.el.tr.classList.toggle('unchanged', unchanged);
    r.el.tr.classList.toggle('error', !!r.error && !r.touched);
    const check = r.el.check;
    check.replaceChildren();
    if (problems.length) check.append(el('div', { class: 'warn', text: problems.join('; ') }));
    if (ocrWarnings.length) check.append(el('div', { class: 'warn', text: ocrWarnings.join('; ') }));
    if (!problems.length && !ocrWarnings.length) {
      const state = unchanged ? ['info', 'Unchanged'] : r.apply ? ['ok', 'Ready'] : ['info', 'Not checked'];
      check.append(el('div', { class: state[0], text: state[1] }));
    }
    if (r.touched) check.append(el('div', { class: 'info', text: 'Edited by you' }));
    else for (const note of r.notes || []) check.append(el('div', { class: 'info', text: note }));
    if (r.source && r.source !== 'auto' && r.source !== 'zones') check.append(el('div', { class: 'info', text: r.source }));
    const conf = [r.numberConfidence, r.titleConfidence].filter((c) => Number.isFinite(c) && c > 0);
    if (conf.length) check.append(el('div', { class: 'info', text: `OCR ${conf.map((c) => c + '%').join(' / ')}` }));
  }
  $('summary').textContent = `${rows.length} read · ${ready} checked and ready · ${review} need review` +
    (blocked ? ` · ${blocked} checked row(s) must be fixed before applying` : '');
  $('applyBtn').disabled = !ready || blocked > 0;
  $('applyBtn').textContent = ready ? `Rename ${ready} checked page${ready === 1 ? '' : 's'} in PlanSwift` : 'Rename checked pages in PlanSwift';
  filterRows();
}

function filterRows() {
  const f = $('rowFilter').value;
  for (const r of rows) {
    if (!r.el) continue;
    const show = f === 'all' || (f === 'review' && r.needsReview) || (f === 'ready' && r.apply) || (f === 'unchanged' && r.newName === r.oldName);
    r.el.tr.hidden = !show;
  }
}

// Enter / arrow keys move between rows in the same column.
$('results').addEventListener('keydown', (e) => {
  const field = e.target.dataset && e.target.dataset.field;
  if (!field || !['Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
  const visible = rows.filter((r) => r.el && !r.el.tr.hidden);
  const i = visible.findIndex((r) => r.el[field] === e.target);
  const next = visible[i + (e.key === 'ArrowUp' ? -1 : 1)];
  if (next) { e.preventDefault(); next.el[field].focus(); next.el[field].select(); }
});

async function applyChecked() {
  const entries = rows.filter((r) => r.apply && r.newName !== r.oldName && !r.blocking).map((r) => ({ id: r.id, newName: r.newName.trim() }));
  if (!entries.length) return;
  const list = el('ul', {}, entries.slice(0, 12).map((e) => {
    const r = rows.find((x) => x.id === e.id);
    return el('li', {}, `${r.oldName} → `, el('b', { text: e.newName }));
  }), entries.length > 12 ? el('li', { text: `…and ${entries.length - 12} more` }) : null);
  const body = el('div', {}, el('p', { text: 'PlanSwift will rename these pages. Each page keeps its ID, scale, measurements and takeoff; the tool checks this and puts the names back if anything else changes.' }), list,
    el('p', { class: 'muted', text: 'Tip: PlanSwift saves changes as it goes. Test on a copy of the job the first time.' }));
  if (!(await openDialog({ title: `Rename ${entries.length} page${entries.length === 1 ? '' : 's'}?`, body, ok: 'Rename in PlanSwift', cancel: 'Cancel' }))) return;
  $('applyBtn').disabled = true;
  setStatus('applyStatus', 'Checking pages in PlanSwift and renaming…');
  const stopWatching = watchProgress();
  try {
    const out = await post('/api/apply', { scanId, entries });
    const run = out.run;
    for (const c of run.changes) {
      const r = rows.find((x) => x.id === c.id);
      if (!r) continue;
      r.oldName = c.currentName;
      r.apply = false;
      r.el.cb.checked = false;
      r.el.old.textContent = c.currentName;
    }
    if (out.ok) setStatus('applyStatus', `Renamed ${run.changes.length} page(s). You can undo this run in History.`, 'success');
    else showRunProblem(run);
    await loadJob();
    validate();
  } catch (e) {
    setStatus('applyStatus', e.message, 'error');
  } finally {
    stopWatching();
    validate();
  }
}

// Shows which step PlanSwift is on while a rename or restore runs.
function watchProgress() {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const p = await api('/api/progress');
      if (p.running && !stopped) {
        const count = p.phase === 'renaming pages' ? ` (${p.done} of ${p.total})` : '';
        setStatus('applyStatus', `PlanSwift: ${p.phase}${count}… ${p.seconds} s`);
      }
    } catch { /* keep the last message */ }
    if (!stopped) setTimeout(tick, 1000);
  };
  setTimeout(tick, 800);
  return () => { stopped = true; };
}

function showRunProblem(run) {
  setStatus('applyStatus', run.error, 'error');
  const statusText = { restored: 'kept its name (rolled back)', 'not-attempted': 'not changed', renamed: 'renamed', 'restore-failed': 'COULD NOT BE SET BACK', unknown: 'unknown — check PlanSwift' };
  openDialog({
    title: run.status === 'rolled-back' ? 'Nothing was renamed' : 'Check these pages in PlanSwift',
    body: el('div', {},
      el('p', { class: 'warn', text: run.error }),
      el('ul', {}, run.changes.map((c) => el('li', { text: `${c.oldName} → ${c.newName}: ${statusText[c.status] || c.status} (now "${c.currentName}")` }))),
      run.checks && run.checks.propertyChanges.length ? el('p', { text: 'Page properties that changed: ' + run.checks.propertyChanges.join('; ') }) : null,
      run.checks && run.checks.takeoffChanges.length ? el('p', { text: `Takeoff items that changed: ${run.checks.takeoffChanges.length}` }) : null)
  });
}

// ---------- CSV ----------
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s;
}

function exportCsv() {
  const head = ['Page ID', 'Current name', 'Sheet number', 'Title', 'New name', 'Apply', 'Notes'];
  const lines = [head.join(',')].concat(rows.map((r) => [r.id, r.oldName, r.number, r.title, r.newName, r.apply ? 'yes' : 'no',
    (r.error ? [r.error] : r.warnings || []).join('; ')].map(csvCell).join(',')));
  const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv' }));
  const a = el('a', { href: url, download: `${(job && job.job) || 'PlanSwift'} page names.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function parseCsv(text) {
  const out = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); out.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out.filter((r) => r.some((c) => c.trim()));
}

async function importCsv(file) {
  const table = parseCsv((await file.text()).replace(/^\uFEFF/, ''));
  const head = (table.shift() || []).map((h) => h.trim().toLowerCase());
  const col = (name) => head.indexOf(name);
  const [ci, cc, cn, ct, cnew, ca] = ['page id', 'current name', 'sheet number', 'title', 'new name', 'apply'].map(col);
  if (cnew < 0 || (ci < 0 && cc < 0)) { setStatus('applyStatus', 'The CSV needs "Page ID" or "Current name", and "New name" columns.', 'error'); return; }
  let matched = 0;
  for (const line of table) {
    const r = rows.find((x) => (ci >= 0 && x.id === line[ci]) || (ci < 0 && cc >= 0 && x.oldName === line[cc]));
    if (!r) continue;
    matched++;
    if (cn >= 0) { r.number = line[cn] || ''; r.el.number.value = r.number; }
    if (ct >= 0) { r.title = line[ct] || ''; r.el.title.value = r.title; }
    r.computed = Naming.buildName(r.number, r.title, namingOptions());
    r.newName = (line[cnew] || '').replace(/^'(?=[=+\-@])/, '').trim();
    r.el.name.value = r.newName;
    r.nameEdited = r.newName !== r.computed;
    r.el.name.classList.toggle('edited', r.nameEdited);
    r.touched = true;
    r.apply = ca >= 0 ? /^(yes|y|true|1|x)$/i.test(line[ca] || '') : r.newName !== r.oldName;
    r.el.cb.checked = r.apply;
  }
  validate();
  setStatus('applyStatus', `Imported ${matched} row(s) from ${file.name}. Review, then apply.`, 'success');
}

// ---------- history and restore ----------
async function loadHistory() {
  try {
    const h = await api('/api/history');
    $('historyInfo').textContent = h.originals ? `${h.originals} page(s) currently carry a name set by this tool.` : 'No pages currently carry a name set by this tool.';
    $('restoreAll').disabled = !h.originals;
    const list = $('historyList');
    list.replaceChildren();
    if (!h.runs.length) { list.append(el('p', { class: 'muted', text: 'No runs yet for this job.' })); return; }
    for (const run of h.runs) {
      const changed = run.changes.filter((c) => c.currentName !== c.oldName).length;
      const status = run.undone ? 'undone' : run.status;
      const undo = el('button', { type: 'button', text: 'Undo this run…', disabled: !!run.undone || !changed });
      undo.addEventListener('click', () => restorePreview({ runId: run.runId }));
      list.append(el('div', { class: 'run' },
        el('header', {},
          el('b', { text: new Date(run.created).toLocaleString() }),
          el('span', { text: run.label }),
          el('span', { class: `pill ${status}`, text: status.replace('-', ' ') }),
          el('span', { class: 'muted', text: `${changed} page(s) changed` }),
          el('span', { class: 'grow' }),
          undo),
        run.error ? el('div', { class: 'warn', text: run.error }) : null,
        (run.timings || []).length ? el('div', { class: 'muted', text: 'Steps: ' + run.timings.map((t) => `${t.phase} ${t.ms === null ? '(did not finish)' : (t.ms / 1000).toFixed(1) + ' s'}`).join(' · ') }) : null,
        el('details', {}, el('summary', { text: 'Pages' }),
          el('ul', {}, run.changes.map((c) => el('li', { text: `${c.oldName} → ${c.newName} (${c.status}${c.currentName !== c.newName && c.currentName !== c.oldName ? `, now "${c.currentName}"` : ''})` }))))));
    }
  } catch (e) {
    $('historyInfo').textContent = e.message;
  }
}

async function restorePreview(body) {
  try {
    const plan = await post('/api/restore/preview', body);
    const restore = plan.items.filter((i) => i.action === 'restore');
    const skip = plan.items.filter((i) => i.action === 'skip');
    const content = el('div', {},
      restore.length ? el('p', { text: `${restore.length} page(s) will get their earlier name back:` }) : el('p', { class: 'warn', text: 'No page can be restored automatically.' }),
      el('ul', {}, restore.map((i) => el('li', {}, `${i.currentName} → `, el('b', { text: i.target })))),
      skip.length ? el('p', { class: 'warn', text: `${skip.length} page(s) will be left alone:` }) : null,
      el('ul', {}, skip.map((i) => el('li', { text: `${i.currentName}: ${i.reason}` }))));
    const ok = await openDialog({ title: plan.title, body: content, ok: restore.length ? `Restore ${restore.length} name(s)` : null, cancel: 'Cancel' });
    if (!ok) return;
    const stopWatching = watchProgress();
    let out;
    try { out = await post('/api/restore/apply', { planId: plan.planId }); } finally { stopWatching(); }
    if (!out.ok) showRunProblem(out.run);
    else setStatus('applyStatus', `Restored ${out.run.changes.length} page name(s).`, 'success');
    await loadJob();
  } catch (e) {
    openDialog({ title: 'Restore', body: el('p', { class: 'warn', text: e.message }) });
  }
}

// ---------- diagnostics and settings ----------
async function diagnostics() {
  const body = el('div', {}, el('p', { text: 'Checking the job folder, OCR engine and PlanSwift connection (read-only)…' }));
  const shown = openDialog({ title: 'PlanSwift connection check', body });
  try {
    const report = await api('/api/diagnostics');
    body.replaceChildren(
      el('ul', { class: 'steps' }, report.steps.map((s) => el('li', {}, el('span', { class: s.ok ? 'ok' : 'warn', text: s.ok ? '✓ ' : '✗ ' }), el('b', { text: s.name + ': ' }), s.detail))),
      report.samplePages.length ? el('details', {}, el('summary', { text: 'First pages as PlanSwift reports them' }),
        el('ul', {}, report.samplePages.map((p) => el('li', { text: `${p.name} · ${p.type} · ${p.guid} · ${p.fullPath}` })))) : null,
      report.firstPageProperties ? el('details', {}, el('summary', { text: 'Properties of the first page' }),
        el('ul', {}, Object.entries(report.firstPageProperties).map(([k, v]) => el('li', { text: `${k}: ${v}` })))) : null,
      el('p', { class: 'muted', text: `Version ${report.version} · Node ${report.node} · ${report.platform} · journal: ${report.dataDir}` }));
    $('dialogCopy').hidden = false;
    $('dialogCopy').onclick = async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); $('dialogCopy').textContent = 'Copied'; } catch { $('dialogCopy').textContent = 'Copy failed'; }
    };
  } catch (e) {
    body.replaceChildren(el('p', { class: 'warn', text: e.message }));
  }
  await shown;
}

async function settingsDialog() {
  const s = await api('/api/settings');
  const root = el('input', { type: 'text', value: s.planSwiftRoot, placeholder: 'Automatic (C:\\Program Files (x86)\\PlanSwift11)' });
  const takeoff = el('input', { type: 'checkbox' });
  takeoff.checked = s.checkTakeoff !== false;
  const body = el('div', { class: 'form-grid' },
    el('label', {}, 'PlanSwift program folder (contains the Data folder)', root),
    el('label', { class: 'check' }, takeoff, ' Compare takeoff quantities before and after renaming (recommended)'),
    el('p', { class: 'muted', text: `Journal and settings folder: ${s.dataDir}` }));
  if (!(await openDialog({ title: 'Settings', body, ok: 'Save', cancel: 'Cancel' }))) return;
  await post('/api/settings', { planSwiftRoot: root.value, checkTakeoff: takeoff.checked });
  await loadJob();
}

async function loadSettings() {
  try {
    const s = await api('/api/settings');
    $('template').value = s.template in (s.templates || {}) ? s.template : 'number-title';
    $('titleCase').value = s.titleCase || 'asis';
  } catch { /* defaults stay */ }
}

function namingChanged() {
  post('/api/settings', namingOptions()).catch(() => {});
  for (const r of rows) {
    r.computed = Naming.buildName(r.number, r.title, namingOptions());
    if (!r.nameEdited && r.el) { r.newName = r.computed; r.el.name.value = r.newName; }
  }
  validate();
}

// ---------- wiring ----------
$('refresh').addEventListener('click', loadJob);
$('diagBtn').addEventListener('click', diagnostics);
$('settingsBtn').addEventListener('click', settingsDialog);
$('selectAll').addEventListener('click', () => { if (job) selected = new Set(job.pages.filter((p) => p.hasImage).map((p) => p.id)); renderPages(); });
$('selectNone').addEventListener('click', () => { selected.clear(); renderPages(); });
$('pageFilter').addEventListener('input', renderPages);
$('numberBtn').addEventListener('click', () => { setTool('number'); setMode('zones'); });
$('titleBtn').addEventListener('click', () => { setTool('title'); setMode('zones'); });
$('clearBtn').addEventListener('click', () => { zones = { number: null, title: null }; drawBoxes(); setTool('number'); });
$('detectBtn').addEventListener('click', detectCurrent);
$('zoom').addEventListener('change', (e) => setZoom(e.target.value));
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => setMode(mode())));
$('scanBtn').addEventListener('click', startScan);
$('cancelScan').addEventListener('click', () => post('/api/scan/cancel', { scanId }).catch(() => {}));
$('template').addEventListener('change', namingChanged);
$('titleCase').addEventListener('change', namingChanged);
$('rowFilter').addEventListener('change', filterRows);
$('checkReady').addEventListener('click', () => {
  for (const r of rows) { r.apply = !r.needsReview && r.newName !== r.oldName && !Naming.validateName(r.newName); if (r.el) r.el.cb.checked = r.apply; }
  validate();
});
$('uncheckAll').addEventListener('click', () => { for (const r of rows) { r.apply = false; if (r.el) r.el.cb.checked = false; } validate(); });
$('applyBtn').addEventListener('click', applyChecked);
$('csvBtn').addEventListener('click', exportCsv);
$('csvFile').addEventListener('change', (e) => { if (e.target.files[0]) importCsv(e.target.files[0]); e.target.value = ''; });
$('restoreAll').addEventListener('click', () => restorePreview({}));
$('historyRefresh').addEventListener('click', loadHistory);

setMode('auto');
loadSettings().then(loadJob);
