/**
 * DNN (Decentralized Names Network) Service for DENOS
 * Ported from PWANS — handles node discovery, name queries, and claim event generation
 */

import { nip19 } from 'nostr-tools';

// Bootstrap nodes
const BOOTSTRAP_NODES = [
    'https://node.icannot.xyz'
];

// Generate UUID v4
function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export interface DnnNode {
    url: string;
    status: 'online' | 'offline' | 'unknown';
    lastSeen?: number;
}

export interface DnnName {
    name: string;
    dnnId: string;
    format: string;
    encoded?: string;
    dnnBlock: number;
    bitcoinBlock: number;
    position: number;
    status: 'pending' | 'confirmed';
    txid?: string;
    camelCase?: string;
}

export interface PendingName extends DnnName {
    txid: string;
}

/** Get the minimum amount for a DNN ID self-transfer (dust limit) */
export function getMinimumDnnIdAmount(): number {
    return 546;
}

class DnnService {
    private discoveredNodes: DnnNode[] = [];
    private initialized = false;

    /** Initialize with bootstrap nodes */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        this.discoveredNodes = BOOTSTRAP_NODES.map(url => ({
            url,
            status: 'unknown' as const
        }));

        await this.checkNodes();

        // Discover additional peers from online nodes
        await this.discoverPeers();

