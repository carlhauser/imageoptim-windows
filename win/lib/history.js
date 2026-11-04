'use strict';

// Remembers which files are already optimized, across launches, so adding a
// folder again only works on what is new or changed.
//
// Files are known by a hash of their content, not their name: a moved, copied
// or renamed file is still recognised, and a file edited since is not. A
// second key - a hash of the path, size and modification time - lets a file
// that has not changed be recognised from its directory entry alone, without
// reading it. Neither key can be turned back into a file name, so the list
// records nothing about where anyone's files are.
//
// The store is one JSON object per line in userData\optimized.jsonl, appended
// as files finish. Later lines win, a torn last line (a crash mid-write) is
// skipped, and once it grows well past the cap it is rewritten with only the
// newest entries.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_CAP = 50000;

// 128 bits of SHA-256 is plenty to tell files apart and halves the store
const shortHash = (hash) => hash.digest('hex').slice(0, 32);

function hashFile(filePath, signal) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 20, signal });
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(shortHash(hash)));
    });
}

function statKey(filePath, stat) {
    const name = path.resolve(filePath);
    const key = `${process.platform === 'win32' ? name.toLowerCase() : name}|${stat.size}|${stat.mtimeMs}`;
    return shortHash(crypto.createHash('sha256').update(key));
}

// What a run with these settings does to a file of this type, as numbers
// where more means more thorough. A remembered file counts as optimized when
// it was done at least this thoroughly in every respect.
function profileFor(type, settings, { level } = {}) {
    return {
        level: level || Number(settings.AdvPngLevel) || 4,
        lossy: settings.LossyEnabled ? 1 : 0,
        strip: (type === 'png' && settings.PngOutRemoveChunks) || (type === 'jpeg' && settings.JpegTranStripAll) ? 1 : 0,
        thorough: type === 'png' && settings.ThoroughPng ? 1 : 0,
        guetzli: type === 'jpeg' && settings.GuetzliEnabled && Number(settings.JpegOptimMaxQuality) >= 80 ? 1 : 0,
    };
}

function satisfies(entry, wanted) {
    if (!entry || !entry.p) return false;
    return Object.keys(wanted).every((key) => (Number(entry.p[key]) || 0) >= wanted[key]);
}

class History {
    constructor(filePath, { cap = DEFAULT_CAP, now = Date.now } = {}) {
        this.filePath = filePath;
        this.cap = cap;
        this.now = now;
        this.byHash = new Map(); // content hash -> { t: type, p: profile, at }
        this.byStat = new Map(); // stat key -> content hash
        this.lines = 0;
        this.needsNewline = false;
    }

    load() {
        this.byHash.clear();
        this.byStat.clear();
        this.lines = 0;
        this.needsNewline = false;
        let text = '';
        try {
            text = fs.readFileSync(this.filePath, 'utf8');
        } catch (err) {
            if (err.code !== 'ENOENT') console.warn('Could not read the optimized-files list:', err.message);
            return this;
        }
        // A torn last line has no newline: the next record must not join it
        this.needsNewline = text.length > 0 && !text.endsWith('\n');
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            let record;
            try {
                record = JSON.parse(line);
            } catch (err) {
                continue; // a write cut short by a crash
            }
            this.apply(record);
            this.lines += 1;
        }
        return this;
    }

    apply(record) {
        if (!record || typeof record.h !== 'string') return;
        if (record.p) this.byHash.set(record.h, { t: record.t, p: record.p, at: Number(record.at) || 0 });
        if (typeof record.s === 'string') this.byStat.set(record.s, record.h);
    }

    findByHash(hash) {
        return (hash && this.byHash.get(hash)) || null;
    }

    findByStat(key) {
        return this.findByHash(this.byStat.get(key));
    }

    count() {
        return this.byHash.size;
    }

    // hash: the file's content as it now is on disk; key: its statKey, if
    // known; type and profile: how it was optimized.
    record({ hash, key, type, profile }) {
        const record = { h: hash, t: type, p: profile, at: this.now() };
        if (key) record.s = key;
        this.apply(record);
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.appendFileSync(this.filePath, `${this.needsNewline ? '\n' : ''}${JSON.stringify(record)}\n`);
            this.needsNewline = false;
            this.lines += 1;
        } catch (err) {
            console.warn('Could not update the optimized-files list:', err.message);
            return;
        }
        if (this.lines > this.cap * 1.25) this.compact();
    }

    // Keeps the newest `cap` files, written beside the store and renamed over
    // it, so a crash leaves the old list or the new one.
    compact() {
        const keep = [...this.byHash.entries()]
            .sort((a, b) => b[1].at - a[1].at)
            .slice(0, this.cap);
        const kept = new Set(keep.map(([hash]) => hash));
        const keys = new Map();
        for (const [key, hash] of this.byStat) {
            if (kept.has(hash)) keys.set(hash, [...(keys.get(hash) || []), key]);
        }

        const out = [];
        for (const [hash, entry] of keep.reverse()) {
            const statKeys = keys.get(hash) || [];
            out.push(JSON.stringify({ h: hash, t: entry.t, p: entry.p, at: entry.at, ...(statKeys[0] ? { s: statKeys[0] } : {}) }));
            for (const key of statKeys.slice(1)) out.push(JSON.stringify({ h: hash, s: key }));
        }

        const staging = `${this.filePath}.tmp`;
        try {
            fs.writeFileSync(staging, out.length ? `${out.join('\n')}\n` : '');
            fs.renameSync(staging, this.filePath);
        } catch (err) {
            console.warn('Could not compact the optimized-files list:', err.message);
            try { fs.unlinkSync(staging); } catch (e) { /* not there */ }
            return;
        }
        this.load();
    }

    forget() {
        this.byHash.clear();
        this.byStat.clear();
        this.lines = 0;
        this.needsNewline = false;
        try {
            fs.unlinkSync(this.filePath);
        } catch (err) {
            if (err.code !== 'ENOENT') console.warn('Could not remove the optimized-files list:', err.message);
        }
    }
}

module.exports = { History, hashFile, statKey, profileFor, satisfies };
