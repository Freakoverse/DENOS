/**
 * Persistent Blossom Media Cache (ported from DEN Chat).
 *
 * Two-part storage:
 *   1. Cache API — stores binary blobs efficiently (browser-managed, on-disk)
 *   2. IndexedDB — lightweight metadata for LRU eviction tracking
 *
 * Content-addressed by SHA-256 hash extracted from Blossom URLs, so the same image
 * served from different blossom servers shares one entry — and a CHANGED picture (new
 * upload → new hash → new URL) is a natural cache miss that fetches the new media while
 * the old blob LRU-evicts. No explicit invalidation needed.
 */

const CACHE_NAME = 'denos-blossom-media-v1';
const META_DB_NAME = 'denos-blossom-meta';
const META_DB_VERSION = 1;
const META_STORE = 'entries';
const CACHE_BUDGET_KEY = 'denos-media-cache-mb';
const DEFAULT_BUDGET_MB = 300;
const CACHE_KEY_PREFIX = 'https://blossom-local-cache/';

function loadBudgetBytes(): number {
    try {
        const raw = localStorage.getItem(CACHE_BUDGET_KEY);
        if (raw !== null) {
            const mb = Number(raw);
            if (Number.isFinite(mb) && mb >= 0) return Math.round(mb) * 1024 * 1024;
        }
    } catch { /* ignore */ }
    return DEFAULT_BUDGET_MB * 1024 * 1024;
}

let cacheBudgetBytes = loadBudgetBytes();

interface CacheEntryMeta {
    hash: string;
    size: number;
    lastAccessed: number;
}

/** Extract a 64-char SHA-256 hash from a Blossom URL's pathname (optional extension). */
export function extractBlossomHash(url: string): string | null {
    try {
        const pathname = new URL(url).pathname;
        const match = pathname.match(/\/?([a-f0-9]{64})(?:\.[a-zA-Z0-9]+)?$/);
        return match ? match[1].toLowerCase() : null;
    } catch {
        return null;
    }
}

/** Ask the browser to keep cached media (vs. best-effort, evictable storage). Call once. */
export async function requestPersistentStorage(): Promise<boolean> {
    try {
        if (!navigator.storage?.persist) return false;
        if (await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
    } catch {
        return false;
    }
}

let cacheApiAvailable: boolean | null = null;
async function isCacheApiAvailable(): Promise<boolean> {
    if (cacheApiAvailable !== null) return cacheApiAvailable;
    try {
        if (typeof caches === 'undefined') { cacheApiAvailable = false; return false; }
        await caches.open(CACHE_NAME);
        cacheApiAvailable = true;
        return true;
    } catch {
        cacheApiAvailable = false;
        return false;
    }
}

let metaDb: IDBDatabase | null = null;
function openMetaDB(): Promise<IDBDatabase> {
    if (metaDb) return Promise.resolve(metaDb);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(META_DB_NAME, META_DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'hash' });
        };
        req.onsuccess = () => { metaDb = req.result; resolve(metaDb); };
        req.onerror = () => reject(req.error);
    });
}

export async function getFromPersistentCache(hash: string): Promise<Blob | null> {
    try {
        if (cacheBudgetBytes <= 0) return null;
        if (!(await isCacheApiAvailable())) return null;
        const cache = await caches.open(CACHE_NAME);
        const response = await cache.match(CACHE_KEY_PREFIX + hash);
        if (!response) return null;
        touchMeta(hash).catch(() => { });
        return await response.blob();
    } catch {
        return null;
    }
}

export async function putInPersistentCache(hash: string, blob: Blob): Promise<void> {
    try {
        if (cacheBudgetBytes <= 0) return;
        if (!(await isCacheApiAvailable())) return;
        const cache = await caches.open(CACHE_NAME);
        const response = new Response(blob, {
            headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Cached-At': Date.now().toString() },
        });
        await cache.put(CACHE_KEY_PREFIX + hash, response);
        try {
            const db = await openMetaDB();
            const tx = db.transaction(META_STORE, 'readwrite');
            tx.objectStore(META_STORE).put({ hash, size: blob.size, lastAccessed: Date.now() } as CacheEntryMeta);
        } catch { /* metadata best-effort */ }
        schedulePrune();
    } catch { /* not critical */ }
}

