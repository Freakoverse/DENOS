/**
 * Zcash Transparent (t1) Address Service for DENOS
 * Uses secp256k1 HASH-160 with Zcash version bytes.
 * Even-y (BIP-340/Nostr convention) for deterministic npub→address.
 * NOTE: Transparent addresses are NOT private — all transactions are visible on-chain.
 */

import * as bitcoin from 'bitcoinjs-lib';
import bs58check from 'bs58check';
import * as ecc from '@bitcoinerlab/secp256k1';
import { getECPair } from '@/services/bitcoin';
import { nip19 } from 'nostr-tools';
import { Buffer } from 'buffer';
import { blake2b } from '@noble/hashes/blake2.js';

// ── Types ──

export interface ZcashTx {
    txid: string;
    value: number;
    timestamp: number;
    confirmations: number;
    type: 'receive' | 'send';
}

// ── Zcash Node Management ──

const STORAGE_KEY = 'denos-zcash-nodes';

const DEFAULT_ZCASH_NODES = [
    'https://sandbox-api.3xpl.com',
    'https://api.blockchair.com/zcash',
];

export const zcashNodes = {
    getNodes(): string[] {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed) && parsed.length > 0) return parsed;
            }
        } catch { }
        return [...DEFAULT_ZCASH_NODES];
    },

    setNodes(nodes: string[]) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nodes));
    },

    addNode(url: string) {
        const nodes = this.getNodes();
        const normalized = url.replace(/\/+$/, '');
        if (!nodes.includes(normalized)) {
            nodes.push(normalized);
            this.setNodes(nodes);
        }
    },

    removeNode(url: string) {
        const nodes = this.getNodes().filter(n => n !== url);
        this.setNodes(nodes);
    },

    async checkNodeHealth(url: string): Promise<boolean> {
        try {
            const res = await fetch(`${url}/stats`, { signal: AbortSignal.timeout(5000) });
            return res.ok;
        } catch {
            return false;
        }
    },

    getDefaultNodes(): string[] {
        return [...DEFAULT_ZCASH_NODES];
    },
};

// ── Balance & History ──

const THREEXPL_BASE = 'https://sandbox-api.3xpl.com';

// Cache to avoid duplicate requests (sandbox is rate-limited)
let _zcashCache: { address: string; time: number; data: { balance: number; txs: ZcashTx[] } } | null = null;
const CACHE_TTL = 15_000; // 15 seconds

/** Fetch balance + history from 3xpl sandbox API (primary) */
async function fetch3xpl(address: string): Promise<{ balance: number; txs: ZcashTx[] } | null> {
    try {
        const url = `${THREEXPL_BASE}/zcash/address/${address}?data=address,events`;
        const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) {
            console.warn(`[Zcash 3xpl] HTTP ${res.status}`);
            return null;
        }
        const json = await res.json();
        if (json.context?.code !== 200) {
            console.warn('[Zcash 3xpl] Error:', json.context?.error || json.data);
            return null;
        }

        const events: any[] = json.data?.events?.['zcash-main'] || [];

        // Consolidate events by txid — a send with change creates two events
        // (one negative spend, one positive change) that should be netted
        const eventsByTx = new Map<string, { netEffect: number; timestamp: number; confirmations: number }>();
        for (const ev of events) {
            const effect = parseInt(ev.effect || '0', 10);
            const txid = ev.transaction || '';
            const ts = ev.time ? Math.floor(new Date(ev.time).getTime() / 1000) : 0;
            const confs = ev.block != null && ev.block > 0 ? 1 : 0;
            const existing = eventsByTx.get(txid);
            if (existing) {
                existing.netEffect += effect;
                // Keep the most relevant timestamp/confirmations
                if (ts > existing.timestamp) existing.timestamp = ts;
                if (confs > existing.confirmations) existing.confirmations = confs;
            } else {
                eventsByTx.set(txid, { netEffect: effect, timestamp: ts, confirmations: confs });
            }
        }

        let balance = 0;
        const txs: ZcashTx[] = [];
        for (const [txid, data] of eventsByTx) {
            balance += data.netEffect;
            // Skip zero-net-effect transactions (fully self-spent, unlikely but possible)
            if (data.netEffect === 0) continue;
            txs.push({
                txid,
                value: Math.abs(data.netEffect),
                timestamp: data.timestamp,
                confirmations: data.confirmations,
                type: data.netEffect >= 0 ? 'receive' as const : 'send' as const,
            });
        }

        console.log(`[Zcash 3xpl] balance=${balance} txs=${txs.length}`);
        return { balance, txs };
    } catch (e) {
        console.error('[Zcash 3xpl] fetch error:', e);
        return null;
    }
}

