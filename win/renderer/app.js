'use strict';

const api = window.imageoptim;

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

const rows = new Map(); // job id -> <tr>
const selection = new Set();

// ------------------------------------------------------------------ formatting

function formatBytes(bytes) {
    if (!bytes) return '0 KB';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSavings(job) {
    if (job.state === 'error') return job.error || 'Error';
    if (job.state === 'queued') return 'waiting';
    if (job.state === 'running') return 'optimizing…';
    if (job.state === 'reverted') return 'reverted';
    if (job.state === 'skipped' && !job.percentOptimized) return 'already optimized';
    if (!job.percentOptimized) return '—';
    return `${job.percentOptimized.toFixed(1)}%`;
}

// ------------------------------------------------------------------ rendering

function renderRow(job) {
    let tr = rows.get(job.id);

    if (!tr) {
        tr = document.createElement('tr');
        tr.dataset.id = job.id;
        tr.innerHTML = `
            <td class="col-name col-name-cell"><span class="state" aria-hidden="true"></span><span class="name"></span></td>
            <td class="col-size size"></td>
            <td class="col-savings savings"></td>
            <td class="col-tool tool"></td>`;
        rows.set(job.id, tr);
        rowsEl.appendChild(tr);
    }

    const [nameCell, sizeCell, savingsCell, toolCell] = tr.children;

    nameCell.lastElementChild.textContent = job.name;
    nameCell.title = job.path;
    // done | unchanged | skipped | running | queued | error | reverted |
    // stopped, drawn by style.css
    tr.dataset.state = job.state === 'done' && !job.percentOptimized ? 'unchanged' : job.state;
    sizeCell.textContent = formatBytes(job.bestSize);
    savingsCell.textContent = formatSavings(job);
    savingsCell.title = job.state === 'error' ? (job.error || 'Error') : '';
    savingsCell.classList.toggle('none', !job.percentOptimized && job.state !== 'error');
    savingsCell.classList.toggle('error', job.state === 'error');
    toolCell.textContent = job.bestTool || '';

    tr.classList.toggle('running', job.state === 'running');
    tr.classList.toggle('selected', selection.has(job.id));
    tr.style.setProperty('--progress', `${Math.round((job.progress || 0) * 100)}%`);

    updateViews();
}

function removeRow(id) {
    const tr = rows.get(id);
    if (tr) tr.remove();
    rows.delete(id);
    selection.delete(id);
    updateViews();
}

// --------------------------------------------------------- queue / done views

// Queue holds what is waiting or being optimized; Done everything finished,
// whether optimized, already optimal, failed, reverted or stopped. Which rows
// show is decided by style.css from the pane's data-view and each row's
// data-state; this keeps the counts and the empty-state text right.
const listPaneEl = document.querySelector('.list-pane');
const viewTabs = [...document.querySelectorAll('.list-tabs [role="tab"]')];
const emptyTitleEl = emptyEl.querySelector('.empty-title');
const emptyHintEl = emptyEl.querySelector('.empty-hint');
const emptyText = { title: emptyTitleEl.textContent, hint: emptyHintEl.innerHTML };
let lastQueued = 0;
let lastRows = 0;
let keepOriginals = false; // Settings → Options → Keep originals

const keptHint = 'PNG, JPEG, GIF and SVG files, or whole folders.<br>'
    + 'Files are optimized in place; each original is kept in an “ImageOptim originals” folder beside it.';

const isQueued = (state) => state === 'queued' || state === 'running';

function showView(view, focus = false) {
    if (listPaneEl.dataset.view !== view) {
        // Rows hidden by the other view must not stay selected, or Delete and
        // Ctrl+Z would act on files that are out of sight.
        selection.clear();
        for (const tr of rows.values()) tr.classList.remove('selected');
    }
    listPaneEl.dataset.view = view;
    for (const tab of viewTabs) {
        const selected = tab.dataset.view === view;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (selected && focus) tab.focus();
    }
    updateViews();
}

function updateViews() {
    let queued = 0;
    for (const tr of rows.values()) if (isQueued(tr.dataset.state)) queued += 1;
    const done = rows.size - queued;
    document.getElementById('count-queue').textContent = queued;
    document.getElementById('count-done').textContent = done;

    // Follow the work: new files bring the queue to the front, and when the
    // last one finishes the results take its place.
    // Files added that all go straight to Done - every one already optimized
    // - show there too, rather than leaving an empty Queue in front.
    const view = listPaneEl.dataset.view;
    const grew = rows.size > lastRows;
    lastRows = rows.size;
    if (queued > 0 && lastQueued === 0 && view !== 'queue') { lastQueued = queued; showView('queue'); return; }
    if (queued === 0 && (lastQueued > 0 || grew) && done > 0 && view !== 'done') { lastQueued = 0; showView('done'); return; }
    lastQueued = queued;

    const shown = view === 'queue' ? queued : done;
    emptyEl.classList.toggle('hidden', shown > 0);
    if (rows.size === 0) {
        emptyTitleEl.textContent = emptyText.title;
        emptyHintEl.innerHTML = keepOriginals ? keptHint : emptyText.hint;
    } else if (view === 'queue') {
        emptyTitleEl.textContent = 'Nothing in the queue';
        emptyHintEl.textContent = 'Finished files are under Done. Drop more images to optimize them.';
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

function renderAll(jobs) {
    const keep = new Set(jobs.map((job) => job.id));
    for (const id of [...rows.keys()]) {
        if (!keep.has(id)) removeRow(id);
    }
    jobs.forEach(renderRow);
}

// The bar along the top of the status bar, and the time left beside it.
// lib/eta.js decides the numbers and the wording.
function renderBatch(batch) {
    batchProgressEl.hidden = !batch;
    if (!batch) return;
    batchProgressEl.style.setProperty('--fraction', batch.fraction.toFixed(4));
    batchProgressEl.setAttribute('aria-valuenow', String(Math.round(batch.fraction * 100)));
    batchProgressEl.setAttribute('aria-valuetext', batch.ariaText);
}

function renderStats(stats) {
    renderBatch(stats.batch);
    if (!stats.files) {
        statusFilesEl.textContent = 'No files';
        statusSavingsEl.textContent = '';
        stopButton.disabled = true;
        return;
    }

    if (stats.batch) {
        statusFilesEl.textContent = stats.batch.text;
    } else {
        const parts = [`${stats.files} file${stats.files === 1 ? '' : 's'}`];
        if (stats.busy) parts.push(`${stats.busy} in progress`);
        if (stats.skipped) parts.push(`${stats.skipped} already optimized`);
        statusFilesEl.textContent = parts.join(', ');
    }

    statusSavingsEl.textContent = stats.savedBytes
        ? `saved ${formatBytes(stats.savedBytes)} (${stats.savedPercent.toFixed(1)}%)`
        : '';

    stopButton.disabled = stats.busy === 0;
}

// -------------------------------------------------------------------- actions

async function addPaths(paths) {
    if (!paths.length) return;
    await api.addPaths(paths);
    const { jobs, stats } = await api.snapshot();
    renderAll(jobs);
    renderStats(stats);
}

async function refresh() {
    const { jobs, stats } = await api.snapshot();
    renderAll(jobs);
    renderStats(stats);
}

document.getElementById('add-files').addEventListener('click', () => api.chooseFiles().then(refresh));
document.getElementById('add-folder').addEventListener('click', () => api.chooseFolders().then(refresh));
document.getElementById('again').addEventListener('click', () => api.again().then(refresh));
document.getElementById('stop').addEventListener('click', () => api.stop().then(refresh));
document.getElementById('clear').addEventListener('click', () => api.clear().then(refresh));

document.getElementById('toggle-settings').addEventListener('click', (event) => {
    const open = settingsEl.hidden;
    settingsEl.hidden = !open;
    event.currentTarget.setAttribute('aria-expanded', String(open));
    if (open) loadTools();
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

window.addEventListener('dragenter', (event) => {
    event.preventDefault();
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

// -------------------------------------------------------------------- the list

rowsEl.addEventListener('click', (event) => {
    const tr = event.target.closest('tr');
    if (!tr) return;

    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) selection.clear();
    if (selection.has(tr.dataset.id)) selection.delete(tr.dataset.id);
    else selection.add(tr.dataset.id);

    for (const [id, row] of rows) row.classList.toggle('selected', selection.has(id));
});

rowsEl.addEventListener('dblclick', (event) => {
    const tr = event.target.closest('tr');
    if (tr) api.reveal(tr.dataset.id);
});

window.addEventListener('keydown', (event) => {
    if (event.target.matches('input, output')) return;

    if ((event.key === 'Delete' || event.key === 'Backspace') && selection.size) {
        event.preventDefault();
        api.removeJobs([...selection]).then(refresh);
        selection.clear();
    }

    if (event.key === 'z' && (event.ctrlKey || event.metaKey) && selection.size) {
        event.preventDefault();
        Promise.all([...selection].map((id) => api.revert(id))).then(refresh);
    }
});

// -------------------------------------------------------------------- settings

// Saturation 100% is this chroma; past it most hues leave the sRGB gamut at
// the lightnesses style.css uses. The default 80% gives the shipped blue.
const MAX_ACCENT_CHROMA = 0.195;

function applyAccent(values) {
    const root = document.documentElement.style;
    if ('AccentHue' in values) root.setProperty('--accent-h', String(values.AccentHue));
    if ('AccentSaturation' in values) {
        root.setProperty('--accent-c', (values.AccentSaturation / 100 * MAX_ACCENT_CHROMA).toFixed(4));
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
    if ('KeepOriginals' in values) {
        keepOriginals = Boolean(values.KeepOriginals);
        updateViews();
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
            const output = settingsEl.querySelector(`[data-output="${key}"]`);
            if (output) output.value = values[key];
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
    const output = settingsEl.querySelector(`[data-output="${key}"]`);
    if (output) output.value = value;
    // Recolour while dragging rather than after the round trip to main
    applyAccent({ [key]: value });

    applySettings(await api.setSettings({ [key]: value }));
});

document.getElementById('reset-settings').addEventListener('click', async () => {
    applySettings(await api.resetSettings());
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
    renderHistory(await api.forgetHistory());
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

api.onJobChange(renderRow);
api.onProgress(renderStats);
api.onIdle((stats) => {
    renderStats(stats);
    if (!settingsEl.hidden) api.historyStats().then(renderHistory);
});
api.onReset(renderAll);
api.onUpdateState(renderUpdate);

(async function init() {
    applySettings(await api.getSettings());
    await refresh();
    renderUpdate(await api.getUpdateState());
}());
