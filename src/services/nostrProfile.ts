/**
 * Nostr Profile Fetcher
 * Fetches kind:0 (metadata) events from Nostr relays for a given pubkey hex
 */

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