/** Fallback: Blockchair API */
async function fetchBlockchair(address: string): Promise<{ balance: number; txs: ZcashTx[] } | null> {
    try {
        const res = await fetch(`https://api.blockchair.com/zcash/dashboards/address/${address}?limit=25`, {
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;
        const data = await res.json();

        if (data.context?.code === 430 || !data.data) {
            console.warn('[Zcash Blockchair] Rate limited / IP blacklisted');
            return null;
        }

        const addrData = data?.data?.[address];
        if (!addrData) return null;

        const balance = addrData?.address?.balance || 0;
        const txs: ZcashTx[] = (addrData?.transactions || []).map((tx: any) => ({
            txid: tx.hash || (typeof tx === 'string' ? tx : ''),
            value: Math.abs(tx.balance_change || 0),
            timestamp: tx.time ? Math.floor(new Date(tx.time).getTime() / 1000) : 0,
            confirmations: tx.block_id ? 1 : 0,
            type: (tx.balance_change || 0) > 0 ? 'receive' as const : 'send' as const,
        }));

        return { balance, txs };
    } catch {
        return null;
    }
}

// In-flight promise deduplication — prevents concurrent calls from racing
let _pendingFetch: Promise<{ balance: number; txs: ZcashTx[] }> | null = null;

/** Fetch Zcash data (deduplicated + cached to prevent duplicate sandbox requests) */
async function fetchZcashData(address: string): Promise<{ balance: number; txs: ZcashTx[] }> {
    // Return cached data if fresh
    if (_zcashCache && _zcashCache.address === address && Date.now() - _zcashCache.time < CACHE_TTL) {
        return _zcashCache.data;
    }
    // If a fetch is already in flight, reuse the same promise
    if (_pendingFetch) return _pendingFetch;

    _pendingFetch = (async () => {
        try {
            const result = await fetch3xpl(address) || await fetchBlockchair(address) || { balance: 0, txs: [] };
            _zcashCache = { address, time: Date.now(), data: result };
            return result;
        } finally {
            _pendingFetch = null;
        }
    })();

    return _pendingFetch;
}

export async function fetchZcashBalance(address: string): Promise<number> {
    const result = await fetchZcashData(address);
    return result.balance;
}

export async function fetchZcashTxHistory(address: string): Promise<ZcashTx[]> {
    const result = await fetchZcashData(address);
    return result.txs;
}

/**
 * HASH-160: SHA-256 → RIPEMD-160 (using bitcoinjs-lib)
 */
function hash160(data: Uint8Array): Buffer {
    bitcoin.initEccLib(ecc);
    return bitcoin.crypto.hash160(Buffer.from(data));
}

/**
 * Derive Zcash transparent address from private key (even-y forced).
 * Zcash t-address version bytes: 0x1C, 0xB8 (mainnet P2PKH)
 */
export function deriveZcashAddress(privateKeyHex: string): string {
    const privateKeyBuffer = Buffer.from(privateKeyHex, 'hex');
    const keyPair = getECPair().fromPrivateKey(privateKeyBuffer);
    let compressed = keyPair.publicKey;

    // Force even-y
    if (compressed[0] === 0x03) {
        // Negate private key
        const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
        const d = BigInt('0x' + privateKeyHex);
        const negated = n - d;
        const negatedHex = negated.toString(16).padStart(64, '0');
        const negatedKeyPair = getECPair().fromPrivateKey(Buffer.from(negatedHex, 'hex'));
        compressed = negatedKeyPair.publicKey;
    }

    const h160 = hash160(compressed);
    // Zcash mainnet t-address version: 0x1CB8 (two bytes)
    const versioned = Buffer.alloc(2 + h160.length);
    versioned[0] = 0x1C;
    versioned[1] = 0xB8;
    versioned.set(h160, 2);
    return bs58check.encode(versioned);
}

/**
 * Derive the "standard" (natural y) Zcash address for comparison.
 */
export function deriveStandardZcashAddress(privateKeyHex: string): string {
    const privateKeyBuffer = Buffer.from(privateKeyHex, 'hex');
    const keyPair = getECPair().fromPrivateKey(privateKeyBuffer);
    const compressed = keyPair.publicKey;
    const h160 = hash160(compressed);
    const versioned = Buffer.alloc(2 + h160.length);
    versioned[0] = 0x1C;
    versioned[1] = 0xB8;
    versioned.set(h160, 2);
    return bs58check.encode(versioned);
}

/**
 * Derive Zcash transparent address from npub (public-only, even-y).
 */
export function npubToZcashAddress(npub: string): string {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') throw new Error('Invalid npub format');
    const pubkeyHex = decoded.data as string;
    const compressed = Buffer.from('02' + pubkeyHex, 'hex');
    const h160 = hash160(compressed);
    const versioned = Buffer.alloc(2 + h160.length);
    versioned[0] = 0x1C;
    versioned[1] = 0xB8;
    versioned.set(h160, 2);
    return bs58check.encode(versioned);
}

/**
 * Derive Zcash address from raw hex pubkey (32-byte x-only, assumes even y).
 */
export function pubkeyHexToZcashAddress(pubkeyHex: string): string {
    const compressed = Buffer.from('02' + pubkeyHex, 'hex');
    const h160 = hash160(compressed);
    const versioned = Buffer.alloc(2 + h160.length);
    versioned[0] = 0x1C;
    versioned[1] = 0xB8;
    versioned.set(h160, 2);
    return bs58check.encode(versioned);
}

/**
 * Get the effective private key (even-y normalized) for signing Zcash transactions.
 */
export function getZcashSigningKey(privateKeyHex: string): string {
    const privateKeyBuffer = Buffer.from(privateKeyHex, 'hex');
    const keyPair = getECPair().fromPrivateKey(privateKeyBuffer);
    const compressed = keyPair.publicKey;

    if (compressed[0] === 0x02) {
        return privateKeyHex;
    }
    // Negate
    const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
    const d = BigInt('0x' + privateKeyHex);
    const negated = n - d;
    return negated.toString(16).padStart(64, '0');
}

// ── Formatting ──

export function zecToSats(zec: number): number {
    return Math.round(zec * 100_000_000);
}

export function satsToZec(sats: number): string {
    return (sats / 100_000_000).toFixed(8);
}

// ══════════════════════════════════════════════════════════════════
// ── Zcash Transparent Transaction Sending (ZIP-225 v5 + ZIP-244) ──
// ══════════════════════════════════════════════════════════════════

// ── Constants ──

const ZEC_VERSION = 0x80000005;           // v5 + fOverwintered
const ZEC_VERSION_GROUP_ID = 0x26A7270A;  // v5 version group
const ZEC_BRANCH_ID = 0x4DEC4DF0;        // NU6.1 (active Nov 2025)
const SIGHASH_ALL = 0x01;
const DEFAULT_FEE = 10_000;               // 0.0001 ZEC
const DEFAULT_SEQUENCE = 0xFFFFFFFF;

// ── Types ──

export interface ZcashUTXO {
    txid: string;
    vout: number;
    value: number;        // zatoshi
    scriptPubKey: string; // hex
}

// ── Helpers ──

/** Write uint32 little-endian */
function writeU32LE(value: number): Buffer {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value >>> 0);
    return buf;
}

/** Write int64 little-endian (for amounts) */
function writeI64LE(value: number): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeInt32LE(value & 0xFFFFFFFF, 0);
    buf.writeInt32LE(Math.floor(value / 0x100000000), 4);
    return buf;
}

