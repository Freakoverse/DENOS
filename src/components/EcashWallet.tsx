/**
 * EcashWallet — Main eCash wallet view.
 * Port of PWANS EcashWallet.tsx adapted for DENOS (Tauri invoke, raw WebSocket, DENOS styling).
 */
import React, { useState, useEffect } from 'react';
import { useEcashStore, type HistoryItem } from '@/services/ecashStore';
import { CashuService } from '@/services/cashu';
import { Nip60Service, Nip61Service, KIND_NIP61_NUTZAP } from '@/services/nip61';
import { Nip87Service } from '@/services/nip87';
import { fetchNostrProfile, type NostrProfile } from '@/services/nostrProfile';
import { nip19 } from 'nostr-tools';
import { invoke } from '@tauri-apps/api/core';
import {
    ArrowDownLeft, ArrowUpRight, ArrowUpDown, User, CircleCheckBig,
    Loader2, AlertTriangle
} from 'lucide-react';
import { SatoshiIcon } from '@/components/SatoshiIcon';
import { cn } from '@/lib/utils';
import { EcashReceiveModal } from './EcashReceiveModal';
import { EcashSendModal } from './EcashSendModal';
import { MintsModal } from './MintsModal';
import { ProofsModal } from './ProofsModal';
import { PendingSendsModal } from './PendingSendsModal';
import { EcashTransactionDetailsModal } from './EcashTransactionDetailsModal';

interface EcashWalletProps {
    activePubkey: string | null;
    initialRecipient?: string;
    autoOpenSend?: boolean;
    onSendComplete?: () => void;
}

