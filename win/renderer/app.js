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
const stopButton = document.getElementById('stop');

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
            <td class="col-name col-name-cell"></td>
            <td class="col-size size"></td>
            <td class="col-savings savings"></td>
            <td class="col-tool tool"></td>`;
        rows.set(job.id, tr);
        rowsEl.appendChild(tr);
    }

    const [nameCell, sizeCell, savingsCell, toolCell] = tr.children;

    nameCell.textContent = job.name;
    nameCell.title = job.path;
    sizeCell.textContent = formatBytes(job.bestSize);
    savingsCell.textContent = formatSavings(job);
    savingsCell.title = job.state === 'error' ? (job.error || 'Error') : '';
    savingsCell.classList.toggle('none', !job.percentOptimized && job.state !== 'error');
    savingsCell.classList.toggle('error', job.state === 'error');
    toolCell.textContent = job.bestTool || '';

    tr.classList.toggle('running', job.state === 'running');
    tr.classList.toggle('selected', selection.has(job.id));
    tr.style.setProperty('--progress', `${Math.round((job.progress || 0) * 100)}%`);

    emptyEl.classList.toggle('hidden', rows.size > 0);
}

function removeRow(id) {
    const tr = rows.get(id);
    if (tr) tr.remove();
    rows.delete(id);
    selection.delete(id);
    emptyEl.classList.toggle('hidden', rows.size > 0);
}

function renderAll(jobs) {
    const keep = new Set(jobs.map((job) => job.id));
    for (const id of [...rows.keys()]) {
        if (!keep.has(id)) removeRow(id);
    }
    jobs.forEach(renderRow);
}

function renderStats(stats) {
    if (!stats.files) {
        statusFilesEl.textContent = 'No files';
        statusSavingsEl.textContent = '';
        stopButton.disabled = true;
        return;
    }

    const parts = [`${stats.files} file${stats.files === 1 ? '' : 's'}`];
    if (stats.busy) parts.push(`${stats.busy} in progress`);
    statusFilesEl.textContent = parts.join(', ');

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

function applySettings(values) {
    for (const input of settingsEl.querySelectorAll('[data-setting]')) {
        const key = input.dataset.setting;
        if (!(key in values)) continue;

        if (input.type === 'checkbox') {
            input.checked = Boolean(values[key]);
        } else {
            input.value = values[key];
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
    else if (input.tagName === 'SELECT') value = input.value;
    else value = Number(input.value);

    const output = settingsEl.querySelector(`[data-output="${key}"]`);
    if (output) output.value = value;

    applySettings(await api.setSettings({ [key]: value }));
});

document.getElementById('reset-settings').addEventListener('click', async () => {
    applySettings(await api.resetSettings());
});

async function loadTools() {
    const { binDir, tools } = await api.listTools();
    toolListEl.innerHTML = '';

    for (const tool of tools) {
        const li = document.createElement('li');
        li.classList.toggle('missing', !tool.installed);
        li.innerHTML = `<span>${tool.name}</span><span>${tool.installed ? 'ready' : 'not built'}</span>`;
        toolListEl.appendChild(li);
    }

    binDirEl.textContent = binDir;
}

// ----------------------------------------------------------------------- init

api.onJobChange(renderRow);
api.onProgress(renderStats);
api.onIdle(renderStats);
api.onReset(renderAll);

(async function init() {
    applySettings(await api.getSettings());
    await refresh();
}());
