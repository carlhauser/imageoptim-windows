'use strict';

const api = window.imageoptim;

const tableEl = document.getElementById('file-table');
const rowsEl = document.getElementById('file-rows');
const emptyEl = document.getElementById('empty-state');
const overlayEl = document.getElementById('drop-overlay');
const settingsEl = document.getElementById('settings-panel');
const toolListEl = document.getElementById('tool-list');
const binDirEl = document.getElementById('bin-dir');
const statusFilesEl = document.getElementById('status-files');
const statusSavingsEl = document.getElementById('status-savings');
const batchProgressEl = document.getElementById('batch-progress');
const stopButton = document.getElementById('stop');
const updateBannerEl = document.getElementById('update-banner');
const updateTextEl = document.getElementById('update-text');
const updateActionsEl = document.getElementById('update-actions');

// ------------------------------------------------------------------ formatting

// Numbers as Windows writes them here: thousands separated, one decimal
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const oneDecimal = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat(undefined);
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function formatBytes(bytes) {
    if (!bytes) return '0 KB';
    if (bytes < 1024) return `${whole.format(bytes)} B`;
    if (bytes < 1024 * 1024) return `${number.format(bytes < 10240 ? Math.round(bytes / 102.4) / 10 : Math.round(bytes / 1024))} KB`;
    if (bytes < 1024 ** 3) return `${oneDecimal.format(bytes / 1024 ** 2)} MB`;
    return `${oneDecimal.format(bytes / 1024 ** 3)} GB`;
}

const formatPercent = (value) => `${oneDecimal.format(value)}%`;

// A tab's count: 12,400 in full up to ten thousand, then 12.4K, so the tabs
// keep their width
const formatCount = (n) => (n < 10000 ? whole.format(n) : compact.format(n));

