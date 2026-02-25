/**
 * eCash Store — Zustand-backed state management with Tauri keyring persistence.
 * Port of PWANS store/ecash.ts adapted for DENOS.
 */
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Proof } from '@cashu/cashu-ts';

// ── Types ──

export interface MintKeys {
    keysets?: { id: string; unit: string; active: boolean }[];
    [keysetId: string]: any;
}

export interface MintState {
    url: string;
    keys: MintKeys;
    active: boolean;
}

export interface HistoryItem {
    id: string;
    type: 'send' | 'receive';
    amount: number;
    mint: string;
    timestamp: number;
    memo?: string;
    isNutzap: boolean;
    token?: string;
    sender?: string;
    recipient?: string;
}

export interface DiscoveredMint {
    url: string;
    status: 'online' | 'offline' | 'unknown';
    trustScore: number;
    reviews: number;
    lastSeen: number;
}

export interface PendingSend {
    id: string;
    token: string;
    recipient: string;
    amount: number;
    mint: string;
    timestamp: number;
    attempts: number;
    lastError?: string;
    proofSecrets: string[];
}

interface EcashState {
    // State
    mints: Record<string, MintState>;
    proofs: Proof[];
    history: HistoryItem[];
    discoveredMints: Record<string, DiscoveredMint>;
    pendingSends: PendingSend[];
    activePubkey: string | null;

    // State setters
    setActivePubkey: (pubkey: string) => void;

    // Mint management
    addMint: (url: string, keys: MintKeys) => void;
    removeMint: (url: string) => void;
    updateMintKeys: (url: string, keys: MintKeys) => void;

    // Proof management
    addProofs: (proofs: Proof[], skipPublish?: boolean) => void;
    removeProofs: (proofs: Proof[], skipPublish?: boolean) => void;

    // History
    addHistoryItem: (item: HistoryItem) => void;

    // Discovered mints (NIP-87)
    addDiscoveredMint: (mint: DiscoveredMint) => void;
    updateMintStatus: (url: string, status: 'online' | 'offline' | 'unknown') => void;
    updateMintTrust: (url: string, delta: number) => void;

    // Pending sends
    addPendingSend: (send: PendingSend) => void;
    removePendingSend: (id: string) => void;
    updatePendingSendAttempt: (id: string, error?: string) => void;

    // NIP-60
    publishProofsToNostr: (skipMerge?: boolean) => Promise<void>;
    mergeWalletState: (incoming: { proofs: Proof[]; history: HistoryItem[] }) => void;

    // Persistence
    saveSession: () => Promise<void>;
    loadSession: (pubkey: string) => Promise<void>;

    // Utility
    getBalance: () => number;
    getMintBalance: (mintUrl: string) => number;
    reset: () => void;
}

// Debounce timer for auto-save
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 2000;

// NIP-60 publish debounce
let publishTimer: ReturnType<typeof setTimeout> | null = null;
const PUBLISH_DEBOUNCE_MS = 5000;

function debouncedSave(state: EcashState) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        state.saveSession().catch(e => console.error('Auto-save failed:', e));
    }, SAVE_DEBOUNCE_MS);
}