export const EcashWallet: React.FC<EcashWalletProps> = ({
    activePubkey,
    initialRecipient = '',
    autoOpenSend = false,
    onSendComplete
}) => {
    const { mints, proofs, history, pendingSends } = useEcashStore();

    // Modal States
    const [showReceive, setShowReceive] = useState(false);
    const [showSend, setShowSend] = useState(false);
    const [showMintsModal, setShowMintsModal] = useState(false);
    const [showProofsModal, setShowProofsModal] = useState(false);
    const [showPendingSends, setShowPendingSends] = useState(false);
    const [selectedTransaction, setSelectedTransaction] = useState<HistoryItem | null>(null);
    const [profiles, setProfiles] = useState<Map<string, NostrProfile>>(new Map());
    const [sendRecipient, setSendRecipient] = useState(initialRecipient);

    // UI States
    const [showInSats, setShowInSats] = useState(true);
    const [isConsolidating, setIsConsolidating] = useState(false);
    const [verifyStatus, setVerifyStatus] = useState<'syncing' | 'verifying' | 'verified' | 'offline' | 'failed' | null>(null);
    const [showOfflineWarning, setShowOfflineWarning] = useState(false);
    const [consolidateResult, setConsolidateResult] = useState<{ success: boolean; count: number } | null>(null);

    // Sync sendRecipient with initialRecipient when it changes
    useEffect(() => {
        if (initialRecipient) {
            setSendRecipient(initialRecipient);
        }
    }, [initialRecipient]);

    // Auto-open send modal if autoOpenSend is true
    useEffect(() => {
        if (autoOpenSend && initialRecipient) {
            setSendRecipient(initialRecipient);
            setShowSend(true);
        }
    }, [autoOpenSend, initialRecipient]);

    // Load session + fetch relay state + reconcile + subscribe
    useEffect(() => {
        if (!activePubkey) return;

        let nutZapSub: { stop: () => void } | null = null;
        let proofSub: { stop: () => void } | null = null;
        let mintSub: { stop: () => void } | null = null;
        let isReconciling = false;

        const init = async () => {
            // Step 1: Load local cache instantly (for fast UI)
            setVerifyStatus('syncing');
            await useEcashStore.getState().loadSession(activePubkey);

            // Step 2: Fetch latest relay state + reconcile
            let privateKeyHex: string;
            try {
                privateKeyHex = await invoke('export_private_key_hex', { pubkey: activePubkey });
            } catch (e) {
                console.error('Failed to export private key:', e);
                setVerifyStatus('failed');
                return;
            }

            setVerifyStatus('verifying');

            // Track the timestamp of the last event we've already processed
            // so the subscription doesn't re-process it
            let reconciledTimestamp = 0;

            try {
                const relayState = await Nip60Service.fetchLatestWalletState(activePubkey, privateKeyHex);

                if (relayState) {
                    reconciledTimestamp = relayState.created_at || 0;
                    await useEcashStore.getState().reconcileWithRelayState(relayState);
                    setVerifyStatus('verified');
                } else {
                    // No relay state found — offline or first-time user
                    const hasProofs = useEcashStore.getState().proofs.length > 0;
                    if (hasProofs) {
                        setVerifyStatus('offline');
                    } else {
                        setVerifyStatus('verified');
                    }
                }
            } catch (e) {
                console.error('Relay fetch/reconcile failed:', e);
                setVerifyStatus('offline');
            }

            // Also account for any publish that happened during reconcile
            // (reconcile publishes if local proofs survived — that event will have
            // created_at = now, which is > reconciledTimestamp)
            const publishTimestamp = Math.floor(Date.now() / 1000);
            const subscriptionSince = Math.max(reconciledTimestamp, publishTimestamp);

            // Step 3: NIP-61 — Subscribe to incoming NutZaps
            const DEFAULT_RELAYS = [
                'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band',
                'wss://relay.primal.net', 'wss://relay.snort.social', 'wss://relay.azzamo.net',
                'wss://relay.cashumints.space'
            ];

            const sockets: WebSocket[] = [];
            const subId = 'nutzap_' + Math.random().toString(36).slice(2, 8);

            for (const relayUrl of DEFAULT_RELAYS) {
                try {
                    const ws = new WebSocket(relayUrl);
                    ws.onopen = () => {
                        ws.send(JSON.stringify(['REQ', subId, {
                            kinds: [KIND_NIP61_NUTZAP],
                            '#p': [activePubkey],
                        }]));
                    };

                    ws.onmessage = async (msg) => {
                        try {
                            const data = JSON.parse(msg.data);
                            if (data[0] !== 'EVENT' || !data[2]) return;

                            const event = data[2];
                            const currentHistory = useEcashStore.getState().history;
                            if (currentHistory.some(h => h.id === event.id)) return;

                            console.log('⚡ Received NutZap', event.id);
                            const details = Nip61Service.parseNutZap(event);
                            if (details && event.content) {
                                try {
                                    await CashuService.receiveToken(event.content);
                                    useEcashStore.getState().addHistoryItem({
                                        id: `${event.id}-receive`,
                                        type: 'receive',
                                        amount: details.amount,
                                        mint: details.mint,
                                        timestamp: event.created_at,
                                        isNutzap: true,
                                        sender: nip19.npubEncode(event.pubkey),
                                        recipient: activePubkey
                                    });
                                    console.log('NutZap Redeemed!');
                                } catch (e: any) {
                                    if (e.message?.includes('already spent')) {
                                        console.log('⚠️ Token already spent, marking as processed');
                                        useEcashStore.getState().addHistoryItem({
                                            id: `${event.id}-receive`,
                                            type: 'receive',
                                            amount: 0,
                                            mint: details.mint,
                                            timestamp: event.created_at,
                                            isNutzap: true,
                                            recipient: activePubkey
                                        });
                                    } else {
                                        console.error('Failed to redeem NutZap', e);
                                    }
                                }
                            }
                        } catch { /* ignore */ }
                    };

                    sockets.push(ws);
                } catch { /* ignore */ }
            }

            nutZapSub = {
                stop: () => {
                    for (const ws of sockets) {
                        try {
                            ws.send(JSON.stringify(['CLOSE', subId]));
                            ws.close();
                        } catch { /* ignore */ }
                    }
                }
            };

            // Step 4: NIP-60 — Subscribe for live wallet state updates (during session)
            // Only process events NEWER than what we already fetched + reconciled
            try {
                proofSub = Nip60Service.subscribeToWalletState(
                    null,
                    activePubkey,
                    privateKeyHex,
                    async (walletState) => {
                        // Skip if a reconcile is already in progress
                        if (isReconciling) return;
                        isReconciling = true;

                        // Live update from another device — reconcile
                        setVerifyStatus('verifying');
                        try {
                            await useEcashStore.getState().reconcileWithRelayState(walletState);
                            setVerifyStatus('verified');
                        } catch {
                            setVerifyStatus('failed');
                        } finally {
                            isReconciling = false;
                        }
                    },
                    subscriptionSince
                );
                console.log(`📡 Subscribed to NIP-60 Wallet State (since: ${subscriptionSince})`);
            } catch (e) {
                console.warn('Could not subscribe to NIP-60:', e);
            }

            // Step 5: NIP-87 — Mint discovery
            mintSub = Nip87Service.subscribeToMints();
            console.log('📡 Subscribed to NIP-87 Mints');
        };

        init();

        return () => {
            nutZapSub?.stop();
            proofSub?.stop();
            mintSub?.stop();
        };
    }, [activePubkey]);

    // Fetch profiles for history items
    useEffect(() => {
        const fetchProfiles = async () => {
            const npubsToFetch = new Set<string>();
            history.forEach(item => {
                if (item.isNutzap) {
                    if (item.sender) npubsToFetch.add(item.sender);
                    if (item.recipient) npubsToFetch.add(item.recipient);
                }
            });

            const newProfiles = new Map(profiles);
            for (const npub of npubsToFetch) {
                if (!newProfiles.has(npub)) {
                    try {
                        // Convert npub to hex for profile fetcher
                        let pubkeyHex = npub;
                        try {
                            const decoded = nip19.decode(npub);
                            if (decoded.type === 'npub') {
                                pubkeyHex = decoded.data as string;
                            }
                        } catch { /* use as-is */ }

                        const profile = await fetchNostrProfile(pubkeyHex);
                        if (profile) {
                            newProfiles.set(npub, profile);
                        }
                    } catch (e) {
                        console.error(`Failed to fetch profile for ${npub}:`, e);
                    }
                }
            }
            setProfiles(newProfiles);
        };

        if (history.length > 0) {
            fetchProfiles();
        }
    }, [history]);

    // Total Balance
    const totalBalance = proofs.reduce((acc, p) => acc + p.amount, 0);
    const balanceInBTC = (totalBalance / 100_000_000).toFixed(8);

    // ── Consolidation handler ──
    const handleConsolidateProofs = async () => {
        try {
            setIsConsolidating(true);
            const currentProofs = useEcashStore.getState().proofs;
            const proofsByMint: Record<string, typeof currentProofs> = {};

            currentProofs.forEach(proof => {
                // Try tagged mintUrl first
                if ((proof as any).mintUrl && mints[(proof as any).mintUrl]) {
                    const url = (proof as any).mintUrl;
                    if (!proofsByMint[url]) proofsByMint[url] = [];
                    proofsByMint[url].push(proof);
                    return;
                }

                // Fallback: keyset ID matching
                let mint = Object.keys(mints).find(m => {
                    const mintKeys = (mints[m].keys as any);
                    return (mintKeys.keysets && Array.isArray(mintKeys.keysets) &&
                        mintKeys.keysets.some((k: any) => k.id === proof.id)) ||
                        mintKeys[proof.id];
                });
                if (!mint) {
                    console.warn(`⚠️ Skipping proof with keyset ${proof.id} - mint not found`);
                    return;
                }
                if (!proofsByMint[mint]) proofsByMint[mint] = [];
                proofsByMint[mint].push(proof);
            });

            let totalConsolidated = 0;
            for (const [mintUrl, mintProofs] of Object.entries(proofsByMint)) {
                if (mintProofs.length === 0) continue;
                const consolidated = await CashuService.consolidateProofs(mintUrl, mintProofs);
                useEcashStore.getState().removeProofs(mintProofs, true);
                useEcashStore.getState().addProofs(consolidated, true, mintUrl);
                totalConsolidated += mintProofs.length;
            }

            console.log('📤 Publishing consolidated state to NIP-60 (skip merge)...');
            await useEcashStore.getState().publishProofsToNostr(true);
            setConsolidateResult({ success: true, count: totalConsolidated });
        } catch (e) {
            console.error('Consolidation failed:', e);
            setConsolidateResult({ success: false, count: 0 });
        } finally {
            setIsConsolidating(false);
        }
    };



    return (
        <div className="flex-1 min-h-0 flex flex-col gap-4">
            {/* Balance Card */}
            <div className="wallet-balance-card bg-gradient-to-br from-primary/15 to-primary/5 border border-primary/20 rounded-2xl p-5 relative overflow-hidden shrink-0">
                <div className="relative z-10">
                    <div className="flex items-center justify-between mb-1">
                        <span className="text-muted-foreground font-medium text-sm">eCash Balance</span>
                        <button
                            onClick={() => setShowInSats(!showInSats)}
                            className="p-1.5 hover:bg-secondary/50 rounded-lg text-muted-foreground hover:text-foreground transition-all cursor-pointer"
                            title="Toggle denomination"
                        >
                            <ArrowUpDown className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="flex items-baseline gap-2 mb-1">
                        {showInSats ? (
                            <>
                                <SatoshiIcon className="text-3xl max-[400px]:text-2xl text-primary" />
                                <span className="text-4xl max-[400px]:text-3xl max-[300px]:text-2xl font-bold text-foreground">
                                    {totalBalance.toLocaleString()}
                                </span>
                                <span className="text-primary font-bold">sats</span>
                            </>
                        ) : (
                            <>
                                <span className="text-3xl max-[400px]:text-2xl text-primary">₿</span>
                                <span className="text-4xl max-[400px]:text-3xl max-[300px]:text-2xl font-bold text-foreground">
                                    {balanceInBTC}
                                </span>
                                <span className="text-primary font-bold">BTC</span>
                            </>
                        )}
                    </div>

                    {/* Alt denomination */}
                    <div className="flex items-center gap-1.5 text-sm text-muted-foreground mb-5">
                        {showInSats ? (
                            <>
                                <span className="text-base text-primary">₿</span>
                                <span>≈ {balanceInBTC} BTC</span>
                            </>
                        ) : (
                            <>
                                <SatoshiIcon className="text-xs" />
                                <span>≈ {totalBalance.toLocaleString()} sats</span>
                            </>
                        )}
                    </div>

                    {/* Status indicators row */}
                    <div className="flex justify-between gap-3 text-xs mb-5">
                        <div
                            className={cn(
                                "px-3 py-1.5 bg-secondary/50 border border-border/30 rounded-lg text-muted-foreground flex items-center gap-2",
                                verifyStatus === 'offline' && "cursor-pointer hover:bg-secondary"
                            )}
                            onClick={verifyStatus === 'offline' ? () => setShowOfflineWarning(true) : undefined}
                        >
                            {verifyStatus === 'syncing' || verifyStatus === null ? (
                                <>
                                    <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                                    <span>Syncing...</span>
                                </>
                            ) : verifyStatus === 'verifying' ? (
                                <>
                                    <Loader2 className="w-3 h-3 animate-spin text-primary" />
                                    <span>Verifying...</span>
                                </>
                            ) : verifyStatus === 'verified' ? (
                                <>
                                    <CircleCheckBig className="w-3 h-3 text-green-500" />
                                    <span className="text-green-500">Verified</span>
                                </>
                            ) : verifyStatus === 'offline' ? (
                                <>
                                    <AlertTriangle className="w-3 h-3 text-yellow-500" />
                                    <span className="text-yellow-500">Unverified</span>
                                </>
                            ) : (
                                <>
                                    <AlertTriangle className="w-3 h-3 text-red-500" />
                                    <span className="text-red-500">Failed</span>
                                </>
                            )}
                        </div>
                        <div className="flex gap-3">
                            <button
                                onClick={() => setShowMintsModal(true)}
                                className="px-3 py-1.5 bg-secondary/50 hover:bg-secondary border border-border/30 hover:border-primary/50 rounded-lg text-muted-foreground hover:text-foreground transition-all cursor-pointer"
                            >
                                {Object.keys(mints).length} Mints
                            </button>
                            <button
                                onClick={() => setShowProofsModal(true)}
                                className="px-3 py-1.5 bg-secondary/50 hover:bg-secondary border border-border/30 hover:border-primary/50 rounded-lg text-muted-foreground hover:text-foreground transition-all cursor-pointer"
                            >
                                {proofs.length} Proofs
                            </button>
                        </div>
                    </div>

                    {/* Consolidation Warning */}
                    {proofs.length >= 1000 && (
                        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4 mb-4">
                            <div className="flex items-start gap-3">
                                <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
                                <div className="flex-1">
                                    <h4 className="font-bold text-yellow-500 mb-1">Too Many Proofs</h4>
                                    <p className="text-sm text-yellow-200/80 mb-3">
                                        You have {proofs.length} proofs. Consolidate them to reduce sync size and improve performance.
                                    </p>
                                    <button
                                        onClick={handleConsolidateProofs}
                                        disabled={isConsolidating}
                                        className="px-4 py-2 bg-yellow-500 hover:bg-yellow-600 disabled:bg-yellow-700 text-black font-bold rounded-lg transition-colors disabled:cursor-not-allowed cursor-pointer"
                                    >
                                        {isConsolidating ? 'Consolidating...' : 'Consolidate Proofs'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Stuck Sends Warning */}
                    {pendingSends.length > 0 && (
                        <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-4 mb-4">
                            <div className="flex items-start gap-3">
                                <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                                <div className="flex-1">
                                    <h4 className="font-bold text-destructive mb-1">Stuck Sends Detected</h4>
                                    <p className="text-sm text-destructive/80 mb-3">
                                        You have {pendingSends.length} {pendingSends.length === 1 ? 'send' : 'sends'} that failed to publish.
                                        The tokens are locked to recipients but not sent yet.
                                    </p>
                                    <button
                                        onClick={() => setShowPendingSends(true)}
                                        className="px-4 py-2 bg-destructive hover:bg-destructive/80 text-destructive-foreground font-bold rounded-lg transition-colors cursor-pointer"
                                    >
                                        Recover {pendingSends.length} {pendingSends.length === 1 ? 'Send' : 'Sends'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Send / Receive buttons */}
                    <div className="flex gap-3">
                        <button
                            onClick={() => setShowReceive(true)}
                            className="flex-1 bg-secondary/50 hover:bg-secondary text-foreground py-2 px-4 rounded-xl font-medium transition-colors flex items-center justify-center gap-2 border border-border/20 cursor-pointer"
                        >
                            <ArrowDownLeft className="w-4 h-4 text-green-500" />
                            Receive
                        </button>
                        <button
                            onClick={() => setShowSend(true)}
                            disabled={verifyStatus === 'syncing' || verifyStatus === 'verifying' || verifyStatus === null}
                            className={cn(
                                "flex-1 py-2 px-4 rounded-xl font-bold transition-colors flex items-center justify-center gap-2",
                                verifyStatus === 'syncing' || verifyStatus === 'verifying' || verifyStatus === null
                                    ? "bg-primary/50 text-primary-foreground/50 cursor-not-allowed"
                                    : "bg-primary hover:bg-primary/80 text-primary-foreground cursor-pointer"
                            )}
                        >
                            <ArrowUpRight className="w-4 h-4" />
                            Send
                        </button>
                    </div>
                </div>
            </div>

            {/* Transaction History */}
            <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex items-baseline gap-2 px-1 mb-3 shrink-0">
                    <h3 className="text-base font-bold text-foreground">History</h3>
                    <span className="text-xs text-muted-foreground">Latest transactions</span>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1 pb-[100px]">
                    {history.filter(item => item.amount > 0).length === 0 ? (
                        <div className="p-6 text-center text-muted-foreground text-sm">
                            No transaction history found.
                        </div>
                    ) : (
                        history.filter(item => item.amount > 0).map(item => {
                            const displayNpub = item.type === 'receive' ? item.sender : item.recipient;
                            const profile = displayNpub ? profiles.get(displayNpub) : null;

                            return (
                                <button
                                    key={item.id}
                                    onClick={() => setSelectedTransaction(item)}
                                    className="w-full text-left bg-card border border-border rounded-xl p-3 flex items-center justify-between hover:border-primary/50 transition-colors cursor-pointer"
                                >
                                    <div className="flex items-center gap-3 flex-1 min-w-0">
                                        <div className={cn(
                                            "p-2 rounded-full flex-shrink-0",
                                            item.type === 'receive' ? 'bg-green-500/10 text-green-500' : 'bg-primary/10 text-primary'
                                        )}>
                                            {item.type === 'receive' ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                                        </div>

                                        {displayNpub ? (
                                            <div className="flex items-center gap-2 flex-1 min-w-0">
                                                {profile?.picture ? (
                                                    <img src={profile.picture} alt={profile.name || ''} className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
                                                ) : (
                                                    <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
                                                        <User className="w-4 h-4 text-muted-foreground" />
                                                    </div>
                                                )}
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-xs text-muted-foreground">
                                                            {item.type === 'receive' ? 'from' : 'to'}
                                                        </span>
                                                        <span className="font-bold text-foreground truncate">
                                                            {profile?.name || profile?.display_name || `${displayNpub.slice(0, 8)}...${displayNpub.slice(-6)}`}
                                                        </span>
                                                        {profile?.nip05 && (
                                                            <CircleCheckBig className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                                                        )}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground">
                                                        {new Date(item.timestamp * 1000).toLocaleDateString()}
                                                    </div>
                                                </div>
                                            </div>
                                        ) : (
                                            <div>
                                                <div className="font-bold text-foreground">
                                                    {item.type === 'receive' ? 'Received' : 'Sent'}
                                                    {item.isNutzap ? ' NutZap' : ' eCash'}
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                    {new Date(item.timestamp * 1000).toLocaleDateString()}
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    <div className="text-right flex-shrink-0 ml-3">
                                        <span className={cn(
                                            "font-bold",
                                            item.type === 'receive' ? 'text-green-500' : 'text-foreground'
                                        )}>
                                            {item.type === 'receive' ? '+' : '-'}{item.amount} sats
                                        </span>
                                    </div>
                                </button>
                            );
                        })
                    )}
                </div>
            </div>

            {/* Modals */}
            <EcashReceiveModal
                isOpen={showReceive}
                onClose={() => {
                    setShowReceive(false);
                }}
            />
            <EcashSendModal
                isOpen={showSend}
                onClose={() => {
                    setShowSend(false);
                    setSendRecipient('');
                    if (onSendComplete) onSendComplete();
                }}
                initialRecipient={sendRecipient}
                activePubkey={activePubkey}
            />
            <MintsModal isOpen={showMintsModal} onClose={() => setShowMintsModal(false)} />
            <ProofsModal isOpen={showProofsModal} onClose={() => setShowProofsModal(false)} />
            <PendingSendsModal
                isOpen={showPendingSends}
                onClose={() => setShowPendingSends(false)}
                activePubkey={activePubkey}
            />
            <EcashTransactionDetailsModal
                isOpen={!!selectedTransaction}
                onClose={() => setSelectedTransaction(null)}
                transaction={selectedTransaction}
            />

            {/* Offline Warning Modal */}
            {showOfflineWarning && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                    <div className="bg-card border border-border rounded-2xl w-full max-w-md p-6 shadow-2xl">
                        <div className="flex items-center gap-3 mb-4">
                            <AlertTriangle className="w-6 h-6 text-yellow-500" />
                            <h3 className="text-xl font-bold text-foreground">Balance Unverified</h3>
                        </div>
                        <p className="text-muted-foreground mb-3">
                            Could not fetch your latest wallet state from Nostr relays.
                        </p>
                        <p className="text-muted-foreground mb-6 text-sm">
                            The displayed balance is from your local cache and may be incorrect. Sending may fail if proofs were already spent from another device.
                        </p>
                        <button
                            onClick={() => setShowOfflineWarning(false)}
                            className="w-full px-4 py-2 bg-primary hover:bg-primary/80 text-primary-foreground font-bold rounded-lg transition-colors cursor-pointer"
                        >
                            I Understand
                        </button>
                    </div>
                </div>
            )}

            {/* Consolidation Result Modal */}
            {consolidateResult && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                    <div className="bg-card border border-border rounded-2xl w-full max-w-md p-6 shadow-2xl">
                        <h3 className="text-xl font-bold text-foreground mb-4">
                            {consolidateResult.success ? '✅ Consolidation Complete' : '❌ Consolidation Failed'}
                        </h3>
                        {consolidateResult.success ? (
                            <p className="text-muted-foreground mb-6">
                                Successfully consolidated <span className="text-primary font-bold">{consolidateResult.count}</span> proofs!
                                <br />
                                Your wallet now has fewer, more efficient proofs.
                            </p>
                        ) : (
                            <p className="text-muted-foreground mb-6">
                                Failed to consolidate proofs. Please try again.
                            </p>
                        )}
                        <button
                            onClick={() => setConsolidateResult(null)}
                            className="w-full px-4 py-2 bg-primary hover:bg-primary/80 text-primary-foreground font-bold rounded-lg transition-colors cursor-pointer"
                        >
                            Close
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
