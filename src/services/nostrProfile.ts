/**
 * Nostr Profile Fetcher
 * Fetches kind:0 (metadata) events from Nostr relays for a given pubkey hex
 */
import { useState, useEffect } from 'react';

export interface NostrProfile {
    name?: string;
    display_name?: string;
    nip05?: string;
    picture?: string;
    about?: string;
    lud16?: string;
}

const DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol',
];

/**
 * Fetch kind:0 profile for a given hex pubkey.
 * Queries multiple relays in parallel and returns the most recent profile.
 */
export async function fetchNostrProfile(
    pubkeyHex: string,
    relayUrls?: string[]
): Promise<NostrProfile | null> {
    const relays = relayUrls && relayUrls.length > 0 ? relayUrls : DEFAULT_RELAYS;
    const timeout = 6000;

    const results = await Promise.allSettled(
        relays.map(relayUrl => fetchProfileFromRelay(relayUrl, pubkeyHex, timeout))
    );

    // Pick the most recent profile (highest created_at)
    let best: { profile: NostrProfile; createdAt: number } | null = null;
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
            if (!best || result.value.createdAt > best.createdAt) {
                best = result.value;
            }
        }
    }

    return best ? best.profile : null;
}

// ── Cached kind:0 identity (name + picture), stale-while-revalidate ──
//
// Single source of truth for displaying an account's kind:0 name and avatar. Backed by the
// `denos-pmeta-<pubkey>` localStorage keyspace. Two rules make it robust:
//   1. NEVER REGRESS — a fetch that returns an empty field must not overwrite a good cached one.
//      (A timed-out or partial relay response returning nothing is why names used to flip back to
//      the npub / avatars blanked.)
//   2. Revalidate at most once per session per pubkey — cache shows instantly; a background fetch
//      then updates only if it brings genuinely new, non-empty data.

export interface ProfileMeta {
    name: string | null;
    picture: string | null;
}

const metaMem = new Map<string, ProfileMeta>();
const metaInflight = new Map<string, Promise<ProfileMeta>>();
const attempted = new Set<string>(); // fetched this session already (even if the result was empty)

/** Synchronous cache read (in-memory → localStorage). `null` if nothing is cached yet. */
export function cachedProfileMeta(pubkeyHex: string): ProfileMeta | null {
    if (metaMem.has(pubkeyHex)) return metaMem.get(pubkeyHex)!;
    try {
        const raw = localStorage.getItem('denos-pmeta-' + pubkeyHex);
        if (raw) { const m = JSON.parse(raw) as ProfileMeta; metaMem.set(pubkeyHex, m); return m; }
    } catch { /* ignore */ }
    return null;
}

/** Merge a fetch result without regressing: empty fields keep the previously cached value. */
function mergeMeta(pubkeyHex: string, incoming: ProfileMeta): ProfileMeta {
    const prev = cachedProfileMeta(pubkeyHex);
    const merged: ProfileMeta = {
        name: (incoming.name && incoming.name.trim()) || prev?.name || null,
        picture: incoming.picture || prev?.picture || null,
    };
    metaMem.set(pubkeyHex, merged);
    if (!prev || prev.name !== merged.name || prev.picture !== merged.picture) {
        try { localStorage.setItem('denos-pmeta-' + pubkeyHex, JSON.stringify(merged)); } catch { /* ignore */ }
    }
    return merged;
}

/** Fetch + merge a pubkey's kind:0 identity. De-duplicates concurrent calls; on failure returns
 *  whatever is cached rather than an empty (so a failed fetch can never blank an existing value). */
export async function resolveProfileMeta(pubkeyHex: string, relayUrls?: string[]): Promise<ProfileMeta> {
    const inflight = metaInflight.get(pubkeyHex);
    if (inflight) return inflight;
    const p = fetchNostrProfile(pubkeyHex, relayUrls)
        .then(prof => mergeMeta(pubkeyHex, {
            name: (prof?.display_name || prof?.name || '').trim() || null,
            picture: prof?.picture || null,
        }))
        .catch(() => cachedProfileMeta(pubkeyHex) || { name: null, picture: null })
        .finally(() => { metaInflight.delete(pubkeyHex); attempted.add(pubkeyHex); });
    metaInflight.set(pubkeyHex, p);
    return p;
}

/** Force a background re-fetch on next use — call after the user edits their own kind:0 profile. */
export function invalidateProfileMeta(pubkeyHex: string): void {
    attempted.delete(pubkeyHex);
}

/** Authoritatively set a pubkey's cached identity — e.g. right after the user saves their OWN
 *  kind:0. Overwrites (unlike the fetch merge) because this is first-party data, and marks it
 *  attempted so a relay fetch lagging behind propagation can't immediately clobber it. */