export const useEcashStore = create<EcashState>((set, get) => ({
    // Initial state
    mints: {},
    proofs: [],
    history: [],
    discoveredMints: {},
    pendingSends: [],
    activePubkey: null,

    setActivePubkey: (pubkey: string) => {
        set({ activePubkey: pubkey });
    },

    // ── Mint management ──

    addMint: (url: string, keys: MintKeys) => {
        set(state => ({
            mints: {
                ...state.mints,
                [url]: { url, keys, active: true }
            }
        }));
        debouncedSave(get());
    },

    removeMint: (url: string) => {
        set(state => {
            const { [url]: _, ...rest } = state.mints;
            return { mints: rest };
        });
        debouncedSave(get());
    },

    updateMintKeys: (url: string, keys: MintKeys) => {
        set(state => ({
            mints: {
                ...state.mints,
                [url]: { ...state.mints[url], keys }
            }
        }));
        debouncedSave(get());
    },

    // ── Proof management ──

    addProofs: (newProofs: Proof[], skipPublish = false) => {
        set(state => ({
            proofs: [...state.proofs, ...newProofs]
        }));
        debouncedSave(get());
        if (!skipPublish) {
            // Schedule NIP-60 publish
            if (publishTimer) clearTimeout(publishTimer);
            publishTimer = setTimeout(() => {
                get().publishProofsToNostr().catch(e =>
                    console.error('Auto NIP-60 publish failed:', e)
                );
            }, PUBLISH_DEBOUNCE_MS);
        }
    },

    removeProofs: (proofsToRemove: Proof[], skipPublish = false) => {
        const secretsToRemove = new Set(proofsToRemove.map(p => p.secret));
        set(state => ({
            proofs: state.proofs.filter(p => !secretsToRemove.has(p.secret))
        }));
        debouncedSave(get());
        if (!skipPublish) {
            if (publishTimer) clearTimeout(publishTimer);
            publishTimer = setTimeout(() => {
                get().publishProofsToNostr().catch(e =>
                    console.error('Auto NIP-60 publish failed:', e)
                );
            }, PUBLISH_DEBOUNCE_MS);
        }
    },

    // ── History ──

    addHistoryItem: (item: HistoryItem) => {
        set(state => {
            // Deduplicate by id
            if (state.history.some(h => h.id === item.id)) return state;
            // Keep last 1000 items
            const newHistory = [item, ...state.history].slice(0, 1000);
            return { history: newHistory };
        });
        debouncedSave(get());
    },

    // ── Discovered mints (NIP-87) ──

    addDiscoveredMint: (mint: DiscoveredMint) => {
        set(state => ({
            discoveredMints: {
                ...state.discoveredMints,
                [mint.url]: mint
            }
        }));
        // Don't persist discovered mints aggressively — they're ephemeral
    },

    updateMintStatus: (url: string, status: 'online' | 'offline' | 'unknown') => {
        set(state => {
            if (!state.discoveredMints[url]) return state;
            return {
                discoveredMints: {
                    ...state.discoveredMints,
                    [url]: { ...state.discoveredMints[url], status }
                }
            };
        });
    },

    updateMintTrust: (url: string, delta: number) => {
        set(state => {
            if (!state.discoveredMints[url]) return state;
            return {
                discoveredMints: {
                    ...state.discoveredMints,
                    [url]: {
                        ...state.discoveredMints[url],
                        trustScore: state.discoveredMints[url].trustScore + delta,
                        reviews: state.discoveredMints[url].reviews + 1
                    }
                }
            };
        });
    },

    // ── Pending sends ──

    addPendingSend: (send: PendingSend) => {
        set(state => ({
            pendingSends: [...state.pendingSends, send]
        }));
        debouncedSave(get());
    },

    removePendingSend: (id: string) => {
        set(state => ({
            pendingSends: state.pendingSends.filter(ps => ps.id !== id)
        }));
        debouncedSave(get());
    },

    updatePendingSendAttempt: (id: string, error?: string) => {
        set(state => ({
            pendingSends: state.pendingSends.map(ps =>
                ps.id === id
                    ? { ...ps, attempts: ps.attempts + 1, lastError: error }
                    : ps
            )
        }));
        debouncedSave(get());
    },

    // ── NIP-60 (Wallet State Backup) ──

    publishProofsToNostr: async (skipMerge = false) => {
        try {
            const { activePubkey, proofs, history } = get();
            if (!activePubkey) {
                console.warn('Cannot publish to NIP-60: no active pubkey');
                return;
            }

            // Dynamically import to avoid circular deps
            const { Nip60Service } = await import('./nip61');

            // Get private key hex
            const privateKeyHex: string = await invoke('export_private_key_hex', {
                pubkey: activePubkey
            });

            await Nip60Service.publishWalletState(
                activePubkey,
                privateKeyHex,
                { proofs, history },
                skipMerge
            );

            console.log('✅ Published wallet state to NIP-60');
        } catch (e: any) {
            console.error('Failed to publish to NIP-60:', e.message || e);
        }
    },

    mergeWalletState: (incoming: { proofs: Proof[]; history: HistoryItem[] }) => {
        set(state => {
            // Merge proofs — deduplicate by secret
            const existingSecrets = new Set(state.proofs.map(p => p.secret));
            const newProofs = incoming.proofs.filter(p => !existingSecrets.has(p.secret));

            // Merge history — deduplicate by id
            const existingIds = new Set(state.history.map(h => h.id));
            const newHistory = incoming.history.filter(h => !existingIds.has(h.id));

            if (newProofs.length === 0 && newHistory.length === 0) return state;

            console.log(`📥 Merged ${newProofs.length} new proofs, ${newHistory.length} new history items from NIP-60`);

            return {
                proofs: [...state.proofs, ...newProofs],
                history: [...newHistory, ...state.history].slice(0, 1000)
            };
        });
        debouncedSave(get());
    },

    // ── Persistence ──

    saveSession: async () => {
        const { activePubkey, proofs, mints, history, pendingSends, discoveredMints } = get();
        if (!activePubkey) return;

        try {
            await invoke('save_ecash_state', {
                pubkey: activePubkey,
                proofsJson: JSON.stringify(proofs),
                mintsJson: JSON.stringify(mints),
                historyJson: JSON.stringify(history),
                pendingJson: JSON.stringify(pendingSends),
                discoveredJson: JSON.stringify(discoveredMints),
            });
            console.log('💾 eCash state saved to keyring');
        } catch (e: any) {
            console.error('Failed to save eCash state:', e.message || e);
        }
    },

    loadSession: async (pubkey: string) => {
        try {
            const data: any = await invoke('load_ecash_state', { pubkey });

            set({
                activePubkey: pubkey,
                proofs: data.proofs || [],
                mints: data.mints || {},
                history: data.history || [],
                pendingSends: data.pending || [],
                discoveredMints: data.discovered || {},
            });

            console.log(`📦 Loaded eCash state for ${pubkey.slice(0, 8)}...`);
        } catch (e: any) {
            console.error('Failed to load eCash state:', e.message || e);
            set({ activePubkey: pubkey });
        }
    },

    // ── Utility ──

    getBalance: () => {
        return get().proofs.reduce((sum, p) => sum + p.amount, 0);
    },

    getMintBalance: (mintUrl: string) => {
        const { proofs, mints } = get();
        const mintState = mints[mintUrl];
        if (!mintState) return 0;

        return proofs
            .filter(proof => {
                const mintKeys = mintState.keys as any;
                return (mintKeys.keysets && Array.isArray(mintKeys.keysets) &&
                    mintKeys.keysets.some((k: any) => k.id === proof.id)) ||
                    mintKeys[proof.id];
            })
            .reduce((sum, p) => sum + p.amount, 0);
    },

    reset: () => {
        set({
            mints: {},
            proofs: [],
            history: [],
            discoveredMints: {},
            pendingSends: [],
            activePubkey: null,
        });
    },
}));
