/**
 * CashuService — Core Cashu eCash operations.
 * Port of PWANS services/cashu.ts adapted for DENOS (Tauri invoke for keys).
 */
import {
    CashuMint,
    CashuWallet,
    getDecodedToken,
    getEncodedTokenV4,
    type Proof as CashuProof,
    type MintKeys as CashuMintKeys,
    type MintKeyset,
    CheckStateEnum,
} from '@cashu/cashu-ts';
import { useEcashStore, type Proof } from './ecashStore';
import { nip19 } from 'nostr-tools';

// ── Mint cache ──
const mintCache = new Map<string, CashuMint>();
const walletCache = new Map<string, CashuWallet>();

export class CashuService {
    /**
     * Get or create a CashuMint instance.
     */
    static getMint(mintUrl: string): CashuMint {
        const normalizedUrl = mintUrl.replace(/\/$/, '');
        if (!mintCache.has(normalizedUrl)) {
            mintCache.set(normalizedUrl, new CashuMint(normalizedUrl));
        }
        return mintCache.get(normalizedUrl)!;
    }

    /**
     * Get an initialized CashuWallet with proper keysets.
     */
    static async getInitializedWallet(mintUrl: string): Promise<CashuWallet> {
        const normalizedUrl = mintUrl.replace(/\/$/, '');
        if (walletCache.has(normalizedUrl)) {
            return walletCache.get(normalizedUrl)!;
        }

        const mint = this.getMint(normalizedUrl);

        // Fetch keyset metadata (for fee rates, active status)
        const { keysets } = await mint.getKeySets();

        // Fetch actual keys (amount → pubkey mappings) — required for mintProofs/swap
        const keys = await mint.getKeys();

        // Patch: some mints don't return active:true
        const patchedKeysets = keysets.map((ks: MintKeyset) => ({
            ...ks,
            active: ks.active !== false
        }));

        const wallet = new CashuWallet(mint, {
            keys: keys.keysets as any,
            keysets: patchedKeysets as any,
            unit: 'sat'
        });
        walletCache.set(normalizedUrl, wallet);
        return wallet;
    }

    /**
     * Load mint keys and store them.
     */
    static async loadMint(mintUrl: string): Promise<CashuMintKeys> {
        const normalizedUrl = mintUrl.replace(/\/$/, '');
        const mint = this.getMint(normalizedUrl);
        const { keysets } = await mint.getKeySets();
        const keys = await mint.getKeys();

        const mintKeys = {
            keysets,
            ...Object.fromEntries(keys.keysets.map(k => [k.id, k]))
        };

        useEcashStore.getState().addMint(normalizedUrl, mintKeys);
        return keys as any;
    }