function formatElapsed(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// "Zopfli · 1 of 3 · 0:12": which optimizers are at work on a running file,
// how many have finished, and for how long it has been going
function formatActivity(job) {
    const a = job.activity;
    if (!a || !a.total) return 'optimizing…';
    const parts = [a.tools.length ? a.tools.join(', ') : 'starting', `${a.done} of ${a.total}`];
    const elapsed = Date.now() - a.startedAt;
    if (elapsed >= 3000) parts.push(formatElapsed(elapsed));
    return parts.join(' · ');
}

function formatSavings(job) {
    if (job.state === 'error') return job.error || 'Error';
    if (job.state === 'queued') return 'waiting';
    if (job.state === 'running') return formatActivity(job);
    if (job.state === 'stopped') return 'stopped';
    if (job.state === 'reverted') return 'reverted';
    if (job.state === 'skipped' && !job.percentOptimized) return 'already optimized';
    // WebP and AVIF files nothing could be done to, and why
    if (job.state === 'done' && job.note) return job.note;
    if (!job.percentOptimized) return 'already optimal';
    return formatPercent(job.percentOptimized);
}

// "pngquant −41 KB → OxiPNG −2 KB": each result kept since the original
function formatSteps(job) {
    if (!job.steps) return '';
    return job.steps.map((step) => `${step.tool} −${formatBytes(step.saved)}${step.lossy ? ' (lossy)' : ''}`).join(' → ');
}

function formatProblems(job) {
    if (!job.problems) return '';
    return job.problems.map((p) => `${p.tool} ${p.problem}`).join('; ');
}

// ------------------------------------------------------------------ the model
//
// Every file the main process has told us about, by id, in the order they
// arrived. Changes come in batches (main.js flush); each batch updates the
// model and asks for one redraw on the next frame. Nothing here walks the DOM
// per file: with tens of thousands of files that is what froze the window.

const jobs = new Map();     // id -> the job as last sent
let arrival = [];           // ids, first seen first
let finishCounter = 0;      // orders the Done tab, newest first
const finishedAt = new Map(); // id -> when it last reached Done or Skipped
let queueOrder = 'smallest'; // Settings → Options → Queue order

const isQueued = (state) => state === 'queued' || state === 'running';
const viewOf = (state) => (isQueued(state) ? 'queue' : state === 'skipped' ? 'skipped' : 'done');

function applyJobs(batch) {
    for (const job of batch) {
        const before = jobs.get(job.id);
        if (!before) arrival.push(job.id);
        // Reaching Done (or Skipped) puts a file at the top of that tab
        if (!before || viewOf(before.state) !== viewOf(job.state)) {
            if (!isQueued(job.state)) finishedAt.set(job.id, ++finishCounter);
        }
        jobs.set(job.id, job);
    }
    structureChanged();
}

function removeJobs(ids) {
    const gone = new Set(ids);
    for (const id of gone) {
        jobs.delete(id);
        finishedAt.delete(id);
        selection.delete(id);
    }
    arrival = arrival.filter((id) => !gone.has(id));
    structureChanged();
}

function resetJobs(all) {
    jobs.clear();
    finishedAt.clear();
    arrival = [];
    selection.clear();
    anchorId = null;
    activeId = null;
    applyJobs(all);
}

// ------------------------------------------------------------------ the views
//
// Queue holds what is waiting or being optimized - running files first, then
// in the order they will run; Done everything finished, whether optimized,
// already optimal, failed, reverted or stopped, newest first; Skipped the
// files an earlier run had already optimized, which were left alone.

const listPaneEl = document.querySelector('.list-pane');
const viewTabs = [...document.querySelectorAll('.list-tabs [role="tab"]')];
const emptyTitleEl = emptyEl.querySelector('.empty-title');
const emptyHintEl = emptyEl.querySelector('.empty-hint');
const emptyText = { title: emptyTitleEl.textContent, hint: emptyHintEl.innerHTML };
let views = { queue: [], done: [], skipped: [] };
let viewsStale = true;
let lastCounts = { queue: 0, done: 0, skipped: 0 };
let keepOriginals = false; // Settings → Options → Keep originals

const keptHint = 'PNG, JPEG, GIF, SVG, WebP and AVIF files, or whole folders.<br>'
    + 'Files are optimized in place; each original is kept in an “ImageOptim originals” folder beside it.';

function currentView() {
    return listPaneEl.dataset.view;
}

// Ctrl+F: a name to match, and whether to show only the files that failed
const filter = { text: '', failedOnly: false };
// A heading clicked: { key: name | size | savings | tool, dir: 1 | -1 }
let sortBy = null;
// Every file in each tab, before the filter: what follows the work and the
// failure count go by
let totals = { queue: 0, done: 0, skipped: 0, failed: 0 };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const SORT_KEYS = {
    name: (a, b) => collator.compare(a.name, b.name),
    size: (a, b) => a.bestSize - b.bestSize,
    savings: (a, b) => a.percentOptimized - b.percentOptimized,
    tool: (a, b) => collator.compare(a.bestTool || '', b.bestTool || ''),
};

function matchesFilter(job) {
    if (filter.failedOnly && job.state !== 'error') return false;
    return !filter.text || job.name.toLowerCase().includes(filter.text);
}

function rebuildViews() {
    const next = { queue: [], done: [], skipped: [] };
    const running = [];
    const counted = { queue: 0, done: 0, skipped: 0, failed: 0 };
    for (const id of arrival) {
        const job = jobs.get(id);
        const view = viewOf(job.state);
        counted[view] += 1;
        if (job.state === 'error') counted.failed += 1;
        if (!matchesFilter(job)) continue;
        if (job.state === 'running') running.push(id);
        else next[view].push(id);
    }
    totals = counted;
    // In the order the queue takes them (lib/queue.js sortPending)
    const size = (id) => jobs.get(id).originalSize;
    if (queueOrder === 'smallest') next.queue.sort((a, b) => size(a) - size(b));
    else if (queueOrder === 'largest') next.queue.sort((a, b) => size(b) - size(a));
    next.queue = running.concat(next.queue);
    const newest = (a, b) => (finishedAt.get(b) || 0) - (finishedAt.get(a) || 0);
    next.done.sort(newest);
    if (sortBy) {
        const compare = SORT_KEYS[sortBy.key];
        for (const list of Object.values(next)) {
            list.sort((a, b) => sortBy.dir * compare(jobs.get(a), jobs.get(b)));
        }
    }
    views = next;
    viewsStale = false;
}

// The headings: up, down, then back to the tab's own order
for (const button of document.querySelectorAll('th button.sort')) {
    button.addEventListener('click', () => {
        const key = button.dataset.sort;
        if (!sortBy || sortBy.key !== key) sortBy = { key, dir: 1 };
        else if (sortBy.dir === 1) sortBy = { key, dir: -1 };
        else sortBy = null;
        for (const th of document.querySelectorAll('#file-table th')) {
            const own = sortBy && th.querySelector('button.sort').dataset.sort === sortBy.key;
            th.setAttribute('aria-sort', own ? (sortBy.dir === 1 ? 'ascending' : 'descending') : 'none');
        }
        structureChanged();
    });
}

// ------------------------------------------------------------------ filter bar

const filterBarEl = document.getElementById('filter-bar');
const filterTextEl = document.getElementById('filter-text');
const filterFailedEl = document.getElementById('filter-failed');

function openFilter({ failedOnly = null } = {}) {
    filterBarEl.hidden = false;
    if (failedOnly !== null) {
        filterFailedEl.checked = failedOnly;
        filter.failedOnly = failedOnly;
    }
    filterTextEl.focus();
    filterTextEl.select();
    structureChanged();
}

function closeFilter() {
    filterBarEl.hidden = true;
    filterTextEl.value = '';
    filterFailedEl.checked = false;
    filter.text = '';
    filter.failedOnly = false;
    tableEl.focus();
    structureChanged();
}

filterTextEl.addEventListener('input', () => {
    filter.text = filterTextEl.value.trim().toLowerCase();
    structureChanged();
});
filterFailedEl.addEventListener('change', () => {
    filter.failedOnly = filterFailedEl.checked;
    structureChanged();
});
document.getElementById('filter-close').addEventListener('click', closeFilter);
filterBarEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        event.preventDefault();
        closeFilter();
    } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
        event.preventDefault();
        tableEl.focus();
    }
});
window.addEventListener('keydown', (event) => {
    if (event.key === 'f' && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
        event.preventDefault();
        openFilter();
    }
});

