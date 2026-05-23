/**
 * NIP-NSP: Nostr Silent Payments Service
 *
 * Core crypto (tweak generation, key tweaking, multi-chain address derivation),
 * Nostr event creation/parsing (kind 1604 notifications, kind 30078 payment list),
 * and balance checking for tweaked addresses.
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { Buffer } from 'buffer';
import { nip44, finalizeEvent, getPublicKey } from 'nostr-tools';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak256 } from 'js-sha3';

import { getECPair } from '@/services/bitcoin';
import {
    privateKeyToBitcoinAddress,
    privateKeyToTaprootAddress,
    fetchUTXOs,
} from '@/services/bitcoin';
import { deriveScanKeys } from '@/services/sp1';
import {
    fetchEvmBalance,
    fetchTokenBalance,
} from '@/services/evm';
import {
    deriveZcashAddress,
    fetchZcashBalance,
    pubkeyHexToZcashAddress,
} from '@/services/zcash';

// ── Constants ──

export const KIND_NSP_NOTIFICATION = 1604;
export const KIND_NSP_PAYMENT_LIST = 30078;
export const NSP_INDEX_DTAG = 'nostr-silent-payment-list-index';
export const NSP_SENT_DTAG = 'nostr-silent-payment-sent-list';
export const MAX_ENTRIES_PER_PAGE = 100;

const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

const HARDCODED_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
    'wss://relay.primal.net',
    'wss://relay.snort.social',
];

// ── Types ──

export type NspChain = 'bitcoin' | 'ethereum' | 'bnb' | 'polygon' | 'avalanche' | 'base' | 'zcash';

export interface NspPayload {
    address: string;
    chain: NspChain;
    asset: string;
    token: string | null;
    tweak: string;
    txid: string;
    amount: string;
    timestamp: number;
}

export interface NspConfirmedPayment {
    chain: NspChain;
    address: string;
    tweak: string;
    asset: string;
    token: string | null;
    txid: string;
    amount: string;
    confirmedAt: number;
}

export interface RelayPublishResult {
    relay: string;
    success: boolean;
    error?: string;
}

export interface NspSentEntry {
    txid: string;
    chain: NspChain;
    asset: string;
    token: string | null;
    amount: string;
    address: string;         // tweaked address sent to
    tweak: string;           // tweak used for derivation
    recipientPubkey: string; // recipient hex pubkey
    senderNsec: string;      // ephemeral sender privkey hex (for renotify)
    timestamp: number;
}

export interface NspIndex {
    last_page: number;
    slots: Record<string, number>;
    last_scanned: number;
}

function pageTag(n: number): string {
    return `nostr-silent-payment-list-${n}`;
}

// ── Reusable Relay Helpers ──

/**
 * Fetch the best (newest) NIP-78 events for a set of d-tags from hardcoded relays.
 * Returns a map of d-tag → raw event object.
 */
async function fetchBestNip78(
    pubkeyHex: string,
    dTags: string[],
    timeoutMs = 6000,
): Promise<Map<string, any>> {
    return new Promise((resolve) => {
        const bestEvents = new Map<string, any>();
        let resolvedCount = 0;
        let resolved = false;
        const totalRelays = HARDCODED_RELAYS.length;
        const sockets: WebSocket[] = [];
        const subId = 'nsp_q_' + Math.random().toString(36).slice(2, 8);

        const finish = () => {
            if (resolved) return;
            resolved = true;
            sockets.forEach(s => { try { s.close(); } catch {} });
            resolve(bestEvents);
        };

        const tryFinish = () => {
            resolvedCount++;
            if (resolvedCount >= totalRelays) finish();
        };

        setTimeout(finish, timeoutMs);

        for (const relayUrl of HARDCODED_RELAYS) {
            try {
                const ws = new WebSocket(relayUrl);
                sockets.push(ws);
                ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, {
                    kinds: [KIND_NSP_PAYMENT_LIST],
                    authors: [pubkeyHex],
                    '#d': dTags,
                    limit: dTags.length,
                }]));
                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'EVENT' && data[2]) {
                            const evt = data[2];
                            const dTag = evt.tags?.find((t: any) => t[0] === 'd')?.[1];
                            if (dTag) {
                                const existing = bestEvents.get(dTag);
                                if (!existing || evt.created_at > existing.created_at) {
                                    bestEvents.set(dTag, evt);
                                }
                            }
                        }
                        if (data[0] === 'EOSE') {
                            try { ws.close(); } catch {}
                            tryFinish();
                        }
                    } catch {}
                };
                ws.onerror = () => tryFinish();
            } catch { tryFinish(); }
        }
    });
}

/**
 * Publish a NIP-78 event with the given d-tag and encrypted content to hardcoded relays.
 */
async function publishNip78(
    privateKeyHex: string,
    dTag: string,
    encryptedContent: string,
): Promise<number> {
    const template = {
        kind: KIND_NSP_PAYMENT_LIST,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['d', dTag]],
        content: encryptedContent,
    };
    const sk = hexToBytes(privateKeyHex);
    const signedEvent = finalizeEvent(template, sk);

    let successCount = 0;
    const promises = HARDCODED_RELAYS.map(relayUrl =>
        new Promise<void>((resolve) => {
            try {
                const ws = new WebSocket(relayUrl);
                const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 5000);
                ws.onopen = () => ws.send(JSON.stringify(['EVENT', signedEvent]));
                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'OK' && data[2] === true) successCount++;
                    } catch {}
                    clearTimeout(timer);
                    try { ws.close(); } catch {}
                    resolve();
                };
                ws.onerror = () => { clearTimeout(timer); resolve(); };
            } catch { resolve(); }
        })
    );
    await Promise.allSettled(promises);
    return successCount;
}

