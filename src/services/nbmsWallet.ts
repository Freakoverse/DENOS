/**
 * NIP-NBMS — Phase 4: cosigner key derivation.
 *
 * Each member contributes an xpub derived from their existing BIP39 seed using the group
 * secret H as the passphrase, on the BIP48 native-segwit P2WSH multisig path. The
 * passphrase isolates this key from the member's main wallet: the xpub reveals nothing
 * spendable without the underlying seed, and the main-account xpub is never exposed.
 *
 * Derivation lives in TS (next to the rest of the Bitcoin stack); the mnemonic is fetched
 * from the Rust keychain on demand via `export_seed_words`.
 */
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import * as bitcoin from 'bitcoinjs-lib';
import { Buffer } from 'buffer';

/** Versioned KDF context, so this derivation can never collide with another use of the
 *  nsec and can be revised in the future without breaking existing wallets. */
const NSEC_KDF_INFO = new TextEncoder().encode('nbms-cosigner-v1');

/** BIP48 path: purpose 48' / coin 0' (mainnet) / account 0' / script-type 2' (P2WSH native segwit). */
export const NBMS_DERIVATION_PATH = "m/48'/0'/0'/2'";

export interface DerivedCosignerKey {
    xpub: string;
    fingerprint: string; // master key fingerprint, 8 hex chars
    path: string;
}

/**
 * Derive the account-level cosigner xpub from a mnemonic + the group secret (hex) as the
 * BIP39 passphrase. Deterministic, so the wallet is always recoverable from seed + H.
 */
export function deriveCosignerXpub(mnemonic: string, passphraseHex: string): DerivedCosignerKey {
    const seed = mnemonicToSeedSync(mnemonic.trim(), passphraseHex);
    const root = HDKey.fromMasterSeed(seed);
    const node = root.derive(NBMS_DERIVATION_PATH);
    if (!node.publicExtendedKey) throw new Error('NBMS: xpub derivation failed');
    return {
        xpub: node.publicExtendedKey,
        fingerprint: root.fingerprint.toString(16).padStart(8, '0'),
        path: NBMS_DERIVATION_PATH,
    };
}

export interface DerivedCosignerKeyFromNsec extends DerivedCosignerKey {
    /** The fresh 24-word mnemonic, surfaced so the member can back it up independently. */
    mnemonic: string;
}

/** The nsec → fresh-mnemonic step (HKDF), shared by xpub and account-node derivation. */
function nsecToMnemonic(nsecHex: string, passphraseHex: string): string {
    const entropy = hkdf(sha256, hexToBytes(nsecHex), hexToBytes(passphraseHex), NSEC_KDF_INFO, 32);
    return entropyToMnemonic(entropy, wordlist);
}

/**
 * Derive a cosigner key for members who have only an nsec (no BIP39 seed). The nsec is run
 * through HKDF (never used directly as a Bitcoin key) with the group secret H as salt to
 * produce a fresh, deterministic 24-word mnemonic, then the standard BIP48 xpub.
 *
 * Recoverable two ways: regenerate from nsec + H, or back up the returned 24 words.
 * Note: for these members the nsec becomes a root for the funds — acceptable, since the
 * nsec is already their most sensitive secret and they have no separate seed.
 */
export function deriveCosignerXpubFromNsec(nsecHex: string, passphraseHex: string): DerivedCosignerKeyFromNsec {
    const mnemonic = nsecToMnemonic(nsecHex, passphraseHex);
    // H is already mixed into the entropy, so no additional BIP39 passphrase here.
    const { xpub, fingerprint, path } = deriveCosignerXpub(mnemonic, '');
    return { xpub, fingerprint, path, mnemonic };
}

/** Account-level HDKey (with private key) for signing — seed path: mnemonic + passphrase H. */
export function cosignerAccountFromSeed(mnemonic: string, passphraseHex: string): HDKey {
    const seed = mnemonicToSeedSync(mnemonic.trim(), passphraseHex);
    return HDKey.fromMasterSeed(seed).derive(NBMS_DERIVATION_PATH);
}

