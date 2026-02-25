import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
    Plus, RefreshCw, CheckCircle, Clock, Loader2, AlertTriangle, Copy, User, AtSign,
    ArrowRight, X,
} from 'lucide-react';
import { dnnService, type DnnName, type PendingName, getMinimumDnnIdAmount } from '@/services/dnn';
import { privateKeyToBitcoinAddress } from '@/services/bitcoin';
import { AcquireIdModal } from './AcquireIdModal';
import { ClaimIdModal } from './ClaimIdModal';
import { cn } from '@/lib/utils';
import { useFeedback } from '@/components/ui/feedback';

interface IdsViewProps {
    activePubkey: string | null;
    activeNpub?: string;
    onNavigateToWallet?: (recipient: string, feeRate?: number, amount?: number) => void;
}

interface ProfileMeta {
    name?: string;
    display_name?: string;
    about?: string;
    picture?: string;
    banner?: string;
    nip05?: string;
    lud16?: string;
    website?: string;
    [key: string]: any;
}

interface SignerState {
    running: boolean;
    relays: { url: string; connected: boolean }[];
    connections: any[];
    pending_requests: any[];
    upv2_login_key: any;
    upv2_sessions: any[];
    login_attempts: any[];
}

const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];

async function fetchKind0(pubkey: string, relayUrls: string[]): Promise<ProfileMeta | null> {
    const urls = relayUrls.length > 0 ? relayUrls : DEFAULT_RELAYS;
    const subId = 'prof_' + Math.random().toString(36).slice(2, 8);

    return new Promise((resolve) => {
        let best: { created_at: number; meta: ProfileMeta } | null = null;
        let resolved = false;
        const sockets: WebSocket[] = [];

        const finish = () => {
            if (resolved) return;
            resolved = true;
            sockets.forEach(s => { try { s.close(); } catch { } });
            resolve(best?.meta ?? null);
        };

        setTimeout(finish, 6000);

        for (const url of urls) {
            try {
                const ws = new WebSocket(url);
                sockets.push(ws);

                ws.onopen = () => {
                    ws.send(JSON.stringify(['REQ', subId, { kinds: [0], authors: [pubkey], limit: 1 }]));
                };

                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'EVENT' && data[2]) {
                            const event = data[2];
                            const createdAt = event.created_at ?? 0;
                            if (!best || createdAt > best.created_at) {
                                best = { created_at: createdAt, meta: JSON.parse(event.content) };
                            }
                        }
                        if (data[0] === 'EOSE') {
                            ws.close();
                        }
                    } catch { }
                };

                ws.onerror = () => ws.close();
            } catch { }
        }
    });
}

async function publishToRelays(signedEventJson: string, relayUrls: string[]): Promise<void> {
    const urls = relayUrls.length > 0 ? relayUrls : DEFAULT_RELAYS;
    const event = JSON.parse(signedEventJson);
    const msg = JSON.stringify(['EVENT', event]);

    await Promise.allSettled(urls.map(url => new Promise<void>((resolve) => {
        try {
            const ws = new WebSocket(url);
            ws.onopen = () => { ws.send(msg); setTimeout(() => { ws.close(); resolve(); }, 2000); };
            ws.onerror = () => { ws.close(); resolve(); };
            setTimeout(() => { try { ws.close(); } catch { } resolve(); }, 5000);
        } catch { resolve(); }
    })));
}

const toCamelCase = (str: string): string => {
    if (!str) return '';
    return str.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
};

