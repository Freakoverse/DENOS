/**
 * BIP-352 Silent Payment (sp1) Service
 *
 * Key derivation from Nostr identity, sp1 address encoding/decoding,
 * BIP-352 ECDH output derivation (send side), and manual txid
 * verification (receive fallback).
 *
 * See NIP-NSP.md section 9 for the full specification.
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

import { getECPair } from '@/services/bitcoin';

// ── Constants ──

const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

// ── Types ──

export interface Sp1Keys {
    scanPriv: string;   // 32-byte hex
    scanPub: Buffer;    // 33-byte compressed
    spendPriv: string;  // 32-byte hex
    spendPub: Buffer;   // 33-byte compressed
}

export interface Sp1Output {
    outputAddress: string;  // bc1p... Taproot address
    tweak: string;          // 32-byte hex tweak used
}

export interface Sp1VerifyResult {
    owned: boolean;
    tweak?: string;         // ECDH-derived tweak hex
    address?: string;       // matched bc1p... output address
    amount?: number;        // output value in satoshis
    spendKey?: string;      // derived spending private key hex
}

// ── Tagged Hash (BIP-340 style) ──

/**
 * BIP-340 tagged hash: SHA-256(SHA-256(tag) || SHA-256(tag) || msg)
 */
function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
    const tagHash = sha256(new TextEncoder().encode(tag));
    const buf = new Uint8Array(tagHash.length + tagHash.length + msg.length);
    buf.set(tagHash, 0);
    buf.set(tagHash, tagHash.length);
    buf.set(msg, tagHash.length * 2);
    return sha256(buf);
}

// ── 1. Key Derivation from Nostr Identity ──

/**
 * Derive BIP-352 scan/spend key pairs from a Nostr nsec/npub.
 *
 * t_scan  = H_tag("nostr-sp/scan",  ser_P(P))
 * t_spend = H_tag("nostr-sp/spend", ser_P(P))
 *
 * scan_priv  = (d_even + t_scan) mod n
 * spend_priv = (d_even + t_spend) mod n
 *
 * ScanPub  = scan_priv · G
 * SpendPub = spend_priv · G
 */
export function deriveScanKeys(privateKeyHex: string, pubkeyHex: string): Sp1Keys {
    // Serialize public key as compressed (02 || x)
    const compressedPub = Buffer.from('02' + pubkeyHex, 'hex');

    // Tagged hash tweaks
    const tScan = taggedHash('nostr-sp/scan', compressedPub);
    const tSpend = taggedHash('nostr-sp/spend', compressedPub);

    // Even-y normalize the private key (same as NSP section 2.2)
    const d = BigInt('0x' + privateKeyHex);
    const keyPair = getECPair().fromPrivateKey(Buffer.from(privateKeyHex, 'hex'));
    const dEven = keyPair.publicKey[0] === 0x03 ? (SECP256K1_N - d) : d;

    // Derive private keys
    const tScanBig = BigInt('0x' + bytesToHex(tScan));
    const tSpendBig = BigInt('0x' + bytesToHex(tSpend));

    const scanPriv = ((dEven + tScanBig) % SECP256K1_N).toString(16).padStart(64, '0');
    const spendPriv = ((dEven + tSpendBig) % SECP256K1_N).toString(16).padStart(64, '0');

    // Derive public keys from private keys
    const scanPub = Buffer.from(
        ecc.pointFromScalar(hexToBytes(scanPriv))!
    );
    const spendPub = Buffer.from(
        ecc.pointFromScalar(hexToBytes(spendPriv))!
    );

    return { scanPriv, scanPub, spendPriv, spendPub };
}

/**
 * Derive public-only scan/spend keys from an npub (sender side).
 * Uses point addition: P + t·G instead of scalar addition.
 */
export function deriveScanPubKeys(pubkeyHex: string): { scanPub: Buffer; spendPub: Buffer } {
    const compressedPub = Buffer.from('02' + pubkeyHex, 'hex');

    const tScan = taggedHash('nostr-sp/scan', compressedPub);
    const tSpend = taggedHash('nostr-sp/spend', compressedPub);

    // t · G
    const scanTweakPoint = ecc.pointFromScalar(tScan);
    const spendTweakPoint = ecc.pointFromScalar(tSpend);
    if (!scanTweakPoint || !spendTweakPoint) throw new Error('Invalid tweak scalar');

    // P + t · G
    const scanPub = ecc.pointAdd(compressedPub, scanTweakPoint);
    const spendPub = ecc.pointAdd(compressedPub, spendTweakPoint);
    if (!scanPub || !spendPub) throw new Error('Point addition failed');

    return {
        scanPub: Buffer.from(scanPub),
        spendPub: Buffer.from(spendPub),
    };
}