    /**
     * Receive a Cashu token — decode, claim proofs, auto-relock unlocked proofs.
     */
    static async receiveToken(tokenStr: string): Promise<{
        amount: number;
        mint: string;
        proofs: Proof[];
    }> {
        console.log('📥 Receiving token...');

        // Decode token — handle V3 (cashuA), V4 (cashuB), or raw JSON
        let decoded: any;
        const trimmed = tokenStr.trim();

        if (trimmed.startsWith('cashuA') || trimmed.startsWith('cashuB')) {
            decoded = getDecodedToken(trimmed);
        } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            // Try JSON-wrapped token
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed.token) {
                    decoded = getDecodedToken(parsed.token);
                } else {
                    decoded = parsed;
                }
            } catch {
                throw new Error('Invalid token format');
            }
        } else {
            throw new Error('Invalid token: must start with cashuA, cashuB, or be valid JSON');
        }

        // Extract mint URL and proofs from decoded token
        let mintUrl: string;
        let tokenProofs: Proof[];

        if (decoded.mint) {
            // V4 format
            mintUrl = decoded.mint;
            tokenProofs = decoded.proofs || [];
        } else if (decoded.token && Array.isArray(decoded.token)) {
            // V3 format
            const firstEntry = decoded.token[0];
            mintUrl = firstEntry.mint;
            tokenProofs = firstEntry.proofs || [];
        } else {
            throw new Error('Could not extract mint URL from token');
        }

        mintUrl = mintUrl.replace(/\/$/, '');
        console.log(`🏦 Token mint: ${mintUrl}, ${tokenProofs.length} proofs`);

        // Ensure mint is loaded
        const store = useEcashStore.getState();
        if (!store.mints[mintUrl]) {
            console.log('📡 Loading unknown mint keys...');
            await this.loadMint(mintUrl);
        }

        // Fetch any missing keysets
        const mint = this.getMint(mintUrl);
        const { keysets: mintKeysets } = await mint.getKeySets();
        const proofKeysetIds = new Set(tokenProofs.map(p => p.id));
        const knownKeysetIds = new Set(
            mintKeysets.map((ks: MintKeyset) => ks.id)
        );

        for (const keysetId of proofKeysetIds) {
            if (!knownKeysetIds.has(keysetId)) {
                console.warn(`⚠️ Unknown keyset ${keysetId} — attempting to continue`);
            }
        }

        // Receive proofs via CashuWallet (swaps them for fresh proofs)
        const wallet = await this.getInitializedWallet(mintUrl);
        let receivedProofs: Proof[];

        try {
            receivedProofs = await wallet.receive(tokenStr);
        } catch (e: any) {
            // If receive fails, the proofs may already be claimed or spent
            if (e.message?.includes('already spent')) {
                throw new Error('Token already spent');
            }
            throw e;
        }

        const totalAmount = receivedProofs.reduce((sum, p) => sum + p.amount, 0);
        console.log(`✅ Received ${totalAmount} sats (${receivedProofs.length} proofs)`);

        // Auto-relock: check if proofs are P2PK locked, if not, relock to our npub
        const activePubkey = store.activePubkey;
        if (activePubkey) {
            try {
                const relocked = await this.relockProofs(mintUrl, receivedProofs, activePubkey);
                if (relocked) {
                    receivedProofs = relocked;
                    console.log('🔒 Auto-relocked proofs to our npub');
                }
            } catch (e) {
                console.warn('⚠️ Auto-relock failed, keeping unlocked proofs:', e);
            }
        }

        // Add proofs to store
        useEcashStore.getState().addProofs(receivedProofs, false, mintUrl);

        return {
            amount: totalAmount,
            mint: mintUrl,
            proofs: receivedProofs
        };
    }

    /**
     * Relock proofs with P2PK to a given pubkey.
     * Sends proofs to self with P2PK lock.
     */
    static async relockProofs(
        mintUrl: string,
        proofs: Proof[],
        pubkeyHex: string
    ): Promise<Proof[] | null> {
        try {
            const wallet = await this.getInitializedWallet(mintUrl);
            const totalAmount = proofs.reduce((sum, p) => sum + p.amount, 0);

            // Create a self-send with P2PK lock
            const { send, keep } = await wallet.send(totalAmount, proofs, {
                pubkey: '02' + pubkeyHex
            });

            // Return the locked proofs
            return [...keep, ...send];
        } catch (e) {
            console.warn('Relock failed:', e);
            return null;
        }
    }

    /**
     * Consolidate proofs — reduce count by swapping with the mint.
     */
    static async consolidateProofs(
        mintUrl: string,
        proofs: Proof[]
    ): Promise<Proof[]> {
        const wallet = await this.getInitializedWallet(mintUrl);
        const totalAmount = proofs.reduce((sum, p) => sum + p.amount, 0);

        console.log(`🔄 Consolidating ${proofs.length} proofs (${totalAmount} sats) at ${mintUrl}`);

        // Encode proofs as a token and receive back — comes back as fewer proofs
        const token = getEncodedTokenV4({
            mint: mintUrl,
            proofs,
            unit: 'sat'
        });

        const consolidated = await wallet.receive(token);
        console.log(`✅ Consolidated to ${consolidated.length} proofs`);
        return consolidated;
    }

    /**
     * Transfer between mints via Lightning.
     */
    static async transferBetweenMints(
        sourceMint: string,
        destMint: string,
        amount: number
    ): Promise<{ success: boolean; amount: number }> {
        console.log(`🔄 Transferring ${amount} sats: ${sourceMint} → ${destMint}`);

        // Step 1: Create mint quote at destination (Lightning invoice)
        const destWallet = await this.getInitializedWallet(destMint);
        const mintQuote = await destWallet.createMintQuote(amount);
        console.log('📝 Mint quote created at destination');

        // Step 2: Melt at source (pay the invoice)
        await this.meltTokens(sourceMint, mintQuote.request);
        console.log('⚡ Invoice paid from source mint');

        // Step 3: Claim minted proofs at destination
        // Poll for payment
        let claimed = false;
        for (let i = 0; i < 30; i++) {
            try {
                const proofs = await destWallet.mintProofs(amount, mintQuote.quote);
                useEcashStore.getState().addProofs(proofs, false, destMint);
                claimed = true;
                console.log(`✅ Claimed ${proofs.length} proofs at destination`);
                break;
            } catch {
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        if (!claimed) {
            throw new Error('Timed out waiting for payment confirmation at destination mint');
        }

        return { success: true, amount };
    }

    /**
     * Check proof states against the mint — returns valid and spent proofs.
     */
    static async checkProofStates(
        mintUrl: string,
        proofs: Proof[]
    ): Promise<{ valid: Proof[]; spent: Proof[] }> {
        if (proofs.length === 0) return { valid: [], spent: [] };

        const wallet = await this.getInitializedWallet(mintUrl);
        const states = await wallet.checkProofsStates(proofs);

        // Guard: if mint returned fewer states than proofs, response is malformed
        if (!states || states.length !== proofs.length) {
            console.error(
                `🛑 Mint returned ${states?.length ?? 0} states for ${proofs.length} proofs — response malformed, treating all as valid`
            );
            return { valid: [...proofs], spent: [] };
        }

        const valid: Proof[] = [];
        const spent: Proof[] = [];

        states.forEach((state, i) => {
            if (state.state === CheckStateEnum.SPENT) {
                spent.push(proofs[i]);
            } else {
                valid.push(proofs[i]);
            }
        });

        console.log(`🔍 Proof check at ${mintUrl.replace('https://', '')}: ${valid.length} valid, ${spent.length} spent`);
        return { valid, spent };
    }

    /**
     * Send a token — lock proofs to recipient with P2PK.
     * If keepProofs=true, proofs are NOT removed from wallet (for NutZap pending sends).
     */
    static async sendToken(
        amount: number,
        mintUrl: string,
        recipient?: string,
        memo?: string,
        keepProofs = false
    ): Promise<string | { token: string; usedProofs: Proof[] }> {
        const store = useEcashStore.getState();
        const mintState = store.mints[mintUrl];
        if (!mintState) throw new Error(`Mint not found: ${mintUrl}`);

        // Get proofs for this mint (use tagged mintUrl first, keyset fallback)
        const mintProofs = store.proofs.filter(proof => {
            if (proof.mintUrl) return proof.mintUrl === mintUrl;
            const mintKeys = mintState.keys as any;
            return (mintKeys.keysets && Array.isArray(mintKeys.keysets) &&
                mintKeys.keysets.some((k: any) => k.id === proof.id)) ||
                mintKeys[proof.id];
        });

        const availableBalance = mintProofs.reduce((sum, p) => sum + p.amount, 0);
        if (availableBalance < amount) {
            throw new Error(`Insufficient balance at ${mintUrl}: need ${amount}, have ${availableBalance}`);
        }

        const wallet = await this.getInitializedWallet(mintUrl);

        // Build send options
        const sendOpts: any = {};

        // P2PK lock to recipient if it's an npub
        if (recipient) {
            let recipientHex = recipient;
            try {
                const decoded = nip19.decode(recipient);
                if (decoded.type === 'npub') {
                    recipientHex = decoded.data as string;
                }
            } catch {
                // Not an npub — might be Lightning address or invoice, skip P2PK
            }

            // Only P2PK lock if it looks like a hex pubkey
            if (/^[0-9a-f]{64}$/i.test(recipientHex)) {
                sendOpts.pubkey = '02' + recipientHex;
            }
        }

        const { send, keep } = await wallet.send(amount, mintProofs, sendOpts);

        // ALWAYS update local state — wallet.send() already spent the originals at the mint
        if (keep.length > 0) {
            useEcashStore.getState().addProofs(keep, true, mintUrl);
        }
        useEcashStore.getState().removeProofs(mintProofs, true);

        // Immediate save — don't risk losing state on tab switch
        await useEcashStore.getState().saveSession();

        if (!keepProofs) {
            // Non-NutZap: publish to NIP-60 immediately
            try {
                await useEcashStore.getState().publishProofsToNostr(true);
                console.log('📤 Send: Wallet state published to relays');
            } catch (e) {
                console.warn('⚠️ Send succeeded but relay publish failed:', e);
            }
        }

        // Encode the token
        const token = getEncodedTokenV4({
            mint: mintUrl,
            proofs: send,
            unit: 'sat',
            memo
        });

        if (keepProofs) {
            // For NutZap: return token + the proofs that were consumed (for pending send tracking)
            return { token, usedProofs: mintProofs };
        }

        return token;
    }

    /**
     * Validate whether a mint is online.
     */
    static async validateMint(mintUrl: string): Promise<boolean> {
        try {
            const mint = this.getMint(mintUrl);
            await mint.getKeys();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Create a Lightning invoice via mint (for receiving).
     */
    static async getMintQuote(mintUrl: string, amount: number) {
        const wallet = await this.getInitializedWallet(mintUrl);
        return wallet.createMintQuote(amount);
    }

    /**
     * Claim proofs from a paid mint quote.
     */
    static async claimMintQuote(mintUrl: string, amount: number, quoteId: string) {
        const wallet = await this.getInitializedWallet(mintUrl);
        const proofs = await wallet.mintProofs(amount, quoteId);
        useEcashStore.getState().addProofs(proofs, false, mintUrl);
        return proofs;
    }

    /**
     * Get a melt quote (fee estimate for paying a Lightning invoice).
     */
    static async getMeltQuote(mintUrl: string, invoice: string) {
        const wallet = await this.getInitializedWallet(mintUrl);
        return wallet.createMeltQuote(invoice);
    }

    /**
     * Pay a Lightning invoice by melting tokens.
     */
    static async meltTokens(
        mintUrl: string,
        invoice: string
    ): Promise<{ quote: any; change: Proof[] }> {
        const store = useEcashStore.getState();
        const mintState = store.mints[mintUrl];
        if (!mintState) throw new Error(`Mint not found: ${mintUrl}`);

        const wallet = await this.getInitializedWallet(mintUrl);

        // Get proofs for this mint (use tagged mintUrl first, keyset fallback)
        const mintProofs = store.proofs.filter(proof => {
            if (proof.mintUrl) return proof.mintUrl === mintUrl;
            const mintKeys = mintState.keys as any;
            return (mintKeys.keysets && Array.isArray(mintKeys.keysets) &&
                mintKeys.keysets.some((k: any) => k.id === proof.id)) ||
                mintKeys[proof.id];
        });

        // Get melt quote first
        const quote = await wallet.createMeltQuote(invoice);
        const totalNeeded = quote.amount + quote.fee_reserve;

        const available = mintProofs.reduce((s, p) => s + p.amount, 0);
        if (available < totalNeeded) {
            throw new Error(
                `Insufficient balance for Lightning payment. ` +
                `Need ${totalNeeded} sats (${quote.amount} + ${quote.fee_reserve} fee), ` +
                `have ${available} sats`
            );
        }

        // Melt (pay invoice)
        const meltResult = await wallet.meltProofs(quote, mintProofs);

        // Remove used proofs
        useEcashStore.getState().removeProofs(mintProofs, true);

        // Add change proofs (overpayment returned)
        const change = meltResult.change || [];
        if (change.length > 0) {
            useEcashStore.getState().addProofs(change, true, mintUrl);
        }

        // Immediate save — don't risk losing state on tab switch
        await useEcashStore.getState().saveSession();

        // Blocking publish — ensure relay has the updated state before confirming
        try {
            await useEcashStore.getState().publishProofsToNostr(true);
            console.log('📤 Melt: Wallet state published to relays');
        } catch (e) {
            console.warn('⚠️ Melt succeeded but relay publish failed:', e);
        }

        console.log(`⚡ Melted ${quote.amount} sats (fee: ${quote.fee_reserve}), ${change.length} change proofs`);

        return { quote, change };
    }
}
