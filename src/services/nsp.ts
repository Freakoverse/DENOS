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
import { nip44, finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak256 } from 'js-sha3';

import { getECPair } from '@/services/bitcoin';
import {
    privateKeyToBitcoinAddress,
    privateKeyToTaprootAddress,
    negatePrivateKey,
    fetchUTXOs,
    fetchTxHistory,
} from '@/services/bitcoin';
import {
    fetchEvmBalance,
    fetchTokenBalance,
} from '@/services/evm';
import {
    deriveZcashAddress,
    fetchZcashBalance,
    fetchZcashTxHistory,
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

/**
 * The user's own configured relays, merged with the hardcoded set for all operations on
 * the user's OWN data (NIP-78 index/pages/sent list, catch-up scan, live subscription).
 * Populated by the app via setNspUserRelays and persisted so it survives reloads. This
 * removes the single-point-of-failure of depending only on the hardcoded relays.
 */
let nspUserRelays: string[] = (() => {
    try { const raw = localStorage.getItem('denos-nsp-user-relays'); return raw ? JSON.parse(raw) : []; } catch { return []; }
})();

export function setNspUserRelays(urls: string[]): void {
    const clean = [...new Set(urls.filter(u => /^wss?:\/\//i.test(u)))];
    nspUserRelays = clean;
    try { localStorage.setItem('denos-nsp-user-relays', JSON.stringify(clean)); } catch { /* ignore */ }
}

/** Hardcoded relays unioned with the user's configured relays. */
function getRelays(): string[] {
    return [...new Set([...HARDCODED_RELAYS, ...nspUserRelays])];
}

// ── Types ──

export type NspChain = 'bitcoin' | 'ethereum' | 'bnb' | 'polygon' | 'avalanche' | 'base' | 'zcash';

export interface NspPayload {
    address: string;
    chain: NspChain;
    asset: string;
    token: string | null;
    txid: string;
    amount: string;
    timestamp: number;
    /** Deterministic payments: the sender's npub and index, from which the recipient
     *  recomputes the tweak. Legacy payments instead carry `tweak`. */
    sender?: string;
    n?: number;
    /** Legacy random-tweak payments only. */
    tweak?: string;
}

export interface NspConfirmedPayment {
    chain: NspChain;
    address: string;
    tweak: string;        // spending tweak (derived deterministically, or legacy random)
    asset: string;
    token: string | null;
    txid: string;
    amount: string;
    confirmedAt: number;
    /** Deterministic provenance — lets the entry be re-derived from the nsec alone. */
    sender?: string;
    n?: number;
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
    address: string;          // tweaked address sent to
    tweak: string;            // tweak used for derivation (derivable; kept for display)
    recipientPubkey: string;  // recipient hex pubkey
    timestamp: number;
    /** Deterministic payments: the index. Renotification recomputes everything from
     *  (sender nsec, recipientPubkey, n) — no stored ephemeral key needed. */
    n?: number;
    /** Legacy only: the ephemeral private key used to sign the original notification. */
    senderNsec?: string;
}

export interface NspIndex {
    last_page: number;
    slots: Record<string, number>;
    last_scanned: number;
    /** User's default index for EVM receive addresses (0–999). Travels with the self-state. */
    evm_default_index?: number;
}

const EVM_CHAINS_SET = new Set<NspChain>(['ethereum', 'bnb', 'polygon', 'avalanche', 'base']);

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
        const totalRelays = getRelays().length;
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

        for (const relayUrl of getRelays()) {
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
    const promises = getRelays().map(relayUrl =>
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

/**
 * LEGACY: random per-payment tweak. Kept so payments created under the old random-tweak
 * scheme remain spendable. New payments use the deterministic derivation below.
 */
export function generateTweak(): string {
    const preimage = `${Date.now()}:${crypto.randomUUID()}`;
    const data = new TextEncoder().encode(preimage);
    const hash = sha256(data);
    return bytesToHex(hash);
}

// ── 1b. Deterministic (ECDH-derived) tweak — NIP-NSP core ──

const NSP_TWEAK_DOMAIN = new TextEncoder().encode('nsp-tweak-v1');
const NSP_NOTIF_DOMAIN = new TextEncoder().encode('nsp-notif-v1');

/** 4-byte big-endian encoding of an index n. */
function ser32(n: number): Uint8Array {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, false);
    return b;
}

/**
 * Deterministic shared secret S between two Nostr identities.
 *
 * S = NIP-44 v2 conversation key (HKDF over the x-coordinate of the secp256k1 ECDH).
 * It is **symmetric** — computeSharedSecret(d_A, P_B) === computeSharedSecret(d_B, P_A) —
 * even when either key has odd-y parity, because it is keyed on the ECDH *x-coordinate*
 * (x(kP) === x(-kP)). Computable only by a holder of one of the two private keys; a third
 * party who knows only both npubs cannot derive it (Diffie–Hellman assumption).
 *
 * @param selfPrivHex    the caller's private key (hex)
 * @param otherPubHex    the counterparty's x-only pubkey (hex, from their npub)
 */
export function computeSharedSecret(selfPrivHex: string, otherPubHex: string): string {
    const key = nip44.v2.utils.getConversationKey(hexToBytes(selfPrivHex), otherPubHex);
    return bytesToHex(key);
}

function domainHash(domain: Uint8Array, sharedHex: string, n: number): string {
    const S = hexToBytes(sharedHex);
    const idx = ser32(n);
    const buf = new Uint8Array(domain.length + S.length + idx.length);
    buf.set(domain, 0);
    buf.set(S, domain.length);
    buf.set(idx, domain.length + S.length);
    return bytesToHex(sha256(buf));
}

/** Deterministic tweak t(n) = SHA-256("nsp-tweak-v1" || S || ser32(n)). */
export function nspTweak(sharedHex: string, n: number): string {
    return domainHash(NSP_TWEAK_DOMAIN, sharedHex, n);
}

/** Deterministic notification signing key k(n) = SHA-256("nsp-notif-v1" || S || ser32(n)). */
export function nspNotifKey(sharedHex: string, n: number): string {
    return domainHash(NSP_NOTIF_DOMAIN, sharedHex, n);
}

/**
 * Sender side: derive the one-time address for paying a recipient at index n, plus the
 * tweak used. The address is derived from the recipient's PUBLIC key (P_R + t·G).
 */
export function deriveNspSend(
    chain: NspChain,
    recipientPubHex: string,
    senderPrivHex: string,
    n: number,
    asset: string = 'taproot',
): { address: string; tweak: string; shared: string } {
    const shared = computeSharedSecret(senderPrivHex, recipientPubHex);
    const tweak = nspTweak(shared, n);
    const address = deriveTweakedAddressFromPubkey(chain, recipientPubHex, tweak, asset);
    return { address, tweak, shared };
}

/**
 * Recipient side: derive the SAME one-time address and the spending tweak from the sender's
 * npub at index n. The address is derived from the recipient's PRIVATE key (d_even + t) and
 * MUST equal the sender's derivation — this is the correctness guarantee that funds sent to
 * the address are spendable.
 */
export function deriveNspReceive(
    chain: NspChain,
    senderPubHex: string,
    recipientPrivHex: string,
    n: number,
    asset: string = 'taproot',
): { address: string; tweak: string; shared: string } {
    const shared = computeSharedSecret(recipientPrivHex, senderPubHex);
    const tweak = nspTweak(shared, n);
    const address = deriveTweakedAddress(chain, recipientPrivHex, tweak, asset);
    return { address, tweak, shared };
}

// ── 1c. Index (n) selection — gap-walk for UTXO, fixed for EVM ──

/**
 * Addresses used this session but possibly not yet visible on-chain. Soft state: cleared on
 * reload, which at worst risks one address reuse, never funds. Prevents back-to-back sends
 * to the same pair from both picking the same index before the first hits the mempool.
 */
const nspPendingAddresses = new Set<string>();
export function markNspAddressPending(address: string): void { nspPendingAddresses.add(address); }

/**
 * Whether an address has ANY on-chain or mempool history (used). esplora `/txs` includes
 * unconfirmed transactions, so this is mempool-aware. Throws if the lookup fails on all
 * nodes — the caller aborts rather than risk reusing an address.
 */
export async function nspAddressHasHistory(chain: NspChain, address: string): Promise<boolean> {
    if (chain === 'bitcoin') return (await fetchTxHistory(address)).length > 0;
    if (chain === 'zcash') return (await fetchZcashTxHistory(address)).length > 0;
    return false; // EVM does not gap-walk
}

/**
 * Select the index `n` and one-time address for an NSP send.
 *   - EVM chains: fixed index (the user's `evmDefaultIndex`, default 0) — no walk.
 *   - UTXO chains: the lowest unused index, by gap-walking derived addresses in parallel
 *     batches and treating confirmed/mempool history and the session pending-cache as "used".
 *
 * `hasHistoryFn` is injectable for testing; production uses `nspAddressHasHistory`.
 */
export async function selectNspIndex(
    chain: NspChain,
    recipientPubHex: string,
    senderPrivHex: string,
    asset: string = 'taproot',
    opts: {
        evmDefaultIndex?: number;
        batch?: number;
        maxBatches?: number;
        hasHistoryFn?: (chain: NspChain, address: string) => Promise<boolean>;
    } = {},
): Promise<{ n: number; address: string; tweak: string }> {
    const derive = (n: number) => deriveNspSend(chain, recipientPubHex, senderPrivHex, n, asset);

    if (EVM_CHAINS_SET.has(chain)) {
        const n = Math.max(0, Math.min(999, Math.floor(opts.evmDefaultIndex ?? 0)));
        const { address, tweak } = derive(n);
        return { n, address, tweak };
    }

    const batch = opts.batch ?? 10;
    // No practical ceiling. Unlike an HD gap limit (which stops after N consecutive UNUSED
    // addresses, because you cannot know where a wallet ends), this walk only advances while
    // lookups SUCCEED and report "used" — an unambiguous signal that the index really is taken.
    // A failed lookup throws and exits, so this cannot spin on network errors; the walk is bounded
    // by how many addresses have genuinely been used. The high value is a runaway backstop only.
    const maxBatches = opts.maxBatches ?? 10_000;
    const hasHistory = opts.hasHistoryFn ?? nspAddressHasHistory;

    for (let b = 0; b < maxBatches; b++) {
        const cand = Array.from({ length: batch }, (_, i) => ({ n: b * batch + i, ...derive(b * batch + i) }));
        const used = await Promise.all(cand.map(c =>
            nspPendingAddresses.has(c.address) ? Promise.resolve(true) : hasHistory(chain, c.address),
        ));
        const firstFree = used.findIndex(u => !u);
        if (firstFree >= 0) {
            const chosen = cand[firstFree];
            return { n: chosen.n, address: chosen.address, tweak: chosen.tweak };
        }
    }
    throw new Error(`NSP: every index below ${batch * maxBatches} is already used`);
}

// ── 1d. Recovery walk ──

export interface NspRecoverResult {
    chain: NspChain;
    asset: string;
    address: string;
    tweak: string;
    n: number;
    sender: string;            // sender npub (own npub for self/in-person)
    balance: number | bigint;
}

/**
 * Recover received payments for a (sender → self) chain by deriving addresses at successive
 * indices and checking them on-chain. UTXO chains use a gap-limited walk; EVM scans a small
 * bounded set (addresses are reused, so few indices exist). `senderPubHex = own pubkey`
 * recovers in-person/self payments; a known sender's pubkey recovers remote payments whose
 * notification was lost. Returns funded addresses with full provenance (sender + n).
 *
 * `checkFn`/`historyFn` are injectable for testing; production uses the on-chain lookups.
 */
export async function recoverNspPayments(
    chain: NspChain,
    asset: string,
    senderPubHex: string,
    recipientPrivHex: string,
    opts: {
        token?: string | null;
        gapLimit?: number;
        maxScan?: number;
        checkFn?: (chain: NspChain, address: string, token?: string | null) => Promise<{ balance: number | bigint; hasFunds: boolean }>;
        historyFn?: (chain: NspChain, address: string) => Promise<boolean>;
    } = {},
): Promise<NspRecoverResult[]> {
    const token = opts.token ?? null;
    const check = opts.checkFn ?? checkTweakedAddressBalance;
    const history = opts.historyFn ?? nspAddressHasHistory;
    const senderNpub = nip19.npubEncode(senderPubHex);
    const found: NspRecoverResult[] = [];

    const record = (n: number, address: string, tweak: string, balance: number | bigint) =>
        found.push({ chain, asset, address, tweak, n, sender: senderNpub, balance });

    if (EVM_CHAINS_SET.has(chain)) {
        // EVM: bounded scan (addresses are reused per sender; few indices in play).
        for (let n = 0; n < (opts.maxScan ?? 10); n++) {
            const { address, tweak } = deriveNspReceive(chain, senderPubHex, recipientPrivHex, n, asset);
            const { balance, hasFunds } = await check(chain, address, token);
            if (hasFunds) record(n, address, tweak, balance);
        }
        return found;
    }

    // UTXO: gap-limited walk. History keeps the gap open across swept (0-balance) addresses.
    const gapLimit = opts.gapLimit ?? 10;
    const maxScan = opts.maxScan ?? 200;
    let gap = 0;
    for (let n = 0; n < maxScan && gap < gapLimit; n++) {
        const { address, tweak } = deriveNspReceive(chain, senderPubHex, recipientPrivHex, n, asset);
        const used = await history(chain, address);
        const { balance, hasFunds } = await check(chain, address, token);
        if (used || hasFunds) gap = 0; else gap++;
        if (hasFunds) record(n, address, tweak, balance);
    }
    return found;
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

    // Candidate selection: try each derivation path in BOTH y-parities and keep the key whose
    // own address actually equals the funded one.
    //
    // Parity matters because a secp256k1 x-coordinate has two valid y values. Taproot and EVM
    // are unaffected (x-only / natural (x,y) respectively) and match on the first candidate, so
    // their behaviour is unchanged — but P2WPKH commits to the exact compressed pubkey, and the
    // address path normalises to even-y while the tweak returns natural parity. Without this,
    // roughly half of native-SegWit payments would be signed with a key that cannot spend them.
    const candidates = [
        tweakPrivateKey(privateKeyHex, tweakHex),
        tweakPrivateKeyLegacy(privateKeyHex, tweakHex),
    ].flatMap(k => [k, negatePrivateKey(k)]);

    for (const candidate of candidates) {
        if (addressForKey(chain, candidate, asset).toLowerCase() === confirmedAddress.toLowerCase()) {
            return candidate;
        }
    }

    // Fail closed. Returning a non-matching key would produce a transaction the network rejects
    // (and could send change to an address the user does not control).
    throw new Error(`No derivation controls ${confirmedAddress} — refusing to sign`);
}

/**
 * Address for an ALREADY-FINAL key, applying no further parity normalisation. This is the
 * inverse check used by {@link getSigningKey}: it answers "what does this exact key control?",
 * whereas {@link deriveTweakedAddress} answers "what address should this tweak produce?".
 */
function addressForKey(chain: NspChain, keyHex: string, asset: string): string {
    switch (chain) {
        case 'bitcoin':
            return asset === 'taproot'
                ? privateKeyToTaprootAddress(keyHex)
                : privateKeyToBitcoinAddress(keyHex);
        case 'ethereum':
        case 'bnb':
        case 'polygon':
        case 'avalanche':
        case 'base': {
            const keyPair = getECPair().fromPrivateKey(Buffer.from(keyHex, 'hex'));
            const uncompressed = Buffer.from(ecc.pointCompress(keyPair.publicKey, false));
            const xy = uncompressed.slice(1);
            const rawAddr = keccak256(xy).slice(-40);
            const addrLower = rawAddr.toLowerCase();
            const checksumHash = keccak256(addrLower);
            let checksummed = '0x';
            for (let i = 0; i < addrLower.length; i++) {
                checksummed += parseInt(checksumHash[i], 16) >= 8 ? addrLower[i].toUpperCase() : addrLower[i];
            }
            return checksummed;
        }
        case 'zcash':
            return deriveZcashAddress(keyHex);
        default:
            throw new Error(`Unsupported chain: ${chain}`);
    }
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

/** Decode an npub (or pass through a 64-char hex pubkey) to x-only hex. */
function npubToHex(npubOrHex: string): string {
    if (/^[0-9a-fA-F]{64}$/.test(npubOrHex)) return npubOrHex.toLowerCase();
    const d = nip19.decode(npubOrHex);
    if (d.type !== 'npub') throw new Error('NSP: expected npub');
    return d.data as string;
}

/** Recompute the spending tweak for a deterministic payment from its (sender, n). */
export function nspTweakFromSender(recipientPrivHex: string, senderNpubOrHex: string, n: number): string {
    const shared = computeSharedSecret(recipientPrivHex, npubToHex(senderNpubOrHex));
    return nspTweak(shared, n);
}

/**
 * Create a deterministic kind:1604 notification. The signing key is k(n) derived from the
 * shared secret (not ephemeral/random), so the sender holds no per-payment state and can
 * recreate this exact-author notification to re-notify. The payload carries the sender's
 * npub and index `n` (encrypted) so the recipient can recompute the tweak and recover.
 */
export function createDeterministicNspNotification(
    senderPrivHex: string,
    recipientPubHex: string,
    n: number,
    fields: { address: string; chain: NspChain; asset: string; token: string | null; txid: string; amount: string },
): { event: any; notifPubkey: string; n: number } {
    const shared = computeSharedSecret(senderPrivHex, recipientPubHex);
    const notifSkHex = nspNotifKey(shared, n);
    const notifSk = hexToBytes(notifSkHex);
    const senderNpub = nip19.npubEncode(getPublicKey(hexToBytes(senderPrivHex)));

    const payload: NspPayload = {
        ...fields,
        sender: senderNpub,
        n,
        timestamp: Math.floor(Date.now() / 1000),
    };
    const encrypted = nip44Encrypt(notifSkHex, recipientPubHex, JSON.stringify(payload));
    const template = {
        kind: KIND_NSP_NOTIFICATION,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', recipientPubHex]],
        content: encrypted,
    };
    const event = finalizeEvent(template, notifSk);
    return { event, notifPubkey: getPublicKey(notifSk), n };
}

/**
 * Verify a decrypted notification payload belongs to us. Handles both deterministic
 * (sender + n) and legacy (tweak) payments. Cryptographic only — does NOT prove an on-chain
 * payment was made (callers SHOULD additionally gate on a real txid/balance against spam).
 */
export function verifyNspPayloadOwnership(recipientPrivHex: string, payload: NspPayload): boolean {
    try {
        const asset = payload.asset || 'taproot';
        if (payload.sender && payload.n !== undefined) {
            const senderHex = npubToHex(payload.sender);
            const { address } = deriveNspReceive(payload.chain, senderHex, recipientPrivHex, payload.n, asset);
            return address.toLowerCase() === payload.address.toLowerCase();
        }
        if (payload.tweak) {
            return verifyPaymentOwnership(recipientPrivHex, payload.tweak, payload.address, payload.chain, asset);
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * LEGACY: ephemeral-key notification (random tweak in payload). Retained so old send flows
 * keep working; new sends use createDeterministicNspNotification.
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
        console.log(`[NSP] Parsing notification id=${event.id?.slice(0, 12)}... from ephemeral=${senderPubkey?.slice(0, 12)}... created_at=${event.created_at}`);
        const plaintext = nip44Decrypt(recipientPrivkeyHex, senderPubkey, event.content);
        const parsed = JSON.parse(plaintext);

        // Valid if it carries an address+chain and EITHER a deterministic (sender + n) or a
        // legacy (tweak) derivation source.
        const hasDeterministic = !!parsed.sender && parsed.n !== undefined;
        if (!parsed.address || !parsed.chain || (!hasDeterministic && !parsed.tweak)) {
            console.warn('[NSP] Invalid notification payload — missing required fields');
            return null;
        }

        console.log(`[NSP] ✓ Parsed notification: chain=${parsed.chain} asset=${parsed.asset} address=${parsed.address?.slice(0, 10)}...`);
        return parsed as NspPayload;
    } catch (e) {
        console.error(`[NSP] ✗ Failed to parse notification id=${event.id?.slice(0, 12)}...:`, e);
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
        const totalRelays = getRelays().length;
        const sockets: WebSocket[] = [];
        const subId = 'nsp_batch_' + Math.random().toString(36).slice(2, 8);
        const filter: any = { kinds: [KIND_NSP_NOTIFICATION], '#p': [pubkeyHex], limit };
        if (since > 0) filter.since = since;
        if (until !== undefined) filter.until = until;

        console.log(`[NSP] fetchNotificationBatch: pubkey=${pubkeyHex.slice(0, 12)}... since=${since} until=${until ?? 'none'} limit=${limit}`);

        const finish = () => {
            if (resolved) return;
            resolved = true;
            sockets.forEach(s => { try { s.close(); } catch {} });
            console.log(`[NSP] fetchNotificationBatch: found ${events.size} unique events`);
            resolve(Array.from(events.values()));
        };
        const tryFinish = () => { resolvedCount++; if (resolvedCount >= totalRelays) finish(); };
        setTimeout(finish, 8000);

        for (const relayUrl of getRelays()) {
            try {
                const ws = new WebSocket(relayUrl);
                sockets.push(ws);
                ws.onopen = () => {
                    console.log(`[NSP]   → querying ${relayUrl}`);
                    ws.send(JSON.stringify(['REQ', subId, filter]));
                };
                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'EVENT' && data[2]) {
                            events.set(data[2].id, data[2]);
                            console.log(`[NSP]   ← event from ${relayUrl}: id=${data[2].id?.slice(0, 12)}...`);
                        }
                        if (data[0] === 'EOSE') { try { ws.close(); } catch {} tryFinish(); }
                    } catch {}
                };
                ws.onerror = () => {
                    console.warn(`[NSP]   ✗ relay error: ${relayUrl}`);
                    tryFinish();
                };
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
    console.log(`[NSP] catchUpScan: pubkey=${pubkeyHex.slice(0, 12)}... lastScanned=${lastScanned} (${lastScanned > 0 ? new Date(lastScanned * 1000).toISOString() : 'beginning'})`);
    let highestCreatedAt = lastScanned;
    let until: number | undefined;
    let totalEvents = 0;
    while (true) {
        const batch = await fetchNotificationBatch(pubkeyHex, lastScanned, until, 500);
        if (batch.length === 0) break;
        totalEvents += batch.length;
        onBatch(batch);
        for (const evt of batch) {
            if (evt.created_at > highestCreatedAt) highestCreatedAt = evt.created_at;
        }
        if (batch.length < 500) break;
        until = Math.min(...batch.map((e: any) => e.created_at));
    }
    console.log(`[NSP] catchUpScan complete: ${totalEvents} total events found`);
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
    const promises = getRelays().map(relayUrl => {
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
        const totalRelays = getRelays().length;
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

        for (const relayUrl of getRelays()) {
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
        const totalRelays = getRelays().length;
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

        for (const relayUrl of getRelays()) {
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

    console.log(`[NSP] Subscribing to kind ${KIND_NSP_NOTIFICATION} for ${pubkeyHex.slice(0, 12)}... since=${sinceTimestamp} on ${getRelays().length} relays`);

    for (const relayUrl of getRelays()) {
        try {
            const ws = new WebSocket(relayUrl);
            ws.onopen = () => {
                console.log(`[NSP] ✓ Subscription connected: ${relayUrl}`);
                ws.send(JSON.stringify(['REQ', subId, filter]));
            };
            ws.onmessage = (msg) => {
                try {
                    const data = JSON.parse(msg.data);
                    if (data[0] === 'EVENT' && data[2]) {
                        console.log(`[NSP] ← Live event from ${relayUrl}: id=${data[2].id?.slice(0, 12)}... created_at=${data[2].created_at}`);
                        callback(data[2]);
                    }
                    if (data[0] === 'EOSE') {
                        console.log(`[NSP]   EOSE from ${relayUrl} — now listening for live events`);
                    }
                } catch { }
            };
            ws.onerror = () => {
                console.warn(`[NSP] ✗ Subscription error: ${relayUrl}`);
            };
            ws.onclose = () => {
                console.log(`[NSP]   Subscription closed: ${relayUrl}`);
            };
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