function showView(view, focus = false) {
    if (currentView() !== view) {
        // Rows hidden by the other view must not stay selected, or Delete and
        // Ctrl+Z would act on files that are out of sight.
        selection.clear();
        anchorId = null;
        activeId = null;
        tableEl.scrollTop = 0;
    }
    listPaneEl.dataset.view = view;
    for (const tab of viewTabs) {
        const selected = tab.dataset.view === view;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (selected && focus) tab.focus();
    }
    scheduleRender();
}

// Follow the work: new files bring the queue to the front, and when the last
// one finishes the results take its place - under Done, or under Skipped if
// every file turned out to be optimized already. Files added that all go
// straight to Skipped show there too, rather than leaving an empty Queue in
// front.
function followTheWork(counts) {
    const last = lastCounts;
    lastCounts = counts;
    if (counts.queue > 0 && last.queue === 0) return 'queue';
    if (counts.queue === 0 && last.queue > 0) {
        return counts.done > 0 ? 'done' : counts.skipped > 0 ? 'skipped' : null;
    }
    if (counts.queue === 0 && counts.skipped > last.skipped && counts.done <= last.done) return 'skipped';
    return null;
}

const statusFailedEl = document.getElementById('status-failed');
const viewNoteEl = document.getElementById('view-note');
const filtering = () => Boolean(filter.text || filter.failedOnly);

const emptyActionsEl = document.getElementById('empty-actions');
document.getElementById('empty-add-files').addEventListener('click', () => api.chooseFiles());
document.getElementById('empty-add-folder').addEventListener('click', () => api.chooseFolders());

function updateCountsAndEmptyState() {
    emptyActionsEl.hidden = jobs.size > 0;
    // What each tab shows: filtered while a filter is on
    const counts = { queue: views.queue.length, done: views.done.length, skipped: views.skipped.length };
    document.getElementById('count-queue').textContent = formatCount(counts.queue);
    document.getElementById('count-done').textContent = formatCount(counts.done);
    document.getElementById('count-skipped').textContent = formatCount(counts.skipped);
    document.getElementById('count-done').classList.toggle('has-errors', totals.failed > 0);
    statusFailedEl.hidden = totals.failed === 0;
    statusFailedEl.textContent = `${formatCount(totals.failed)} failed`;

    // The work is followed by what is there, not by what the filter shows
    const follow = followTheWork({ queue: totals.queue, done: totals.done, skipped: totals.skipped });
    if (follow && follow !== currentView()) showView(follow);

    const view = currentView();
    viewNoteEl.hidden = !(view === 'skipped' && counts.skipped > 0);
    emptyEl.classList.toggle('hidden', counts[view] > 0);
    if (filtering() && totals[view] > 0) {
        emptyTitleEl.textContent = 'No files match the filter';
        emptyHintEl.textContent = 'Change it, or close it with Esc to see every file.';
    } else if (jobs.size === 0) {
        emptyTitleEl.textContent = emptyText.title;
        emptyHintEl.innerHTML = keepOriginals ? keptHint : emptyText.hint;
    } else if (view === 'queue') {
        emptyTitleEl.textContent = 'Nothing in the queue';
        emptyHintEl.textContent = 'Finished files are under Done. Drop more images to optimize them.';
    } else if (view === 'skipped') {
        emptyTitleEl.textContent = 'Nothing skipped';
        emptyHintEl.textContent = 'Files an earlier run already optimized come here instead of being optimized again.';
    } else {
        emptyTitleEl.textContent = 'Nothing finished yet';
        emptyHintEl.textContent = 'Files move here as soon as their optimization completes.';
    }
}

for (const tab of viewTabs) {
    tab.addEventListener('click', () => showView(tab.dataset.view));
    tab.addEventListener('keydown', (event) => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const next = viewTabs[(viewTabs.indexOf(tab) + step + viewTabs.length) % viewTabs.length];
        showView(next.dataset.view, true);
    });
}

// -------------------------------------------------------------- the list
//
// Only the rows in sight exist: a few dozen <tr>, reused as the list scrolls,
// between two spacer rows that stand in for the rest. Each row is a fixed
// 36 px (style.css td), which is what makes the arithmetic possible.

const ROW_HEIGHT = 36;
const OVERSCAN = 8;
const topSpacer = document.createElement('tr');
const bottomSpacer = document.createElement('tr');
for (const spacer of [topSpacer, bottomSpacer]) {
    spacer.className = 'spacer';
    spacer.setAttribute('aria-hidden', 'true');
}
const pool = []; // <tr> elements, reused
let rowsInUse = 0;
rowsEl.append(topSpacer, bottomSpacer);

// Rows stay where they are and only their contents change, so the one under
// the mouse keeps its hover and a double-click is not lost to a redraw;
// rows are only added or taken away at the end.
function setRowCount(count) {
    while (pool.length < count) pool.push(makeRow());
    while (rowsInUse < count) rowsEl.insertBefore(pool[rowsInUse++], bottomSpacer);
    while (rowsInUse > count) pool[--rowsInUse].remove();
}