// ── 1. Tweak Generation ──

export function generateTweak(): string {
    const preimage = `${Date.now()}:${crypto.randomUUID()}`;
    const data = new TextEncoder().encode(preimage);
    const hash = sha256(data);
    return bytesToHex(hash);
}

// ── 2. Key Tweaking ──

/**
 * Tweak a public key: P' = P + t·G, then even-y normalize.
 * Input: 32-byte x-only pubkey hex (from npub), 32-byte tweak hex.
 * Returns: 33-byte compressed pubkey (02-prefixed, even-y).
 */
export function tweakPublicKey(xOnlyPubkeyHex: string, tweakHex: string): Buffer {
    const compressed = Buffer.from('02' + xOnlyPubkeyHex, 'hex');
    const tweakScalar = Buffer.from(tweakHex, 'hex');

    const tweakPoint = ecc.pointFromScalar(tweakScalar);
    if (!tweakPoint) throw new Error('Invalid tweak scalar');

    const tweakedPoint = ecc.pointAdd(compressed, tweakPoint);
    if (!tweakedPoint) throw new Error('Point addition failed');

    // Return the raw compressed tweaked point (02 or 03 prefix).
    // Even-y normalization is NOT done here — it is the caller's
    // responsibility to handle parity based on the target chain:
    //   - Bitcoin Taproot: uses x-only (parity irrelevant)
    //   - EVM/Zcash: needs full (x, y), so the real parity matters
    return Buffer.from(tweakedPoint);
}

/**
 * Tweak a private key: d' = (d_even + t) mod n.
 * The base key is normalized to even-y BEFORE tweaking to match the sender's
 * convention of starting from (02 || x_npub). Returns the raw tweaked key
 * with natural parity — callers apply chain-specific normalization.
 */
export function tweakPrivateKey(privateKeyHex: string, tweakHex: string): string {
    const d = BigInt('0x' + privateKeyHex);
    const t = BigInt('0x' + tweakHex);
    const keyPair = getECPair().fromPrivateKey(Buffer.from(privateKeyHex, 'hex'));
    const dNorm = keyPair.publicKey[0] === 0x03 ? (SECP256K1_N - d) : d;
    const dPrime = (dNorm + t) % SECP256K1_N;
    return dPrime.toString(16).padStart(64, '0');
}

/**
 * Legacy tweak: d' = (d + t) mod n — NO base normalization.
 * Used for backward compatibility with old notifications created before
 * the even-y normalization fix. Old notifications derived addresses using
 * the raw private key, so signing/verification must use the same path.
 */
export function tweakPrivateKeyLegacy(privateKeyHex: string, tweakHex: string): string {
    const d = BigInt('0x' + privateKeyHex);
    const t = BigInt('0x' + tweakHex);
    const dPrime = (d + t) % SECP256K1_N;
    return dPrime.toString(16).padStart(64, '0');
}

/**
 * Get the correct signing key for a confirmed payment address.
 * Tries the normalized derivation first (new code), falls back to legacy
 * (raw d + t) if the address matches the old derivation. This ensures
 * both old and new NSP addresses can be spent from.
 */
export function getSigningKey(
    chain: NspChain,
    privateKeyHex: string,
    tweakHex: string,
    confirmedAddress: string,
    asset: string = 'taproot',
): string {
    // ── sp1 (BIP-352): completely different key derivation ──
    // signing_key = (spend_priv + t_k) mod n
    // where spend_priv comes from deriveScanKeys, NOT the standard NSP tweak
    if (asset === 'sp1' && chain === 'bitcoin') {
        const keyPair = getECPair().fromPrivateKey(Buffer.from(privateKeyHex, 'hex'));
        const pubkeyHex = Buffer.from(keyPair.publicKey.slice(1)).toString('hex');
        const keys = deriveScanKeys(privateKeyHex, pubkeyHex);
        const spendPrivBig = BigInt('0x' + keys.spendPriv);
        const tweakBig = BigInt('0x' + tweakHex);
        const signingKey = ((spendPrivBig + tweakBig) % SECP256K1_N).toString(16).padStart(64, '0');
        return signingKey;
    }

    // Try normalized key first
    const normalizedKey = tweakPrivateKey(privateKeyHex, tweakHex);
    const normalizedAddr = deriveTweakedAddress(chain, privateKeyHex, tweakHex, asset);
    if (normalizedAddr.toLowerCase() === confirmedAddress.toLowerCase()) {
        return normalizedKey;
    }
    // Fall back to legacy key
    return tweakPrivateKeyLegacy(privateKeyHex, tweakHex);
}

// ── 3. Multi-Chain Tweaked Address Derivation ──

/**
 * Derive a tweaked address for any supported chain.
 * Uses the private key path (recipient-side, can also verify sender-side).
 */
