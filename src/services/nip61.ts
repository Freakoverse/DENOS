/**
 * NIP-60/61 Services — Wallet state backup & NutZap events.
 * Port of PWANS services/nip61.ts adapted for DENOS (raw WebSocket, nostr-tools signing).
 */
import { nip44, finalizeEvent } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';

export const KIND_NIP60_WALLET = 30078;
export const KIND_NIP61_NUTZAP = 9321;

const DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
    'wss://relay.primal.net',
    'wss://relay.snort.social',
    'wss://relay.azzamo.net',
    'wss://relay.cashumints.space'
];

// ── Helper: publish event to relays via raw WebSocket ──
async function publishToRelays(
    signedEvent: any,
    relayUrls: string[] = DEFAULT_RELAYS
): Promise<number> {
    let successCount = 0;
    const promises = relayUrls.map(relayUrl => {
        return new Promise<void>((resolve) => {
            try {
                const ws = new WebSocket(relayUrl);
                const timer = setTimeout(() => {
                    try { ws.close(); } catch { /* ignore */ }
                    resolve();
                }, 5000);

                ws.onopen = () => {
                    ws.send(JSON.stringify(['EVENT', signedEvent]));
                };

                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'OK' && data[2] === true) {
                            successCount++;
                        }
                    } catch { /* ignore */ }
                    clearTimeout(timer);
                    try { ws.close(); } catch { /* ignore */ }
                    resolve();
                };

                ws.onerror = () => {
                    clearTimeout(timer);
                    resolve();
                };
            } catch {
                resolve();
            }
        });
    });

    await Promise.allSettled(promises);
    return successCount;
}

// ── Helper: subscribe to events from relays ──
function subscribeToRelays(
    filter: any,
    callback: (event: any) => void,
    relayUrls: string[] = DEFAULT_RELAYS
): { stop: () => void } {
    const sockets: WebSocket[] = [];
    const subId = 'sub_' + Math.random().toString(36).slice(2, 10);

    for (const relayUrl of relayUrls) {
        try {
            const ws = new WebSocket(relayUrl);

            ws.onopen = () => {
                ws.send(JSON.stringify(['REQ', subId, filter]));
            };

            ws.onmessage = (msg) => {
                try {
                    const data = JSON.parse(msg.data);
                    if (data[0] === 'EVENT' && data[2]) {
                        callback(data[2]);
                    }
                } catch { /* ignore */ }
            };

            ws.onerror = () => { /* ignore */ };
            sockets.push(ws);
        } catch { /* ignore */ }
    }

    return {
        stop: () => {
            for (const ws of sockets) {
                try {
                    ws.send(JSON.stringify(['CLOSE', subId]));
                    ws.close();
                } catch { /* ignore */ }
            }
        }
    };
}

// ══════════════════════════════════════════════
//  NIP-60 (Wallet State Backup)
// ══════════════════════════════════════════════

export class Nip60Service {
    /**
     * Encrypt wallet state using NIP-44 (encrypt to self).
     */
    static encryptWalletState(
        privateKeyHex: string,
        pubkeyHex: string,
        walletState: { proofs: any[]; history: any[] }
    ): string {
        const payload = JSON.stringify(walletState);
        const sk = hexToBytes(privateKeyHex);
        const conversationKey = nip44.v2.utils.getConversationKey(sk, pubkeyHex);
        return nip44.v2.encrypt(payload, conversationKey);
    }

    /**
     * Decrypt wallet state from NIP-44 ciphertext.
     * Handles backward compatibility with old format (proofs-only).
     */
    static decryptWalletState(
        privateKeyHex: string,
        pubkeyHex: string,
        ciphertext: string
    ): { proofs: any[]; history: any[] } {
        const sk = hexToBytes(privateKeyHex);
        const conversationKey = nip44.v2.utils.getConversationKey(sk, pubkeyHex);
        const plaintext = nip44.v2.decrypt(ciphertext, conversationKey);

        const parsed = JSON.parse(plaintext);

        // Backward compat: old format was just a proofs array
        if (Array.isArray(parsed)) {
            return { proofs: parsed, history: [] };
        }

        return {
            proofs: parsed.proofs || [],
            history: parsed.history || []
        };
    }