// ── 2. sp1 Address Encoding / Decoding ──

/**
 * Encode ScanPub || SpendPub into a BIP-352 sp1... address (bech32m).
 *
 * Encoding matches OpenETR/NSW convention:
 *   data = convertbits(scanPub_33 || spendPub_33, 8→5)
 *   address = bech32m_encode("sp", [version] + data)
 *
 * Version is prepended as a 5-bit word, not as an 8-bit byte before conversion.
 * Full 33-byte compressed pubkeys are encoded (not x-only).
 */
export function encodeSp1Address(scanPub: Buffer, spendPub: Buffer): string {
    if (scanPub.length !== 33 || spendPub.length !== 33) {
        throw new Error('scan and spend public keys must be 33-byte compressed pubkeys');
    }

    // Concatenate full compressed pubkeys: 66 bytes
    const payload = Buffer.concat([scanPub, spendPub]);

    // Convert 66 bytes to 5-bit words
    const dataWords = bech32mConvertBits(payload, 8, 5, true);

    // Prepend version (0) as a 5-bit word
    const words = [0, ...dataWords];

    return bech32mEncode('sp', words);
}

/**
 * Decode a BIP-352 sp1... address back into ScanPub and SpendPub.
 */
export function decodeSp1Address(address: string): { scanPub: Buffer; spendPub: Buffer } {
    const { hrp, words } = bech32mDecode(address);
    if (hrp !== 'sp') throw new Error(`Invalid sp1 HRP: ${hrp}`);

    // First 5-bit word is the version
    const version = words[0];
    if (version !== 0x00) throw new Error(`Unsupported sp1 version: ${version}`);

    // Remaining 5-bit words → 8-bit bytes
    const data = Buffer.from(bech32mConvertBits(words.slice(1), 5, 8, false));

    // Full 33-byte compressed pubkeys
    if (data.length < 66) throw new Error(`Invalid sp1 data length: ${data.length}, expected at least 66`);

    const scanPub = data.slice(0, 33);
    const spendPub = data.slice(33, 66);

    return { scanPub, spendPub };
}

// ── Bech32m Helpers ──
// Minimal bech32m implementation for sp1 encoding.
// bitcoinjs-lib includes bech32 but only via address.toBech32/fromBech32 which
// is tightly coupled to Bitcoin addresses. We use a standalone implementation.

const BECH32M_CONST = 0x2bc830a3;
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32mPolymod(values: number[]): number {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
        const b = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) {
            chk ^= (b >> i) & 1 ? GEN[i] : 0;
        }
    }
    return chk;
}

function bech32mHrpExpand(hrp: string): number[] {
    const ret: number[] = [];
    for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
    ret.push(0);
    for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
    return ret;
}

function bech32mCreateChecksum(hrp: string, data: number[]): number[] {
    const values = [...bech32mHrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
    const polymod = bech32mPolymod(values) ^ BECH32M_CONST;
    const ret: number[] = [];
    for (let i = 0; i < 6; i++) ret.push((polymod >> (5 * (5 - i))) & 31);
    return ret;
}

function bech32mVerifyChecksum(hrp: string, data: number[]): boolean {
    return bech32mPolymod([...bech32mHrpExpand(hrp), ...data]) === BECH32M_CONST;
}

function bech32mEncode(hrp: string, data: number[]): string {
    const checksum = bech32mCreateChecksum(hrp, data);
    const combined = [...data, ...checksum];
    let encoded = hrp + '1';
    for (const d of combined) encoded += CHARSET[d];
    return encoded;
}

function bech32mDecode(str: string): { hrp: string; words: number[] } {
    const lower = str.toLowerCase();
    const pos = lower.lastIndexOf('1');
    if (pos < 1 || pos + 7 > lower.length) throw new Error('Invalid bech32m string');
    const hrp = lower.slice(0, pos);
    const dataChars = lower.slice(pos + 1);
    const data: number[] = [];
    for (const c of dataChars) {
        const idx = CHARSET.indexOf(c);
        if (idx === -1) throw new Error(`Invalid bech32m character: ${c}`);
        data.push(idx);
    }
    if (!bech32mVerifyChecksum(hrp, data)) throw new Error('Invalid bech32m checksum');
    return { hrp, words: data.slice(0, -6) }; // strip checksum
}

function bech32mConvertBits(data: Buffer | number[], fromBits: number, toBits: number, pad: boolean): number[] {
    let acc = 0;
    let bits = 0;
    const ret: number[] = [];
    const maxv = (1 << toBits) - 1;
    for (const value of data) {
        if (value < 0 || value >> fromBits !== 0) throw new Error('Invalid value');
        acc = (acc << fromBits) | value;
        bits += fromBits;
        while (bits >= toBits) {
            bits -= toBits;
            ret.push((acc >> bits) & maxv);
        }
    }
    if (pad) {
        if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
    } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
        throw new Error('Invalid padding');
    }
    return ret;
}