export function IdsView({ activePubkey, activeNpub, onNavigateToWallet }: IdsViewProps) {
    const { toast } = useFeedback();

    const [confirmedNames, setConfirmedNames] = useState<DnnName[]>([]);
    const [pendingNames, setPendingNames] = useState<PendingName[]>([]);
    const [namesLoading, setNamesLoading] = useState(false);
    const [nodesLoading, setNodesLoading] = useState(false);
    const [serviceReady, setServiceReady] = useState(false);

    const [showAcquireModal, setShowAcquireModal] = useState(false);
    const [showClaimModal, setShowClaimModal] = useState(false);
    const [showDnnWarning, setShowDnnWarning] = useState(false);
    const [selectedPendingName, setSelectedPendingName] = useState<PendingName | null>(null);
    const [activeTab, setActiveTab] = useState<'confirmed' | 'pending'>('confirmed');

    // Handle modal state
    const [handleModalName, setHandleModalName] = useState<string | null>(null);
    const [profileData, setProfileData] = useState<ProfileMeta | null>(null);
    const [currentNip05, setCurrentNip05] = useState<string | null>(null);
    const [profileLoading, setProfileLoading] = useState(false);
    const [updatingHandle, setUpdatingHandle] = useState(false);
    const [relayUrls, setRelayUrls] = useState<string[]>([]);

    // Get relay URLs from signer state
    useEffect(() => {
        const unlisten = listen<SignerState>('signer-state', (event) => {
            setRelayUrls(event.payload.relays.map(r => r.url));
        });
        invoke<SignerState>('get_signer_state')
            .then(s => setRelayUrls(s.relays.map(r => r.url)))
            .catch(() => { });
        return () => { unlisten.then(fn => fn()); };
    }, []);

    // Fetch current NIP-05 on mount and when pubkey changes
    useEffect(() => {
        if (!activePubkey) return;
        (async () => {
            try {
                const profile = await fetchKind0(activePubkey, relayUrls);
                if (profile) {
                    setCurrentNip05(profile.nip05 || null);
                    setProfileData(profile);
                }
            } catch { }
        })();
    }, [activePubkey, relayUrls]);

    // Initialize DNN service on mount
    useEffect(() => {
        (async () => {
            setNodesLoading(true);
            try {
                await dnnService.initialize();
                setServiceReady(true);
            } catch (e) {
                console.error('[IdsView] Failed to initialize DNN service:', e);
            } finally {
                setNodesLoading(false);
            }
        })();
    }, []);

    // Fetch names when service is ready and keypair changes
    useEffect(() => {
        if (serviceReady && activeNpub) {
            fetchNames();
        }
    }, [serviceReady, activeNpub]);

    const fetchNames = async () => {
        if (!activeNpub || !activePubkey) return;
        setNamesLoading(true);
        try {
            // Fetch confirmed names
            const confirmed = await dnnService.getUserNames(activeNpub);
            setConfirmedNames(confirmed);

            // Fetch pending names — need hex pubkey
            const pending = await dnnService.getPendingNames(activePubkey);
            setPendingNames(pending);
        } catch (e) {
            console.error('[IdsView] Failed to fetch names:', e);
        } finally {
            setNamesLoading(false);
        }
    };

    const handleRefresh = async () => {
        setNodesLoading(true);
        try {
            await dnnService.checkNodes();
            await dnnService.discoverPeers();
        } catch (e) {
            console.error('[IdsView] Failed to refresh nodes:', e);
        } finally {
            setNodesLoading(false);
        }
        await fetchNames();
    };

    const handleClaimClick = (pendingName: PendingName) => {
        setSelectedPendingName(pendingName);
        setShowClaimModal(true);
    };

    const openHandleModal = async (dnnId: string) => {
        setHandleModalName(dnnId);
        setProfileLoading(true);
        try {
            if (activePubkey) {
                const profile = await fetchKind0(activePubkey, relayUrls);
                if (profile) {
                    setProfileData(profile);
                    setCurrentNip05(profile.nip05 || null);
                }
            }
        } catch { }
        setProfileLoading(false);
    };

    const confirmSetHandle = async () => {
        if (!handleModalName || !activePubkey) return;
        setUpdatingHandle(true);
        try {
            // Build updated profile — keep all existing fields, only change nip05
            const updatedProfile = { ...(profileData || {}), nip05: handleModalName };
            const content = JSON.stringify(updatedProfile);

            // Sign via Tauri backend
            const signedJson = await invoke<string>('sign_event_local', {
                kind: 0,
                content,
                tags: [],
            });

            // Publish to relays
            await publishToRelays(signedJson, relayUrls);

            setCurrentNip05(handleModalName);
            setProfileData(updatedProfile);
            setHandleModalName(null);
            toast('NIP-05 handle updated!', 'success');
        } catch (e: any) {
            toast('Failed to update handle: ' + e, 'error');
        }
        setUpdatingHandle(false);
    };

    const totalNames = confirmedNames.length + pendingNames.length;
    const hasNoNames = totalNames === 0 && !namesLoading;

    if (!activePubkey) {
        return (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
                <AtSign className="w-10 h-10 opacity-40" />
                <p className="text-sm">Select an account to view DNN IDs</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4 h-full overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold text-foreground">DNN IDs</h2>
                    <button
                        onClick={() => setShowDnnWarning(true)}
                        className="px-2 py-0.5 text-[10px] font-bold text-primary bg-primary/10 border border-primary/30 rounded cursor-pointer hover:bg-primary/20 transition-colors"
                    >
                        READ ME
                    </button>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleRefresh}
                        disabled={namesLoading || nodesLoading}
                        className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
                        title="Refresh"
                    >
                        <RefreshCw className={cn("w-5 h-5", (namesLoading || nodesLoading) && "animate-spin")} />
                    </button>
                    <button
                        onClick={() => setShowAcquireModal(true)}
                        className="flex items-center gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground font-medium px-3 py-2 rounded-lg transition-colors text-sm cursor-pointer"
                    >
                        <Plus className="w-4 h-4" />
                        Add ID
                    </button>
                </div>
            </div>

            {/* Loading State */}
            {namesLoading && totalNames === 0 && (
                <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-8 h-8 text-primary animate-spin" />
                </div>
            )}

            {/* Empty State */}
            {hasNoNames && (
                <div className="text-center py-12 bg-secondary/30 rounded-xl border border-border">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-secondary flex items-center justify-center">
                        <User className="w-8 h-8 text-muted-foreground" />
                    </div>
                    <p className="text-muted-foreground mb-4">No DNN IDs yet</p>
                    <button
                        onClick={() => setShowAcquireModal(true)}
                        className="inline-flex items-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground font-medium px-4 py-2 rounded-lg transition-colors cursor-pointer"
                    >
                        <Plus className="w-4 h-4" />
                        Get Your First ID
                    </button>
                </div>
            )}

            {/* Names Lists */}
            {!hasNoNames && (
                <div className="flex flex-col flex-1 min-h-0 gap-4">
                    {/* Tabs */}
                    <div className="flex gap-4 border-b border-border">
                        <button
                            onClick={() => setActiveTab('confirmed')}
                            className={cn(
                                "pb-2 text-sm font-medium transition-colors grow cursor-pointer",
                                activeTab === 'confirmed'
                                    ? "text-primary border-b-2 border-primary"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            Confirmed ({confirmedNames.length})
                        </button>
                        <button
                            onClick={() => setActiveTab('pending')}
                            className={cn(
                                "pb-2 text-sm font-medium transition-colors grow cursor-pointer",
                                activeTab === 'pending'
                                    ? "text-primary border-b-2 border-primary"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            Pending ({pendingNames.length})
                        </button>
                    </div>

                    {/* Confirmed Names */}
                    {activeTab === 'confirmed' && (
                        <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pb-[100px]">
                            {confirmedNames.length === 0 ? (
                                <p className="text-center text-muted-foreground py-8">No confirmed IDs</p>
                            ) : (
                                confirmedNames.map((name, idx) => {
                                    const camelId = toCamelCase(name.dnnId || '');
                                    const isActive = currentNip05?.toLowerCase() === camelId.toLowerCase();
                                    return (
                                        <div key={idx} className="bg-card rounded-xl p-4 border border-border">
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-3">
                                                    <span className="font-medium text-foreground">{camelId}</span>
                                                    {name.status === 'confirmed' && <CheckCircle className="w-4 h-4 text-green-400" />}
                                                </div>
                                                <div className="flex items-center gap-1">
                                                    <button
                                                        onClick={() => {
                                                            navigator.clipboard.writeText(camelId);
                                                            toast('ID copied!', 'success');
                                                        }}
                                                        className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors cursor-pointer"
                                                    >
                                                        <Copy className="w-4 h-4" />
                                                    </button>
                                                    {isActive ? (
                                                        <span className="px-2.5 py-1 text-xs font-medium text-green-400 bg-green-400/10 border border-green-400/30 rounded-lg">
                                                            Active
                                                        </span>
                                                    ) : (
                                                        <button
                                                            onClick={() => openHandleModal(camelId)}
                                                            className="px-2.5 py-1 text-xs font-medium text-primary bg-primary/10 border border-primary/30 rounded-lg hover:bg-primary/20 transition-colors cursor-pointer"
                                                        >
                                                            Set as Handle
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                            <p className="text-xs text-muted-foreground mt-1">
                                                DNN Block: {name.dnnBlock} • Position: {name.position}
                                            </p>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    )}

                    {/* Pending Names */}
                    {activeTab === 'pending' && (
                        <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pb-[100px]">
                            {pendingNames.length === 0 ? (
                                <p className="text-center text-muted-foreground py-8">No pending IDs</p>
                            ) : (
                                pendingNames.map((name, idx) => (
                                    <div key={idx} className="bg-card rounded-xl p-4 border border-primary/30">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-3">
                                                <Clock className="w-4 h-4 text-primary" />
                                                <span className="font-medium text-foreground">{toCamelCase(name.dnnId || '')}</span>
                                            </div>
                                            <button
                                                onClick={() => handleClaimClick(name)}
                                                className="px-3 py-1 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-lg transition-colors cursor-pointer"
                                            >
                                                Claim
                                            </button>
                                        </div>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            Ready to claim on-chain
                                        </p>
                                    </div>
                                ))
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Acquire Modal */}
            {showAcquireModal && (
                <AcquireIdModal
                    onClose={() => setShowAcquireModal(false)}
                    onOpenSend={async () => {
                        setShowAcquireModal(false);
                        if (activePubkey && onNavigateToWallet) {
                            try {
                                const hex = await invoke<string>('export_private_key_hex', { pubkey: activePubkey });
                                if (hex) {
                                    const myAddress = privateKeyToBitcoinAddress(hex);
                                    onNavigateToWallet(myAddress, 1, getMinimumDnnIdAmount());
                                }
                            } catch (e) {
                                console.error('[IdsView] Failed to get address for self-transfer:', e);
                            }
                        }
                    }}
                />
            )}

            {/* Claim Modal */}
            {showClaimModal && selectedPendingName && activePubkey && (
                <ClaimIdModal
                    pendingName={selectedPendingName}
                    activePubkey={activePubkey}
                    onClose={() => {
                        setShowClaimModal(false);
                        setSelectedPendingName(null);
                    }}
                    onSuccess={() => {
                        setShowClaimModal(false);
                        setSelectedPendingName(null);
                        fetchNames();
                    }}
                />
            )}

            {/* Set as Handle Modal */}
            {handleModalName && (
                <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                    <div className="flex min-h-full items-center justify-center px-4 py-20">
                        <div className="bg-card rounded-2xl p-6 max-w-md w-full border border-border shadow-2xl">
                            {/* Header */}
                            <div className="flex items-center justify-between mb-5">
                                <h3 className="text-lg font-bold text-foreground">Set as NIP-05 Handle</h3>
                                <button
                                    onClick={() => setHandleModalName(null)}
                                    className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors cursor-pointer"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>

                            {profileLoading ? (
                                <div className="flex items-center justify-center py-10">
                                    <Loader2 className="w-6 h-6 text-primary animate-spin" />
                                </div>
                            ) : (
                                <>
                                    {/* Current NIP-05 */}
                                    <div className="space-y-3 mb-5">
                                        <div className="bg-secondary/50 rounded-xl p-4 border border-border">
                                            <p className="text-xs text-muted-foreground mb-1.5">Current NIP-05</p>
                                            <p className={cn(
                                                "text-sm font-medium",
                                                currentNip05 ? "text-foreground" : "text-muted-foreground italic"
                                            )}>
                                                {currentNip05 || 'Not set'}
                                            </p>
                                        </div>

                                        {/* Arrow */}
                                        <div className="flex justify-center">
                                            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                                                <ArrowRight className="w-4 h-4 text-primary rotate-90" />
                                            </div>
                                        </div>

                                        {/* New NIP-05 */}
                                        <div className="bg-primary/5 rounded-xl p-4 border border-primary/30">
                                            <p className="text-xs text-muted-foreground mb-1.5">New NIP-05</p>
                                            <p className="text-sm font-medium text-primary">
                                                {handleModalName}
                                            </p>
                                        </div>
                                    </div>

                                    <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
                                        This will update your Nostr profile's NIP-05 field. All other profile data will remain unchanged.
                                    </p>

                                    {/* Actions */}
                                    <div className="flex gap-3">
                                        <button
                                            onClick={() => setHandleModalName(null)}
                                            className="flex-1 py-2.5 bg-secondary hover:bg-secondary/80 text-foreground font-medium rounded-xl transition-colors cursor-pointer text-sm"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={confirmSetHandle}
                                            disabled={updatingHandle}
                                            className="flex-1 py-2.5 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-xl transition-colors cursor-pointer text-sm disabled:opacity-50 flex items-center justify-center gap-2"
                                        >
                                            {updatingHandle ? (
                                                <>
                                                    <Loader2 className="w-4 h-4 animate-spin" />
                                                    Updating…
                                                </>
                                            ) : (
                                                'Confirm'
                                            )}
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* DNN Warning Modal */}
            {showDnnWarning && (
                <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                    <div className="flex min-h-full items-center justify-center px-4 py-20">
                        <div className="bg-card rounded-2xl p-6 max-w-md w-full border border-border shadow-2xl">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center">
                                    <AlertTriangle className="w-6 h-6 text-primary" />
                                </div>
                                <h3 className="text-xl font-bold text-foreground">DNN Early Development</h3>
                            </div>
                            <div className="bg-secondary/50 rounded-xl p-4 border border-border mb-4">
                                <p className="text-muted-foreground text-sm leading-relaxed mb-3">
                                    DNN (Decentralized Naming Network) is still in <strong className="text-primary">early development</strong> and actively being tested.
                                </p>
                                <p className="text-muted-foreground text-sm leading-relaxed">
                                    Things will change and you will <strong>most likely not keep</strong> the IDs you acquire during this testing phase. The network may be reset, names may be reassigned, and features may change significantly.
                                </p>
                            </div>
                            <button
                                onClick={() => setShowDnnWarning(false)}
                                className="w-full py-3 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-xl transition-colors cursor-pointer"
                            >
                                I Understand
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
