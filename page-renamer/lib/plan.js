'use strict';
// Turns requested renames into a safe order, and builds restore plans from the journal.
const { nameKey, validateName } = require('./naming');

// changes: [{ id, oldName, newName }]; pages: every page in the open job [{ id, name }].
// A page may take a name another page is giving up in the same batch, so renames are ordered
// to free each name before it is reused. Swaps (cycles) are refused.
function orderRenames(changes, pages) {
  const holders = new Map(pages.map((p) => [nameKey(p.name), p]));
  const moving = new Map(changes.map((c) => [c.id, c]));
  const targets = new Map();
  for (const c of changes) {
    const reason = validateName(c.newName);
    if (reason) throw Error(`${reason}: "${c.newName}"`);
    const key = nameKey(c.newName);
    if (targets.has(key)) throw Error(`Two pages would both be named "${c.newName}".`);
    targets.set(key, c);
  }
  const after = new Map();
  for (const c of changes) {
    const holder = holders.get(nameKey(c.newName));
    if (!holder || holder.id === c.id) continue;
    if (!moving.has(holder.id)) throw Error(`"${c.newName}" is already the name of another page. Rename or uncheck that page first.`);
    after.set(c.id, holder.id);
  }
  const ordered = [];
  const state = new Map();
  const visit = (c) => {
    if (state.get(c.id) === 'done') return;
    if (state.get(c.id) === 'visiting') {
      throw Error(`Pages "${c.oldName}" and "${c.newName}" would swap names. Rename one of them to a temporary name first.`);
    }
    state.set(c.id, 'visiting');
    const blocker = after.get(c.id);
    if (blocker) visit(moving.get(blocker));
    state.set(c.id, 'done');
    ordered.push(c);
  };
  changes.forEach(visit);
  return ordered;
}

function planItem(page, target, skipReason) {
  return {
    id: page.id,
    currentName: page.name,
    target,
    action: skipReason ? 'skip' : 'restore',
    reason: skipReason || ''
  };
}

// Restores the names a run replaced, page by page, when the page still carries the run's name.
function undoPlan(run, pages) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const items = [];
  for (const c of run.changes) {
    if (c.currentName === c.oldName) continue;
    const page = byId.get(c.id);
    if (!page) { items.push({ id: c.id, currentName: c.currentName, target: c.oldName, action: 'skip', reason: 'Page no longer exists' }); continue; }
    if (page.name === c.oldName) continue;
    const skip = page.name !== c.currentName ? `Renamed since this run (expected "${c.currentName}")` : '';
    items.push(planItem(page, c.oldName, skip));
  }
  return finalizePlan(items, pages);
}

// Restores every page this tool renamed to the name it had before the first rename.
function restoreAllPlan(ledger, pages) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const items = [];
  for (const [id, entry] of Object.entries(ledger.pages || {})) {
    const page = byId.get(id);
    if (!page) { items.push({ id, currentName: entry.current, target: entry.original, action: 'skip', reason: 'Page no longer exists' }); continue; }
    if (page.name === entry.original) continue;
    const skip = page.name !== entry.current ? `Renamed outside this tool (expected "${entry.current}")` : '';
    items.push(planItem(page, entry.original, skip));
  }
  return finalizePlan(items, pages);
}

// Marks restores that cannot run because the old name is now taken by a page that stays put.
function finalizePlan(items, pages) {
  const active = () => items.filter((i) => i.action === 'restore');
  let changed = true;
  while (changed) {
    changed = false;
    const moving = new Set(active().map((i) => i.id));
    for (const item of active()) {
      const holder = pages.find((p) => p.id !== item.id && nameKey(p.name) === nameKey(item.target));
      if (holder && !moving.has(holder.id)) {
        item.action = 'skip';
        item.reason = `"${item.target}" is now used by another page`;
        changed = true;
      }
    }
  }
  return items;
}

module.exports = { orderRenames, undoPlan, restoreAllPlan };