// ── 3. BIP-352 ECDH Output Derivation (Sender Side) ──

/**
 * Smallest outpoint from a set of input outpoints (BIP-352 §5.1).
 * Outpoints are sorted lexicographically (txid:vout as bytes).
 */
function smallestOutpoint(outpoints: { txid: string; vout: number }[]): Buffer {
    const serialized = outpoints.map(o => {
        // txid is in display order (big-endian) — reverse to little-endian
        const txidLE = Buffer.from(o.txid, 'hex').reverse();
        const voutBuf = Buffer.alloc(4);
        voutBuf.writeUInt32LE(o.vout);
        return Buffer.concat([txidLE, voutBuf]);
    });
    serialized.sort((a, b) => a.compare(b));
    return serialized[0];
}

/**
 * Derive a BIP-352 output address for sending to an sp1 address.
 *
 * A_sum      = sum of all input pubkeys (here just one: signing_key · G)
 * input_hash = tagged_hash("BIP0352/Inputs", smallest_outpoint || A_sum)
 * ecdh       = (input_hash · signing_key) · ScanPub
 * t_0        = tagged_hash("BIP0352/SharedSecret", ser_P(ecdh) || ser_32(0))
 * output_pub = SpendPub + t_0 · G
 * output_addr = P2TR(x_only(output_pub))
 */
export function deriveOutputForSp1(
    signingKeyHex: string,
    recipientScanPub: Buffer,
    recipientSpendPub: Buffer,
    outpoints: { txid: string; vout: number }[],
): Sp1Output {
    bitcoin.initEccLib(ecc);

    // A = signing_key · G (compressed)
    const A = Buffer.from(ecc.pointFromScalar(hexToBytes(signingKeyHex))!);

    // input_hash = tagged_hash("BIP0352/Inputs", smallest_outpoint || A)
    const smallest = smallestOutpoint(outpoints);
    const inputHashData = Buffer.concat([smallest, A]);
    const inputHash = taggedHash('BIP0352/Inputs', inputHashData);

    // ecdh_secret = (input_hash · signing_key) · ScanPub
    // First: scalar = (input_hash * signing_key) mod n
    const inputHashBig = BigInt('0x' + bytesToHex(inputHash));
    const signingKeyBig = BigInt('0x' + signingKeyHex);
    const ecdhScalar = ((inputHashBig * signingKeyBig) % SECP256K1_N)
        .toString(16).padStart(64, '0');

    // Then: shared_secret_point = ecdhScalar · ScanPub
    const sharedSecretPoint = ecc.pointMultiply(recipientScanPub, hexToBytes(ecdhScalar));
    if (!sharedSecretPoint) throw new Error('ECDH failed: pointMultiply returned null');

    // t_0 = tagged_hash("BIP0352/SharedSecret", ser_P(shared_secret) || ser_32(0))
    const ser32_0 = Buffer.alloc(4);
    ser32_0.writeUInt32BE(0);
    const tweakData = Buffer.concat([Buffer.from(sharedSecretPoint), ser32_0]);
    const t0 = taggedHash('BIP0352/SharedSecret', tweakData);
    const tweakHex = bytesToHex(t0);

    // output_pub = SpendPub + t_0 · G
    const tweakPoint = ecc.pointFromScalar(t0);
    if (!tweakPoint) throw new Error('Invalid tweak scalar');

    const outputPub = ecc.pointAdd(recipientSpendPub, tweakPoint);
    if (!outputPub) throw new Error('Output point addition failed');

    // BIP-352: the derived point IS the Taproot output key directly.
    // Encode as a P2TR witness program (OP_1 <32-byte-x-only>) WITHOUT
    // applying an additional TapTweak — the candidate is the output key, not
    // the internal key.
    const xOnly = Buffer.from(outputPub).slice(1); // 32-byte x-only
    const address = bitcoin.address.toBech32(xOnly, 1, bitcoin.networks.bitcoin.bech32);
    if (!address) throw new Error('Failed to encode P2TR output address');

    return { outputAddress: address, tweak: tweakHex };
}