export function deriveTweakedAddress(
    chain: NspChain,
    privateKeyHex: string,
    tweakHex: string,
    asset: string = 'taproot',
): string {
    const tweakedKey = tweakPrivateKey(privateKeyHex, tweakHex);

    switch (chain) {
        case 'bitcoin': {
            // Bitcoin needs even-y normalization for Taproot (BIP-340)
            const dPrime = BigInt('0x' + tweakedKey);
            const keyPair = getECPair().fromPrivateKey(Buffer.from(tweakedKey, 'hex'));
            let finalKey = tweakedKey;
            if (keyPair.publicKey[0] === 0x03) {
                // Odd y — negate for even-y
                const negated = SECP256K1_N - dPrime;
                finalKey = negated.toString(16).padStart(64, '0');
            }
            return asset === 'taproot'
                ? privateKeyToTaprootAddress(finalKey)
                : privateKeyToBitcoinAddress(finalKey);
        }
        case 'ethereum':
        case 'bnb':
        case 'polygon':
        case 'avalanche':
        case 'base': {
            // EVM: use the natural tweaked key — no even-y normalization.
            // deriveEvmAddressRaw uses the key's natural parity.
            const keyPair = getECPair().fromPrivateKey(Buffer.from(tweakedKey, 'hex'));
            const compressed = keyPair.publicKey; // 33 bytes, natural parity
            const uncompressed = Buffer.from(ecc.pointCompress(compressed, false));
            const xy = uncompressed.slice(1); // 64 bytes: x || y
            // keccak256(xy) → last 20 bytes → EIP-55 checksum
            const hash = keccak256(xy);
            const rawAddr = hash.slice(-40);
            // EIP-55 checksum
            const addrLower = rawAddr.toLowerCase();
            const checksumHash = keccak256(addrLower);
            let checksummed = '0x';
            for (let i = 0; i < addrLower.length; i++) {
                checksummed += parseInt(checksumHash[i], 16) >= 8 ? addrLower[i].toUpperCase() : addrLower[i];
            }
            return checksummed;
        }
        case 'zcash':
            return deriveZcashAddress(tweakedKey);
        default:
            throw new Error(`Unsupported chain: ${chain}`);
    }
}

/**
 * Derive a tweaked address from a PUBLIC KEY (sender-side).
 * The sender doesn't have the recipient's private key, so we use
 * tweakPublicKey(P, t) = P + t·G, then derive the chain address from
 * the resulting compressed public key.
 */
export function deriveTweakedAddressFromPubkey(
    chain: NspChain,
    xOnlyPubkeyHex: string,
    tweakHex: string,
    asset: string = 'taproot',
): string {
    const tweakedCompressed = tweakPublicKey(xOnlyPubkeyHex, tweakHex);
    // tweakedCompressed is 33-byte compressed (02 or 03 prefix — natural parity)
    const xOnly = tweakedCompressed.slice(1); // 32-byte x-only

    switch (chain) {
        case 'bitcoin': {
            bitcoin.initEccLib(ecc);
            if (asset === 'taproot') {
                // Taproot uses x-only — parity doesn't matter
                const { address } = bitcoin.payments.p2tr({
                    internalPubkey: xOnly,
                    network: bitcoin.networks.bitcoin,
                });
                if (!address) throw new Error('Failed to derive Taproot address from pubkey');
                return address;
            } else {
                // P2WPKH needs even-y compressed pubkey
                let pubForP2wpkh = tweakedCompressed;
                if (tweakedCompressed[0] === 0x03) {
                    pubForP2wpkh = Buffer.from(tweakedCompressed);
                    pubForP2wpkh[0] = 0x02;
                }
                const { address } = bitcoin.payments.p2wpkh({
                    pubkey: pubForP2wpkh,
                    network: bitcoin.networks.bitcoin,
                });
                if (!address) throw new Error('Failed to derive Segwit address from pubkey');
                return address;
            }
        }
        case 'ethereum':
        case 'bnb':
        case 'polygon':
        case 'avalanche':
        case 'base': {
            // EVM: decompress the tweaked key WITH its natural parity to get the real (x, y)
            const uncompressed = Buffer.from(ecc.pointCompress(tweakedCompressed, false));
            const xy = uncompressed.slice(1); // 64 bytes: x || y
            const hash = keccak256(xy);
            const rawAddr = hash.slice(-40);
            const addrLower = rawAddr.toLowerCase();
            const checksumHash = keccak256(addrLower);
            let checksummed = '0x';
            for (let i = 0; i < addrLower.length; i++) {
                checksummed += parseInt(checksumHash[i], 16) >= 8 ? addrLower[i].toUpperCase() : addrLower[i];
            }
            return checksummed;
        }
        case 'zcash': {
            const xOnlyHex = tweakedCompressed.slice(1).toString('hex');
            return pubkeyHexToZcashAddress(xOnlyHex);
        }
        default:
            throw new Error(`Unsupported chain: ${chain}`);
    }
}

// ── 4. Payment URI Builder ──

const CHAIN_URI_SCHEMES: Record<NspChain, string> = {
    bitcoin: 'bitcoin',
    ethereum: 'ethereum',
    bnb: 'bnb',
    polygon: 'polygon',
    avalanche: 'avalanche',
    base: 'base',
    zcash: 'zcash',
};

export function buildPaymentURI(
    chain: NspChain,
    address: string,
    amount?: string,
    tokenContract?: string | null,
): string {
    const scheme = CHAIN_URI_SCHEMES[chain];
    let uri = `${scheme}:${address}`;

    if (amount && parseFloat(amount) > 0) {
        uri += `?amount=${amount}`;
        if (tokenContract) {
            uri += `&token=${tokenContract}`;
        }
    } else if (tokenContract) {
        uri += `?token=${tokenContract}`;
    }

    return uri;
}

// ── 5. NIP-44 Helpers ──

function nip44Encrypt(senderPrivkeyHex: string, recipientPubkeyHex: string, plaintext: string): string {
    const sk = hexToBytes(senderPrivkeyHex);
    const conversationKey = nip44.v2.utils.getConversationKey(sk, recipientPubkeyHex);
    return nip44.v2.encrypt(plaintext, conversationKey);
}

function nip44Decrypt(recipientPrivkeyHex: string, senderPubkeyHex: string, ciphertext: string): string {
    const sk = hexToBytes(recipientPrivkeyHex);
    const conversationKey = nip44.v2.utils.getConversationKey(sk, senderPubkeyHex);
    return nip44.v2.decrypt(ciphertext, conversationKey);
}