// On the next frame - or, in a window that is minimized or covered, where
// Chromium stops sending frames, shortly after: the counts, the empty-state
// text and what a screen reader finds must not freeze until it is shown.
let renderQueued = false;
function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    const run = () => {
        if (!renderQueued) return;
        renderQueued = false;
        render();
    };
    requestAnimationFrame(run);
    setTimeout(run, 250);
}

function structureChanged() {
    viewsStale = true;
    scheduleRender();
}

function makeRow() {
    const tr = document.createElement('tr');
    tr.setAttribute('role', 'row');
    tr.innerHTML = `
        <td class="col-name col-name-cell" role="gridcell"><span class="state" role="img"></span><span class="name"></span></td>
        <td class="col-size size" role="gridcell"></td>
        <td class="col-savings savings" role="gridcell"><span class="text"></span><button type="button" class="row-stop command" tabindex="-1" aria-label="Stop this file" title="Stop this file"><span class="icon i-stop" aria-hidden="true"></span></button></td>
        <td class="col-tool tool" role="gridcell"><span class="text"></span><span class="badge" hidden>lossy</span></td>`;
    return tr;
}

const STATE_NAMES = {
    done: 'Optimized', unchanged: 'Already optimal', skipped: 'Skipped', queued: 'Waiting',
    running: 'Optimizing', error: 'Failed', reverted: 'Reverted', stopped: 'Stopped',
};

function fillRow(tr, job, index) {
    tr.dataset.id = job.id;
    tr.id = `row-${index}`;
    tr.setAttribute('aria-rowindex', String(index + 2)); // the header is row 1
    const [nameCell, sizeCell, savingsCell, toolCell] = tr.children;

    // done | unchanged | skipped | running | queued | error | reverted |
    // stopped, drawn by style.css
    const state = job.state === 'done' && !job.percentOptimized ? 'unchanged' : job.state;
    tr.dataset.state = state;
    nameCell.firstElementChild.setAttribute('aria-label', STATE_NAMES[state] || state);
    nameCell.lastElementChild.textContent = job.name;
    nameCell.title = job.path;
    sizeCell.textContent = formatBytes(job.bestSize);
    sizeCell.title = job.bestSize !== job.originalSize
        ? `${formatBytes(job.originalSize)} → ${formatBytes(job.bestSize)}, ${formatBytes(job.originalSize - job.bestSize)} smaller`
        : '';
    savingsCell.firstElementChild.textContent = formatSavings(job);
    const problems = formatProblems(job);
    savingsCell.title = job.state === 'error' ? (job.error || 'Error')
        : problems ? `Some optimizers had problems: ${problems}`
            : (job.state === 'done' && job.noteDetail) || '';
    savingsCell.classList.toggle('none', !job.percentOptimized && job.state !== 'error' && job.state !== 'running');
    savingsCell.classList.toggle('activity', job.state === 'running');
    savingsCell.classList.toggle('error', job.state === 'error');
    savingsCell.classList.toggle('problems', Boolean(problems) && job.state !== 'running');
    toolCell.firstElementChild.textContent = job.bestTool || '';
    toolCell.lastElementChild.hidden = !job.lossy;
    toolCell.title = formatSteps(job);

    const selected = selection.has(job.id);
    tr.classList.toggle('running', job.state === 'running');
    tr.classList.toggle('selected', selected);
    tr.classList.toggle('active', job.id === activeId);
    tr.setAttribute('aria-selected', String(selected));
    // Only a running row draws its line; a stale value on a reused row
    // would otherwise animate from wherever the last file left off
    if (job.state === 'running') tr.style.setProperty('--progress', `${Math.round((job.progress || 0) * 100)}%`);
    else tr.style.removeProperty('--progress');
}

// Where the first row starts inside the scrolling table: below the sticky
// header and the body's top padding
function rowsOffset() {
    return rowsEl.offsetTop + 4;
}

function render() {
    if (viewsStale) {
        rebuildViews();
        updateCountsAndEmptyState();
    }
    const ids = views[currentView()];
    tableEl.setAttribute('aria-rowcount', String(ids.length + 1));

    const top = Math.max(0, tableEl.scrollTop - rowsOffset());
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const visible = Math.ceil(tableEl.clientHeight / ROW_HEIGHT) + 2 * OVERSCAN;
    const last = Math.min(ids.length, first + visible);

    setRowCount(Math.max(0, last - first));
    for (let i = first; i < last; i++) fillRow(pool[i - first], jobs.get(ids[i]), i);

    topSpacer.style.height = `${first * ROW_HEIGHT}px`;
    bottomSpacer.style.height = `${(ids.length - last) * ROW_HEIGHT}px`;

    const activeIndex = activeId ? ids.indexOf(activeId) : -1;
    if (activeIndex >= first && activeIndex < last) {
        tableEl.setAttribute('aria-activedescendant', `row-${activeIndex}`);
    } else {
        tableEl.removeAttribute('aria-activedescendant');
    }
}

tableEl.addEventListener('scroll', scheduleRender, { passive: true });
new ResizeObserver(scheduleRender).observe(tableEl);

