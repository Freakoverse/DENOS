import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { ECPairFactory, type ECPairAPI } from 'ecpair';
import { Buffer } from 'buffer';
import { nip19 } from 'nostr-tools';

// Make Buffer available globally for bitcoinjs-lib
if (typeof window !== 'undefined' && !(window as any).Buffer) {
    (window as any).Buffer = Buffer;
}

/** BIP125 opt-in Replace-By-Fee: marks every input replaceable so a low-fee tx can be
 *  fee-bumped instead of getting stuck. 0xffffffff disables RBF (and locktime); any value
 *  ≤ 0xfffffffd opts in. Locktime stays 0, so the tx is still immediately final. */
const RBF_SEQUENCE = 0xfffffffd;

// Lazy initialization
let ECPair: ECPairAPI | null = null;

export function getECPair(): ECPairAPI {
    if (!ECPair) {
        bitcoin.initEccLib(ecc);
        ECPair = ECPairFactory(ecc);
    }
    return ECPair;
}

// ── Bitcoin Node Management ──

const STORAGE_KEY = 'denos-bitcoin-nodes';

const DEFAULT_BITCOIN_NODES = [
    'https://blockstream.info/api',
    'https://mempool.space/api',
    'https://mempool.emzy.de/api',
];

export const bitcoinNodes = {
    getNodes(): string[] {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed) && parsed.length > 0) return parsed;
            }
        } catch { }
        return [...DEFAULT_BITCOIN_NODES];
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
            const res = await fetch(`${url}/blocks/tip/height`, { signal: AbortSignal.timeout(5000) });
            return res.ok;
        } catch {
            return false;
        }
    },

    getDefaultNodes(): string[] {
        return [...DEFAULT_BITCOIN_NODES];
    },
};

/**
 * Fetch from the first healthy Bitcoin node, falling back to the next on failure.
 */
async function fetchWithFallback(path: string, options?: RequestInit): Promise<Response> {
    const nodes = bitcoinNodes.getNodes();
    let lastError: Error | null = null;

    for (const baseUrl of nodes) {
        try {
            const res = await fetch(`${baseUrl}${path}`, options);
            if (res.ok) return res;
            // Read the error body for better diagnostics (e.g. broadcast rejections)
            let errorDetail = '';
            try { errorDetail = await res.text(); } catch { }
            lastError = new Error(
                errorDetail
                    ? `${baseUrl}: HTTP ${res.status} — ${errorDetail.slice(0, 200)}`
                    : `${baseUrl}: HTTP ${res.status}`
            );
        } catch (e: any) {
            lastError = e;
        }
    }

    throw lastError || new Error('All Bitcoin nodes failed');
}

// ── Address derivation ──

export function privateKeyToBitcoinAddress(privateKeyHex: string): string {
    try {
        const privateKeyBuffer = Buffer.from(privateKeyHex, 'hex');
        const keyPair = getECPair().fromPrivateKey(privateKeyBuffer);
        const { address } = bitcoin.payments.p2wpkh({
            pubkey: keyPair.publicKey,
            network: bitcoin.networks.bitcoin,
        });
        return address || '';
    } catch (error) {
        console.error('Error deriving P2WPKH address:', error);
        return '';
    }
}

// ── Key parity ──
//
// A secp256k1 x-coordinate has TWO valid y values, and a Nostr pubkey is x-only. So one key
// yields two distinct P2WPKH addresses: `02||x` (spendable by `d`) and `03||x` (spendable by
// `n - d`). Negating the scalar flips y-parity while preserving x. Signing an input with the
// wrong parity produces a valid-looking but unspendable transaction, so anything that spends
// P2WPKH must select the parity that actually controls the address being spent.

const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

/** The counterpart key: same x-coordinate, opposite y-parity. */
export function negatePrivateKey(privateKeyHex: string): string {
    const d = BigInt('0x' + privateKeyHex);
    return (SECP256K1_N - d).toString(16).padStart(64, '0');
}

/** Both P2WPKH addresses reachable from one key, tagged by which one is the natural parity. */
export function bothSegwitAddresses(privateKeyHex: string): {
    natural: string;
    alternate: string;
    naturalIsEven: boolean;
} {
    const keyPair = getECPair().fromPrivateKey(Buffer.from(privateKeyHex, 'hex'));
    return {
        natural: privateKeyToBitcoinAddress(privateKeyHex),
        alternate: privateKeyToBitcoinAddress(negatePrivateKey(privateKeyHex)),
        naturalIsEven: keyPair.publicKey[0] === 0x02,
    };
}

/**
 * The two P2WPKH addresses keyed by y-parity rather than by "whichever this key happened to
 * produce". Parity is the stable, npub-derivable framing — anyone can compute both `02||x` and
 * `03||x` from a pubkey — whereas which one is *natural* depends on the raw stored scalar and
 * cannot be determined from the npub. Presenting by parity keeps DENOS aligned with other
 * wallets; `naturalIsEven` is surfaced purely as a label.
 */