// ── 6. Kind 1604 — NSP Notification ──

/**
 * Generate an ephemeral key pair, create a kind 1604 event with NIP-44 encrypted payload.
 */
export function createNspNotification(
    recipientPubkeyHex: string,
    payload: NspPayload,
    ephemeralSkHex?: string,
): { event: any; ephemeralPubkey: string; ephemeralSkHex: string } {
    // Use provided ephemeral key or generate a new one
    let ephemeralSk: Uint8Array;
    let skHex: string;
    if (ephemeralSkHex) {
        skHex = ephemeralSkHex;
        ephemeralSk = hexToBytes(ephemeralSkHex);
    } else {
        ephemeralSk = new Uint8Array(32);
        crypto.getRandomValues(ephemeralSk);
        skHex = bytesToHex(ephemeralSk);
    }
    const ephemeralPubkey = getPublicKey(ephemeralSk);

    // Encrypt payload to recipient
    const plaintext = JSON.stringify(payload);
    const encrypted = nip44Encrypt(skHex, recipientPubkeyHex, plaintext);

    const template = {
        kind: KIND_NSP_NOTIFICATION,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['p', recipientPubkeyHex],
        ],
        content: encrypted,
    };

    const signedEvent = finalizeEvent(template, ephemeralSk);

    return { event: signedEvent, ephemeralPubkey, ephemeralSkHex: skHex };
}

/**
 * Decrypt and parse a kind 1604 notification.
 */
export function parseNspNotification(
    event: any,
    recipientPrivkeyHex: string,
): NspPayload | null {
    try {
        const senderPubkey = event.pubkey;
        const plaintext = nip44Decrypt(recipientPrivkeyHex, senderPubkey, event.content);
        const parsed = JSON.parse(plaintext);

        // Validate required fields
        if (!parsed.address || !parsed.chain || !parsed.tweak) {
            console.warn('[NSP] Invalid notification payload — missing required fields');
            return null;
        }

        return parsed as NspPayload;
    } catch (e) {
        console.error('[NSP] Failed to parse notification:', e);
        return null;
    }
}

// ── 7. Relay Publishing ──

/**
 * Fetch a user's NIP-65 relay list (kind 10002).
 */
export async function fetchRelayList(pubkeyHex: string): Promise<string[]> {
    const readRelays: string[] = [];

    return new Promise((resolve) => {
        const subId = 'nsp_rl_' + Math.random().toString(36).slice(2, 8);
        let best: any = null;
        let resolved = false;
        const sockets: WebSocket[] = [];

        const finish = () => {
            if (resolved) return;
            resolved = true;
            sockets.forEach(s => { try { s.close(); } catch { } });
            if (best) {
                for (const tag of best.tags || []) {
                    if (tag[0] === 'r') {
                        const marker = tag[2] || '';
                        if (!marker || marker === 'read') {
                            readRelays.push(tag[1]);
                        }
                    }
                }
            }
            resolve(readRelays);
        };

        setTimeout(finish, 5000);

        for (const relay of HARDCODED_RELAYS.slice(0, 3)) {
            try {
                const ws = new WebSocket(relay);
                sockets.push(ws);
                ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, {
                    kinds: [10002],
                    authors: [pubkeyHex],
                    limit: 1,
                }]));
                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'EVENT' && data[2]) {
                            if (!best || data[2].created_at > best.created_at) {
                                best = data[2];
                            }
                        }
                        if (data[0] === 'EOSE') ws.close();
                    } catch { }
                };
                ws.onerror = () => ws.close();
            } catch { }
        }
    });
}

/**
 * Publish an event to specific relays with per-relay progress reporting.
 */
export async function publishToRelaysWithProgress(
    signedEvent: any,
    relayUrls: string[],
    onProgress?: (result: RelayPublishResult) => void,
): Promise<RelayPublishResult[]> {
    const results: RelayPublishResult[] = [];

    const promises = relayUrls.map(relayUrl => {
        return new Promise<RelayPublishResult>((resolve) => {
            try {
                const ws = new WebSocket(relayUrl);
                const timer = setTimeout(() => {
                    try { ws.close(); } catch { }
                    const result = { relay: relayUrl, success: false, error: 'Timeout' };
                    onProgress?.(result);
                    resolve(result);
                }, 8000);

                ws.onopen = () => {
                    ws.send(JSON.stringify(['EVENT', signedEvent]));
                };

                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'OK') {
                            clearTimeout(timer);
                            const result = {
                                relay: relayUrl,
                                success: data[2] === true,
                                error: data[2] === true ? undefined : (data[3] || 'Rejected'),
                            };
                            onProgress?.(result);
                            try { ws.close(); } catch { }
                            resolve(result);
                        }
                    } catch { }
                };

                ws.onerror = () => {
                    clearTimeout(timer);
                    const result = { relay: relayUrl, success: false, error: 'Connection error' };
                    onProgress?.(result);
                    resolve(result);
                };
            } catch (e) {
                const result = { relay: relayUrl, success: false, error: String(e) };
                onProgress?.(result);
                resolve(result);
            }
        });
    });

    const settled = await Promise.all(promises);
    results.push(...settled);
    return results;
}

/**
 * Full publish flow: fetch recipient's NIP-65, merge with hardcoded relays, publish.
 */
export async function publishNspNotification(
    signedEvent: any,
    recipientPubkeyHex: string,
    onProgress?: (result: RelayPublishResult) => void,
): Promise<RelayPublishResult[]> {
    // Get recipient's relay list
    const recipientRelays = await fetchRelayList(recipientPubkeyHex);

    // Pick up to 3 hardcoded relays not already in the recipient's list
    const extra = HARDCODED_RELAYS.filter(r => !recipientRelays.includes(r)).slice(0, 3);

    const allRelays = [...new Set([...recipientRelays, ...extra])];

    console.log(`[NSP] Publishing to ${allRelays.length} relays:`, allRelays);

    return publishToRelaysWithProgress(signedEvent, allRelays, onProgress);
}

