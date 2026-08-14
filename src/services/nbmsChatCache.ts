/**
 * NIP-NBMS — local channel-message cache.
 *
 * A single IndexedDB pool across ALL group chats, budgeted at 100 MB. As new messages
 * come in and the pool exceeds budget, the oldest messages (by inner timestamp) are pruned
 * first. This makes the channel append-only locally (a relay-side NIP-09 deletion can't
 * erase what we've already cached) and gives instant history on open.
 */

import type { Event } from 'nostr-tools';

const DB_NAME = 'denos-nbms-chat';
const DB_VERSION = 2; // v2: keyed by inner rumor id (was wrap id) + stores the rumor for restore
const STORE = 'messages';
const BUDGET_BYTES = 100 * 1024 * 1024;

export interface CachedChatMsg {
    id: string;            // inner rumor id (primary key) — stable across re-wraps
    groupNpub: string;
    author: string;
    type: string;
    created_at: number;    // inner rumor time (display/sort)
    rawCreatedAt: number;  // wrap time (pagination cursor)
    content: Record<string, unknown>;
    tags: string[][];
    rumor?: Event;         // verified inner rumor, kept so a deleted message can be re-wrapped & restored
    size: number;          // bytes
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const d = req.result;
            // v1 was keyed by wrap id; drop it and recreate keyed by rumor id.
            if (d.objectStoreNames.contains(STORE)) d.deleteObjectStore(STORE);
            const os = d.createObjectStore(STORE, { keyPath: 'id' });
            os.createIndex('groupNpub', 'groupNpub', { unique: false });
            os.createIndex('created_at', 'created_at', { unique: false });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
    return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}

function sizeOf(content: unknown, tags: unknown): number {
    try { return new Blob([JSON.stringify({ content, tags })]).size + 80; } catch { return 256; }
}

export interface IncomingMsg {
    id: string;
    author: string;
    type: string;
    created_at: number;
    rawCreatedAt?: number;
    content: Record<string, unknown>;
    tags?: string[][];
    rumor?: Event;
}

/** Upsert messages for a group into the pool, then schedule a background prune. */
export async function cacheMessages(groupNpub: string, msgs: IncomingMsg[]): Promise<void> {
    if (msgs.length === 0) return;
    try {
        const d = await db();
        const tx = d.transaction(STORE, 'readwrite');
        const os = tx.objectStore(STORE);
        for (const m of msgs) {
            os.put({
                id: m.id, groupNpub, author: m.author, type: m.type,
                created_at: m.created_at, rawCreatedAt: m.rawCreatedAt ?? m.created_at,
                content: m.content, tags: m.tags ?? [], rumor: m.rumor, size: sizeOf(m.content, m.tags ?? []),
            } as CachedChatMsg);
        }
        await txDone(tx);
        schedulePrune();
    } catch { /* best-effort */ }
}

/** All cached messages for a group, oldest → newest. */
export async function getCachedMessages(groupNpub: string): Promise<CachedChatMsg[]> {
    try {
        const d = await db();
        const idx = d.transaction(STORE, 'readonly').objectStore(STORE).index('groupNpub');
        const out: CachedChatMsg[] = await new Promise((resolve, reject) => {
            const req = idx.getAll(groupNpub);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        out.sort((a, b) => a.created_at - b.created_at);
        return out;
    } catch {
        return [];
    }
}

let pruneScheduled = false;
function schedulePrune(): void {
    if (pruneScheduled) return;
    pruneScheduled = true;
    setTimeout(() => { pruneScheduled = false; prune().catch(() => { }); }, 5000);
}

/** Sum total size; if over budget, delete oldest (by inner created_at) until under. */
async function prune(): Promise<void> {
    const d = await db();
    const total: number = await new Promise(resolve => {
        let sum = 0;
        const req = d.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
        req.onsuccess = () => { const c = req.result; if (!c) { resolve(sum); return; } sum += (c.value as CachedChatMsg).size || 0; c.continue(); };
        req.onerror = () => resolve(sum);
    });
    if (total <= BUDGET_BYTES) return;

    let remaining = total;
    await new Promise<void>(resolve => {
        const req = d.transaction(STORE, 'readwrite').objectStore(STORE).index('created_at').openCursor(null, 'next'); // oldest first
        req.onsuccess = () => {
            const c = req.result;
            if (!c || remaining <= BUDGET_BYTES) { resolve(); return; }
            remaining -= (c.value as CachedChatMsg).size || 0;
            c.delete();
            c.continue();
        };
        req.onerror = () => resolve();
    });
}

export async function getChatCacheStats(): Promise<{ count: number; sizeMB: number }> {
    try {
        const d = await db();
        const [count, size]: [number, number] = await new Promise(resolve => {
            let c = 0, s = 0;
            const req = d.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
            req.onsuccess = () => { const cur = req.result; if (!cur) { resolve([c, s]); return; } c++; s += (cur.value as CachedChatMsg).size || 0; cur.continue(); };
            req.onerror = () => resolve([c, s]);
        });
        return { count, sizeMB: Math.round((size / 1024 / 1024) * 10) / 10 };
    } catch {
        return { count: 0, sizeMB: 0 };
    }
}