/** Account-level HDKey (with private key) for signing — nsec path: HKDF mnemonic, no passphrase. */
export function cosignerAccountFromNsec(nsecHex: string, passphraseHex: string): HDKey {
    const seed = mnemonicToSeedSync(nsecToMnemonic(nsecHex, passphraseHex), '');
    return HDKey.fromMasterSeed(seed).derive(NBMS_DERIVATION_PATH);
}

/** Loose validation of a pasted xpub (for the "imported" tab). */
export function isValidXpub(xpub: string): boolean {
    const v = xpub.trim();
    if (!/^(xpub|Ypub|Zpub|tpub|Upub|Vpub)[1-9A-HJ-NP-Za-km-z]{100,120}$/.test(v)) return false;
    try {
        HDKey.fromExtendedKey(v);
        return true;
    } catch {
        return false;
    }
}

/** Compute the fingerprint of an xpub node itself (fallback when origin is unknown). */
export function xpubFingerprint(xpub: string): string {
    try {
        return HDKey.fromExtendedKey(xpub.trim()).fingerprint.toString(16).padStart(8, '0');
    } catch {
        return '00000000';
    }
}

// ──────────────────────────────────────────────────────────────────────────
//  Multisig wallet construction — wsh(sortedmulti(M, ...))
// ──────────────────────────────────────────────────────────────────────────

export interface DescriptorKey {
    xpub: string;
    fingerprint: string;
}

export interface MultisigPayment {
    address: string;
    output: Buffer;        // P2WSH scriptPubKey
    witnessScript: Buffer; // the p2ms redeem script
}

/**
 * Build the P2WSH sorted-multisig payment for threshold `m`, chain (0 = receive,
 * 1 = change) and `index`. Pubkeys are derived from each cosigner's account xpub at
 * `/chain/index` and BIP67-sorted (sortedmulti), so all members derive identical scripts.
 */
export function multisigPaymentForIndex(
    keys: { xpub: string }[],
    m: number,
    chain: 0 | 1,
    index: number,
    network: bitcoin.Network = bitcoin.networks.bitcoin,
): MultisigPayment {
    const pubkeys = keys.map(k => {
        const node = HDKey.fromExtendedKey(k.xpub).deriveChild(chain).deriveChild(index);
        if (!node.publicKey) throw new Error('NBMS: cannot derive cosigner pubkey');
        return Buffer.from(node.publicKey);
    });
    pubkeys.sort((a, b) => a.compare(b)); // BIP67
    const p2ms = bitcoin.payments.p2ms({ m, pubkeys, network });
    const p2wsh = bitcoin.payments.p2wsh({ redeem: p2ms, network });
    if (!p2wsh.address || !p2wsh.output || !p2ms.output) throw new Error('NBMS: payment build failed');
    return { address: p2wsh.address, output: p2wsh.output as Buffer, witnessScript: p2ms.output as Buffer };
}

/** Convenience: just the address for a chain/index. */
export function deriveMultisigAddress(
    keys: { xpub: string }[],
    m: number,
    chain: 0 | 1,
    index: number,
    network: bitcoin.Network = bitcoin.networks.bitcoin,
): string {
    return multisigPaymentForIndex(keys, m, chain, index, network).address;
}

/**
 * Build a standard output descriptor for the wallet, with BIP-380 key origins and the
 * `<0;1>` multipath. Suitable for export to Sparrow / Bitcoin Core.
 */
export function buildDescriptor(keys: DescriptorKey[], m: number): string {
    const inner = keys.map(k => {
        const origin = k.fingerprint && k.fingerprint !== '00000000'
            ? `[${k.fingerprint}/48h/0h/0h/2h]`
            : '';
        return `${origin}${k.xpub}/<0;1>/*`;
    }).join(',');
    return `wsh(sortedmulti(${m},${inner}))`;
}