/** CompactSize encoding (Bitcoin varint) */
function compactSize(n: number): Buffer {
    if (n < 0xFD) return Buffer.from([n]);
    if (n <= 0xFFFF) {
        const buf = Buffer.alloc(3);
        buf[0] = 0xFD;
        buf.writeUInt16LE(n, 1);
        return buf;
    }
    const buf = Buffer.alloc(5);
    buf[0] = 0xFE;
    buf.writeUInt32LE(n, 1);
    return buf;
}

/** BLAKE2b-256 with personalization (16-byte ASCII string) */
function blake2b256(personalization: string, data: Buffer): Buffer {
    const pers = Buffer.alloc(16);
    pers.write(personalization.slice(0, 16), 'ascii');
    return Buffer.from(blake2b(data, { personalization: pers, dkLen: 32 }));
}

/** Construct P2PKH scriptPubKey from a t1-address */
function addressToScriptPubKey(address: string): Buffer {
    const decoded = Buffer.from(bs58check.decode(address));
    // Zcash t-addr: 2-byte version (0x1CB8) + 20-byte pubKeyHash
    const pubKeyHash = decoded.slice(2);
    // OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
    return Buffer.concat([
        Buffer.from([0x76, 0xa9, 0x14]),
        pubKeyHash,
        Buffer.from([0x88, 0xac]),
    ]);
}

