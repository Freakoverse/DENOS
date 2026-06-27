/**
 * NIP-NMS — Phase 6: multisig PSBT engine (build → sign → combine → finalize).
 *
 * Propose-once / sign-many: the proposer freezes inputs/outputs/fee into a PSBT; every
 * member signs that exact PSBT (partial sigs combine in any order); once the threshold is
 * met, anyone finalizes and broadcasts.
 *
 * Each input carries BIP32 derivation for every cosigner, so signing is self-describing
 * (and the PSBT is portable to external signers like Sparrow).
 */
import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';
import { HDKey } from '@scure/bip32';
import { getECPair } from './bitcoin';
import { multisigPaymentForIndex, NMS_DERIVATION_PATH } from './nmsWallet';

export interface DescriptorKeyFull {
    xpub: string;
    fingerprint: string;
}

export interface SpendableUtxo {
    txid: string;
    vout: number;
    value: number; // sats
    chain: 0 | 1;
    index: number;
}

const NETWORK = bitcoin.networks.bitcoin;

/** Build the canonical unsigned PSBT for a spend. */
export function buildMultisigPsbt(params: {
    keys: DescriptorKeyFull[];
    m: number;
    utxos: SpendableUtxo[];
    recipient: string;
    amountSats: number;
    feeSats: number;
    changeAddress: string;
    network?: bitcoin.Network;
}): { psbtBase64: string; fee: number; change: number } {
    const network = params.network ?? NETWORK;
    const psbt = new bitcoin.Psbt({ network });

    let totalIn = 0;
    for (const u of params.utxos) {
        const pay = multisigPaymentForIndex(params.keys, params.m, u.chain, u.index, network);
        const bip32Derivation = params.keys.map(k => {
            const node = HDKey.fromExtendedKey(k.xpub).deriveChild(u.chain).deriveChild(u.index);
            if (!node.publicKey) throw new Error('NMS: cannot derive input pubkey');
            return {
                masterFingerprint: Buffer.from(/^[0-9a-fA-F]{8}$/.test(k.fingerprint) ? k.fingerprint : '00000000', 'hex'),
                pubkey: Buffer.from(node.publicKey),
                path: `${NMS_DERIVATION_PATH}/${u.chain}/${u.index}`,
            };
        });
        psbt.addInput({
            hash: u.txid,
            index: u.vout,
            witnessUtxo: { script: pay.output, value: BigInt(u.value) },
            witnessScript: pay.witnessScript,
            bip32Derivation,
        });
        totalIn += u.value;
    }

    const change = totalIn - params.amountSats - params.feeSats;
    if (change < 0) throw new Error(`Insufficient funds: need ${params.amountSats + params.feeSats} sats, have ${totalIn}`);

    psbt.addOutput({ address: params.recipient, value: BigInt(params.amountSats) });
    const hasChange = change > 546; // dust
    if (hasChange) psbt.addOutput({ address: params.changeAddress, value: BigInt(change) });

    return { psbtBase64: psbt.toBase64(), fee: params.feeSats, change: hasChange ? change : 0 };
}

/**
 * Sign every input this member is a cosigner of, identified by matching their master
 * fingerprint in the input's BIP32 derivation. Returns the updated PSBT (base64).
 */
export function signMultisigPsbt(
    psbtBase64: string,
    accountNode: HDKey,
    myFingerprint: string,
    network: bitcoin.Network = NETWORK,
): string {
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network });
    const fp = (myFingerprint || '').toLowerCase();
    psbt.data.inputs.forEach((inp, i) => {
        const der = inp.bip32Derivation?.find(d => Buffer.from(d.masterFingerprint).toString('hex').toLowerCase() === fp);
        if (!der) return;
        const parts = der.path.split('/');
        const index = parseInt(parts[parts.length - 1], 10);
        const chain = parseInt(parts[parts.length - 2], 10);
        const node = accountNode.deriveChild(chain).deriveChild(index);
        if (!node.privateKey) return;
        const signer = getECPair().fromPrivateKey(Buffer.from(node.privateKey));
        psbt.signInput(i, signer);
    });
    return psbt.toBase64();
}

/** Combine partial signatures from several copies of the same PSBT into one. */
export function combinePsbts(base64s: string[], network: bitcoin.Network = NETWORK): string {
    const psbts = base64s.map(b => bitcoin.Psbt.fromBase64(b, { network }));
    const [first, ...rest] = psbts;
    if (rest.length) first.combine(...rest);
    return first.toBase64();
}

/** Minimum number of partial signatures present across all inputs (the safe threshold tally). */
export function countSignatures(psbtBase64: string, network: bitcoin.Network = NETWORK): number {
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network });
    if (psbt.data.inputs.length === 0) return 0;
    return psbt.data.inputs.reduce((min, inp) => Math.min(min, inp.partialSig?.length ?? 0), Infinity);
}

/** Attempt to finalize + extract. Returns the raw tx hex when the threshold is met. */
export function finalizeMultisigPsbt(psbtBase64: string, network: bitcoin.Network = NETWORK): { complete: boolean; txHex?: string } {
    const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network });
    try {
        psbt.finalizeAllInputs();
        return { complete: true, txHex: psbt.extractTransaction().toHex() };
    } catch {
        return { complete: false };
    }
}

/** Rough vbyte estimate for a P2WSH M-of-N spend, for fee calculation. */
export function estimateVbytes(inputCount: number, outputCount: number, m: number, n: number): number {
    // witness: m sigs (~73 wu each) + witnessScript (~ n*34 + a few) → /4 for vbytes
    const witnessPerInput = (m * 73 + n * 34 + 10) / 4;
    const inputBase = 41; // outpoint + sequence + empty scriptSig
    const outputSize = 31; // P2WSH/P2WPKH outputs ~31-43; use 31
    return Math.ceil(10 + inputCount * (inputBase + witnessPerInput) + outputCount * outputSize);
}