async function touchMeta(hash: string): Promise<void> {
    try {
        const db = await openMetaDB();
        const tx = db.transaction(META_STORE, 'readwrite');
        const store = tx.objectStore(META_STORE);
        const req = store.get(hash);
        await new Promise<void>(resolve => {
            req.onsuccess = () => { const e = req.result as CacheEntryMeta | undefined; if (e) store.put({ ...e, lastAccessed: Date.now() }); resolve(); };
            req.onerror = () => resolve();
        });
    } catch { /* best-effort */ }
}

let pruneScheduled = false;
function schedulePrune(): void {
    if (pruneScheduled) return;
    pruneScheduled = true;
    setTimeout(() => { pruneScheduled = false; pruneCache().catch(() => { }); }, 5000);
}

async function pruneCache(): Promise<void> {
    try {
        const db = await openMetaDB();
        const store = db.transaction(META_STORE, 'readonly').objectStore(META_STORE);
        const allReq = store.getAll();
        const entries: CacheEntryMeta[] = await new Promise((resolve, reject) => {
            allReq.onsuccess = () => resolve(allReq.result || []);
            allReq.onerror = () => reject(allReq.error);
        });
        const totalSize = entries.reduce((s, e) => s + e.size, 0);
        if (totalSize <= cacheBudgetBytes) return;
        entries.sort((a, b) => a.lastAccessed - b.lastAccessed);
        let currentSize = totalSize;
        const toEvict: string[] = [];
        for (const e of entries) {
            if (currentSize <= cacheBudgetBytes) break;
            toEvict.push(e.hash);
            currentSize -= e.size;
        }
        if (toEvict.length === 0) return;
        const cache = await caches.open(CACHE_NAME);
        for (const hash of toEvict) await cache.delete(CACHE_KEY_PREFIX + hash);
        const storeDel = db.transaction(META_STORE, 'readwrite').objectStore(META_STORE);
        for (const hash of toEvict) storeDel.delete(hash);
    } catch { /* best-effort */ }
}

export async function getCacheStats(): Promise<{ entryCount: number; totalSizeMB: number }> {
    try {
        const db = await openMetaDB();
        const store = db.transaction(META_STORE, 'readonly').objectStore(META_STORE);
        const allReq = store.getAll();
        const entries: CacheEntryMeta[] = await new Promise((resolve, reject) => {
            allReq.onsuccess = () => resolve(allReq.result || []);
            allReq.onerror = () => reject(allReq.error);
        });
        const totalBytes = entries.reduce((s, e) => s + e.size, 0);
        return { entryCount: entries.length, totalSizeMB: Math.round((totalBytes / 1024 / 1024) * 10) / 10 };
    } catch {
        return { entryCount: 0, totalSizeMB: 0 };
    }
}

export async function clearPersistentCache(): Promise<void> {
    try { await caches.delete(CACHE_NAME); } catch { /* ok */ }
    try {
        const db = await openMetaDB();
        db.transaction(META_STORE, 'readwrite').objectStore(META_STORE).clear();
    } catch { /* ok */ }
}

export function getCacheBudgetMB(): number {
    return Math.round(cacheBudgetBytes / 1024 / 1024);
}

export async function setCacheBudgetMB(mb: number): Promise<void> {
    const clamped = Math.max(0, Math.round(mb));
    cacheBudgetBytes = clamped * 1024 * 1024;
    try { localStorage.setItem(CACHE_BUDGET_KEY, String(clamped)); } catch { /* ignore */ }
    if (clamped === 0) await clearPersistentCache();
    else await pruneCache();
}