/** Encode an outpoint (32-byte txid LE + 4-byte index LE) */
function encodeOutpoint(txid: string, vout: number): Buffer {
    // txid is displayed big-endian, but serialized little-endian
    const txidBuf = Buffer.from(txid, 'hex').reverse();
    return Buffer.concat([txidBuf, writeU32LE(vout)]);
}

// ── UTXO Fetching ──

/** Fetch UTXOs from 3xpl events (derive from positive-effect events) */
export async function fetchZcashUTXOs(address: string): Promise<ZcashUTXO[]> {
    const scriptPubKey = addressToScriptPubKey(address).toString('hex');
    
    try {
        // Fetch events to find received transactions
        const url = `${THREEXPL_BASE}/zcash/address/${address}?data=address,events`;
        const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) return [];
        const json = await res.json();
        if (json.context?.code !== 200) return [];

        const events: any[] = json.data?.events?.['zcash-main'] || [];
        
        // Build UTXOs from received (positive) events
        // For each receive event, we need to find the correct output index
        const utxos: ZcashUTXO[] = [];
        
        for (const ev of events) {
            const effect = parseInt(ev.effect || '0', 10);
            if (effect <= 0) continue; // Only unspent receives
            
            const txid = ev.transaction;
            if (!txid) continue;
            
            // Try to get output index from sort_key or fetch tx details
            // sort_key within the event correlates to the output position
            // For a simple P2PKH receive, try vout=0 first, then scan
            let vout = 0;
            
            // Try to fetch transaction details to find exact output index
            try {
                const txUrl = `${THREEXPL_BASE}/zcash/transaction/${txid}?data=transaction,events`;
                const txRes = await fetch(txUrl, { signal: AbortSignal.timeout(8000) });
                if (txRes.ok) {
                    const txJson = await txRes.json();
                    const txEvents = txJson.data?.events?.['zcash-main'] || [];
                    // Find the event that credits our address
                    for (let i = 0; i < txEvents.length; i++) {
                        const te = txEvents[i];
                        if (te.address === address && parseInt(te.effect || '0', 10) > 0) {
                            // The sort_key within a tx's events maps to the output index
                            vout = te.sort_key ?? i;
                            break;
                        }
                    }
                }
            } catch { /* fall through with vout=0 */ }
            
            utxos.push({
                txid,
                vout,
                value: effect,
                scriptPubKey,
            });
        }
        
        console.log(`[Zcash UTXOs] Found ${utxos.length} for ${address}`);
        return utxos;
    } catch (e) {
        console.error('[Zcash UTXOs] fetch error:', e);
        return [];
    }
}

// ── ZIP-244 Signature Digest ──