        this.initialized = true;
    }

    /** Discover peers from online nodes */
    async discoverPeers(): Promise<void> {
        const onlineNode = this.getOnlineNode();
        if (!onlineNode) return;

        try {
            const response = await fetch(`${onlineNode.url}/dnn/peers`, {
                signal: AbortSignal.timeout(5000)
            });
            if (response.ok) {
                const peers = await response.json();
                if (Array.isArray(peers)) {
                    for (const peerUrl of peers) {
                        if (typeof peerUrl === 'string' && !this.discoveredNodes.find(n => n.url === peerUrl)) {
                            this.discoveredNodes.push({ url: peerUrl, status: 'unknown' });
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[DnnService] Failed to discover peers:', e);
        }
    }

    /** Check status of all known nodes */
    async checkNodes(): Promise<void> {
        const checks = this.discoveredNodes.map(async (node) => {
            try {
                const response = await fetch(`${node.url}/dnn/status`, {
                    signal: AbortSignal.timeout(5000)
                });
                if (response.ok) {
                    node.status = 'online';
                    node.lastSeen = Date.now();
                } else {
                    node.status = 'offline';
                }
            } catch {
                node.status = 'offline';
            }
        });
        await Promise.allSettled(checks);
    }

    /** Get first online node */
    getOnlineNode(): DnnNode | null {
        return this.discoveredNodes.find(n => n.status === 'online') || null;
    }

    /** Get all discovered nodes */
    getNodes(): DnnNode[] {
        return [...this.discoveredNodes];
    }

    /** Get all DNN names owned by an npub */
    async getUserNames(npub: string): Promise<DnnName[]> {
        const onlineNode = this.getOnlineNode();
        if (!onlineNode) {
            console.warn('[DnnService] No online nodes available');
            return [];
        }

        try {
            const response = await fetch(`${onlineNode.url}/dnn/lookup/npub/${npub}`, {
                signal: AbortSignal.timeout(10000)
            });
            if (!response.ok) {
                console.error('[DnnService] Failed to fetch user names:', response.status);
                return [];
            }

            const data = await response.json();
            const names: DnnName[] = [];

            if (data.names && Array.isArray(data.names)) {
                for (const item of data.names) {
                    const encoded = item.encoded || '';
                    const camelCase = encoded.replace(/-([a-z])/g, (_match: string, letter: string) => letter.toUpperCase());

                    names.push({
                        name: item.name || '',
                        dnnId: encoded,
                        format: encoded,
                        encoded: encoded,
                        dnnBlock: item.dnn_block || 0,
                        bitcoinBlock: item.bitcoin_block || 0,
                        position: item.position || 0,
                        status: 'confirmed',
                        camelCase: camelCase
                    });
                }
            }

            return names;
        } catch (e) {
            console.error('[DnnService] Failed to fetch user names:', e);
            return [];
        }
    }

    /** Verify if a DNN ID belongs to a specific npub */
    async verifyDnnId(dnnId: string, expectedNpub: string): Promise<boolean> {
        if (!dnnId || !expectedNpub) return false;

        const onlineNode = this.getOnlineNode();
        if (!onlineNode) {
            console.warn('[DnnService] No online nodes available for verification');
            return false;
        }

        try {
            const normalizedDnnId = dnnId.toLowerCase();
            const response = await fetch(`${onlineNode.url}/dnn/resolve/${normalizedDnnId}`, {
                signal: AbortSignal.timeout(5000)
            });

            if (!response.ok) return false;

            const data = await response.json();
            return data.npub === expectedNpub;
        } catch (e) {
            console.error('[DnnService] Failed to verify DNN ID:', e);
            return false;
        }
    }

    /** Get pending names (unclaimed self-transfer transactions) */
    async getPendingNames(pubkeyHex: string): Promise<PendingName[]> {
        const onlineNode = this.getOnlineNode();
        if (!onlineNode) return [];

        try {
            const derivedAddresses = await this.deriveAllAddresses(pubkeyHex);
            if (!derivedAddresses || derivedAddresses.length === 0) {
                console.warn('[DnnService] Could not derive Bitcoin addresses for pubkey');
                return [];
            }

            const allPendingNames: PendingName[] = [];
            const seenTxids = new Set<string>();

            for (const address of derivedAddresses) {
                const response = await fetch(`${onlineNode.url}/dnn/anchors?address=${address}&status=pending`, {
                    signal: AbortSignal.timeout(10000)
                });

                if (!response.ok) continue;

                const data = await response.json();
                const transactions = Array.isArray(data) ? data : (data?.results || []);

                for (const item of transactions) {
                    const txid = item.transaction_id || item.TransactionID || '';
                    if (seenTxids.has(txid)) continue;
                    seenTxids.add(txid);

                    if (!item.has_anchor_event) {
                        const numericId = `n${item.dnn_block || item.DNNBlock || 0}.${item.position || item.Position || 0}`;
                        const encodedId = item.encoded || numericId;

                        allPendingNames.push({
                            name: item.name || encodedId,
                            dnnId: encodedId,
                            format: encodedId,
                            encoded: item.encoded,
                            dnnBlock: item.dnn_block || item.DNNBlock || 0,
                            bitcoinBlock: item.bitcoin_block || item.BitcoinBlock || 0,
                            position: item.position || item.Position || 0,
                            status: 'pending',
                            txid: txid
                        });
                    }
                }
            }

            return allPendingNames;
        } catch (e) {
            console.error('[DnnService] Failed to fetch pending names:', e);
            return [];
        }
    }

    /** Derive all Bitcoin addresses for a pubkey (calls DNN node API) */
    async deriveAllAddresses(pubkeyHex: string): Promise<string[]> {
        const onlineNode = this.getOnlineNode();
        if (!onlineNode) return [];

        try {
            const response = await fetch(`${onlineNode.url}/dnn/derive-address/${pubkeyHex}`, {
                signal: AbortSignal.timeout(5000)
            });

            if (response.ok) {
                const data = await response.json();
                if (data.addresses && Array.isArray(data.addresses)) {
                    return data.addresses.map((item: any) => item.address).filter(Boolean);
                }
            }
        } catch (e) {
            console.error('[DnnService] Failed to derive addresses:', e);
        }
        return [];
    }

    /** Generate NIP-DN events for claiming a DNN ID */
    generateClaimEvents(
        _pubkey: string,
        txid: string,
        desiredName?: string
    ): {
        nameEvent: any;
        connectionEvent: any;
        metadataEvent: any;
        anchorEvent: any;
        dTags: { name: string; connection: string; metadata: string; anchor: string };
    } {
        const now = Math.floor(Date.now() / 1000);

        const dTags = {
            name: generateUUID(),
            connection: generateUUID(),
            metadata: generateUUID(),
            anchor: generateUUID()
        };

        // Kind 61600 - Name Event
        const nameEvent = {
            kind: 61600,
            created_at: now,
            tags: [
                ['d', dTags.name],
                ['t', 'DNN'],
                ...(desiredName ? [['n', desiredName]] : [])
            ],
            content: JSON.stringify({ updated_at: now })
        };

        // Kind 62600 - Connection Event
        const connectionEvent = {
            kind: 62600,
            created_at: now,
            tags: [
                ['d', dTags.connection],
                ['t', 'DNN'],
                ['v', '1']
            ],
            content: JSON.stringify({})
        };

        // Kind 63600 - Metadata Event
        const metadataEvent = {
            kind: 63600,
            created_at: now,
            tags: [
                ['d', dTags.metadata],
                ['t', 'DNN']
            ],
            content: JSON.stringify({ updated_at: now, metadata: {} })
        };

        // Kind 60600 - Anchor Event (naddr values filled later)
        const anchorEvent = {
            kind: 60600,
            created_at: now,
            tags: [
                ['d', dTags.anchor],
                ['n', ''],
                ['c', ''],
                ['m', ''],
                ['x', txid],
                ['t', 'DNN']
            ],
            content: JSON.stringify({ updated_at: now })
        };

        return { nameEvent, connectionEvent, metadataEvent, anchorEvent, dTags };
    }

    /** Create naddr for an addressable event */
    createNaddr(pubkeyHex: string, kind: number, dTag: string, relays: string[] = []): string {
        return nip19.naddrEncode({
            identifier: dTag,
            pubkey: pubkeyHex,
            kind,
            relays
        });
    }

    /** Fill in anchor event with naddr references */
    fillAnchorEvent(
        anchorEvent: any,
        pubkeyHex: string,
        dTags: { name: string; connection: string; metadata: string },
        relays: string[] = []
    ): any {
        const nameNaddr = this.createNaddr(pubkeyHex, 61600, dTags.name, relays);
        const connectionNaddr = this.createNaddr(pubkeyHex, 62600, dTags.connection, relays);
        const metadataNaddr = this.createNaddr(pubkeyHex, 63600, dTags.metadata, relays);

        const updatedEvent = { ...anchorEvent };
        updatedEvent.tags = anchorEvent.tags.map((tag: string[]) => {
            if (tag[0] === 'n') return ['n', nameNaddr];
            if (tag[0] === 'c') return ['c', connectionNaddr];
            if (tag[0] === 'm') return ['m', metadataNaddr];
            return tag;
        });

        return updatedEvent;
    }
}

// Singleton
export const dnnService = new DnnService();