// ---------------------------------------------------------------- selection
//
// The rows that are selected, the one keyboard focus is on (active), and the
// one a Shift range starts from (anchor), all by id, so they survive the
// rows being reused and the list reordering under them.

const selection = new Set();
let activeId = null;
let anchorId = null;

function selectRange(ids, fromId, toId) {
    const a = ids.indexOf(fromId);
    const b = ids.indexOf(toId);
    if (a < 0 || b < 0) return;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selection.add(ids[i]);
}

function scrollIntoView(index) {
    const rowTop = rowsOffset() + index * ROW_HEIGHT;
    const header = rowsEl.offsetTop;
    if (rowTop - header < tableEl.scrollTop) {
        tableEl.scrollTop = rowTop - header;
    } else if (rowTop + ROW_HEIGHT > tableEl.scrollTop + tableEl.clientHeight) {
        tableEl.scrollTop = rowTop + ROW_HEIGHT - tableEl.clientHeight;
    }
}

rowsEl.addEventListener('mousedown', (event) => {
    // Shift+click extends a range: the browser's own text selection would
    // otherwise highlight half the window
    if (event.shiftKey) event.preventDefault();
});

rowsEl.addEventListener('click', (event) => {
    const tr = event.target.closest('tr[data-id]');
    if (!tr) return;
    if (event.target.closest('.row-stop')) {
        api.jobCommand('stop', [tr.dataset.id]);
        return;
    }
    const id = tr.dataset.id;
    const ids = views[currentView()];

    if (event.shiftKey && anchorId) {
        if (!event.ctrlKey) selection.clear();
        selectRange(ids, anchorId, id);
    } else if (event.ctrlKey || event.metaKey) {
        if (selection.has(id)) selection.delete(id);
        else selection.add(id);
        anchorId = id;
    } else {
        selection.clear();
        selection.add(id);
        anchorId = id;
    }
    activeId = id;
    tableEl.focus({ preventScroll: true });
    scheduleRender();
});

rowsEl.addEventListener('dblclick', (event) => {
    const tr = event.target.closest('tr[data-id]');
    if (tr) api.jobCommand('reveal', [tr.dataset.id]);
});

// The files a command acts on: the selection, or the row the keyboard is on
function targetIds() {
    if (selection.size) return [...selection];
    return activeId ? [activeId] : [];
}

// Right-click: a row outside the selection becomes the selection first, as in
// Explorer. main.js builds the menu, which runs the commands itself.
rowsEl.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const tr = event.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    if (!selection.has(id)) {
        selection.clear();
        selection.add(id);
        anchorId = id;
    }
    activeId = id;
    scheduleRender();
    api.showJobMenu([...selection]);
});

// The grid's own keys, while it has focus
tableEl.addEventListener('keydown', (event) => {
    const ids = views[currentView()];
    if (!ids.length) return;
    const page = Math.max(1, Math.floor(tableEl.clientHeight / ROW_HEIGHT) - 1);
    const at = activeId ? ids.indexOf(activeId) : -1;
    const moves = {
        ArrowDown: at + 1, ArrowUp: at - 1, PageDown: at + page, PageUp: at - page,
        Home: 0, End: ids.length - 1,
    };
    const ctrl = event.ctrlKey || event.metaKey;

    if (event.key in moves) {
        event.preventDefault();
        const index = Math.max(0, Math.min(ids.length - 1, at < 0 ? 0 : moves[event.key]));
        activeId = ids[index];
        if (event.shiftKey) {
            if (!anchorId) anchorId = ids[Math.max(0, at)];
            selection.clear();
            selectRange(ids, anchorId, activeId);
        } else if (!ctrl) {
            selection.clear();
            selection.add(activeId);
            anchorId = activeId;
        }
        scrollIntoView(index);
        scheduleRender();
    } else if (event.key === ' ' && activeId) {
        event.preventDefault();
        if (ctrl && selection.has(activeId)) selection.delete(activeId);
        else selection.add(activeId);
        anchorId = activeId;
        scheduleRender();
    } else if (event.key === 'a' && ctrl) {
        event.preventDefault();
        selectAll();
    } else if (event.key === 'Enter' && activeId) {
        event.preventDefault();
        api.jobCommand('reveal', [activeId]);
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault();
        if (!selection.size && activeId) selection.add(activeId);
        if (selection.size) {
            scheduleRender();
            api.showJobMenu([...selection]);
        }
    }
});

// Delete and Ctrl+Z act on the selected files - but only when the keys are
// not meant for a control: Backspace in a dropdown or on a button used to
// take the selected rows out of the list.
window.addEventListener('keydown', (event) => {
    if (event.target.closest('input, output, select, textarea, button, [role="tab"], #settings-panel')) return;
    if (!selection.size) return;

    if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        api.jobCommand('remove', [...selection]);
    }

    if (event.key === 'z' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        api.jobCommand('revert', [...selection]);
    }
});

// The Edit menu's commands
function selectAll() {
    for (const id of views[currentView()]) selection.add(id);
    scheduleRender();
}

api.onMenuCommand((command) => {
    if (command === 'select-all') return selectAll();
    if (command === 'settings') return document.getElementById('toggle-settings').click();
    if (command === 'find') return openFilter();
    const ids = targetIds();
    if (ids.length) api.jobCommand(command, ids);
    return undefined;
});

