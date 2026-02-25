/**
 * Nostr Follows Fetcher
 * Fetches kind:3 (contact list) events from Nostr relays for a given pubkey hex.
 * Returns an array of followed pubkey hexes.
 */

const DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol',
    'wss://relay.nostr.band',
];

/**
 * Fetch the contact list (kind:3) for a given hex pubkey.
 * Queries multiple relays in parallel, picks the most recent event,
 * and extracts followed pubkey hexes from its `p` tags.
 */
export async function fetchFollows(
    pubkeyHex: string,
    relayUrls?: string[]
): Promise<string[]> {
    const relays = relayUrls && relayUrls.length > 0 ? relayUrls : DEFAULT_RELAYS;
    const timeout = 8000;

    const results = await Promise.allSettled(
        relays.map(relay => fetchContactListFromRelay(relay, pubkeyHex, timeout))
    );

    // Pick the most recent contact list (highest created_at)
    let best: { tags: string[][]; createdAt: number } | null = null;
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
            if (!best || result.value.createdAt > best.createdAt) {
                best = result.value;
            }
        }
    }

    if (!best) return [];

    // Extract unique pubkey hexes from "p" tags
    const pubkeys = new Set<string>();
    for (const tag of best.tags) {
        if (tag[0] === 'p' && tag[1] && tag[1].length === 64) {
            pubkeys.add(tag[1]);
        }
    }

    return Array.from(pubkeys);
}

function fetchContactListFromRelay(
    relayUrl: string,
    pubkeyHex: string,
    timeoutMs: number
): Promise<{ tags: string[][]; createdAt: number } | null> {
    return new Promise((resolve) => {
        let ws: WebSocket | null = null;
        let resolved = false;
        let bestEvent: { tags: string[][]; createdAt: number } | null = null;

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
                resolve(bestEvent);
            }
        }, timeoutMs);

        try {
            ws = new WebSocket(relayUrl);

            ws.onopen = () => {
                const subId = 'follows_' + Math.random().toString(36).slice(2, 8);
                const req = JSON.stringify([
                    'REQ', subId,
                    { kinds: [3], authors: [pubkeyHex], limit: 1 }
                ]);
                ws!.send(req);
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data[0] === 'EVENT' && data[2]) {
                        const nostrEvent = data[2];
                        if (nostrEvent.kind === 3 && Array.isArray(nostrEvent.tags)) {
                            const createdAt = nostrEvent.created_at || 0;
                            if (!bestEvent || createdAt > bestEvent.createdAt) {
                                bestEvent = { tags: nostrEvent.tags, createdAt };
                            }
                        }
                    }
                    if (data[0] === 'EOSE') {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timer);
                            cleanup();
                            resolve(bestEvent);
                        }
                    }
                } catch { /* ignore parse errors */ }
            };

            ws.onerror = () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    cleanup();
                    resolve(bestEvent);
                }
            };

            ws.onclose = () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    resolve(bestEvent);
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
