/**
 * NIP-NSP — local durability cache.
 *
 * Stores the user's NSP self-state (confirmed payment list, sent list, index) in IndexedDB,
 * keyed per pubkey. These are recovery anchors — NOT pruned — so a relay purge never costs
 * the user the tweaks needed to spend received funds, and the wallet loads instantly.
 *
 * Plain key→value store; the app merges cache with relay state and rebroadcasts anything the
 * relays have dropped.
 */
const DB_NAME = 'denos-nsp-cache';
const DB_VERSION = 1;
const STORE = 'lists';

export type NspCacheKind = 'confirmed' | 'sent' | 'index';

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const d = req.result;
            if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

export async function nspCacheGet<T>(pubkey: string, kind: NspCacheKind): Promise<T | null> {
    try {
        const d = await db();
        return await new Promise(resolve => {
            const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(`${pubkey}:${kind}`);
            req.onsuccess = () => resolve(req.result ? (req.result.data as T) : null);
            req.onerror = () => resolve(null);
        });
    } catch {
        return null;
    }
}

export async function nspCacheSet(pubkey: string, kind: NspCacheKind, data: unknown): Promise<void> {
    try {
        const d = await db();
        await new Promise<void>(resolve => {
            const tx = d.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put({ key: `${pubkey}:${kind}`, data });
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        });
    } catch { /* best-effort */ }
}
