/**
 * NIP-87 Service — Mint discovery via Nostr events.
 * Port of PWANS services/nip87.ts adapted for DENOS (raw WebSocket instead of NDK).
 */
import { useEcashStore } from './ecashStore';

export const KIND_MINT_INFO = 38172;
export const KIND_MINT_RECOMMENDATION = 38000;

const DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
    'wss://relay.primal.net',
    'wss://relay.snort.social',
    'wss://relay.azzamo.net',
    'wss://relay.cashumints.space'
];

export class Nip87Service {
    static parseMintInfo(event: any): { url: string; pubkey: string } | null {
        try {
            const urlTag = event.tags?.find((t: any) => t[0] === 'u');
            if (!urlTag || !urlTag[1]) return null;
            return {
                url: urlTag[1].replace(/\/$/, ''),
                pubkey: event.pubkey
            };
        } catch {
            return null;
        }
    }

    /**
     * Subscribe to mint discovery events from relays.
     * Returns a stop function to cancel the subscription.
     */
    static subscribeToMints(
        _ndk?: any, // unused — we use raw WebSocket
        relayUrls: string[] = DEFAULT_RELAYS
    ): { stop: () => void } {
        console.log('🔍 Nip87Service: Subscribing to mints (kinds 38172, 38000)...');

        const sockets: WebSocket[] = [];
        const subId = 'mint_discovery_' + Math.random().toString(36).slice(2, 8);
        let eventCount = 0;
        let lastLogTime = Date.now();

        for (const relayUrl of relayUrls) {
            try {
                const ws = new WebSocket(relayUrl);

                ws.onopen = () => {
                    ws.send(JSON.stringify(['REQ', subId, {
                        kinds: [KIND_MINT_INFO, KIND_MINT_RECOMMENDATION],
                        limit: 500
                    }]));
                };

                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] !== 'EVENT' || !data[2]) return;

                        const event = data[2];
                        eventCount++;

                        // Throttle logging
                        const now = Date.now();
                        if (now - lastLogTime > 5000) {
                            console.log(`📡 NIP-87: Received ${eventCount} mint discovery events`);
                            lastLogTime = now;
                        }

                        const store = useEcashStore.getState();

                        if (event.kind === KIND_MINT_INFO) {
                            const info = Nip87Service.parseMintInfo(event);
                            if (info && info.url) {
                                if (!store.discoveredMints[info.url] && !store.mints[info.url]) {
                                    store.addDiscoveredMint({
                                        url: info.url,
                                        status: 'unknown',
                                        trustScore: 0,
                                        reviews: 0,
                                        lastSeen: Date.now()
                                    });
                                }
                            }
                        } else if (event.kind === KIND_MINT_RECOMMENDATION) {
                            const urlTag = event.tags?.find((t: any) => t[0] === 'u');
                            if (urlTag && urlTag[1]) {
                                const url = urlTag[1].replace(/\/$/, '');
                                if (store.discoveredMints[url]) {
                                    store.updateMintTrust(url, 1);
                                }
                            }
                        }
                    } catch { /* ignore bad events */ }
                };

                ws.onerror = () => { /* ignore */ };
                sockets.push(ws);
            } catch { /* ignore connection failures */ }
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
}