// ── 8. NIP-78 — Paginated Payment List Persistence ──

export async function loadNspIndex(privateKeyHex: string, pubkeyHex: string): Promise<NspIndex> {
    const events = await fetchBestNip78(pubkeyHex, [NSP_INDEX_DTAG]);
    const evt = events.get(NSP_INDEX_DTAG);
    if (!evt) return { last_page: -1, slots: {}, last_scanned: 0 };
    try {
        const plaintext = nip44Decrypt(privateKeyHex, pubkeyHex, evt.content);
        return JSON.parse(plaintext);
    } catch {
        return { last_page: -1, slots: {}, last_scanned: 0 };
    }
}

export async function saveNspIndex(privateKeyHex: string, pubkeyHex: string, index: NspIndex): Promise<number> {
    const encrypted = nip44Encrypt(privateKeyHex, pubkeyHex, JSON.stringify(index));
    return publishNip78(privateKeyHex, NSP_INDEX_DTAG, encrypted);
}

export async function saveNspPage(privateKeyHex: string, pubkeyHex: string, pageNum: number, payments: NspConfirmedPayment[]): Promise<number> {
    const encrypted = nip44Encrypt(privateKeyHex, pubkeyHex, JSON.stringify({ payments }));
    return publishNip78(privateKeyHex, pageTag(pageNum), encrypted);
}

/**
 * Load all pages and merge into a flat array. Each entry gets a transient `_page` field.
 */
export async function loadAllNspPages(privateKeyHex: string, pubkeyHex: string, lastPage: number): Promise<NspConfirmedPayment[]> {
    if (lastPage < 0) return [];
    const dTags = Array.from({ length: lastPage + 1 }, (_, i) => pageTag(i));
    const events = await fetchBestNip78(pubkeyHex, dTags);
    const all: NspConfirmedPayment[] = [];
    for (let i = 0; i <= lastPage; i++) {
        const evt = events.get(pageTag(i));
        if (!evt) continue;
        try {
            const plaintext = nip44Decrypt(privateKeyHex, pubkeyHex, evt.content);
            const parsed = JSON.parse(plaintext);
            const payments = (parsed.payments || []) as NspConfirmedPayment[];
            payments.forEach(p => (p as any)._page = i);
            all.push(...payments);
        } catch {
            console.error(`[NSP] Failed to decrypt page ${i}`);
        }
    }
    return all;
}

/**
 * Add newly confirmed payments to paginated storage. Uses slots to fill existing pages first.
 */
export async function addConfirmedPayments(
    privateKeyHex: string,
    pubkeyHex: string,
    index: NspIndex,
    newPayments: NspConfirmedPayment[],
    existingConfirmed: NspConfirmedPayment[],
): Promise<NspIndex> {
    if (newPayments.length === 0) return index;
    const updatedIndex: NspIndex = { ...index, slots: { ...index.slots } };
    const remaining = [...newPayments];
    const pageAppends = new Map<number, NspConfirmedPayment[]>();

    // Fill existing pages that have slots
    for (const [pageStr, slots] of Object.entries(updatedIndex.slots).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
        if (remaining.length === 0) break;
        const pageNum = parseInt(pageStr);
        const toAdd = remaining.splice(0, slots);
        toAdd.forEach(p => (p as any)._page = pageNum);
        pageAppends.set(pageNum, toAdd);
        const newSlots = slots - toAdd.length;
        if (newSlots <= 0) delete updatedIndex.slots[pageStr];
        else updatedIndex.slots[pageStr] = newSlots;
    }

    // Create new pages for remaining entries
    while (remaining.length > 0) {
        updatedIndex.last_page++;
        const pageNum = updatedIndex.last_page;
        const batch = remaining.splice(0, MAX_ENTRIES_PER_PAGE);
        batch.forEach(p => (p as any)._page = pageNum);
        pageAppends.set(pageNum, batch);
        const newSlots = MAX_ENTRIES_PER_PAGE - batch.length;
        if (newSlots > 0) updatedIndex.slots[String(pageNum)] = newSlots;
    }

    // Save each affected page
    for (const [pageNum, newEntries] of pageAppends) {
        const existingOnPage = existingConfirmed.filter(p => (p as any)._page === pageNum);
        await saveNspPage(privateKeyHex, pubkeyHex, pageNum, [...existingOnPage, ...newEntries]);
    }

    await saveNspIndex(privateKeyHex, pubkeyHex, updatedIndex);
    console.log(`[NSP] Added ${newPayments.length} payment(s) across ${pageAppends.size} page(s)`);
    return updatedIndex;
}

/**
 * Remove payments by tweak. Updates affected pages and slot counts.
 */
export async function removePaymentsFromPages(
    privateKeyHex: string,
    pubkeyHex: string,
    index: NspIndex,
    tweaksToRemove: Set<string>,
    allConfirmed: NspConfirmedPayment[],
): Promise<NspIndex> {
    const updatedIndex: NspIndex = { ...index, slots: { ...index.slots } };
    const affectedPages = new Set<number>();
    for (const p of allConfirmed) {
        if (tweaksToRemove.has(p.tweak)) {
            const pg = (p as any)._page;
            if (pg !== undefined) affectedPages.add(pg);
        }
    }
    const toKeep = allConfirmed.filter(p => !tweaksToRemove.has(p.tweak));
    for (const pageNum of affectedPages) {
        const pageEntries = toKeep.filter(p => (p as any)._page === pageNum);
        await saveNspPage(privateKeyHex, pubkeyHex, pageNum, pageEntries);
        const available = MAX_ENTRIES_PER_PAGE - pageEntries.length;
        if (available > 0) updatedIndex.slots[String(pageNum)] = available;
    }
    await saveNspIndex(privateKeyHex, pubkeyHex, updatedIndex);
    console.log(`[NSP] Removed ${tweaksToRemove.size} entries from ${affectedPages.size} page(s)`);
    return updatedIndex;
}