export function segwitAddressesByParity(privateKeyHex: string): {
    even: string;
    odd: string;
    naturalIsEven: boolean;
} {
    const { natural, alternate, naturalIsEven } = bothSegwitAddresses(privateKeyHex);
    return {
        even: naturalIsEven ? natural : alternate,
        odd: naturalIsEven ? alternate : natural,
        naturalIsEven,
    };
}

/** The private key controlling the even-y (`02||x`) or odd-y (`03||x`) P2WPKH address. */
export function segwitKeyForParity(privateKeyHex: string, parity: 'even' | 'odd'): string {
    const keyPair = getECPair().fromPrivateKey(Buffer.from(privateKeyHex, 'hex'));
    const naturalIsEven = keyPair.publicKey[0] === 0x02;
    return (parity === 'even') === naturalIsEven ? privateKeyHex : negatePrivateKey(privateKeyHex);
}

/**
 * Pick whichever of (d, n - d) actually controls `address`.
 *
 * Fails closed: throws if neither parity matches, rather than signing with a key that cannot
 * spend the input (which would yield a transaction the network rejects, or worse, change sent
 * to an address the user does not control).
 */
export function segwitKeyForAddress(privateKeyHex: string, address: string): string {
    for (const candidate of [privateKeyHex, negatePrivateKey(privateKeyHex)]) {
        if (privateKeyToBitcoinAddress(candidate) === address) return candidate;
    }
    throw new Error(`Neither key parity controls ${address} — refusing to sign`);
}

export function privateKeyToTaprootAddress(privateKeyHex: string): string {
    try {
        const privateKeyBuffer = Buffer.from(privateKeyHex, 'hex');
        const keyPair = getECPair().fromPrivateKey(privateKeyBuffer);
        const internalPubkey = keyPair.publicKey.slice(1, 33);
        const { address } = bitcoin.payments.p2tr({
            internalPubkey,
            network: bitcoin.networks.bitcoin,
        });
        return address || '';
    } catch (error) {
        console.error('Error deriving Taproot address:', error);
        return '';
    }
}

/**
 * Convert npub to Bitcoin Taproot (P2TR) address.
 * Preferred for social sending — deterministic from npub.
 */
export function npubToTaprootAddress(npub: string): string {
    try {
        const decoded = nip19.decode(npub);
        if (decoded.type !== 'npub') throw new Error('Invalid npub format');
        const pubkeyHex = decoded.data as string;
        const pubkeyBuffer = Buffer.from(pubkeyHex, 'hex');
        const { address } = bitcoin.payments.p2tr({
            internalPubkey: pubkeyBuffer,
            network: bitcoin.networks.bitcoin,
        });
        return address || '';
    } catch (error) {
        console.error('Error converting npub to Taproot address:', error);
        throw error;
    }
}

// ── UTXO / Balance ──

export interface UTXO {
    txid: string;
    vout: number;
    value: number;
    status: {
        confirmed: boolean;
        block_height?: number;
        block_hash?: string;
        block_time?: number;
    };
}

export async function fetchUTXOs(address: string): Promise<UTXO[]> {
    const res = await fetchWithFallback(`/address/${address}/utxo`);
    return res.json();
}

// ── Fee estimates ──

export interface FeeRates {
    fastestFee: number;
    halfHourFee: number;
    hourFee: number;
    economyFee: number;
    minimumFee: number;
}

export async function getFeeRates(): Promise<FeeRates> {
    const res = await fetchWithFallback('/fee-estimates');
    const data = await res.json();
    return {
        fastestFee: Math.ceil(data['1'] || 1),
        halfHourFee: Math.ceil(data['3'] || 1),
        hourFee: Math.ceil(data['6'] || 1),
        economyFee: Math.ceil(data['144'] || 1),
        minimumFee: Math.ceil(data['504'] || 1),
    };
}

// ── Transaction history ──

export interface TxHistory {
    txid: string;
    fee: number;
    vin: any[];
    vout: any[];
    status: {
        confirmed: boolean;
        block_height?: number;
        block_hash?: string;
        block_time?: number;
    };
}

export async function fetchTxHistory(address: string): Promise<TxHistory[]> {
    const res = await fetchWithFallback(`/address/${address}/txs`);
    return res.json();
}

// ── Broadcast ──

export async function broadcastTransaction(txHex: string): Promise<string> {
    const res = await fetchWithFallback('/tx', {
        method: 'POST',
        body: txHex,
    });
    return res.text();
}

// ── Transaction creation ──

