import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';
import { ECPairFactory, type ECPairAPI } from 'ecpair';
import { Buffer } from 'buffer';
import { nip19 } from 'nostr-tools';

// Make Buffer available globally for bitcoinjs-lib
if (typeof window !== 'undefined' && !(window as any).Buffer) {
    (window as any).Buffer = Buffer;
}

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
            lastError = new Error(`${baseUrl}: HTTP ${res.status}`);
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

export async function createBitcoinTransaction(
    privateKeyHex: string,
    toAddress: string,
    amountSats: number,
    utxos: UTXO[],
    feeRate: number
): Promise<{ txHex: string; fee: number }> {
    const privateKeyBuffer = Buffer.from(privateKeyHex, 'hex');
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

// ── Helpers ──

export function satsToBTC(sats: number): string {
    return (sats / 100_000_000).toFixed(8);
}

export function btcToSats(btc: number): number {
    return Math.round(btc * 100_000_000);
}

export type AddressType = 'native' | 'taproot';