// ------------------------------------------------------------------ the totals

// The bar along the top of the status bar, and the time left beside it.
// lib/eta.js decides the numbers and the wording.
// The announcer: a few words for screen readers when a batch starts and
// when it ends, nothing in between
const announcerEl = document.getElementById('announcer');
let announcedBatch = false;

function announce(text) {
    announcerEl.textContent = '';
    // A fresh node each time, so the same words are read again
    setTimeout(() => { announcerEl.textContent = text; }, 50);
}

function renderBatch(batch) {
    if (batch && !announcedBatch) {
        announcedBatch = true;
        announce(`Optimizing ${whole.format(batch.total)} file${batch.total === 1 ? '' : 's'}`);
    }
    batchProgressEl.hidden = !batch;
    if (!batch) return;
    batchProgressEl.style.setProperty('--fraction', batch.fraction.toFixed(4));
    batchProgressEl.setAttribute('aria-valuenow', String(Math.round(batch.fraction * 100)));
    batchProgressEl.setAttribute('aria-valuetext', batch.ariaText);
}

// While a dropped folder is being looked through, before its files show
let scanning = null;

let scanNote = null; // what the last drop turned up, when it is worth saying

function renderScan(scan) {
    scanning = scan.done ? null : scan;
    if (scan.done && scan.found === 0) {
        scanNote = scan.ignored
            ? `No PNG, JPEG, GIF, SVG, WebP or AVIF images there (${whole.format(scan.ignored)} other file${scan.ignored === 1 ? '' : 's'})`
            : 'No PNG, JPEG, GIF, SVG, WebP or AVIF images there';
        setTimeout(() => {
            scanNote = null;
            if (lastStats) renderStats(lastStats);
        }, 6000);
    }
    if (scanning) statusFilesEl.textContent = `Looking for images… ${whole.format(scanning.found)} found`;
    else if (lastStats) renderStats(lastStats);
}

let lastStats = null;

function renderStats(stats) {
    lastStats = stats;
    renderBatch(stats.batch);
    if (scanning) {
        stopButton.disabled = stats.busy === 0;
        return;
    }
    document.getElementById('again').disabled = !stats.files;
    document.getElementById('clear').disabled = !stats.files;
    if (!stats.files) {
        statusFilesEl.textContent = scanNote || 'No files';
        statusSavingsEl.textContent = '';
        stopButton.disabled = true;
        return;
    }

    const files = `${whole.format(stats.files)} file${stats.files === 1 ? '' : 's'}`;
    if (stats.batch) {
        statusFilesEl.textContent = stats.batch.text;
    } else if (scanNote) {
        statusFilesEl.textContent = scanNote;
    } else if (!stats.busy && !stats.savedBytes && !stats.failed) {
        statusFilesEl.textContent = stats.files === 1
            ? 'The file was already optimal'
            : `All ${files} were already optimal`;
    } else {
        const parts = [files];
        if (stats.busy) parts.push(`${whole.format(stats.busy)} in progress`);
        if (stats.skipped) parts.push(`${whole.format(stats.skipped)} already optimized`);
        if (stats.maxPercent && stats.optimized > 1) parts.push(`up to ${formatPercent(stats.maxPercent)} per file`);
        statusFilesEl.textContent = parts.join(', ');
    }

    statusSavingsEl.textContent = stats.savedBytes
        ? `Saved ${formatBytes(stats.savedBytes)} of ${formatBytes(stats.originalTotal)} (${formatPercent(stats.savedPercent)})`
        : '';

    stopButton.disabled = stats.busy === 0;
}

statusFailedEl.addEventListener('click', () => {
    showView('done');
    openFilter({ failedOnly: true });
});

// Settings → Options, from the status bar's "Lossy on"
const statusLossyEl = document.getElementById('status-lossy');
statusLossyEl.addEventListener('click', () => {
    if (settingsEl.hidden) document.getElementById('toggle-settings').click();
    selectTab(document.getElementById('tab-options'), true);
});

// Above Skipped
document.getElementById('optimize-skipped').addEventListener('click', () => {
    api.jobCommand('again', views.skipped.slice());
});

// -------------------------------------------------------------------- actions

// The files themselves arrive through onJobsChanged as the queue takes them
function addPaths(paths) {
    if (paths.length) api.addPaths(paths);
}

async function refresh() {
    const { jobs: all, stats } = await api.snapshot();
    resetJobs(all);
    renderStats(stats);
}

document.getElementById('add-files').addEventListener('click', () => api.chooseFiles());
document.getElementById('add-folder').addEventListener('click', () => api.chooseFolders());
document.getElementById('again').addEventListener('click', () => api.again());
document.getElementById('stop').addEventListener('click', () => api.stop());
document.getElementById('clear').addEventListener('click', () => api.clear());

const toggleSettingsEl = document.getElementById('toggle-settings');