/**
 * Spend from a single P2WPKH address.
 *
 * `fromAddress` is the address the UTXOs actually sit on. When supplied, the signing key is
 * chosen by matching parity against it (see {@link segwitKeyForAddress}) so either of the two
 * addresses a key maps to can be spent; it also becomes the change address. When omitted the
 * natural parity is used, matching {@link privateKeyToBitcoinAddress}.
 */
export async function createBitcoinTransaction(
    privateKeyHex: string,
    toAddress: string,
    amountSats: number,
    utxos: UTXO[],
    feeRate: number,
    fromAddress?: string
): Promise<{ txHex: string; fee: number }> {
    const signingKeyHex = fromAddress ? segwitKeyForAddress(privateKeyHex, fromAddress) : privateKeyHex;
    const privateKeyBuffer = Buffer.from(signingKeyHex, 'hex');
    const keyPair = getECPair().fromPrivateKey(privateKeyBuffer);
    const compressedPubkey = keyPair.publicKey;

    const { address: changeAddress, output: changeOutput } = bitcoin.payments.p2wpkh({
        pubkey: compressedPubkey,
        network: bitcoin.networks.bitcoin,
    });

    if (!changeAddress || !changeOutput) throw new Error('Failed to generate change address');

    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });

    let totalInput = 0;
    for (const utxo of utxos) {
        psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
                script: changeOutput,
                value: BigInt(utxo.value),
            },
            sequence: RBF_SEQUENCE,
        });
        totalInput += utxo.value;
    }

    const estimatedSize = utxos.length * 68 + 2 * 31 + 10.5;
    const estimatedFee = Math.ceil(estimatedSize * feeRate);
    const change = totalInput - amountSats - estimatedFee;

    if (change < 0) {
        throw new Error(`Insufficient funds. Need ${amountSats + estimatedFee} sats, have ${totalInput} sats`);
    }

    psbt.addOutput({ address: toAddress, value: BigInt(amountSats) });

    if (change > 546) {
        psbt.addOutput({ address: changeAddress, value: BigInt(change) });
    }

    for (let i = 0; i < utxos.length; i++) {
        psbt.signInput(i, keyPair);
    }

    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    return { txHex: tx.toHex(), fee: estimatedFee };
}

export async function createTaprootTransaction(
    privateKeyHex: string,
    toAddress: string,
    amountSats: number,
    utxos: UTXO[],
    feeRate: number
): Promise<{ txHex: string; fee: number }> {
    const privateKeyBuffer = Buffer.from(privateKeyHex, 'hex');
    const keyPair = getECPair().fromPrivateKey(privateKeyBuffer);
    const internalPubkey = keyPair.publicKey.slice(1, 33);

    const { address: changeAddress, output: changeOutput } = bitcoin.payments.p2tr({
        internalPubkey,
        network: bitcoin.networks.bitcoin,
    });

    if (!changeAddress || !changeOutput) throw new Error('Failed to generate Taproot change address');

    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });

    let totalInput = 0;
    for (const utxo of utxos) {
        psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
                script: changeOutput,
                value: BigInt(utxo.value),
            },
            tapInternalKey: internalPubkey,
            sequence: RBF_SEQUENCE,
        });
        totalInput += utxo.value;
    }

    const estimatedSize = utxos.length * 57.5 + 2 * 43 + 10.5;
    const estimatedFee = Math.ceil(estimatedSize * feeRate);
    const change = totalInput - amountSats - estimatedFee;

    if (change < 0) {
        throw new Error(`Insufficient funds. Need ${amountSats + estimatedFee} sats, have ${totalInput} sats`);
    }

    psbt.addOutput({ address: toAddress, value: BigInt(amountSats) });

    if (change > 546) {
        psbt.addOutput({ address: changeAddress, value: BigInt(change) });
    }

    const tweakedSigner = keyPair.tweak(
        bitcoin.crypto.taggedHash('TapTweak', internalPubkey)
    );

    for (let i = 0; i < utxos.length; i++) {
        psbt.signInput(i, tweakedSigner);
    }

    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    return { txHex: tx.toHex(), fee: estimatedFee };
}

/**
 * Build a P2WPKH (native SegWit) transaction from UTXOs spread across multiple addresses, each
 * with its own key — the SegWit counterpart of {@link createMultiKeyTaprootTransaction}, used to
 * spend NSP payments received on native-SegWit addresses.
 *
 * Each entry's key parity is resolved against its own address, and the derived script is checked
 * against that address, so a mismatch throws rather than producing an unspendable transaction.
 * Change returns to the first input's address.
 */