interface TxData {
    inputs: { txid: string; vout: number; value: number; scriptPubKey: Buffer; sequence: number }[];
    outputs: { value: number; scriptPubKey: Buffer }[];
    lockTime: number;
    expiryHeight: number;
}

/** T.1: header_digest */
function headerDigest(lockTime: number, expiryHeight: number): Buffer {
    const data = Buffer.concat([
        writeU32LE(ZEC_VERSION),
        writeU32LE(ZEC_VERSION_GROUP_ID),
        writeU32LE(ZEC_BRANCH_ID),
        writeU32LE(lockTime),
        writeU32LE(expiryHeight),
    ]);
    return blake2b256('ZTxIdHeadersHash', data);
}

/** T.2a: prevouts_digest */
function prevoutsDigest(inputs: TxData['inputs']): Buffer {
    const data = Buffer.concat(inputs.map(i => encodeOutpoint(i.txid, i.vout)));
    return blake2b256('ZTxIdPrevoutHash', data);
}

/** T.2b: sequence_digest */
function sequenceDigest(inputs: TxData['inputs']): Buffer {
    const data = Buffer.concat(inputs.map(i => writeU32LE(i.sequence)));
    return blake2b256('ZTxIdSequencHash', data);
}

/** Encode a single output for hashing (8-byte value + compactSize + scriptPubKey) */
function encodeOutput(value: number, scriptPubKey: Buffer): Buffer {
    return Buffer.concat([writeI64LE(value), compactSize(scriptPubKey.length), scriptPubKey]);
}

/** T.2c: outputs_digest */
function outputsDigest(outputs: TxData['outputs']): Buffer {
    const data = Buffer.concat(outputs.map(o => encodeOutput(o.value, o.scriptPubKey)));
    return blake2b256('ZTxIdOutputsHash', data);
}


/** T.3: sapling_digest (empty for transparent-only) */
function saplingDigest(): Buffer {
    return blake2b256('ZTxIdSaplingHash', Buffer.alloc(0));
}

/** T.4: orchard_digest (empty for transparent-only) */
function orchardDigest(): Buffer {
    return blake2b256('ZTxIdOrchardHash', Buffer.alloc(0));
}

/** S.2c: amounts_sig_digest — hash of all input values */
function amountsSigDigest(inputs: TxData['inputs']): Buffer {
    const data = Buffer.concat(inputs.map(i => writeI64LE(i.value)));
    return blake2b256('ZTxTrAmountsHash', data);
}

/** S.2d: scriptpubkeys_sig_digest — hash of all input scriptPubKeys (with CompactSize prefix) */
function scriptpubkeysSigDigest(inputs: TxData['inputs']): Buffer {
    const data = Buffer.concat(inputs.map(i =>
        Buffer.concat([compactSize(i.scriptPubKey.length), i.scriptPubKey])
    ));
    return blake2b256('ZTxTrScriptsHash', data);
}

/** S.2g: txin_sig_digest — per-input commitment */
function txinSigDigest(input: TxData['inputs'][0]): Buffer {
    const data = Buffer.concat([
        encodeOutpoint(input.txid, input.vout),
        writeI64LE(input.value),
        compactSize(input.scriptPubKey.length),
        input.scriptPubKey,
        writeU32LE(input.sequence),
    ]);
    return blake2b256('Zcash___TxInHash', data);
}