    /**
     * Create a kind 30078 parameterized replaceable event for wallet state.
     */
    static createProofEvent(
        _pubkeyHex: string,
        encryptedContent: string
    ): any {
        return {
            kind: KIND_NIP60_WALLET,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['d', 'proofs'],
            ],
            content: encryptedContent,
        };
    }

    /**
     * Publish wallet state to Nostr relays.
     */
    static async publishWalletState(
        pubkeyHex: string,
        privateKeyHex: string,
        walletState: { proofs: any[]; history: any[] },
        _skipMerge = false
    ): Promise<void> {
        const encrypted = this.encryptWalletState(privateKeyHex, pubkeyHex, walletState);
        const template = this.createProofEvent(pubkeyHex, encrypted);

        const sk = hexToBytes(privateKeyHex);
        const signedEvent = finalizeEvent(template, sk);

        const successCount = await publishToRelays(signedEvent);
        console.log(`📤 NIP-60: Published wallet state to ${successCount} relays`);
    }

    /**
     * Fetch the latest wallet state from relays (one-shot).
     * Waits for EOSE from relays to ensure we have the newest event.
     * Returns null if no event found or all relays are offline.
     */
    static async fetchLatestWalletState(
        pubkeyHex: string,
        privateKeyHex: string,
        relayUrls: string[] = DEFAULT_RELAYS,
        timeoutMs = 6000
    ): Promise<{ proofs: any[]; history: any[]; created_at: number } | null> {
        return new Promise((resolve) => {
            let bestEvent: any = null;
            let resolvedCount = 0;
            const totalRelays = relayUrls.length;
            let resolved = false;

            const tryResolve = () => {
                if (resolved) return;
                resolvedCount++;
                if (resolvedCount >= totalRelays) {
                    resolved = true;
                    if (!bestEvent) {
                        resolve(null);
                        return;
                    }
                    try {
                        const walletState = Nip60Service.decryptWalletState(
                            privateKeyHex, pubkeyHex, bestEvent.content
                        );
                        resolve({
                            ...walletState,
                            created_at: bestEvent.created_at
                        });
                    } catch (e) {
                        console.error('Failed to decrypt fetched NIP-60 state:', e);
                        resolve(null);
                    }
                }
            };

            // Global timeout — resolve with whatever we have
            const timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    if (!bestEvent) {
                        console.warn('⏱️ NIP-60 fetch timed out, no events received');
                        resolve(null);
                        return;
                    }
                    try {
                        const walletState = Nip60Service.decryptWalletState(
                            privateKeyHex, pubkeyHex, bestEvent.content
                        );
                        resolve({
                            ...walletState,
                            created_at: bestEvent.created_at
                        });
                    } catch {
                        resolve(null);
                    }
                }
            }, timeoutMs);

            const subId = 'fetch_' + Math.random().toString(36).slice(2, 10);
            const sockets: WebSocket[] = [];

            for (const relayUrl of relayUrls) {
                try {
                    const ws = new WebSocket(relayUrl);

                    const wsTimer = setTimeout(() => {
                        try { ws.close(); } catch { /* ignore */ }
                        tryResolve();
                    }, timeoutMs - 500);

                    ws.onopen = () => {
                        ws.send(JSON.stringify(['REQ', subId, {
                            kinds: [KIND_NIP60_WALLET],
                            authors: [pubkeyHex],
                            '#d': ['proofs'],
                            limit: 1
                        }]));
                    };

                    ws.onmessage = (msg) => {
                        try {
                            const data = JSON.parse(msg.data);
                            if (data[0] === 'EVENT' && data[2]) {
                                const event = data[2];
                                if (!bestEvent || event.created_at > bestEvent.created_at) {
                                    bestEvent = event;
                                }
                            } else if (data[0] === 'EOSE') {
                                clearTimeout(wsTimer);
                                try {
                                    ws.send(JSON.stringify(['CLOSE', subId]));
                                    ws.close();
                                } catch { /* ignore */ }
                                tryResolve();
                            }
                        } catch { /* ignore */ }
                    };

                    ws.onerror = () => {
                        clearTimeout(wsTimer);
                        tryResolve();
                    };

                    sockets.push(ws);
                } catch {
                    tryResolve();
                }
            }

            // Cleanup on resolve
            const origResolve = resolve;
            resolve = ((val: any) => {
                clearTimeout(timer);
                for (const ws of sockets) {
                    try { ws.close(); } catch { /* ignore */ }
                }
                origResolve(val);
            }) as any;
        });
    }

    /**
     * Subscribe to own wallet state events.
     * Pass sinceTimestamp to skip events already processed (e.g., from initial fetch).
     */
    static subscribeToWalletState(
        _ndk: any, // unused — we use raw WebSocket
        pubkeyHex: string,
        privateKeyHex: string,
        onUpdate: (walletState: { proofs: any[]; history: any[] }) => void,
        sinceTimestamp = 0
    ): { stop: () => void } {
        let latestTimestamp = sinceTimestamp;

        return subscribeToRelays(
            {
                kinds: [KIND_NIP60_WALLET],
                authors: [pubkeyHex],
                '#d': ['proofs'],
                limit: 1
            },
            (event: any) => {
                // Only process events newer than what we've already seen
                if (event.created_at <= latestTimestamp) return;
                latestTimestamp = event.created_at;

                try {
                    const walletState = Nip60Service.decryptWalletState(
                        privateKeyHex,
                        pubkeyHex,
                        event.content
                    );
                    console.log(`📥 NIP-60 live: Received wallet state (${walletState.proofs.length} proofs, ${walletState.history.length} history)`);
                    onUpdate(walletState);
                } catch (e) {
                    console.error('Failed to decrypt NIP-60 wallet state:', e);
                }
            }
        );
    }
}

// ══════════════════════════════════════════════
//  NIP-61 (NutZaps)
// ══════════════════════════════════════════════

export class Nip61Service {
    /**
     * Create a NutZap event (kind 9321).
     */
    static createNutZapEvent(
        token: string,
        mintUrl: string,
        amount: number,
        recipientPubkeyHex: string,
        privateKeyHex: string
    ): any {
        const template = {
            kind: KIND_NIP61_NUTZAP,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
                ['p', recipientPubkeyHex],
                ['amount', amount.toString()],
                ['u', mintUrl],
            ],
            content: token,
        };

        const sk = hexToBytes(privateKeyHex);
        return finalizeEvent(template, sk);
    }

    /**
     * Parse an incoming NutZap event.
     */
    static parseNutZap(event: any): {
        amount: number;
        mint: string;
        recipient: string;
        sender: string;
    } | null {
        try {
            const amountTag = event.tags?.find((t: any) => t[0] === 'amount');
            const mintTag = event.tags?.find((t: any) => t[0] === 'u');
            const recipientTag = event.tags?.find((t: any) => t[0] === 'p');

            if (!amountTag || !mintTag || !recipientTag) return null;

            return {
                amount: parseInt(amountTag[1]),
                mint: mintTag[1],
                recipient: recipientTag[1],
                sender: event.pubkey
            };
        } catch {
            return null;
        }
    }
}