export function primeProfileMeta(pubkeyHex: string, meta: ProfileMeta): void {
    metaMem.set(pubkeyHex, meta);
    attempted.add(pubkeyHex);
    try { localStorage.setItem('denos-pmeta-' + pubkeyHex, JSON.stringify(meta)); } catch { /* ignore */ }
}

// Name-only convenience, backed by the same cache.
export function cachedProfileName(pubkeyHex: string): string | null | undefined {
    const m = cachedProfileMeta(pubkeyHex);
    return m ? m.name : undefined; // undefined = never fetched
}
export async function resolveProfileName(pubkeyHex: string, relayUrls?: string[]): Promise<string | null> {
    return (await resolveProfileMeta(pubkeyHex, relayUrls)).name;
}

/** Reactive kind:0 identity for one pubkey: cache instantly, revalidate in the background once. */
export function useProfileMeta(pubkeyHex?: string | null): ProfileMeta | null {
    const [meta, setMeta] = useState<ProfileMeta | null>(() => (pubkeyHex ? cachedProfileMeta(pubkeyHex) : null));
    useEffect(() => {
        if (!pubkeyHex) { setMeta(null); return; }
        setMeta(cachedProfileMeta(pubkeyHex));
        if (attempted.has(pubkeyHex)) return;
        let live = true;
        resolveProfileMeta(pubkeyHex).then(m => { if (live) setMeta(m); });
        return () => { live = false; };
    }, [pubkeyHex]);
    return meta;
}

/**
 * Reactive kind:0 names for a set of pubkeys. Returns `pubkey -> name` only for those that HAVE a
 * name; callers fall back to a truncated npub when absent. This map only ever *gains* names — a
 * revalidation never removes one — so a display can't flip back to the npub once a name is known.
 */
export function useProfileNames(pubkeyHexes: string[]): Record<string, string> {
    const key = pubkeyHexes.join(',');
    const seedFromCache = (): Record<string, string> => {
        const o: Record<string, string> = {};
        for (const pk of pubkeyHexes) { const n = cachedProfileMeta(pk)?.name; if (n) o[pk] = n; }
        return o;
    };
    const [names, setNames] = useState<Record<string, string>>(seedFromCache);
    useEffect(() => {
        let live = true;
        setNames(seedFromCache());
        for (const pk of pubkeyHexes) {
            if (attempted.has(pk)) continue;
            resolveProfileMeta(pk).then(m => {
                if (m.name && live) setNames(prev => (prev[pk] === m.name ? prev : { ...prev, [pk]: m.name! }));
            });
        }
        return () => { live = false; };
    }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
    return names;
}

function fetchProfileFromRelay(
    relayUrl: string,
    pubkeyHex: string,
    timeoutMs: number
): Promise<{ profile: NostrProfile; createdAt: number } | null> {
    return new Promise((resolve) => {
        let ws: WebSocket | null = null;
        let resolved = false;

        const cleanup = () => {
            if (ws) {
                try { ws.close(); } catch { /* ignore */ }
                ws = null;
            }
        };

        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                cleanup();
                resolve(null);
            }
        }, timeoutMs);

        try {
            ws = new WebSocket(relayUrl);

            ws.onopen = () => {
                // Send REQ for kind:0 (metadata) events by this pubkey
                const subId = 'profile_' + Math.random().toString(36).slice(2, 8);
                const req = JSON.stringify([
                    'REQ', subId,
                    { kinds: [0], authors: [pubkeyHex], limit: 1 }
                ]);
                ws!.send(req);
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    // EVENT message: ["EVENT", subId, event]
                    if (data[0] === 'EVENT' && data[2]) {
                        const nostrEvent = data[2];
                        if (nostrEvent.kind === 0 && nostrEvent.content) {
                            const profile = JSON.parse(nostrEvent.content) as NostrProfile;
                            if (!resolved) {
                                resolved = true;
                                clearTimeout(timer);
                                cleanup();
                                resolve({ profile, createdAt: nostrEvent.created_at || 0 });
                            }
                        }
                    }
                    // EOSE: end of stored events — if we haven't found anything, resolve null
                    if (data[0] === 'EOSE') {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timer);
                            cleanup();
                            resolve(null);
                        }
                    }
                } catch { /* ignore parse errors */ }
            };

            ws.onerror = () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    cleanup();
                    resolve(null);
                }
            };

            ws.onclose = () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    resolve(null);
                }
            };
        } catch {
            if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                resolve(null);
            }
        }
    });
}