/** Compute the full ZIP-244 signature digest for a transparent input */
function signatureDigest(tx: TxData, inputIndex: number): Buffer {
    const branchIdLE = writeU32LE(ZEC_BRANCH_ID);
    const personalization = Buffer.alloc(16);
    personalization.write('ZcashTxHash_', 'ascii');
    branchIdLE.copy(personalization, 12);

    // S.1: header_digest (same as T.1)
    const hdrDigest = headerDigest(tx.lockTime, tx.expiryHeight);

    // S.2: transparent_sig_digest
    const transSigData = Buffer.concat([
        Buffer.from([SIGHASH_ALL]),                    // S.2a
        prevoutsDigest(tx.inputs),                     // S.2b
        amountsSigDigest(tx.inputs),                   // S.2c
        scriptpubkeysSigDigest(tx.inputs),              // S.2d
        sequenceDigest(tx.inputs),                     // S.2e
        outputsDigest(tx.outputs),                     // S.2f
        txinSigDigest(tx.inputs[inputIndex]),           // S.2g
    ]);
    const transSigDigest = blake2b256('ZTxIdTranspaHash', transSigData);

    // S.3 & S.4: empty for transparent-only
    const sapDigest = saplingDigest();
    const orchDigest = orchardDigest();

    // Final signature digest
    const sigData = Buffer.concat([hdrDigest, transSigDigest, sapDigest, orchDigest]);
    return Buffer.from(blake2b(sigData, { personalization, dkLen: 32 }));
}

// ── ECDSA Signing + DER ──

/** Sign a message hash and return DER-encoded signature */
function ecdsaSign(msgHash: Buffer, privateKeyHex: string): Buffer {
    const privKey = Buffer.from(privateKeyHex, 'hex');
    const sigObj = ecc.sign(msgHash, privKey);
    // sigObj is 64 bytes: r (32) + s (32)
    const r = sigObj.slice(0, 32);
    const s = sigObj.slice(32, 64);

    // Low-S normalization (BIP-62)
    const sInt = BigInt('0x' + Buffer.from(s).toString('hex'));
    const halfOrder = BigInt('0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0');
    let sNorm = s;
    if (sInt > halfOrder) {
        const order = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
        const sLow = order - sInt;
        sNorm = Buffer.from(sLow.toString(16).padStart(64, '0'), 'hex');
    }

    // DER encode
    function derInt(val: Buffer): Buffer {
        let v = val;
        // Strip leading zeros
        while (v.length > 1 && v[0] === 0) v = v.slice(1);
        // Add leading zero if high bit set
        if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0x00]), v]);
        return Buffer.concat([Buffer.from([0x02, v.length]), v]);
    }

    const rDer = derInt(Buffer.from(r));
    const sDer = derInt(Buffer.from(sNorm));
    const der = Buffer.concat([Buffer.from([0x30, rDer.length + sDer.length]), rDer, sDer]);
    return der;
}

// ── Transaction Serialization (ZIP-225 v5) ──

/** Serialize a transparent-only v5 transaction */
function serializeV5Tx(
    inputs: { txid: string; vout: number; sequence: number; scriptSig: Buffer }[],
    outputs: { value: number; scriptPubKey: Buffer }[],
    lockTime: number,
    expiryHeight: number,
): Buffer {
    const parts: Buffer[] = [
        writeU32LE(ZEC_VERSION),
        writeU32LE(ZEC_VERSION_GROUP_ID),
        writeU32LE(ZEC_BRANCH_ID),
        writeU32LE(lockTime),
        writeU32LE(expiryHeight),
        // Transparent inputs
        compactSize(inputs.length),
    ];

    for (const inp of inputs) {
        parts.push(encodeOutpoint(inp.txid, inp.vout));
        parts.push(compactSize(inp.scriptSig.length));
        parts.push(inp.scriptSig);
        parts.push(writeU32LE(inp.sequence));
    }

    // Transparent outputs
    parts.push(compactSize(outputs.length));
    for (const out of outputs) {
        parts.push(writeI64LE(out.value));
        parts.push(compactSize(out.scriptPubKey.length));
        parts.push(out.scriptPubKey);
    }

    // Empty Sapling + Orchard
    parts.push(compactSize(0)); // nSpendsSapling
    parts.push(compactSize(0)); // nOutputsSapling
    parts.push(compactSize(0)); // nActionsOrchard

    return Buffer.concat(parts);
}

// ── Public API ──