// ── 4. Manual txid Verification (Receive Fallback) ──

/**
 * Fetch a full Bitcoin transaction from mempool.space and extract
 * the sender's input public keys from witness data.
 */
async function fetchTxWithWitness(txid: string): Promise<{
    inputs: { pubkey: Buffer; outpoint: { txid: string; vout: number } }[];
    outputs: { address: string; value: number }[];
}> {
    const resp = await fetch(`https://mempool.space/api/tx/${txid}`);
    if (!resp.ok) throw new Error(`Failed to fetch tx: ${resp.statusText}`);
    const tx = await resp.json();

    const inputs: { pubkey: Buffer; outpoint: { txid: string; vout: number } }[] = [];
    for (const vin of tx.vin) {
        const outpoint = { txid: vin.txid, vout: vin.vout };
        // Taproot input: witness has the signature (64 or 65 bytes) and sometimes
        // a script path. For key-path spends, the pubkey is in the UTXO's
        // scriptpubkey_address (x-only), recoverable from prevout.
        if (vin.prevout?.scriptpubkey_type === 'v1_p2tr') {
            // x-only pubkey from the Taproot output being spent
            const scriptHex = vin.prevout.scriptpubkey as string;
            // v1 witness program: OP_1 OP_PUSH32 <32-byte-x-only>
            const xOnly = Buffer.from(scriptHex.slice(4), 'hex'); // skip 5120 prefix
            const compressed = Buffer.concat([Buffer.from([0x02]), xOnly]);
            inputs.push({ pubkey: compressed, outpoint });
        } else if (vin.prevout?.scriptpubkey_type === 'v0_p2wpkh') {
            // SegWit v0: witness = [signature, pubkey]
            const witness = vin.witness as string[];
            if (witness && witness.length >= 2) {
                const pubkey = Buffer.from(witness[1], 'hex');
                if (pubkey.length === 33) {
                    inputs.push({ pubkey, outpoint });
                }
            }
        }
    }

    const outputs: { address: string; value: number }[] = [];
    for (const vout of tx.vout) {
        if (vout.scriptpubkey_address) {
            outputs.push({ address: vout.scriptpubkey_address, value: vout.value });
        }
    }

    return { inputs, outputs };
}

/**
 * Verify if a transaction contains an output destined for the recipient's sp1 address.
 *
 * BIP-352 scanning procedure:
 *   A_sum      = sum of all eligible input pubkeys
 *   input_hash = tagged_hash("BIP0352/Inputs", smallest_outpoint || A_sum)
 *   ecdh       = (input_hash · scan_priv) · A_sum
 *   t_k        = tagged_hash("BIP0352/SharedSecret", ser_P(ecdh) || ser_32(k))
 *   candidate  = SpendPub + t_k · G
 *   → check if any Taproot output matches candidate (x-only)
 */