function setSettingsOpen(open) {
    settingsEl.hidden = !open;
    toggleSettingsEl.setAttribute('aria-expanded', String(open));
    if (open) {
        loadTools();
        // Into the panel, on its selected tab
        (settingsEl.querySelector('[role="tab"][aria-selected="true"]') || settingsEl).focus();
    } else if (settingsEl.contains(document.activeElement) || document.activeElement === document.body) {
        toggleSettingsEl.focus();
    }
}

toggleSettingsEl.addEventListener('click', () => setSettingsOpen(settingsEl.hidden));

settingsEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        event.preventDefault();
        setSettingsOpen(false);
        return;
    }
    // In a narrow window the panel covers the list: Tab goes round inside it
    if (event.key !== 'Tab' || getComputedStyle(settingsEl).position !== 'absolute') return;
    const focusable = [...settingsEl.querySelectorAll('button, input, select, [tabindex="0"]')]
        .filter((el) => !el.disabled && el.offsetParent !== null && el.tabIndex >= 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
});

// Settings tabs: a plain WAI-ARIA tab list, with the arrow keys moving
// between tabs and only the selected one in the tab order.
const tabs = [...settingsEl.querySelectorAll('[role="tab"]')];

function selectTab(tab, focus = false) {
    for (const t of tabs) {
        const selected = t === tab;
        t.setAttribute('aria-selected', String(selected));
        t.tabIndex = selected ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !selected;
    }
    if (focus) tab.focus();
}

for (const tab of tabs) {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        selectTab(tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length], true);
    });
}

// ---------------------------------------------------------------- drag & drop

let dragDepth = 0;

// Only for files: dragging text or a link over the window used to raise it too
const carriesFiles = (event) => Boolean(event.dataTransfer && [...event.dataTransfer.types].includes('Files'));

window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    if (!carriesFiles(event)) return;
    dragDepth += 1;
    overlayEl.hidden = false;
});

window.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) overlayEl.hidden = true;
});

window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    overlayEl.hidden = true;

    const paths = [...event.dataTransfer.files]
        .map((file) => api.pathForFile(file))
        .filter(Boolean);
    addPaths(paths);
});

// -------------------------------------------------------------------- settings

// Saturation 100% is this chroma; past it most hues leave the sRGB gamut at
// the lightnesses style.css uses. The default 80% gives the shipped blue.
const MAX_ACCENT_CHROMA = 0.195;

// Every setting as last known, for what depends on more than one of them
const current = {};
let windowsAccentHex = null; // RRGGBB, from main.js

// The OKLCH hue and chroma of an sRGB colour, so Windows' accent can be used
// the way the sliders are: at style.css's own lightnesses, which keep text on
// and in it readable whatever the colour.
function oklchOf(hex) {
    const linear = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const [r, g, b] = linear;
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * q;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * q;
    const hue = (Math.atan2(bb, a) * 180) / Math.PI;
    return { h: (hue + 360) % 360, c: Math.sqrt(a * a + bb * bb) };
}

function applyAccent(values) {
    Object.assign(current, values);
    const root = document.documentElement.style;
    let hue = current.AccentHue;
    let chroma = (current.AccentSaturation / 100) * MAX_ACCENT_CHROMA;
    if (current.AccentSource === 'windows' && windowsAccentHex) {
        const accent = oklchOf(windowsAccentHex);
        hue = accent.h;
        chroma = Math.min(MAX_ACCENT_CHROMA, accent.c);
    }
    if (Number.isFinite(hue)) root.setProperty('--accent-h', hue.toFixed(1));
    if (Number.isFinite(chroma)) root.setProperty('--accent-c', chroma.toFixed(4));
    const useWindows = current.AccentSource === 'windows';
    accentWindowsEl.checked = useWindows;
    for (const el of settingsEl.querySelectorAll('[data-custom-accent]')) {
        el.classList.toggle('off', useWindows);
        for (const input of el.querySelectorAll('input')) input.disabled = useWindows;
    }
}

const accentWindowsEl = document.getElementById('accent-windows');
accentWindowsEl.addEventListener('change', async () => {
    const value = accentWindowsEl.checked ? 'windows' : 'custom';
    applyAccent({ AccentSource: value });
    applySettings(await api.setSettings({ AccentSource: value }));
});

// What a slider's number means
const EFFORT = { 1: 'Fastest', 2: 'Fast', 4: 'Normal', 5: 'Extra', 6: 'Insane', 7: 'Maximum' };
const QUALITY_KEYS = ['PngMinQuality', 'JpegOptimMaxQuality', 'GifQuality', 'WebPQuality', 'AvifQuality'];
const HUES = [[20, 'red'], [50, 'orange'], [75, 'yellow'], [160, 'green'], [200, 'teal'], [265, 'blue'], [320, 'purple'], [360, 'pink']];

function describeValue(key, value) {
    if (QUALITY_KEYS.includes(key)) return Number(value) >= 100 ? 'Lossless' : String(value);
    if (key === 'AdvPngLevel') return EFFORT[value] ? `${value} · ${EFFORT[value]}` : String(value);
    if (key === 'AccentHue') return `${HUES.find(([upTo]) => value <= upTo)[1]}, ${value}°`;
    if (key === 'AccentSaturation') return `${value}%`;
    return String(value);
}