/** Create a signed Zcash transparent transaction */
export async function createZcashTransaction(
    privateKeyHex: string,
    toAddress: string,
    amountZatoshi: number,
    utxos: ZcashUTXO[],
    fee: number = DEFAULT_FEE,
    useStandard: boolean = false,
): Promise<{ txHex: string; fee: number }> {
    // Get the correct signing key (even-y or standard)
    const signingKeyHex = useStandard ? privateKeyHex : getZcashSigningKey(privateKeyHex);
    const signingKeyBuf = Buffer.from(signingKeyHex, 'hex');
    const keyPair = getECPair().fromPrivateKey(signingKeyBuf);
    const pubkey = keyPair.publicKey; // 33-byte compressed

    // Derive change address from the signing key
    const changeScriptPubKey = addressToScriptPubKey(
        useStandard ? deriveStandardZcashAddress(privateKeyHex) : deriveZcashAddress(privateKeyHex)
    );
    const toScriptPubKey = addressToScriptPubKey(toAddress);

    // Select UTXOs
    let totalInput = 0;
    const selectedUtxos: ZcashUTXO[] = [];
    for (const utxo of utxos) {
        selectedUtxos.push(utxo);
        totalInput += utxo.value;
        if (totalInput >= amountZatoshi + fee) break;
    }

    if (totalInput < amountZatoshi + fee) {
        throw new Error(`Insufficient funds. Need ${amountZatoshi + fee} zatoshi, have ${totalInput}`);
    }

    const change = totalInput - amountZatoshi - fee;

    // Build transaction data
    const inputs: TxData['inputs'] = selectedUtxos.map(u => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        scriptPubKey: Buffer.from(u.scriptPubKey, 'hex'),
        sequence: DEFAULT_SEQUENCE,
    }));

    const outputs: TxData['outputs'] = [
        { value: amountZatoshi, scriptPubKey: toScriptPubKey },
    ];
    // Add change output if above dust (546 zatoshi)
    if (change > 546) {
        outputs.push({ value: change, scriptPubKey: changeScriptPubKey });
    }

    const txData: TxData = { inputs, outputs, lockTime: 0, expiryHeight: 0 };

    // Sign each input
    const signedInputs = inputs.map((inp, idx) => {
        const sigHash = signatureDigest(txData, idx);
        const derSig = ecdsaSign(sigHash, signingKeyHex);
        // scriptSig = <sig + SIGHASH_ALL> <pubkey>
        const sigWithHashType = Buffer.concat([derSig, Buffer.from([SIGHASH_ALL])]);
        const scriptSig = Buffer.concat([
            Buffer.from([sigWithHashType.length]),
            sigWithHashType,
            Buffer.from([pubkey.length]),
            pubkey,
        ]);
        return {
            txid: inp.txid,
            vout: inp.vout,
            sequence: inp.sequence,
            scriptSig,
        };
    });

    const txHex = serializeV5Tx(signedInputs, outputs, 0, 0).toString('hex');
    console.log(`[Zcash TX] Created tx: ${txHex.length / 2} bytes, fee=${fee}`);
    return { txHex, fee };
}

/** Broadcast a raw Zcash transaction */
export async function broadcastZcashTransaction(txHex: string): Promise<string> {
    // Try SoChain
    try {
        const res = await fetch('https://sochain.com/api/v3/broadcast_transaction/ZEC', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tx_hex: txHex }),
            signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
            const data = await res.json();
            if (data.data?.txid) {
                console.log('[Zcash Broadcast] SoChain success:', data.data.txid);
                return data.data.txid;
            }
        }
        console.warn('[Zcash Broadcast] SoChain failed:', await res.text());
    } catch (e) {
        console.warn('[Zcash Broadcast] SoChain error:', e);
    }

    // Try Blockchair
    try {
        const res = await fetch('https://api.blockchair.com/zcash/push/transaction', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${txHex}`,
            signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
            const data = await res.json();
            if (data.data?.transaction_hash) {
                console.log('[Zcash Broadcast] Blockchair success:', data.data.transaction_hash);
                return data.data.transaction_hash;
            }
        }
        console.warn('[Zcash Broadcast] Blockchair failed:', await res.text());
    } catch (e) {
        console.warn('[Zcash Broadcast] Blockchair error:', e);
    }

    throw new Error('Failed to broadcast Zcash transaction. All broadcast endpoints failed.');
}