export async function verifyTxOwnership(
    scanPrivHex: string,
    spendPub: Buffer,
    txid: string,
): Promise<Sp1VerifyResult> {
    bitcoin.initEccLib(ecc);

    let txData;
    try {
        txData = await fetchTxWithWitness(txid);
    } catch (e) {
        console.error('[SP1] Failed to fetch tx:', e);
        return { owned: false };
    }

    console.log('[SP1] Inputs extracted:', txData.inputs.length, txData.inputs.map(i => ({
        type: i.pubkey.toString('hex').slice(0, 6) + '...',
        outpoint: i.outpoint.txid.slice(0, 8) + ':' + i.outpoint.vout,
    })));
    console.log('[SP1] Outputs:', txData.outputs.map(o => ({
        addr: o.address.slice(0, 12) + '...',
        value: o.value,
    })));

    if (txData.inputs.length === 0) {
        console.warn('[SP1] No recoverable input pubkeys in tx');
        return { owned: false };
    }

    // ── BIP-352 §5.1: Sum ALL eligible input pubkeys (no dedup!) ──
    let summedPubkey: Uint8Array | null = txData.inputs[0].pubkey;
    for (let i = 1; i < txData.inputs.length; i++) {
        summedPubkey = ecc.pointAdd(summedPubkey!, txData.inputs[i].pubkey);
        if (!summedPubkey) {
            console.warn('[SP1] Input pubkey summation resulted in point at infinity');
            return { owned: false };
        }
    }
    if (!summedPubkey) return { owned: false };

    const A_sum = Buffer.from(summedPubkey);
    console.log('[SP1] A_sum:', A_sum.toString('hex'));

    // Compute smallest outpoint
    const outpoints = txData.inputs.map(i => i.outpoint);
    const smallest = smallestOutpoint(outpoints);
    console.log('[SP1] Smallest outpoint:', smallest.toString('hex'));

    try {
        // ── input_hash = tagged_hash("BIP0352/Inputs", smallest_outpoint || A_sum) ──
        const inputHashData = Buffer.concat([smallest, A_sum]);
        const inputHash = taggedHash('BIP0352/Inputs', inputHashData);
        console.log('[SP1] input_hash:', bytesToHex(inputHash));

        // ── scalar = (input_hash * scan_priv) mod n ──
        const inputHashBig = BigInt('0x' + bytesToHex(inputHash));
        const scanPrivBig = BigInt('0x' + scanPrivHex);
        const ecdhScalar = ((inputHashBig * scanPrivBig) % SECP256K1_N)
            .toString(16).padStart(64, '0');

        // ── shared_secret_point = ecdhScalar · A_sum ──
        const sharedSecretPoint = ecc.pointMultiply(A_sum, hexToBytes(ecdhScalar));
        if (!sharedSecretPoint) {
            console.warn('[SP1] ECDH point multiply returned null');
            return { owned: false };
        }
        console.log('[SP1] ECDH shared secret:', bytesToHex(new Uint8Array(sharedSecretPoint)));

        // ── Scan outputs: try k = 0, 1, 2, ... ──
        const taprootOutputs = txData.outputs.filter(o =>
            o.address.startsWith('bc1p') && o.address.length === 62
        );
        if (taprootOutputs.length === 0) {
            console.warn('[SP1] No Taproot outputs found in tx');
            return { owned: false };
        }

        // Build output key lookup from bc1p addresses
        const outputsByXOnly = new Map<string, { address: string; value: number }>();
        for (const out of taprootOutputs) {
            try {
                const decoded = bitcoin.address.fromBech32(out.address);
                // decoded.data is Uint8Array — wrap in Buffer for proper hex encoding
                const xOnlyHex = Buffer.from(decoded.data).toString('hex');
                outputsByXOnly.set(xOnlyHex, out);
            } catch {}
        }

        console.log('[SP1] Taproot output x-only keys:', Array.from(outputsByXOnly.keys()));
        console.log('[SP1] SpendPub:', spendPub.toString('hex'));

        const maxK = taprootOutputs.length;
        for (let k = 0; k < maxK; k++) {
            // t_k = tagged_hash("BIP0352/SharedSecret", ser_P(ecdh) || ser_32(k))
            const ser32_k = Buffer.alloc(4);
            ser32_k.writeUInt32BE(k);
            const tweakData = Buffer.concat([Buffer.from(sharedSecretPoint), ser32_k]);
            const t_k = taggedHash('BIP0352/SharedSecret', tweakData);
            const tweakHex = bytesToHex(t_k);

            const tweakPoint = ecc.pointFromScalar(t_k);
            if (!tweakPoint) continue;

            const candidatePub = ecc.pointAdd(spendPub, tweakPoint);
            if (!candidatePub) continue;

            const candidateXOnly = Buffer.from(candidatePub).slice(1).toString('hex');
            console.log(`[SP1] k=${k} candidate x-only: ${candidateXOnly}`);

            // BIP-352: candidate IS the output key (no TapTweak).
            // Match directly against the x-only keys in the transaction outputs.
            const matchedOutput = outputsByXOnly.get(candidateXOnly);
            if (matchedOutput) {
                console.log('[SP1] ✓ Match found at k=' + k);
                return { owned: true, tweak: tweakHex, address: matchedOutput.address, amount: matchedOutput.value };
            }
        }

        console.warn('[SP1] No candidate matched any output');
    } catch (e) {
        console.warn('[SP1] BIP-352 verification failed:', e);
    }

    return { owned: false };
}