/**
 * Fetch a batch of kind 1604 notifications from relays (one-shot query).
 */
export async function fetchNotificationBatch(
    pubkeyHex: string,
    since: number,
    until?: number,
    limit = 500,
): Promise<any[]> {
    return new Promise((resolve) => {
        const events = new Map<string, any>();
        let resolvedCount = 0;
        let resolved = false;
        const totalRelays = HARDCODED_RELAYS.length;
        const sockets: WebSocket[] = [];
        const subId = 'nsp_batch_' + Math.random().toString(36).slice(2, 8);
        const filter: any = { kinds: [KIND_NSP_NOTIFICATION], '#p': [pubkeyHex], limit };
        if (since > 0) filter.since = since;
        if (until !== undefined) filter.until = until;

        const finish = () => {
            if (resolved) return;
            resolved = true;
            sockets.forEach(s => { try { s.close(); } catch {} });
            resolve(Array.from(events.values()));
        };
        const tryFinish = () => { resolvedCount++; if (resolvedCount >= totalRelays) finish(); };
        setTimeout(finish, 8000);

        for (const relayUrl of HARDCODED_RELAYS) {
            try {
                const ws = new WebSocket(relayUrl);
                sockets.push(ws);
                ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'EVENT' && data[2]) events.set(data[2].id, data[2]);
                        if (data[0] === 'EOSE') { try { ws.close(); } catch {} tryFinish(); }
                    } catch {}
                };
                ws.onerror = () => tryFinish();
            } catch { tryFinish(); }
        }
    });
}

/**
 * Catch-up scan: paginated fetch of kind 1604 notifications since last_scanned.
 */
export async function catchUpScan(
    pubkeyHex: string,
    lastScanned: number,
    onBatch: (events: any[]) => void,
): Promise<number> {
    let highestCreatedAt = lastScanned;
    let until: number | undefined;
    while (true) {
        const batch = await fetchNotificationBatch(pubkeyHex, lastScanned, until, 500);
        if (batch.length === 0) break;
        onBatch(batch);
        for (const evt of batch) {
            if (evt.created_at > highestCreatedAt) highestCreatedAt = evt.created_at;
        }
        if (batch.length < 500) break;
        until = Math.min(...batch.map((e: any) => e.created_at));
    }
    return highestCreatedAt;
}

/**
 * One-time migration: load payments from the old single-event 'nostr-silent-payment-list' d-tag.
 * Returns the payments if found, empty array if not.
 */
export async function loadLegacyPayments(
    privateKeyHex: string,
    pubkeyHex: string,
): Promise<NspConfirmedPayment[]> {
    const LEGACY_DTAG = 'nostr-silent-payment-list';
    const events = await fetchBestNip78(pubkeyHex, [LEGACY_DTAG]);
    const evt = events.get(LEGACY_DTAG);
    if (!evt) return [];
    try {
        const plaintext = nip44Decrypt(privateKeyHex, pubkeyHex, evt.content);
        const parsed = JSON.parse(plaintext);
        console.log(`[NSP] Found ${(parsed.payments || []).length} legacy payments for migration`);
        return parsed.payments || [];
    } catch {
        return [];
    }
}


// ── 8b. NIP-78 — Sent List Persistence ──

/**
 * Save outgoing sent transactions as a kind 30078 event (self-encrypted).
 */
export async function saveSentList(
    privateKeyHex: string,
    pubkeyHex: string,
    entries: NspSentEntry[],
): Promise<number> {
    const plaintext = JSON.stringify({ entries });
    const encrypted = nip44Encrypt(privateKeyHex, pubkeyHex, plaintext);

    const template = {
        kind: KIND_NSP_PAYMENT_LIST,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
            ['d', NSP_SENT_DTAG],
        ],
        content: encrypted,
    };

    const sk = hexToBytes(privateKeyHex);
    const signedEvent = finalizeEvent(template, sk);

    let successCount = 0;
    const promises = HARDCODED_RELAYS.map(relayUrl => {
        return new Promise<void>((resolve) => {
            try {
                const ws = new WebSocket(relayUrl);
                const timer = setTimeout(() => {
                    try { ws.close(); } catch { }
                    resolve();
                }, 5000);
                ws.onopen = () => ws.send(JSON.stringify(['EVENT', signedEvent]));
                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'OK' && data[2] === true) successCount++;
                    } catch { }
                    clearTimeout(timer);
                    try { ws.close(); } catch { }
                    resolve();
                };
                ws.onerror = () => { clearTimeout(timer); resolve(); };
            } catch { resolve(); }
        });
    });

    await Promise.allSettled(promises);
    console.log(`[NSP] Saved sent list (${entries.length} entries) to ${successCount} relays`);
    return successCount;
}

/**
 * Load outgoing sent transactions from relays.
 */