export async function createMultiKeySegwitTransaction(
    taggedUtxos: { utxo: UTXO; privateKeyHex: string; address: string }[],
    toAddress: string,
    amountSats: number,
    feeRate: number
): Promise<{ txHex: string; fee: number }> {
    if (taggedUtxos.length === 0) throw new Error('No UTXOs provided');

    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });
    const signers: ReturnType<ReturnType<typeof getECPair>['fromPrivateKey']>[] = [];

    let totalInput = 0;
    for (const { utxo, privateKeyHex, address } of taggedUtxos) {
        // Fails closed if neither parity controls this address.
        const keyHex = segwitKeyForAddress(privateKeyHex, address);
        const kp = getECPair().fromPrivateKey(Buffer.from(keyHex, 'hex'));
        const { address: derived, output } = bitcoin.payments.p2wpkh({
            pubkey: kp.publicKey,
            network: bitcoin.networks.bitcoin,
        });
        if (!output || derived !== address) {
            throw new Error(`Derived script does not match ${address} — refusing to sign`);
        }
        psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: { script: output, value: BigInt(utxo.value) },
            sequence: RBF_SEQUENCE,
        });
        totalInput += utxo.value;
        signers.push(kp);
    }

    const estimatedSize = taggedUtxos.length * 68 + 2 * 31 + 10.5;
    const estimatedFee = Math.ceil(estimatedSize * feeRate);
    const change = totalInput - amountSats - estimatedFee;

    if (change < 0) {
        throw new Error(`Insufficient funds. Need ${amountSats + estimatedFee} sats, have ${totalInput} sats`);
    }

    psbt.addOutput({ address: toAddress, value: BigInt(amountSats) });
    if (change > 546) {
        psbt.addOutput({ address: taggedUtxos[0].address, value: BigInt(change) });
    }

    signers.forEach((kp, i) => psbt.signInput(i, kp));

    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    return { txHex: tx.toHex(), fee: estimatedFee };
}

/**
 * Build a Taproot transaction using UTXOs from multiple addresses,
 * each signed with its own private key. HD-wallet-style coin selection.
 * Change is sent back to the first input address.
 */
export async function createMultiKeyTaprootTransaction(
    taggedUtxos: { utxo: UTXO; privateKeyHex: string }[],
    toAddress: string,
    amountSats: number,
    feeRate: number
): Promise<{ txHex: string; fee: number }> {
    if (taggedUtxos.length === 0) throw new Error('No UTXOs provided');

    const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });

    // Derive change address from the first key
    const firstKeyPair = getECPair().fromPrivateKey(Buffer.from(taggedUtxos[0].privateKeyHex, 'hex'));
    const firstInternalPub = firstKeyPair.publicKey.slice(1, 33);
    const { address: changeAddress } = bitcoin.payments.p2tr({
        internalPubkey: firstInternalPub,
        network: bitcoin.networks.bitcoin,
    });
    if (!changeAddress) throw new Error('Failed to derive change address');

    // Add all inputs
    let totalInput = 0;
    const signers: ReturnType<ReturnType<typeof getECPair>['fromPrivateKey']>[] = [];
    for (const { utxo, privateKeyHex } of taggedUtxos) {
        const kp = getECPair().fromPrivateKey(Buffer.from(privateKeyHex, 'hex'));
        const internalPub = kp.publicKey.slice(1, 33); // x-only

        const p2tr = bitcoin.payments.p2tr({
            internalPubkey: internalPub,
            network: bitcoin.networks.bitcoin,
        });
        if (!p2tr.output) throw new Error('Failed to derive output script');

        psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: { script: Buffer.from(p2tr.output), value: BigInt(utxo.value) },
            tapInternalKey: internalPub,
            sequence: RBF_SEQUENCE,
        });
        totalInput += utxo.value;
        signers.push(kp);
    }

    const estimatedSize = taggedUtxos.length * 57.5 + 2 * 43 + 10.5;
    const estimatedFee = Math.ceil(estimatedSize * feeRate);
    const change = totalInput - amountSats - estimatedFee;

    if (change < 0) {
        throw new Error(`Insufficient funds. Need ${amountSats + estimatedFee} sats, have ${totalInput} sats`);
    }

    psbt.addOutput({ address: toAddress, value: BigInt(amountSats) });
    if (change > 546) {
        psbt.addOutput({ address: changeAddress, value: BigInt(change) });
    }

    // Sign each input (standard Taproot key-path: apply TapTweak before signing)
    for (let i = 0; i < signers.length; i++) {
        const internalPub = signers[i].publicKey.slice(1, 33);
        const tweakedSigner = signers[i].tweak(
            bitcoin.crypto.taggedHash('TapTweak', internalPub)
        );
        psbt.signInput(i, tweakedSigner);
    }

    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    return { txHex: tx.toHex(), fee: estimatedFee };
}

// ── Helpers ──

export function satsToBTC(sats: number): string {
    return (sats / 100_000_000).toFixed(8);
}

export function btcToSats(btc: number): number {
    return Math.round(btc * 100_000_000);
}

export type AddressType = 'native' | 'taproot';