function showValue(input, value) {
    const key = input.dataset.setting;
    const text = describeValue(key, value);
    input.setAttribute('aria-valuetext', text);
    const output = settingsEl.querySelector(`[data-output="${key}"]`);
    if (output) output.value = text;
}

// A row that does nothing without another setting is disabled, and its small
// print says which (index.html data-requires)
function applyRequirements() {
    for (const el of settingsEl.querySelectorAll('[data-requires]')) {
        const off = !current[el.dataset.requires];
        el.classList.toggle('off', off);
        for (const input of el.querySelectorAll('input, select')) input.disabled = off;
    }
}

// The sliders draw their own filled track, which needs to know how far along
// the thumb is.
function updateFill(input) {
    if (input.type !== 'range') return;
    const min = Number(input.min), max = Number(input.max);
    input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

function applySettings(values) {
    applyAccent(values);
    applyRequirements();
    if ('LossyEnabled' in values) statusLossyEl.hidden = !values.LossyEnabled;
    if ('KeepOriginals' in values) {
        keepOriginals = Boolean(values.KeepOriginals);
        structureChanged();
    }
    if ('QueueOrder' in values && values.QueueOrder !== queueOrder) {
        queueOrder = values.QueueOrder;
        structureChanged();
    }
    for (const input of settingsEl.querySelectorAll('[data-setting]')) {
        const key = input.dataset.setting;
        if (!(key in values)) continue;

        if (input.type === 'checkbox') {
            input.checked = Boolean(values[key]);
        } else if (input.type === 'radio') {
            input.checked = input.value === values[key];
        } else {
            input.value = values[key];
            updateFill(input);
            if (input.type === 'range') showValue(input, values[key]);
        }
    }
}

settingsEl.addEventListener('input', async (event) => {
    const input = event.target.closest('[data-setting]');
    if (!input) return;

    const key = input.dataset.setting;
    let value;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'radio' || input.tagName === 'SELECT') value = input.value;
    else value = Number(input.value);

    updateFill(input);
    if (input.type === 'range') showValue(input, value);
    // Recolour while dragging rather than after the round trip to main
    applyAccent({ [key]: value });
    applyRequirements();

    applySettings(await api.setSettings({ [key]: value }));
});

document.getElementById('reset-settings').addEventListener('click', async () => {
    if (await api.confirm('reset-settings')) applySettings(await api.resetSettings());
});

// Settings → Options → Optimized files
const historyCountEl = document.getElementById('history-count');
const forgetHistoryButton = document.getElementById('forget-history');

function renderHistory({ count }) {
    historyCountEl.textContent = count
        ? `${count.toLocaleString()} file${count === 1 ? '' : 's'} remembered`
        : 'No files remembered';
    forgetHistoryButton.disabled = !count;
}

forgetHistoryButton.addEventListener('click', async () => {
    if (await api.confirm('forget-history')) renderHistory(await api.forgetHistory());
});

async function loadTools() {
    renderHistory(await api.historyStats());
    const { binDir, tools } = await api.listTools();
    toolListEl.innerHTML = '';

    for (const tool of tools) {
        const li = document.createElement('li');
        li.classList.toggle('missing', !tool.installed);
        const name = document.createElement('span');
        name.textContent = tool.name;
        const status = document.createElement('span');
        status.className = 'tool-status';
        status.textContent = tool.installed ? 'Ready' : 'Not built';
        li.append(name, status);
        toolListEl.appendChild(li);
    }

    binDirEl.textContent = binDir;
}

// --------------------------------------------------------------------- updates

// The wording and the buttons are decided in lib/updater.js; this only draws
// them. textContent throughout, since the version comes from GitHub.
function renderUpdate(state) {
    const banner = state && state.banner;
    updateBannerEl.hidden = !banner;
    if (!banner) return;

    updateTextEl.textContent = banner.text;
    updateActionsEl.replaceChildren(...banner.actions.map((action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = action.label;
        button.dataset.action = action.id;
        button.classList.toggle('primary', Boolean(action.primary));
        return button;
    }));
}

updateActionsEl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button) api.updateAction(button.dataset.action);
});

// ----------------------------------------------------------------------- init

api.onJobsChanged(applyJobs);
api.onProgress(renderStats);
api.onScan(renderScan);
api.onIdle((stats) => {
    renderStats(stats);
    if (announcedBatch) {
        announcedBatch = false;
        const parts = [stats.savedBytes
            ? `Finished. Saved ${formatBytes(stats.savedBytes)} of ${formatBytes(stats.originalTotal)}`
            : 'Finished. Nothing could be made smaller'];
        if (stats.failed) parts.push(`${whole.format(stats.failed)} failed`);
        announce(parts.join('. '));
    }
    if (!settingsEl.hidden) api.historyStats().then(renderHistory);
});
api.onReset(resetJobs);
api.onRemoved(removeJobs);
api.onSettingsChanged(applySettings);
api.onUpdateState(renderUpdate);

api.onWindowsAccent((color) => {
    windowsAccentHex = color;
    applyAccent({});
});

(async function init() {
    windowsAccentHex = await api.getWindowsAccent();
    applySettings(await api.getSettings());
    await refresh();
    renderUpdate(await api.getUpdateState());
}());