export async function loadSentList(
    privateKeyHex: string,
    pubkeyHex: string,
): Promise<{ entries: NspSentEntry[]; createdAt: number }> {
    return new Promise((resolve) => {
        let bestEvent: any = null;
        let resolvedCount = 0;
        let resolved = false;
        const totalRelays = HARDCODED_RELAYS.length;
        const sockets: WebSocket[] = [];
        const subId = 'nsp_sent_' + Math.random().toString(36).slice(2, 8);

        const tryResolve = () => {
            if (resolved) return;
            resolvedCount++;
            if (resolvedCount >= totalRelays) {
                resolved = true;
                sockets.forEach(s => { try { s.close(); } catch { } });
                if (!bestEvent) {
                    resolve({ entries: [], createdAt: 0 });
                    return;
                }
                try {
                    const plaintext = nip44Decrypt(privateKeyHex, pubkeyHex, bestEvent.content);
                    const parsed = JSON.parse(plaintext);
                    resolve({
                        entries: parsed.entries || [],
                        createdAt: bestEvent.created_at || 0,
                    });
                } catch (e) {
                    console.error('[NSP] Failed to decrypt sent list:', e);
                    resolve({ entries: [], createdAt: 0 });
                }
            }
        };

        void setTimeout(() => {
            if (!resolved) {
                resolved = true;
                sockets.forEach(s => { try { s.close(); } catch { } });
                if (!bestEvent) { resolve({ entries: [], createdAt: 0 }); return; }
                try {
                    const plaintext = nip44Decrypt(privateKeyHex, pubkeyHex, bestEvent.content);
                    const parsed = JSON.parse(plaintext);
                    resolve({ entries: parsed.entries || [], createdAt: bestEvent.created_at || 0 });
                } catch { resolve({ entries: [], createdAt: 0 }); }
            }
        }, 6000);

        for (const relayUrl of HARDCODED_RELAYS) {
            try {
                const ws = new WebSocket(relayUrl);
                sockets.push(ws);
                ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, {
                    kinds: [KIND_NSP_PAYMENT_LIST],
                    authors: [pubkeyHex],
                    '#d': [NSP_SENT_DTAG],
                    limit: 1,
                }]));
                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'EVENT' && data[2]) {
                            if (!bestEvent || data[2].created_at > bestEvent.created_at) {
                                bestEvent = data[2];
                            }
                        }
                        if (data[0] === 'EOSE') {
                            try { ws.close(); } catch { }
                            tryResolve();
                        }
                    } catch { }
                };
                ws.onerror = () => { tryResolve(); };
            } catch { tryResolve(); }
        }
    });
}

/**
 * Fetch an existing kind 1604 notification event authored by a specific ephemeral key.
 * Used to check if a notification is already on relays before republishing.
 */
export async function fetchExistingNotification(
    ephemeralNsecHex: string,
    recipientPubkeyHex: string,
): Promise<any | null> {
    const ephemeralPubkey = getPublicKey(hexToBytes(ephemeralNsecHex));

    return new Promise((resolve) => {
        let foundEvent: any = null;
        let resolvedCount = 0;
        let resolved = false;
        const totalRelays = HARDCODED_RELAYS.length;
        const sockets: WebSocket[] = [];
        const subId = 'nsp_fetch_' + Math.random().toString(36).slice(2, 8);

        const tryResolve = () => {
            if (resolved) return;
            resolvedCount++;
            if (resolvedCount >= totalRelays) {
                resolved = true;
                sockets.forEach(s => { try { s.close(); } catch { } });
                resolve(foundEvent);
            }
        };

        void setTimeout(() => {
            if (!resolved) {
                resolved = true;
                sockets.forEach(s => { try { s.close(); } catch { } });
                resolve(foundEvent);
            }
        }, 5000);

        for (const relayUrl of HARDCODED_RELAYS) {
            try {
                const ws = new WebSocket(relayUrl);
                sockets.push(ws);
                ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, {
                    kinds: [KIND_NSP_NOTIFICATION],
                    authors: [ephemeralPubkey],
                    '#p': [recipientPubkeyHex],
                    limit: 1,
                }]));
                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'EVENT' && data[2]) {
                            if (!foundEvent || data[2].created_at > foundEvent.created_at) {
                                foundEvent = data[2];
                            }
                        }
                        if (data[0] === 'EOSE') {
                            try { ws.close(); } catch { }
                            tryResolve();
                        }
                    } catch { }
                };
                ws.onerror = () => { tryResolve(); };
            } catch { tryResolve(); }
        }
    });
}

// ── 9. Verification ──

/**
 * Verify that a tweaked address belongs to us.
 */
export function verifyPaymentOwnership(
    privateKeyHex: string,
    tweakHex: string,
    claimedAddress: string,
    chain: NspChain,
    asset: string = 'taproot',
): boolean {
    try {
        // ── sp1 (BIP-352): completely different derivation path ──
        // The "tweak" for sp1 is the BIP-352 shared secret tweak t_k.
        // candidate = SpendPub + t_k · G  (output key, no TapTweak)
        if (asset === 'sp1' && chain === 'bitcoin') {
            const tweakBytes = hexToBytes(tweakHex);
            const tweakPoint = ecc.pointFromScalar(tweakBytes);
            if (!tweakPoint) return false;

            // Derive spendPub using the canonical deriveScanKeys path
            const pubkeyHex = bytesToHex(getECPair().fromPrivateKey(
                Buffer.from(privateKeyHex, 'hex')).publicKey.slice(1));
            const keys = deriveScanKeys(privateKeyHex, pubkeyHex);

            const candidatePub = ecc.pointAdd(keys.spendPub, tweakPoint);
            if (!candidatePub) return false;

            // BIP-352: output key is the raw candidate (no TapTweak)
            const xOnly = Buffer.from(candidatePub).slice(1);
            const derivedAddr = bitcoin.address.toBech32(xOnly, 1, bitcoin.networks.bitcoin.bech32);
            if (derivedAddr.toLowerCase() === claimedAddress.toLowerCase()) return true;

            console.warn(`[NSP] sp1 ownership mismatch:`,
                `\n  derived  =${derivedAddr}`,
                `\n  claimed  =${claimedAddress}`,
                `\n  tweak    =${tweakHex.slice(0, 16)}...`);
            return false;
        }

        // Primary: current derivation (base key normalized to even-y)
        const derived = deriveTweakedAddress(chain, privateKeyHex, tweakHex, asset);
        if (derived.toLowerCase() === claimedAddress.toLowerCase()) return true;

        // Legacy fallback: old derivation (raw d + t, no base normalization).
        // Old notifications may have used this path if the sender derived
        // the address via the private key path before the even-y fix.
        const d = BigInt('0x' + privateKeyHex);
        const t = BigInt('0x' + tweakHex);
        const dLegacy = (d + t) % SECP256K1_N;
        const legacyKey = dLegacy.toString(16).padStart(64, '0');

        let legacyAddr: string;
        if (chain === 'bitcoin') {
            const kp = getECPair().fromPrivateKey(Buffer.from(legacyKey, 'hex'));
            let finalKey = legacyKey;
            if (kp.publicKey[0] === 0x03) {
                finalKey = (SECP256K1_N - dLegacy).toString(16).padStart(64, '0');
            }
            legacyAddr = asset === 'taproot'
                ? privateKeyToTaprootAddress(finalKey)
                : privateKeyToBitcoinAddress(finalKey);
        } else if (['ethereum', 'bnb', 'polygon', 'avalanche', 'base'].includes(chain)) {
            const kp = getECPair().fromPrivateKey(Buffer.from(legacyKey, 'hex'));
            const compressed = kp.publicKey;
            const uncompressed = Buffer.from(ecc.pointCompress(compressed, false));
            const xy = uncompressed.slice(1);
            const hash = keccak256(xy);
            const rawAddr = hash.slice(-40);
            const addrLower = rawAddr.toLowerCase();
            const checksumHash = keccak256(addrLower);
            let checksummed = '0x';
            for (let i = 0; i < addrLower.length; i++) {
                checksummed += parseInt(checksumHash[i], 16) >= 8 ? addrLower[i].toUpperCase() : addrLower[i];
            }
            legacyAddr = checksummed;
        } else if (chain === 'zcash') {
            legacyAddr = deriveZcashAddress(legacyKey);
        } else {
            legacyAddr = '';
        }

        if (legacyAddr && legacyAddr.toLowerCase() === claimedAddress.toLowerCase()) {
            console.log(`[NSP] Legacy derivation matched for ${chain}/${asset} (old notification)`);
            return true;
        }

        console.warn(`[NSP] Ownership mismatch for ${chain}/${asset}:`,
            `\n  derived (new) =${derived}`,
            `\n  derived (old) =${legacyAddr}`,
            `\n  claimed       =${claimedAddress}`,
            `\n  tweak         =${tweakHex.slice(0, 16)}...`);
        return false;
    } catch (e) {
        console.error('[NSP] Ownership verification failed:', e);
        return false;
    }
}

// ── 10. Balance Checking ──

/**
 * Check balance for a tweaked address on a specific chain.
 */
export async function checkTweakedAddressBalance(
    chain: NspChain,
    address: string,
    tokenContract?: string | null,
): Promise<{ balance: number | bigint; hasFunds: boolean }> {
    try {
        switch (chain) {
            case 'bitcoin': {
                const utxos = await fetchUTXOs(address);
                const total = utxos.reduce((s, u) => s + u.value, 0);
                return { balance: total, hasFunds: total > 0 };
            }
            case 'ethereum':
            case 'bnb':
            case 'polygon':
            case 'avalanche':
            case 'base': {
                if (tokenContract) {
                    const bal = await fetchTokenBalance(chain, tokenContract, address);
                    return { balance: bal, hasFunds: bal > 0n };
                }
                const bal = await fetchEvmBalance(chain, address);
                return { balance: bal, hasFunds: bal > 0n };
            }
            case 'zcash': {
                const bal = await fetchZcashBalance(address);
                return { balance: bal, hasFunds: bal > 0 };
            }
            default:
                return { balance: 0, hasFunds: false };
        }
    } catch (e) {
        console.error('[NSP] Balance check failed:', e);
        return { balance: 0, hasFunds: false };
    }
}

// ── 11. Subscribe to Incoming Notifications ──

/**
 * Subscribe to kind 1604 events addressed to us.
 */
export function subscribeToNspNotifications(
    pubkeyHex: string,
    callback: (event: any) => void,
    sinceTimestamp = 0,
): { stop: () => void } {
    const sockets: WebSocket[] = [];
    const subId = 'nsp_sub_' + Math.random().toString(36).slice(2, 10);
    const filter: any = {
        kinds: [KIND_NSP_NOTIFICATION],
        '#p': [pubkeyHex],
        limit: 50,
    };
    if (sinceTimestamp > 0) filter.since = sinceTimestamp;

    for (const relayUrl of HARDCODED_RELAYS) {
        try {
            const ws = new WebSocket(relayUrl);
            ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
            ws.onmessage = (msg) => {
                try {
                    const data = JSON.parse(msg.data);
                    if (data[0] === 'EVENT' && data[2]) {
                        callback(data[2]);
                    }
                } catch { }
            };
            ws.onerror = () => { };
            sockets.push(ws);
        } catch { }
    }

    return {
        stop: () => {
            for (const ws of sockets) {
                try {
                    ws.send(JSON.stringify(['CLOSE', subId]));
                    ws.close();
                } catch { }
            }
        },
    };
}
