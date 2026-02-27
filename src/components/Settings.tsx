import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import {
    Radio, X, Plus, Info, Terminal, ChevronRight, ArrowLeft, Shield, Eye, EyeOff, Users,
    Copy, Check, RefreshCw, Heart, Bitcoin, Banknote, ChevronDown, Sun, Moon, Palette, Store, Network, Lock,
    Play, GraduationCap, Cloud, Download,
} from 'lucide-react';
import { useFeedback } from '@/components/ui/feedback';
import { KeypairManager } from '@/components/KeypairManager';
import { bitcoinNodes } from '@/services/bitcoin';
import { blossomServers } from '@/services/blossomServers';
import type { AppState } from '@/App';
import { fetchNostrProfile, type NostrProfile } from '@/services/nostrProfile';
import { dnnService } from '@/services/dnn';
import { nip19 } from 'nostr-tools';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { QRCodeSVG } from 'qrcode.react';
import { npubToTaprootAddress } from '@/services/bitcoin';

interface RelayInfo {
    url: string;
    connected: boolean;
}

interface SignerState {
    running: boolean;
    relays: RelayInfo[];
    user_relays: RelayInfo[];
    connections: any[];
    pending_requests: any[];
    upv2_login_key: any;
    upv2_sessions: any[];
    login_attempts: any[];
}

type SubPage = 'accounts' | 'relays' | 'debug' | 'about' | 'security' | 'preferences' | 'merchant' | 'currency-nodes' | 'tutorials' | 'blossom' | null;

interface Props {
    logs: string[];
    appState: AppState;
    onNavigateToWallet?: (recipient: string) => void;
    onNavigateToEcashSend?: (recipient: string) => void;
    onLock?: () => void;
}

export function Settings({ logs, appState, onNavigateToWallet, onNavigateToEcashSend, onLock }: Props) {
    const [signerState, setSignerState] = useState<SignerState | null>(null);
    const [newRelay, setNewRelay] = useState('');
    const [addingRelay, setAddingRelay] = useState(false);
    const [newUserRelay, setNewUserRelay] = useState('');
    const [addingUserRelay, setAddingUserRelay] = useState(false);
    const [publishingRelays, setPublishingRelays] = useState(false);
    const [fetchingUserRelays, setFetchingUserRelays] = useState(false);
    const publishedUserRelaysRef = useRef<string[] | null>(null);
    const [subPage, setSubPage] = useState<SubPage>(null);
    const { toast } = useFeedback();
    const bottomRef = useRef<HTMLDivElement>(null);
    const [lightMode, setLightMode] = useState(() => localStorage.getItem('denos-theme') === 'light');

    // Apply theme class on mount and when toggled
    useEffect(() => {
        document.documentElement.classList.toggle('light', lightMode);
        localStorage.setItem('denos-theme', lightMode ? 'light' : 'dark');
    }, [lightMode]);

    useEffect(() => {
        const unlisten = listen<SignerState>('signer-state', (event) => setSignerState(event.payload));
        invoke<SignerState>('get_signer_state').then(setSignerState).catch(() => { });
        return () => { unlisten.then(fn => fn()); };
    }, []);

    useEffect(() => {
        if (subPage === 'debug') bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs, subPage]);

    // Initialize the published baseline from the auto-fetched state
    useEffect(() => {
        if (signerState && signerState.user_relays.length > 0 && publishedUserRelaysRef.current === null) {
            publishedUserRelaysRef.current = signerState.user_relays.map(r => r.url).sort();
        }
    }, [signerState]);

    const relays = signerState?.relays ?? [];

    const handleAddRelay = async () => {
        let url = newRelay.trim();
        if (!url) return;
        if (!url.startsWith('wss://') && !url.startsWith('ws://')) url = 'wss://' + url;
        setAddingRelay(true);
        try {
            await invoke('add_relay', { url });
            setNewRelay('');
        } catch (e: any) {
            toast('Error adding relay: ' + e);
        }
        setAddingRelay(false);
    };

    const handleRemoveRelay = async (url: string) => {
        try { await invoke('remove_relay', { url }); } catch (e: any) { toast('Error: ' + e); }
    };

    /* ── Sub-pages ── */

    if (subPage === 'accounts') {
        return (
            <div className="animate-fade-in">
                <KeypairManager appState={appState} onBack={() => setSubPage(null)} />
            </div>
        );
    }

    // ── Currency Nodes sub-page ──
    if (subPage === 'currency-nodes') {
        return <CurrencyNodesSubPage onBack={() => setSubPage(null)} />;
    }

    if (subPage === 'relays') {
        const userRelays = signerState?.user_relays ?? [];

        const handleAddUserRelay = async () => {
            let url = newUserRelay.trim();
            if (!url) return;
            if (!url.startsWith('wss://') && !url.startsWith('ws://')) url = 'wss://' + url;
            setAddingUserRelay(true);
            try {
                await invoke('add_user_relay', { url });
                setNewUserRelay('');
            } catch (e: any) {
                toast('Error adding user relay: ' + e);
            }
            setAddingUserRelay(false);
        };

        const handleRemoveUserRelay = async (url: string) => {
            try { await invoke('remove_user_relay', { url }); } catch (e: any) { toast('Error: ' + e); }
        };

        const handlePublish = async () => {
            setPublishingRelays(true);
            try {
                await invoke('publish_user_relays');
                publishedUserRelaysRef.current = userRelays.map(r => r.url).sort();
                toast('Relay list published!', 'success');
            } catch (e: any) {
                toast('Error publishing: ' + e);
            }
            setPublishingRelays(false);
        };

        const handleFetchUserRelays = async () => {
            setFetchingUserRelays(true);
            try {
                const fetched = await invoke<string[]>('fetch_user_relays');
                if (fetched.length > 0) {
                    publishedUserRelaysRef.current = fetched.sort();
                    toast(`Fetched ${fetched.length} relay(s) from Nostr`, 'success');
                } else {
                    toast('No relay list found on Nostr');
                }
            } catch (e: any) {
                toast('Error fetching: ' + e);
            }
            setFetchingUserRelays(false);
        };

        const currentUrls = userRelays.map(r => r.url).sort();
        const publishedUrls = publishedUserRelaysRef.current;
        const isDirty = publishedUrls === null
            ? userRelays.length > 0
            : JSON.stringify(currentUrls) !== JSON.stringify(publishedUrls);

        return (
            <div className="space-y-4 pb-[100px] animate-fade-in">
                <button
                    onClick={() => setSubPage(null)}
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                    <ArrowLeft className="w-4 h-4" /> Back
                </button>

                {/* Signer's local relays */}
                <Card>
                    <CardContent className="pt-4">
                        <div className="flex items-center justify-between mb-3">
                            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Signer's local relays</div>
                            <button
                                onClick={async () => { try { await invoke('reset_relays'); toast('Relays reset to defaults', 'success'); } catch (e: any) { toast('Error: ' + e, 'error'); } }}
                                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                            >Reset</button>
                        </div>

                        <div className="flex gap-2 mb-3">
                            <Input
                                value={newRelay}
                                onChange={e => setNewRelay(e.target.value)}
                                placeholder="wss://..."
                                className="flex-1 h-9 text-sm"
                                onKeyDown={e => e.key === 'Enter' && handleAddRelay()}
                            />
                            <Button
                                size="sm"
                                className="h-9"
                                onClick={handleAddRelay}
                                disabled={addingRelay || !newRelay.trim()}
                            >
                                <Plus className="w-4 h-4" /> Add
                            </Button>
                        </div>

                        {relays.length === 0 ? (
                            <div className="py-4 text-center text-sm text-muted-foreground">
                                No relays configured. Add one above.
                            </div>
                        ) : (
                            <div className="divide-y divide-border">
                                {relays.map(relay => (
                                    <div key={relay.url} className="flex items-center gap-3 py-3 first:pt-0 group">
                                        <div className={cn(
                                            "w-2 h-2 rounded-full shrink-0",
                                            relay.connected ? "bg-success" : "bg-muted-foreground"
                                        )} />
                                        <span className="text-sm truncate flex-1">{relay.url}</span>
                                        <Badge variant="secondary" className="text-[10px] shrink-0">
                                            {relay.connected ? 'connected' : 'offline'}
                                        </Badge>
                                        <button
                                            className="text-muted-foreground hover:text-destructive transition-all cursor-pointer shrink-0 p-1"
                                            onClick={() => handleRemoveRelay(relay.url)}
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* User's relays (NIP-65) */}
                <Card>
                    <CardContent className="pt-4">
                        <div className="flex items-center justify-between mb-3">
                            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">User's relays</div>
                            <button
                                onClick={handleFetchUserRelays}
                                disabled={fetchingUserRelays}
                                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
                            >
                                <RefreshCw className={cn("w-3 h-3", fetchingUserRelays && "animate-spin")} />
                                Fetch from Nostr
                            </button>
                        </div>

                        <div className="flex gap-2 mb-3">
                            <Input
                                value={newUserRelay}
                                onChange={e => setNewUserRelay(e.target.value)}
                                placeholder="wss://..."
                                className="flex-1 h-9 text-sm"
                                onKeyDown={e => e.key === 'Enter' && handleAddUserRelay()}
                            />
                            <Button
                                size="sm"
                                className="h-9"
                                onClick={handleAddUserRelay}
                                disabled={addingUserRelay || !newUserRelay.trim()}
                            >
                                <Plus className="w-4 h-4" /> Add
                            </Button>
                        </div>

                        {userRelays.length === 0 ? (
                            <div className="py-4 text-center text-sm text-muted-foreground">
                                No user relays. Fetch from Nostr or add manually.
                            </div>
                        ) : (
                            <div className="divide-y divide-border">
                                {userRelays.map(relay => (
                                    <div key={relay.url} className="flex items-center gap-3 py-3 first:pt-0 group">
                                        <div className={cn(
                                            "w-2 h-2 rounded-full shrink-0",
                                            relay.connected ? "bg-success" : "bg-muted-foreground"
                                        )} />
                                        <span className="text-sm truncate flex-1">{relay.url}</span>
                                        <Badge variant="secondary" className="text-[10px] shrink-0">
                                            {relay.connected ? 'connected' : 'offline'}
                                        </Badge>
                                        <button
                                            className="text-muted-foreground hover:text-destructive transition-all cursor-pointer shrink-0 p-1"
                                            onClick={() => handleRemoveUserRelay(relay.url)}
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="pt-3 mt-2 border-t border-border">
                            <Button
                                size="sm"
                                className="w-full"
                                onClick={handlePublish}
                                disabled={publishingRelays || !isDirty}
                            >
                                {publishingRelays ? 'Publishing…' : 'Save / Publish'}
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (subPage === 'debug') {
        return (
            <div className="space-y-4 animate-fade-in">
                <button
                    onClick={() => setSubPage(null)}
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                    <ArrowLeft className="w-4 h-4" /> Back
                </button>

                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Terminal className="w-4.5 h-4.5" />
                            Debug Console
                        </CardTitle>
                        <Badge variant="secondary">{logs.length}</Badge>
                    </CardHeader>
                    <CardContent>
                        <div className="bg-background rounded-lg p-3 max-h-[60vh] overflow-y-auto font-mono text-xs leading-relaxed">
                            {logs.length === 0 ? (
                                <div className="text-muted-foreground text-center py-6">
                                    Waiting for log events…
                                </div>
                            ) : (
                                logs.map((log, i) => (
                                    <div
                                        key={i}
                                        className={cn(
                                            "border-b border-border py-0.5",
                                            log.includes('ERROR') ? 'text-destructive' :
                                                log.includes('WARN') ? 'text-warning' :
                                                    log.includes('INFO') ? 'text-success' :
                                                        'text-muted-foreground'
                                        )}
                                    >
                                        {log}
                                    </div>
                                ))
                            )}
                            <div ref={bottomRef} />
                        </div>
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (subPage === 'about') {
        return <AboutPage onBack={() => setSubPage(null)} toast={toast} onNavigateToWallet={onNavigateToWallet} onNavigateToEcashSend={onNavigateToEcashSend} appState={appState} />;
    }

    if (subPage === 'preferences') {
        return (
            <div className="space-y-4 animate-fade-in">
                <button
                    onClick={() => setSubPage(null)}
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                    <ArrowLeft className="w-4 h-4" /> Back
                </button>

                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Palette className="w-4.5 h-4.5" />
                            Preferences
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center">
                                    {lightMode ? <Sun className="w-4.5 h-4.5 text-warning" /> : <Moon className="w-4.5 h-4.5 text-primary" />}
                                </div>
                                <div>
                                    <p className="text-sm font-medium">Light Mode</p>
                                    <p className="text-xs text-muted-foreground">{lightMode ? 'Light theme active' : 'Dark theme active'}</p>
                                </div>
                            </div>
                            <Switch checked={lightMode} onCheckedChange={setLightMode} />
                        </div>
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (subPage === 'security') {
        return <SecuritySettings onBack={() => setSubPage(null)} toast={toast} appState={appState} onLock={onLock} />;
    }

    if (subPage === 'tutorials') {
        return <TutorialsPage onBack={() => setSubPage(null)} />;
    }

    if (subPage === 'blossom') {
        return <BlossomServersPage onBack={() => setSubPage(null)} toast={toast} />;
    }

    if (subPage === 'merchant') {
        return (
            <div className="space-y-4 animate-fade-in">
                <button
                    onClick={() => setSubPage(null)}
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                    <ArrowLeft className="w-4 h-4" /> Back
                </button>

                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Store className="w-4.5 h-4.5" />
                            Merchant
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div>
                                    <p className="text-sm font-medium">Commerce Page</p>
                                    <p className="text-xs text-muted-foreground">Enable to show Commerce in navigation</p>
                                </div>
                            </div>
                            <Switch
                                checked={localStorage.getItem('denos-commerce-enabled') === 'true'}
                                onCheckedChange={(checked) => {
                                    localStorage.setItem('denos-commerce-enabled', String(checked));
                                    window.dispatchEvent(new Event('commerce-toggle'));
                                }}
                            />
                        </div>
                    </CardContent>
                </Card>
            </div>
        );
    }

    /* ── Menu List ── */
    const menuItems: { id: SubPage; label: string; desc: string; icon: typeof Radio; badge?: string }[] = [
        { id: 'accounts', label: 'Accounts', desc: `${appState.keypairs.length} keypairs`, icon: Users },
        { id: 'security', label: 'Security', desc: 'PIN lock & auto-lock', icon: Shield },
        { id: 'preferences', label: 'Preferences', desc: 'Theme & display', icon: Palette },
        {
            id: 'relays', label: 'Relays', desc: (() => {
                const userRelays = signerState?.user_relays ?? [];
                const signerUrlSet = new Set(relays.map(r => r.url.replace(/\/$/, '')));
                const extra = userRelays.filter(r => !signerUrlSet.has(r.url.replace(/\/$/, '')));
                return `${relays.length + extra.length} configured`;
            })(), icon: Radio, badge: (() => {
                const userRelays = signerState?.user_relays ?? [];
                const signerUrlSet = new Set(relays.map(r => r.url.replace(/\/$/, '')));
                const extra = userRelays.filter(r => !signerUrlSet.has(r.url.replace(/\/$/, '')));
                const total = relays.length + extra.length;
                const connected = relays.filter(r => r.connected).length + extra.filter(r => r.connected).length;
                return `${connected}/${total}`;
            })()
        },
        { id: 'currency-nodes', label: 'Network Currency Nodes', desc: 'Network node connections', icon: Network },
        { id: 'debug', label: 'Debug Console', desc: `${logs.length} log entries`, icon: Terminal },
        { id: 'merchant', label: 'Merchant', desc: 'Manage commercial settings', icon: Store },
        { id: 'blossom', label: 'Blossom Servers', desc: 'Media server fallbacks', icon: Cloud },
        { id: 'tutorials', label: 'Tutorials', desc: 'Learn how to use DENOS', icon: GraduationCap },
        { id: 'about', label: 'About DENOS', desc: 'Version 0.1', icon: Info },
    ];



    return (
        <div className="space-y-4">

            <Card>
                <CardContent className="pt-4 divide-y divide-border">
                    {menuItems.map(({ id, label, desc, icon: Icon, badge }) => (
                        <button
                            key={id}
                            onClick={() => setSubPage(id)}
                            className="flex items-center gap-3 w-full py-4 first:pt-0 last:pb-0 cursor-pointer group text-left hover:opacity-80 transition-opacity"
                        >
                            <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                                <Icon className="w-4.5 h-4.5 text-muted-foreground" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium">{label}</p>
                                <p className="text-xs text-muted-foreground">{desc}</p>
                            </div>
                            {badge && (
                                <Badge variant="secondary" className="shrink-0 text-xs">{badge}</Badge>
                            )}
                            <ChevronRight className="w-4.5 h-4.5 text-muted-foreground shrink-0" />
                        </button>
                    ))}
                </CardContent>
            </Card>

            {onLock && (
                <button
                    onClick={onLock}
                    className="flex items-center justify-center gap-2 w-full py-3.5 rounded-xl bg-foreground/10 text-foreground hover:bg-foreground/20 transition-colors cursor-pointer font-medium text-sm"
                >
                    <Lock className="w-4 h-4" />
                    Lock Signer
                </button>
            )}

            <div className="h-[100px]" />
        </div>
    );
}

// ── Security Settings Sub-Page ──
function SecuritySettings({ onBack, toast, appState, onLock }: {
    onBack: () => void;
    toast: (msg: string, type?: 'error' | 'success' | 'info') => void;
    appState: AppState;
    onLock?: () => void;
}) {
    const [step, setStep] = useState<'menu' | 'change-pin' | 'delete-phrase' | 'delete-pin' | 'delete-confirm' | 'delete-countdown'>('menu');
    const [currentPin, setCurrentPin] = useState('');
    const [newPin, setNewPin] = useState('');
    const [confirmPin, setConfirmPin] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [showCurrent, setShowCurrent] = useState(false);
    const [showNew, setShowNew] = useState(false);
    const [lockTimeout, setLockTimeout] = useState(5);

    // Delete flow state
    const [deletePhrase, setDeletePhrase] = useState('');
    const [deletePin1, setDeletePin1] = useState('');
    const [deletePin2, setDeletePin2] = useState('');
    const [deletePin3, setDeletePin3] = useState('');
    const [countdown, setCountdown] = useState(10);
    const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Determine profile number (1-based index in the profiles list)
    const profileIndex = appState.profiles.findIndex(p => p.id === appState.active_profile) + 1;
    const profileNumber = profileIndex > 0 ? profileIndex : 1;
    const requiredPhrase = `Delete PIN Account ${profileNumber}`;

    useEffect(() => {
        invoke<{ lock_timeout_minutes: number }>('get_app_state')
            .then(state => setLockTimeout(state.lock_timeout_minutes))
            .catch(() => { });
    }, []);

    // Countdown logic
    useEffect(() => {
        if (step === 'delete-countdown') {
            setCountdown(10);
            countdownRef.current = setInterval(() => {
                setCountdown(prev => {
                    if (prev <= 1) {
                        if (countdownRef.current) clearInterval(countdownRef.current);
                        // Execute deletion
                        handleDeleteProfile();
                        return 0;
                    }
                    return prev - 1;
                });
            }, 1000);
            return () => {
                if (countdownRef.current) clearInterval(countdownRef.current);
            };
        }
    }, [step]);

    const handleAbortCountdown = () => {
        if (countdownRef.current) clearInterval(countdownRef.current);
        resetDeleteState();
    };

    const resetDeleteState = () => {
        setStep('menu');
        setDeletePhrase('');
        setDeletePin1('');
        setDeletePin2('');
        setDeletePin3('');
        setError('');
    };

    const handleDeleteProfile = async () => {
        try {
            await invoke('delete_profile', {
                profileId: appState.active_profile,
                pin: deletePin1,
            });
            toast('PIN Account deleted permanently', 'success');
            resetDeleteState();
            // Lock the app — will show another profile or creation flow
            if (onLock) onLock();
        } catch (e) {
            toast('Delete failed: ' + String(e), 'error');
            resetDeleteState();
        }
    };

    const handleChangePin = async () => {
        if (currentPin.length !== 8) { setError('Current PIN must be 8 digits'); return; }
        if (newPin.length !== 8 || !/^\d{8}$/.test(newPin)) { setError('New PIN must be 8 digits'); return; }
        if (newPin !== confirmPin) { setError('PINs do not match'); return; }
        setLoading(true);
        try {
            await invoke('change_pin', { currentPin, newPin });
            toast('PIN changed successfully', 'success');
            setStep('menu');
            setCurrentPin(''); setNewPin(''); setConfirmPin(''); setError('');
        } catch (e) {
            setError(String(e));
        }
        setLoading(false);
    };

    const handleSetTimeout = async (minutes: number) => {
        try {
            await invoke('set_lock_timeout', { minutes });
            setLockTimeout(minutes);
            toast(`Auto-lock set to ${minutes} minutes`, 'success');
        } catch (e) {
            toast('Error: ' + e);
        }
    };

    // ── Delete: Step 1 — Type exact phrase ──
    if (step === 'delete-phrase') {
        return (
            <div className="space-y-4 animate-fade-in">
                <button
                    onClick={resetDeleteState}
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                    <ArrowLeft className="w-4 h-4" /> Back
                </button>

                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base text-destructive">
                            <Shield className="w-4.5 h-4.5" />
                            Delete PIN Account {profileNumber}
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <p className="text-sm text-muted-foreground">
                            To proceed, type the exact phrase below (case-sensitive):
                        </p>
                        <div className="bg-destructive/10 rounded-lg px-3 py-2 text-sm font-mono text-destructive text-center select-all">
                            {requiredPhrase}
                        </div>
                        <Input
                            value={deletePhrase}
                            onChange={(e) => { setDeletePhrase(e.target.value); setError(''); }}
                            placeholder="Type the phrase exactly..."
                            className="font-mono text-sm"
                        />
                        {error && <p className="text-xs text-destructive">{error}</p>}
                        <Button
                            variant="destructive"
                            className="w-full"
                            disabled={deletePhrase !== requiredPhrase}
                            onClick={() => {
                                if (deletePhrase === requiredPhrase) {
                                    setError('');
                                    setStep('delete-pin');
                                } else {
                                    setError('Phrase does not match');
                                }
                            }}
                        >
                            Continue
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    // ── Delete: Step 2 — Enter PIN three times ──
    if (step === 'delete-pin') {
        const allMatch = deletePin1.length === 8 && deletePin1 === deletePin2 && deletePin2 === deletePin3;
        return (
            <div className="space-y-4 animate-fade-in">
                <button
                    onClick={() => { setStep('delete-phrase'); setDeletePin1(''); setDeletePin2(''); setDeletePin3(''); setError(''); }}
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                    <ArrowLeft className="w-4 h-4" /> Back
                </button>

                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base text-destructive">
                            <Shield className="w-4.5 h-4.5" />
                            Confirm Your PIN
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <p className="text-sm text-muted-foreground">
                            Enter your PIN for PIN Account {profileNumber} three times to confirm:
                        </p>
                        {[
                            { label: 'PIN (1st entry)', value: deletePin1, setter: setDeletePin1 },
                            { label: 'PIN (2nd entry)', value: deletePin2, setter: setDeletePin2 },
                            { label: 'PIN (3rd entry)', value: deletePin3, setter: setDeletePin3 },
                        ].map(({ label, value, setter }, i) => (
                            <div key={i}>
                                <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
                                <input
                                    type="password"
                                    value={value}
                                    onChange={(e) => { setter(e.target.value.replace(/\D/g, '').slice(0, 8)); setError(''); }}
                                    placeholder="• • • • • • • •"
                                    maxLength={8}
                                    inputMode="numeric"
                                    className="w-full bg-secondary/50 border border-border rounded-xl px-3 py-2.5 text-foreground text-sm tracking-widest font-mono focus:ring-2 focus:ring-primary outline-none"
                                />
                            </div>
                        ))}

                        {error && <p className="text-xs text-destructive">{error}</p>}

                        <Button
                            variant="destructive"
                            className="w-full"
                            disabled={!allMatch}
                            onClick={() => {
                                if (!allMatch) {
                                    setError('All three PINs must match');
                                    return;
                                }
                                setError('');
                                setStep('delete-confirm');
                            }}
                        >
                            Continue
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    // ── Delete: Step 3 — Final warning ──
    if (step === 'delete-confirm') {
        return (
            <div className="space-y-4 animate-fade-in">
                <button
                    onClick={() => setStep('delete-pin')}
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                    <ArrowLeft className="w-4 h-4" /> Back
                </button>

                <Card className="border-destructive/30">
                    <CardContent className="pt-6 space-y-4 text-center">
                        <div className="w-14 h-14 rounded-full bg-destructive/15 flex items-center justify-center mx-auto">
                            <Shield className="w-7 h-7 text-destructive" />
                        </div>
                        <h3 className="text-lg font-bold text-destructive">Are you sure?</h3>
                        <p className="text-sm text-muted-foreground leading-relaxed">
                            This will completely erase all generated and/or imported seeds and keypairs/nsecs under this PIN account{' '}
                            <span className="font-semibold text-foreground">PIN Account {profileNumber}</span>.
                        </p>
                        <p className="text-sm font-bold text-destructive">
                            THIS CANNOT BE UNDONE AND IS PERMANENT
                        </p>
                        <div className="flex gap-3 pt-2">
                            <Button
                                variant="outline"
                                className="flex-1"
                                onClick={resetDeleteState}
                            >
                                Cancel
                            </Button>
                            <Button
                                variant="destructive"
                                className="flex-1"
                                onClick={() => setStep('delete-countdown')}
                            >
                                Confirm Delete
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            </div>
        );
    }

    // ── Delete: Step 4 — Countdown ──
    if (step === 'delete-countdown') {
        const progress = ((10 - countdown) / 10) * 100;
        return (
            <div className="space-y-6 animate-fade-in">
                <Card className="border-destructive/50">
                    <CardContent className="pt-6 space-y-6 text-center">
                        <div className="relative w-28 h-28 mx-auto">
                            {/* Background circle */}
                            <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
                                <circle cx="60" cy="60" r="52" fill="none" stroke="currentColor" strokeWidth="6" className="text-secondary" />
                                <circle
                                    cx="60" cy="60" r="52" fill="none"
                                    stroke="currentColor" strokeWidth="6"
                                    className="text-destructive transition-all duration-1000 ease-linear"
                                    strokeDasharray={`${2 * Math.PI * 52}`}
                                    strokeDashoffset={`${2 * Math.PI * 52 * (1 - progress / 100)}`}
                                    strokeLinecap="round"
                                />
                            </svg>
                            <div className="absolute inset-0 flex items-center justify-center">
                                <span className="text-4xl font-bold text-destructive tabular-nums">{countdown}</span>
                            </div>
                        </div>

                        <div>
                            <h3 className="text-lg font-bold text-destructive">Deleting PIN Account {profileNumber}</h3>
                            <p className="text-sm text-muted-foreground mt-1">
                                All data will be permanently erased in {countdown} second{countdown !== 1 ? 's' : ''}...
                            </p>
                        </div>

                        <Button
                            variant="outline"
                            className="w-full border-foreground/20"
                            onClick={handleAbortCountdown}
                        >
                            Abort
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (step === 'change-pin') {
        return (
            <div className="space-y-4 animate-fade-in">
                <button
                    onClick={() => { setStep('menu'); setError(''); }}
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                    <ArrowLeft className="w-4 h-4" /> Back
                </button>

                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Shield className="w-4.5 h-4.5" />
                            Change PIN
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {/* Current PIN */}
                        <div>
                            <label className="text-xs text-muted-foreground mb-1 block">Current PIN</label>
                            <div className="relative">
                                <input
                                    type={showCurrent ? 'text' : 'password'}
                                    value={currentPin}
                                    onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                                    placeholder="• • • • • • • •"
                                    maxLength={8}
                                    inputMode="numeric"
                                    className="w-full bg-secondary/50 border border-border rounded-xl px-3 pr-10 py-2.5 text-foreground text-sm tracking-widest font-mono focus:ring-2 focus:ring-primary outline-none"
                                />
                                <button onClick={() => setShowCurrent(!showCurrent)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer">
                                    {showCurrent ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                </button>
                            </div>
                        </div>

                        {/* New PIN */}
                        <div>
                            <label className="text-xs text-muted-foreground mb-1 block">New PIN</label>
                            <div className="relative">
                                <input
                                    type={showNew ? 'text' : 'password'}
                                    value={newPin}
                                    onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                                    placeholder="• • • • • • • •"
                                    maxLength={8}
                                    inputMode="numeric"
                                    className="w-full bg-secondary/50 border border-border rounded-xl px-3 pr-10 py-2.5 text-foreground text-sm tracking-widest font-mono focus:ring-2 focus:ring-primary outline-none"
                                />
                                <button onClick={() => setShowNew(!showNew)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer">
                                    {showNew ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                </button>
                            </div>
                        </div>

                        {/* Confirm New PIN */}
                        <div>
                            <label className="text-xs text-muted-foreground mb-1 block">Confirm New PIN</label>
                            <input
                                type="password"
                                value={confirmPin}
                                onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleChangePin(); }}
                                placeholder="• • • • • • • •"
                                maxLength={8}
                                inputMode="numeric"
                                className="w-full bg-secondary/50 border border-border rounded-xl px-3 py-2.5 text-foreground text-sm tracking-widest font-mono focus:ring-2 focus:ring-primary outline-none"
                            />
                        </div>

                        {error && <p className="text-xs text-destructive">{error}</p>}

                        <Button onClick={handleChangePin} disabled={loading} className="w-full">
                            {loading ? 'Changing...' : 'Change PIN'}
                        </Button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    const timeoutOptions = [1, 2, 5, 10, 15, 30];

    return (
        <div className="space-y-4 animate-fade-in">
            <button
                onClick={onBack}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
                <ArrowLeft className="w-4 h-4" /> Back
            </button>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Shield className="w-4.5 h-4.5" />
                        Security
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    {/* Change PIN */}
                    <button
                        onClick={() => setStep('change-pin')}
                        className="flex items-center gap-3 w-full py-3 cursor-pointer group text-left hover:opacity-80 transition-opacity"
                    >
                        <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                            <Shield className="w-4.5 h-4.5 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium">Change PIN</p>
                            <p className="text-xs text-muted-foreground">Update your 8-digit security PIN</p>
                        </div>
                        <ChevronRight className="w-4.5 h-4.5 text-muted-foreground shrink-0" />
                    </button>

                    <div className="border-t border-border" />

                    {/* Auto-lock timeout */}
                    <div>
                        <p className="text-sm font-medium mb-1">Auto-lock Timeout</p>
                        <p className="text-xs text-muted-foreground mb-3">Lock the app after this period of inactivity</p>
                        <div className="flex flex-wrap gap-2">
                            {timeoutOptions.map(min => (
                                <button
                                    key={min}
                                    onClick={() => handleSetTimeout(min)}
                                    className={cn(
                                        "px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer border",
                                        lockTimeout === min
                                            ? "bg-primary text-primary-foreground border-primary"
                                            : "bg-secondary border-border hover:border-primary/50"
                                    )}
                                >
                                    {min} min
                                </button>
                            ))}
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Delete PIN Account */}
            <button
                onClick={() => setStep('delete-phrase')}
                className="flex items-center justify-center gap-2 w-full py-3.5 rounded-xl bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors cursor-pointer font-medium text-sm"
            >
                <Shield className="w-4 h-4" />
                Delete PIN Account {profileNumber}
            </button>
        </div>
    );
}

/* ── Blossom Video with server fallback ── */
function BlossomVideo({ hash, ext, ...videoProps }: {
    hash: string;
    ext: string;
} & React.VideoHTMLAttributes<HTMLVideoElement>) {
    const servers = blossomServers.getServers();
    const [serverIndex, setServerIndex] = useState(0);
    const [allFailed, setAllFailed] = useState(false);

    // Build URL: servers store full URLs like https://video.nostr.build
    const baseUrl = servers[serverIndex]?.replace(/\/+$/, '');
    const currentUrl = baseUrl ? `${baseUrl}/${hash}.${ext}` : '';

    const handleError = useCallback(() => {
        if (serverIndex < servers.length - 1) {
            console.log(`[BlossomVideo] ${servers[serverIndex]} failed, trying ${servers[serverIndex + 1]}…`);
            setServerIndex(i => i + 1);
        } else {
            console.error('[BlossomVideo] All Blossom servers failed');
            setAllFailed(true);
        }
    }, [serverIndex, servers]);

    if (allFailed || servers.length === 0) {
        return (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground text-sm">
                Video unavailable
            </div>
        );
    }

    return <video key={currentUrl} src={currentUrl} onError={handleError} {...videoProps} />;
}

/* ── Tutorial items ── */
const TUTORIALS = [
    {
        id: 'signing-into-clients',
        title: 'Signing into Nostr clients',
        description: 'If this is your first time using a Nostr signer and account manager, here\'s a short video on how to sign in to different Nostr sites, apps, and software.',
        hash: '866c604285248a0f2340b02fab7e79b422d0d901a421e539fd89f84a51d80271',
        ext: 'mp4',
    },
];

// ── Tutorials Page Component ──
function TutorialsPage({ onBack }: { onBack: () => void }) {
    const [activeTutorial, setActiveTutorial] = useState<string | null>(null);
    const tutorial = TUTORIALS.find(t => t.id === activeTutorial);

    return (
        <div className="space-y-4 animate-fade-in">
            <button
                onClick={onBack}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
                <ArrowLeft className="w-4 h-4" /> Back
            </button>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <GraduationCap className="w-4.5 h-4.5" />
                        Tutorials
                    </CardTitle>
                </CardHeader>
                <CardContent className="divide-y divide-border">
                    {TUTORIALS.map(t => (
                        <button
                            key={t.id}
                            onClick={() => setActiveTutorial(t.id)}
                            className="flex items-center gap-3 w-full py-4 first:pt-0 last:pb-0 cursor-pointer group text-left hover:opacity-80 transition-opacity"
                        >
                            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                                <Play className="w-4.5 h-4.5 text-primary" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium">{t.title}</p>
                                <p className="text-xs text-muted-foreground line-clamp-1">{t.description}</p>
                            </div>
                            <ChevronRight className="w-4.5 h-4.5 text-muted-foreground shrink-0" />
                        </button>
                    ))}
                </CardContent>
            </Card>

            {/* Tutorial Video Modal */}
            <Dialog open={!!activeTutorial} onOpenChange={(open) => { if (!open) setActiveTutorial(null); }}>
                <DialogContent className="sm:max-w-2xl p-0 overflow-hidden">
                    <div className="aspect-video w-full bg-black">
                        {tutorial && (
                            <BlossomVideo
                                hash={tutorial.hash}
                                ext={tutorial.ext}
                                autoPlay
                                controls
                                className="w-full h-full"
                            />
                        )}
                    </div>
                    <div className="px-6 pb-6 pt-4">
                        <h3 className="text-lg font-semibold mb-2">{tutorial?.title}</h3>
                        <p className="text-sm text-muted-foreground">
                            {tutorial?.description}
                        </p>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}

// ── Blossom Servers Page Component ──
function BlossomServersPage({ onBack, toast }: { onBack: () => void; toast: (msg: string, type?: 'error' | 'success' | 'info') => void }) {
    const [servers, setServers] = useState<string[]>(() => blossomServers.getServers());
    const [newServer, setNewServer] = useState('');
    const [serverHealth, setServerHealth] = useState<Record<string, boolean | null>>({});
    const [checkingHealth, setCheckingHealth] = useState(false);
    const [userServers, setUserServers] = useState<string[]>([]);
    const [fetchingUser, setFetchingUser] = useState(false);
    const [newUserServer, setNewUserServer] = useState('');
    const [publishingServers, setPublishingServers] = useState(false);
    const publishedUserServersRef = useRef<string[] | null>(null);

    // Check health on mount
    useEffect(() => {
        checkAllHealth();
    }, []);

    const checkAllHealth = async () => {
        setCheckingHealth(true);
        const health: Record<string, boolean | null> = {};
        for (const url of servers) health[url] = null;
        setServerHealth(health);

        await Promise.all(servers.map(async (url) => {
            const ok = await blossomServers.checkHealth(url);
            setServerHealth(prev => ({ ...prev, [url]: ok }));
        }));
        setCheckingHealth(false);
    };

    const handleAddServer = () => {
        let url = newServer.trim().replace(/\/+$/, '');
        if (!url) return;
        if (!/^https?:\/\//.test(url)) {
            url = 'https://' + url;
        }
        if (servers.includes(url)) {
            toast('Server already exists', 'error');
            return;
        }
        blossomServers.addServer(url);
        setServers(blossomServers.getServers());
        setNewServer('');
        toast('Server added', 'success');
        // Check health of new server
        blossomServers.checkHealth(url).then(ok => {
            setServerHealth(prev => ({ ...prev, [url]: ok }));
        });
    };

    const handleRemoveServer = (url: string) => {
        if (servers.length <= 1) {
            toast('Must keep at least one server', 'error');
            return;
        }
        blossomServers.removeServer(url);
        setServers(blossomServers.getServers());
        toast('Server removed', 'success');
    };

    const handleResetServers = () => {
        blossomServers.resetToDefaults();
        setServers(blossomServers.getServers());
        toast('Blossom servers reset to defaults', 'success');
        checkAllHealth();
    };

    const handleFetchUserServers = async () => {
        setFetchingUser(true);
        try {
            const fetched = await invoke<string[]>('fetch_user_blossom_servers');
            setUserServers(fetched);
            publishedUserServersRef.current = [...fetched].sort();
            if (fetched.length > 0) {
                toast(`Fetched ${fetched.length} Blossom server(s) from Nostr`, 'success');
            } else {
                toast('No Blossom server list found on Nostr (kind 10063)');
            }
        } catch (e: any) {
            toast('Error fetching: ' + e, 'error');
        }
        setFetchingUser(false);
    };

    const handleAddUserServer = () => {
        let url = newUserServer.trim().replace(/\/+$/, '');
        if (!url) return;
        if (!/^https?:\/\//.test(url)) url = 'https://' + url;
        if (userServers.includes(url)) {
            toast('Server already in list', 'error');
            return;
        }
        setUserServers(prev => [...prev, url]);
        setNewUserServer('');
    };

    const handleRemoveUserServer = (url: string) => {
        setUserServers(prev => prev.filter(s => s !== url));
    };

    const handlePublishUserServers = async () => {
        setPublishingServers(true);
        try {
            await invoke('publish_user_blossom_servers', { servers: userServers });
            publishedUserServersRef.current = [...userServers].sort();
            toast('Blossom server list published!', 'success');
        } catch (e: any) {
            toast('Error publishing: ' + e, 'error');
        }
        setPublishingServers(false);
    };

    const currentUserUrls = [...userServers].sort();
    const publishedUserUrls = publishedUserServersRef.current;
    const isUserDirty = publishedUserUrls === null
        ? userServers.length > 0
        : JSON.stringify(currentUserUrls) !== JSON.stringify(publishedUserUrls);

    return (
        <div className="space-y-4 pb-[100px] animate-fade-in">
            <button
                onClick={onBack}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
                <ArrowLeft className="w-4 h-4" /> Back
            </button>

            {/* Signer's local Blossom servers */}
            <Card>
                <CardContent className="pt-4">
                    <div className="flex items-center justify-between mb-3">
                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Signer's local Blossom servers</div>
                        <div className="flex items-center gap-3">
                            <button
                                onClick={handleResetServers}
                                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                            >Reset</button>
                            <button
                                onClick={checkAllHealth}
                                disabled={checkingHealth}
                                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
                            >
                                <RefreshCw className={cn("w-3 h-3", checkingHealth && "animate-spin")} />
                                Check
                            </button>
                        </div>
                    </div>

                    <div className="flex gap-2 mb-3">
                        <Input
                            value={newServer}
                            onChange={e => setNewServer(e.target.value)}
                            placeholder="https://..."
                            className="flex-1 h-9 text-sm"
                            onKeyDown={e => e.key === 'Enter' && handleAddServer()}
                        />
                        <Button
                            size="sm"
                            className="h-9"
                            onClick={handleAddServer}
                            disabled={!newServer.trim()}
                        >
                            <Plus className="w-4 h-4" /> Add
                        </Button>
                    </div>

                    {servers.length === 0 ? (
                        <div className="py-4 text-center text-sm text-muted-foreground">
                            No servers configured. Add one above.
                        </div>
                    ) : (
                        <div className="divide-y divide-border">
                            {servers.map(url => (
                                <div key={url} className="flex items-center gap-3 py-3 first:pt-0 group">
                                    <div className={cn(
                                        "w-2 h-2 rounded-full shrink-0",
                                        serverHealth[url] === true ? "bg-success" :
                                            serverHealth[url] === false ? "bg-destructive" :
                                                "bg-muted-foreground"
                                    )} />
                                    <span className="text-sm truncate flex-1">{url}</span>
                                    <Badge variant="secondary" className="text-[10px] shrink-0">
                                        {serverHealth[url] === true ? 'online' :
                                            serverHealth[url] === false ? 'offline' :
                                                'checking…'}
                                    </Badge>
                                    <button
                                        className="text-muted-foreground hover:text-destructive transition-all cursor-pointer shrink-0 p-1"
                                        onClick={() => handleRemoveServer(url)}
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* User's Blossom servers (kind 10063) */}
            <Card>
                <CardContent className="pt-4">
                    <div className="flex items-center justify-between mb-3">
                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">User's Blossom servers</div>
                        <button
                            onClick={handleFetchUserServers}
                            disabled={fetchingUser}
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
                        >
                            <RefreshCw className={cn("w-3 h-3", fetchingUser && "animate-spin")} />
                            Fetch from Nostr
                        </button>
                    </div>

                    <div className="flex gap-2 mb-3">
                        <Input
                            value={newUserServer}
                            onChange={e => setNewUserServer(e.target.value)}
                            placeholder="https://..."
                            className="flex-1 h-9 text-sm"
                            onKeyDown={e => e.key === 'Enter' && handleAddUserServer()}
                        />
                        <Button
                            size="sm"
                            className="h-9"
                            onClick={handleAddUserServer}
                            disabled={!newUserServer.trim()}
                        >
                            <Plus className="w-4 h-4" /> Add
                        </Button>
                    </div>

                    {userServers.length === 0 ? (
                        <div className="py-4 text-center text-sm text-muted-foreground">
                            No user Blossom servers found. Fetch from Nostr or add manually.
                        </div>
                    ) : (
                        <div className="divide-y divide-border">
                            {userServers.map(url => (
                                <div key={url} className="flex items-center gap-3 py-3 first:pt-0">
                                    <Cloud className="w-4 h-4 text-muted-foreground shrink-0" />
                                    <span className="text-sm truncate flex-1">{url}</span>
                                    <button
                                        className="text-muted-foreground hover:text-destructive transition-all cursor-pointer shrink-0 p-1"
                                        onClick={() => handleRemoveUserServer(url)}
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="pt-3 mt-2 border-t border-border">
                        <Button
                            size="sm"
                            className="w-full"
                            onClick={handlePublishUserServers}
                            disabled={publishingServers || !isUserDirty}
                        >
                            {publishingServers ? 'Publishing…' : 'Save / Publish'}
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}

// ── Version History Data ──
const VERSION_HISTORY = [
    {
        version: '0.1',
        date: 'Feb 2026',
        title: 'Initial Release',
        changes: [
            'NIP-46 remote signer with multi-relay support',
            'NIP-UPV2 password-based authentication',
            'NIP-PC55 desktop counterpart to NIP-55',
            'Built-in Bitcoin wallet (on-chain)',
            'Cashu eCash wallet with NUT-11 P2PK locking',
            'DNN identity system integration',
            'Per-app policy controls (Manual, Custom, Auto Approve, Auto Reject)',
            'Custom signing rules per event kind',
            'PIN-based lock screen with auto-lock timeout',
            'Offline login attempt detection',
            'Multi-keypair management with account switching',
            'Cross-platform support',
        ],
    },
];

const DEV_NPUB = 'npub18n4ysp43ux5c98fs6h9c57qpr4p8r3j8f6e32v0vj8egzy878aqqyzzk9r';

// ── About Page Component ──
function AboutPage({ onBack, toast, onNavigateToWallet, onNavigateToEcashSend, appState }: {
    onBack: () => void;
    toast: (msg: string, type?: 'error' | 'success' | 'info') => void;
    onNavigateToWallet?: (recipient: string) => void;
    onNavigateToEcashSend?: (recipient: string) => void;
    appState: AppState;
}) {
    const [expandedVersion, setExpandedVersion] = useState<string | null>(null);
    const [devProfile, setDevProfile] = useState<NostrProfile | null>(null);
    const [devDnnName, setDevDnnName] = useState<string | null>(null);
    const [showDnnId, setShowDnnId] = useState(false);
    const [copied, setCopied] = useState(false);
    const [showTipModal, setShowTipModal] = useState(false);
    const [tipView, setTipView] = useState<'menu' | 'bitcoin' | 'ecash'>('menu');
    const [tipCopied, setTipCopied] = useState(false);
    // Update state
    const [checkingUpdate, setCheckingUpdate] = useState(false);
    const [downloadingUpdate, setDownloadingUpdate] = useState(false);
    const [updateInfo, setUpdateInfo] = useState<{
        new_version: string; notes: string; has_platform_binary: boolean;
        binary_hash?: string; binary_ext?: string;
    } | null>(null);

    // Developer publish state
    const [showPublishModal, setShowPublishModal] = useState(false);
    const [pubVersion, setPubVersion] = useState('');
    const [pubNotes, setPubNotes] = useState('');
    const [pubFiles, setPubFiles] = useState<Record<string, File | null>>({
        'windows-x86_64': null,
        'linux-x86_64': null,
        'darwin-x86_64': null,
        'darwin-aarch64': null,
    });
    const [publishing, setPublishing] = useState(false);
    const [publishStatus, setPublishStatus] = useState('');
    const [publishPhase, setPublishPhase] = useState<'files' | 'uploading' | 'review' | 'publishing'>('files');
    type UploadResult = { server: string; method: 'upload'; success: boolean; error?: string };
    const [uploadResults, setUploadResults] = useState<Record<string, UploadResult[]>>({});
    const [platformHashes, setPlatformHashes] = useState<Record<string, { hash: string; ext: string }>>({});
    const [uploadProgress, setUploadProgress] = useState<{ bytes_sent: number; total_bytes: number; startTime: number } | null>(null);
    const [pubServerToggles, setPubServerToggles] = useState<Record<string, boolean>>(() => {
        const servers = blossomServers.getServers();
        return Object.fromEntries(servers.map(s => [s, true]));
    });
    const [showServerPicker, setShowServerPicker] = useState(false);

    // Remote version history modal state
    const [showRemoteVersions, setShowRemoteVersions] = useState(false);
    const [remoteVersions, setRemoteVersions] = useState<any[]>([]);
    const [fetchingVersions, setFetchingVersions] = useState(false);
    const [expandedRemoteVersion, setExpandedRemoteVersion] = useState<string | null>(null);

    // Detect if current user is the DENOS developer
    const devPubkeyHex = (() => {
        try {
            const decoded = nip19.decode(DEV_NPUB);
            return decoded.type === 'npub' ? decoded.data as string : null;
        } catch { return null; }
    })();
    const isDeveloper = devPubkeyHex && appState.active_keypair === devPubkeyHex;

    const handleCheckForUpdate = async () => {
        setCheckingUpdate(true);
        try {
            const info = await invoke<any>('check_for_update');
            if (info) {
                setUpdateInfo(info);
                toast(`Update available: v${info.new_version}`, 'success');
            } else {
                setUpdateInfo(null);
                toast('You are on the latest version', 'success');
            }
        } catch (e: any) {
            toast('Failed to check: ' + e, 'error');
        }
        setCheckingUpdate(false);
    };

    const handleDownloadUpdate = async () => {
        if (!updateInfo?.binary_hash || !updateInfo?.binary_ext) {
            toast('No binary available for your platform', 'error');
            return;
        }
        setDownloadingUpdate(true);
        try {
            const servers = blossomServers.getServers();
            await invoke('download_and_install_update', {
                hash: updateInfo.binary_hash,
                ext: updateInfo.binary_ext,
                blossomServers: servers,
            });
            toast('Update installed — restarting…', 'success');
        } catch (e: any) {
            toast('Update failed: ' + e, 'error');
        }
        setDownloadingUpdate(false);
    };

    const handleUploadFiles = async () => {
        if (!pubVersion.trim()) { toast('Version is required', 'error'); return; }
        const filesToUpload = Object.entries(pubFiles).filter(([, f]) => f !== null) as [string, File][];
        if (filesToUpload.length === 0) { toast('Add at least one platform binary', 'error'); return; }

        setPublishing(true);
        setPublishPhase('uploading');
        const servers = blossomServers.getServers().filter(s => pubServerToggles[s] !== false);
        if (servers.length === 0) { toast('Enable at least one Blossom server', 'error'); setPublishing(false); setPublishPhase('files'); return; }
        const results: Record<string, UploadResult[]> = {};
        const hashes: Record<string, { hash: string; ext: string }> = {};

        for (const [platform, file] of filesToUpload) {
            results[platform] = [];
            setPublishStatus(`Preparing ${platform}…`);

            const arrayBuf = await file.arrayBuffer();
            const bytes = new Uint8Array(arrayBuf);
            const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
            const hashArr = Array.from(new Uint8Array(hashBuf));
            const fileHash = hashArr.map(b => b.toString(16).padStart(2, '0')).join('');

            const ext = file.name.includes('.') ? file.name.substring(file.name.indexOf('.') + 1) : 'bin';
            // Chunked base64 encoding (spread operator crashes on large arrays)
            let binStr = '';
            const chunkSize = 8192;
            for (let i = 0; i < bytes.length; i += chunkSize) {
                binStr += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
            }
            const b64 = btoa(binStr);
            let tempPath = '';
            try {
                tempPath = await invoke<string>('write_temp_file', {
                    filename: `denos_pub_${platform}.${ext}`,
                    dataBase64: b64,
                });
            } catch (e: any) {
                toast(`Failed to stage ${platform}: ${e}`, 'error');
                continue;
            }

            // Upload directly to each server
            for (const server of servers) {
                const hostname = new URL(server).hostname;
                try {
                    setPublishStatus(`Uploading ${platform} to ${hostname}…`);
                    setUploadProgress({ bytes_sent: 0, total_bytes: bytes.length, startTime: Date.now() });
                    const unlisten = await listen<{ bytes_sent: number; total_bytes: number }>('upload-progress', (ev) => {
                        setUploadProgress(prev => prev ? { ...prev, bytes_sent: ev.payload.bytes_sent } : null);
                    });
                    try {
                        await invoke<string>('upload_to_blossom', { filePath: tempPath, serverUrl: server, platform });
                        results[platform].push({ server: hostname, method: 'upload', success: true });
                    } finally {
                        unlisten();
                        setUploadProgress(null);
                    }
                } catch (e: any) {
                    results[platform].push({ server: hostname, method: 'upload', success: false, error: String(e) });
                }
            }

            hashes[platform] = { hash: fileHash, ext };
        }

        setUploadResults(results);
        setPlatformHashes(hashes);
        setPublishing(false);
        setPublishStatus('');
        setPublishPhase('review');
    };

    const handleConfirmPublish = async () => {
        if (Object.keys(platformHashes).length === 0) {
            toast('No platform binaries were uploaded successfully', 'error');
            return;
        }
        setPublishPhase('publishing');
        setPublishing(true);
        try {
            const manifest = {
                version: pubVersion.trim(),
                notes: pubNotes.trim(),
                pub_date: new Date().toISOString(),
                platforms: platformHashes,
            };
            const eventId = await invoke<string>('publish_update_event', {
                manifestJson: JSON.stringify(manifest),
            });
            toast(`Update v${pubVersion} published! Event: ${eventId.slice(0, 12)}…`, 'success');
            setShowPublishModal(false);
            setPubVersion(''); setPubNotes('');
            setPubFiles({ 'windows-x86_64': null, 'linux-x86_64': null, 'darwin-x86_64': null, 'darwin-aarch64': null });
            setPublishPhase('files');
            setUploadResults({}); setPlatformHashes({});
        } catch (e: any) {
            toast('Publish failed: ' + e, 'error');
            setPublishPhase('review');
        }
        setPublishing(false);
    };

    // Derive dev's taproot address from npub
    let devTaprootAddress = '';
    try { devTaprootAddress = npubToTaprootAddress(DEV_NPUB); } catch { }

    useEffect(() => {
        // Decode npub to hex for profile fetch
        try {
            const decoded = nip19.decode(DEV_NPUB);
            if (decoded.type === 'npub') {
                const hex = decoded.data as string;
                fetchNostrProfile(hex).then(p => { if (p) setDevProfile(p); });
                // Fetch blockchain-verified DNN names and verify ownership
                dnnService.initialize().then(() => {
                    dnnService.getUserNames(DEV_NPUB).then(async names => {
                        if (names.length > 0) {
                            const name = names[0];
                            const displayName = name.camelCase || name.encoded || name.name;
                            // Verify the DNN ID actually belongs to this npub
                            const verified = await dnnService.verifyDnnId(
                                name.dnnId || name.encoded || name.name,
                                DEV_NPUB
                            );
                            if (verified) setDevDnnName(displayName);
                        }
                    }).catch(() => { });
                }).catch(() => { });
            }
        } catch { }
    }, []);

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        toast('Copied to clipboard', 'success');
        setTimeout(() => setCopied(false), 2000);
    };

    const displayId = showDnnId && devDnnName ? devDnnName : DEV_NPUB;
    const displayIdTruncated = showDnnId && devDnnName
        ? devDnnName
        : `${DEV_NPUB.slice(0, 16)}…${DEV_NPUB.slice(-8)}`;

    return (
        <div className="space-y-5 animate-fade-in pb-[100px]">
            <button
                onClick={onBack}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
                <ArrowLeft className="w-4 h-4" /> Back
            </button>

            {/* ── Hero / Logo ── */}
            <div className="flex flex-col items-center text-center pt-2 pb-1">
                <img src="/denos-logo.png" alt="DENOS" className="w-20 h-20 rounded-2xl mb-4" />
                <h1 className="text-2xl font-bold tracking-tight">DENOS</h1>
                <p className="text-sm text-muted-foreground mt-1">Version {VERSION_HISTORY[0].version}</p>
                <p className="text-sm text-muted-foreground mt-4 px-2 leading-relaxed max-w-sm">
                    DENOS is a Nostr signer, ID manager, and payment system.
                </p>
            </div>

            {/* ── Check for Updates ── */}
            <Button
                className="w-full cursor-pointer"
                variant={updateInfo ? 'default' : 'secondary'}
                onClick={updateInfo ? handleDownloadUpdate : handleCheckForUpdate}
                disabled={checkingUpdate || downloadingUpdate}
            >
                {checkingUpdate ? (
                    <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Checking…</>
                ) : downloadingUpdate ? (
                    <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Downloading update…</>
                ) : updateInfo ? (
                    <><Download className="w-4 h-4 mr-2" /> Update Now — v{updateInfo.new_version}</>
                ) : (
                    <><RefreshCw className="w-4 h-4 mr-2" /> Check for Updates</>
                )}
            </Button>

            {/* ── Version History ── */}
            <Card>
                <CardHeader className="pb-2">
                    <div className="w-full flex items-center justify-between">
                        <CardTitle className="flex items-center gap-2 text-sm">
                            Version History
                        </CardTitle>
                        <button
                            onClick={async () => {
                                setShowRemoteVersions(true);
                                setFetchingVersions(true);
                                try {
                                    const versions = await invoke<any[]>('fetch_version_history');
                                    setRemoteVersions(versions);
                                } catch (e: any) {
                                    toast('Failed to fetch: ' + e, 'error');
                                }
                                setFetchingVersions(false);
                            }}
                            className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer p-1"
                            title="View published versions from Nostr"
                        >
                            <Cloud className="w-4 h-4" />
                        </button>
                    </div>
                </CardHeader>
                <CardContent className="space-y-1">
                    {VERSION_HISTORY.map(v => (
                        <div key={v.version} className="space-y-2">
                            <button
                                onClick={() => setExpandedVersion(expandedVersion === v.version ? null : v.version)}
                                className="w-full flex items-center justify-between py-2.5 px-2.5 text-left cursor-pointer hover:bg-secondary/40 rounded-lg transition-colors"
                            >
                                <div>
                                    <span className="text-sm font-semibold">v{v.version}</span>
                                    <span className="text-xs text-muted-foreground ml-2">{v.date}</span>
                                    <p className="text-xs text-muted-foreground mt-0.5">{v.title}</p>
                                </div>
                                <ChevronDown className={cn(
                                    "w-4 h-4 text-muted-foreground transition-transform duration-200",
                                    expandedVersion === v.version && "rotate-180"
                                )} />
                            </button>
                            {expandedVersion === v.version && (
                                <div className="pl-3 pr-1 pb-3 animate-fade-in">
                                    <ul className="space-y-1.5">
                                        {v.changes.map((change, i) => (
                                            <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                                                <span className="w-1 h-1 rounded-full bg-primary mt-1.5 shrink-0" />
                                                {change}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    ))}
                </CardContent>
            </Card>

            {/* ── Developer Card ── */}
            <Card>
                <CardContent className="space-y-3 mt-4">
                    <div className="flex items-center gap-3">
                        {devProfile?.picture ? (
                            <img src={devProfile.picture} alt="" className="w-11 h-11 rounded-full object-cover border-2 border-primary/30" />
                        ) : (
                            <div className="w-11 h-11 rounded-full bg-secondary flex items-center justify-center border-2 border-primary/30">
                                <Users className="w-5 h-5 text-muted-foreground" />
                            </div>
                        )}
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold truncate">
                                {devProfile?.display_name || devProfile?.name || 'Developer'}
                            </p>
                            <div className="flex items-center gap-1 mt-0.5">
                                <span className="text-[11px] text-muted-foreground truncate">
                                    {displayIdTruncated}
                                </span>
                                <button
                                    onClick={() => copyToClipboard(displayId)}
                                    className="p-0.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0"
                                    title="Copy"
                                >
                                    {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                                </button>
                                {devDnnName && (
                                    <button
                                        onClick={() => setShowDnnId(!showDnnId)}
                                        className="p-0.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0"
                                        title={showDnnId ? 'Show npub' : 'Show DNN ID'}
                                    >
                                        <RefreshCw className="w-3 h-3" />
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>

                    <Button
                        className="w-full cursor-pointer"
                        variant="secondary"
                        onClick={() => setShowTipModal(true)}
                    >
                        <Heart className="w-4 h-4 mr-2 text-red-400" />
                        Tip the Developer
                    </Button>
                </CardContent>
            </Card>

            {/* ── Developer Publish (only visible to DENOS creator) ── */}
            {isDeveloper && (
                <Button
                    className="w-full cursor-pointer"
                    variant="secondary"
                    onClick={() => setShowPublishModal(true)}
                >
                    <Cloud className="w-4 h-4 mr-2" /> Publish New Update
                </Button>
            )}

            {/* ── Publish Modal ── */}
            <Dialog open={showPublishModal} onOpenChange={setShowPublishModal}>
                <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Cloud className="w-5 h-5" /> Publish New Update
                        </DialogTitle>
                    </DialogHeader>

                    <div className="space-y-4 pt-2">
                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-muted-foreground">Version</label>
                            <Input
                                value={pubVersion}
                                onChange={e => setPubVersion(e.target.value)}
                                placeholder="0.2.0"
                                className="h-9"
                            />
                        </div>

                        <div className="space-y-1.5">
                            <label className="text-xs font-medium text-muted-foreground">Release Notes</label>
                            <textarea
                                value={pubNotes}
                                onChange={e => setPubNotes(e.target.value)}
                                placeholder="What's new in this version…"
                                className="w-full h-20 px-3 py-2 text-sm rounded-lg border border-border bg-secondary/30 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                        </div>

                        {/* Blossom server picker button */}
                        {(() => {
                            const allServers = blossomServers.getServers();
                            const enabledCount = allServers.filter(s => pubServerToggles[s] !== false).length;
                            return (
                                <button
                                    type="button"
                                    onClick={() => setShowServerPicker(true)}
                                    className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-border bg-secondary/30 hover:bg-secondary/50 transition-colors text-sm cursor-pointer"
                                >
                                    <span className="flex items-center gap-2">
                                        <Cloud className="w-4 h-4 text-muted-foreground" />
                                        <span>Blossom Servers</span>
                                    </span>
                                    <span className={`text-xs font-mono px-2 py-0.5 rounded-full ${enabledCount === allServers.length ? 'bg-green-500/20 text-green-400' : enabledCount === 0 ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
                                        {enabledCount}/{allServers.length}
                                    </span>
                                </button>
                            );
                        })()}

                        <div className="space-y-2">
                            <label className="text-xs font-medium text-muted-foreground">Platform Binaries</label>
                            {Object.entries(pubFiles).map(([platform, file]) => {
                                const labels: Record<string, string> = {
                                    'windows-x86_64': 'Windows (.exe)',
                                    'linux-x86_64': 'Linux (.AppImage)',
                                    'darwin-x86_64': 'macOS Intel (.dmg)',
                                    'darwin-aarch64': 'macOS ARM (.dmg)',
                                };
                                return (
                                    <div
                                        key={platform}
                                        className={`relative flex items-center gap-3 p-3 rounded-lg border-2 border-dashed transition-colors ${file ? 'border-green-500/40 bg-green-500/5' : 'border-border hover:border-primary/40'
                                            }`}
                                        onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-primary'); }}
                                        onDragLeave={e => { e.currentTarget.classList.remove('border-primary'); }}
                                        onDrop={e => {
                                            e.preventDefault();
                                            e.currentTarget.classList.remove('border-primary');
                                            const f = e.dataTransfer.files[0];
                                            if (f) setPubFiles(prev => ({ ...prev, [platform]: f }));
                                        }}
                                    >
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs font-medium">{labels[platform] || platform}</p>
                                            {file ? (
                                                <p className="text-[11px] text-green-500 truncate">{file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)</p>
                                            ) : (
                                                <p className="text-[11px] text-muted-foreground">Drop file here or click to browse</p>
                                            )}
                                        </div>
                                        {file ? (
                                            <button
                                                onClick={() => setPubFiles(prev => ({ ...prev, [platform]: null }))}
                                                className="p-1 text-muted-foreground hover:text-foreground"
                                            >
                                                <X className="w-4 h-4" />
                                            </button>
                                        ) : (
                                            <label className="p-1.5 rounded-md bg-secondary hover:bg-secondary/80 cursor-pointer">
                                                <Plus className="w-4 h-4" />
                                                <input
                                                    type="file"
                                                    className="hidden"
                                                    onChange={e => {
                                                        const f = e.target.files?.[0];
                                                        if (f) setPubFiles(prev => ({ ...prev, [platform]: f }));
                                                    }}
                                                />
                                            </label>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        {publishStatus && (
                            <p className="text-xs text-muted-foreground animate-pulse">{publishStatus}</p>
                        )}

                        {/* Upload progress bar */}
                        {uploadProgress && (() => {
                            const pct = Math.round((uploadProgress.bytes_sent / uploadProgress.total_bytes) * 100);
                            const elapsed = (Date.now() - uploadProgress.startTime) / 1000;
                            const rate = elapsed > 0.5 ? uploadProgress.bytes_sent / elapsed : 0;
                            const rateMB = (rate / (1024 * 1024)).toFixed(2);
                            const sentMB = (uploadProgress.bytes_sent / (1024 * 1024)).toFixed(1);
                            const totalMB = (uploadProgress.total_bytes / (1024 * 1024)).toFixed(1);
                            return (
                                <div className="space-y-1">
                                    <div className="w-full h-2 rounded-full bg-secondary overflow-hidden">
                                        <div
                                            className="h-full rounded-full bg-green-500 transition-all duration-150"
                                            style={{ width: `${pct}%` }}
                                        />
                                    </div>
                                    <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                                        <span>{sentMB} / {totalMB} MB</span>
                                        <span>{pct}%{rate > 0 ? ` · ${rateMB} MB/s` : ''}</span>
                                    </div>
                                </div>
                            );
                        })()}

                        {/* Phase: files → Upload button */}
                        {publishPhase === 'files' && (
                            <Button
                                className="w-full cursor-pointer"
                                onClick={handleUploadFiles}
                                disabled={!pubVersion.trim() || Object.values(pubFiles).every(f => f === null)}
                            >
                                <Cloud className="w-4 h-4 mr-2" /> Upload to Blossom Servers
                            </Button>
                        )}

                        {/* Phase: uploading → spinner */}
                        {publishPhase === 'uploading' && (
                            <Button className="w-full" disabled>
                                <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Uploading…
                            </Button>
                        )}

                        {/* Phase: review → results summary + confirm */}
                        {publishPhase === 'review' && (
                            <div className="space-y-3">
                                <h4 className="text-sm font-semibold">Upload Results</h4>
                                {Object.entries(uploadResults).map(([platform, results]) => {
                                    const hasSuccess = results.some(r => r.success);
                                    return (
                                        <div key={platform} className="rounded-lg border border-border/50 p-3 space-y-1.5">
                                            <div className="flex items-center gap-2">
                                                <span className={`w-2 h-2 rounded-full ${hasSuccess ? 'bg-green-500' : 'bg-red-500'}`} />
                                                <span className="text-sm font-medium">{platform}</span>
                                                {platformHashes[platform] && (
                                                    <span className="text-[10px] text-muted-foreground font-mono ml-auto">
                                                        {platformHashes[platform].hash.slice(0, 12)}…
                                                    </span>
                                                )}
                                            </div>
                                            {results.map((r, i) => (
                                                <div key={i} className="flex items-center gap-2 text-xs pl-4">
                                                    <span className={r.success ? 'text-green-500' : 'text-red-400'}>
                                                        {r.success ? '✓' : '✗'}
                                                    </span>
                                                    <span className="text-muted-foreground">{r.server}</span>
                                                </div>
                                            ))}
                                        </div>
                                    );
                                })}

                                {Object.keys(platformHashes).length === 0 && (
                                    <p className="text-sm text-red-400">All uploads failed. Cannot publish.</p>
                                )}

                                {Object.keys(platformHashes).length > 0 && (
                                    <Button
                                        className="w-full cursor-pointer"
                                        onClick={handleConfirmPublish}
                                        disabled={publishing}
                                    >
                                        {publishing ? (
                                            <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Signing & Publishing…</>
                                        ) : (
                                            <><Shield className="w-4 h-4 mr-2" /> Confirm & Publish kind 30078</>
                                        )}
                                    </Button>
                                )}

                                <button
                                    onClick={() => { setPublishPhase('files'); setUploadResults({}); setPlatformHashes({}); }}
                                    className="text-xs text-muted-foreground hover:text-foreground mx-auto block"
                                >
                                    ← Back to files
                                </button>
                            </div>
                        )}
                    </div>
                </DialogContent>
            </Dialog>

            {/* ── Server Picker Modal ── */}
            <Dialog open={showServerPicker} onOpenChange={setShowServerPicker}>
                <DialogContent className="max-w-sm">
                    <div className="space-y-4 pt-2">
                        <h3 className="text-sm font-semibold flex items-center gap-2">
                            <Cloud className="w-4 h-4" /> Upload Targets
                        </h3>
                        <p className="text-xs text-muted-foreground">Choose which Blossom servers to upload to.</p>
                        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                            {blossomServers.getServers().map(server => {
                                const hostname = new URL(server).hostname;
                                return (
                                    <div key={server} className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-border/50 bg-secondary/20">
                                        <span className="text-sm">{hostname}</span>
                                        <Switch
                                            checked={pubServerToggles[server] !== false}
                                            onCheckedChange={(checked) => setPubServerToggles(prev => ({ ...prev, [server]: checked }))}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* ── Remote Version History Modal ── */}
            <Dialog open={showRemoteVersions} onOpenChange={setShowRemoteVersions}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Cloud className="w-5 h-5" /> Published Versions
                        </DialogTitle>
                    </DialogHeader>
                    <div className="max-h-[60vh] overflow-y-auto space-y-1 pr-1">
                        {fetchingVersions ? (
                            <div className="flex items-center justify-center py-8">
                                <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
                            </div>
                        ) : remoteVersions.length === 0 ? (
                            <div className="py-8 text-center text-sm text-muted-foreground">
                                No published versions found on Nostr.
                            </div>
                        ) : (
                            remoteVersions.map(v => (
                                <div key={v.version} className="rounded-lg border border-border/50 overflow-hidden">
                                    <button
                                        onClick={() => setExpandedRemoteVersion(expandedRemoteVersion === v.version ? null : v.version)}
                                        className="w-full flex items-center justify-between p-3 text-left cursor-pointer hover:bg-secondary/40 transition-colors"
                                    >
                                        <div>
                                            <span className="text-sm font-semibold">v{v.version}</span>
                                            <span className="text-xs text-muted-foreground ml-2">
                                                {v.pub_date ? new Date(v.pub_date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : ''}
                                            </span>
                                        </div>
                                        <ChevronDown className={cn(
                                            "w-4 h-4 text-muted-foreground transition-transform duration-200",
                                            expandedRemoteVersion === v.version && "rotate-180"
                                        )} />
                                    </button>
                                    {expandedRemoteVersion === v.version && (
                                        <div className="px-3 pb-3 space-y-3 animate-fade-in border-t border-border/30 pt-3">
                                            {v.notes && (
                                                <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">{v.notes}</p>
                                            )}
                                            {v.platforms && Object.keys(v.platforms).length > 0 && (
                                                <div className="space-y-1.5">
                                                    <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Downloads</div>
                                                    <div className="grid gap-1.5">
                                                        {Object.entries(v.platforms).map(([platform, info]: [string, any]) => {
                                                            const labels: Record<string, string> = {
                                                                'windows-x86_64': '🪟 Windows',
                                                                'linux-x86_64': '🐧 Linux',
                                                                'darwin-x86_64': '🍎 macOS (Intel)',
                                                                'darwin-aarch64': '🍎 macOS (ARM)',
                                                            };
                                                            const label = labels[platform] || platform;
                                                            // Construct download URL from first available Blossom server
                                                            const servers = blossomServers.getServers();
                                                            const downloadUrl = servers.length > 0
                                                                ? `${servers[0]}/${info.hash}`
                                                                : null;
                                                            return (
                                                                <button
                                                                    key={platform}
                                                                    onClick={() => {
                                                                        if (downloadUrl) {
                                                                            window.open(downloadUrl, '_blank');
                                                                        } else {
                                                                            toast('No Blossom server configured', 'error');
                                                                        }
                                                                    }}
                                                                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/30 hover:bg-secondary/60 transition-colors text-sm cursor-pointer"
                                                                >
                                                                    <Download className="w-3.5 h-3.5 text-muted-foreground" />
                                                                    <span>{label}</span>
                                                                    <span className="text-[10px] text-muted-foreground ml-auto">.{info.ext}</span>
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </DialogContent>
            </Dialog>

            {/* ── Tip Modal ── */}
            <Dialog open={showTipModal} onOpenChange={(open) => { setShowTipModal(open); if (!open) setTipView('menu'); }}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            {tipView === 'menu' && <><Heart className="w-5 h-5 text-red-400" /> Tip the Developer</>}
                            {tipView === 'bitcoin' && (
                                <button onClick={() => setTipView('menu')} className="flex items-center gap-2 cursor-pointer hover:text-primary transition-colors">
                                    <ArrowLeft className="w-4 h-4" />
                                    Send Bitcoin
                                </button>
                            )}
                            {tipView === 'ecash' && (
                                <button onClick={() => setTipView('menu')} className="flex items-center gap-2 cursor-pointer hover:text-primary transition-colors">
                                    <ArrowLeft className="w-4 h-4" />
                                    Send eCash
                                </button>
                            )}
                        </DialogTitle>
                    </DialogHeader>

                    {/* ── Main Menu ── */}
                    {tipView === 'menu' && (
                        <div className="space-y-2.5 pt-2">
                            <button
                                onClick={() => setTipView('bitcoin')}
                                className="w-full flex items-center gap-3 p-3.5 rounded-xl bg-secondary hover:bg-secondary/80 transition-colors cursor-pointer text-left"
                            >
                                <div className="w-10 h-10 rounded-full bg-orange-500/15 flex items-center justify-center shrink-0">
                                    <Bitcoin className="w-5 h-5 text-orange-400" />
                                </div>
                                <div>
                                    <p className="text-sm font-semibold">Send Bitcoin</p>
                                    <p className="text-xs text-muted-foreground">On-chain Bitcoin transaction</p>
                                </div>
                            </button>
                            <button
                                onClick={() => setTipView('ecash')}
                                className="w-full flex items-center gap-3 p-3.5 rounded-xl bg-secondary hover:bg-secondary/80 transition-colors cursor-pointer text-left"
                            >
                                <div className="w-10 h-10 rounded-full bg-green-500/15 flex items-center justify-center shrink-0">
                                    <Banknote className="w-5 h-5 text-green-400" />
                                </div>
                                <div>
                                    <p className="text-sm font-semibold">Send eCash</p>
                                    <p className="text-xs text-muted-foreground">Cashu eCash token</p>
                                </div>
                            </button>
                            <button
                                onClick={() => { setShowTipModal(false); toast('Silent payments coming soon', 'info'); }}
                                className="w-full flex items-center gap-3 p-3.5 rounded-xl bg-secondary hover:bg-secondary/80 transition-colors cursor-pointer text-left"
                            >
                                <div className="w-10 h-10 rounded-full bg-purple-500/15 flex items-center justify-center shrink-0">
                                    <EyeOff className="w-5 h-5 text-purple-400" />
                                </div>
                                <div>
                                    <p className="text-sm font-semibold">Silently Pay</p>
                                    <p className="text-xs text-muted-foreground">Private silent payment</p>
                                </div>
                            </button>
                        </div>
                    )}

                    {/* ── Bitcoin QR View ── */}
                    {tipView === 'bitcoin' && (
                        <div className="flex flex-col items-center gap-4 pt-2">
                            <div className="bg-white p-3 rounded-xl">
                                <QRCodeSVG value={`bitcoin:${devTaprootAddress}`} size={180} />
                            </div>
                            <div className="w-full space-y-1.5">
                                <label className="text-xs text-muted-foreground font-medium">Taproot Address (P2TR)</label>
                                <div className="flex items-center gap-1.5">
                                    <div className="flex-1 bg-secondary/50 border border-border rounded-lg px-3 py-2 text-xs font-mono text-foreground break-all">
                                        {devTaprootAddress}
                                    </div>
                                    <button
                                        onClick={() => { navigator.clipboard.writeText(devTaprootAddress); setTipCopied(true); toast('Address copied', 'success'); setTimeout(() => setTipCopied(false), 2000); }}
                                        className="p-2 shrink-0 bg-secondary hover:bg-secondary/80 rounded-lg transition-colors cursor-pointer"
                                    >
                                        {tipCopied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                                    </button>
                                </div>
                            </div>
                            {onNavigateToWallet && (
                                <Button
                                    className="w-full gap-2"
                                    onClick={() => { setShowTipModal(false); setTipView('menu'); onNavigateToWallet(devTaprootAddress); }}
                                >
                                    Send from DENOS
                                </Button>
                            )}
                        </div>
                    )}

                    {/* ── eCash QR View ── */}
                    {tipView === 'ecash' && (
                        <div className="flex flex-col items-center gap-4 pt-2">
                            <div className="bg-white p-3 rounded-xl">
                                <QRCodeSVG value={DEV_NPUB} size={180} />
                            </div>
                            <div className="w-full space-y-1.5">
                                <label className="text-xs text-muted-foreground font-medium">Nostr Public Key (npub)</label>
                                <div className="flex items-center gap-1.5">
                                    <div className="flex-1 bg-secondary/50 border border-border rounded-lg px-3 py-2 text-xs font-mono text-foreground break-all">
                                        {DEV_NPUB}
                                    </div>
                                    <button
                                        onClick={() => { navigator.clipboard.writeText(DEV_NPUB); setTipCopied(true); toast('npub copied', 'success'); setTimeout(() => setTipCopied(false), 2000); }}
                                        className="p-2 shrink-0 bg-secondary hover:bg-secondary/80 rounded-lg transition-colors cursor-pointer"
                                    >
                                        {tipCopied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                                    </button>
                                </div>
                            </div>
                            {onNavigateToEcashSend && (
                                <Button
                                    className="w-full gap-2"
                                    onClick={() => { setShowTipModal(false); setTipView('menu'); onNavigateToEcashSend(DEV_NPUB); }}
                                >
                                    Send from DENOS
                                </Button>
                            )}
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}

/* ── Currency Nodes Sub-Page ── */

function CurrencyNodesSubPage({ onBack }: { onBack: () => void }) {
    const [level, setLevel] = useState<'currencies' | 'bitcoin'>('currencies');
    const [nodes, setNodes] = useState<string[]>([]);
    const [nodeHealth, setNodeHealth] = useState<Record<string, boolean | null>>({});
    const [newNodeUrl, setNewNodeUrl] = useState('');
    const [checkingHealth, setCheckingHealth] = useState(false);
    const { toast } = useFeedback();

    // Load nodes on mount
    useEffect(() => {
        setNodes(bitcoinNodes.getNodes());
    }, []);

    // Check health when viewing Bitcoin nodes
    useEffect(() => {
        if (level === 'bitcoin') {
            checkAllHealth();
        }
    }, [level, nodes.length]);

    const checkAllHealth = async () => {
        setCheckingHealth(true);
        const health: Record<string, boolean | null> = {};
        for (const url of nodes) {
            health[url] = null; // loading
        }
        setNodeHealth(health);

        await Promise.all(nodes.map(async (url) => {
            const ok = await bitcoinNodes.checkNodeHealth(url);
            setNodeHealth(prev => ({ ...prev, [url]: ok }));
        }));
        setCheckingHealth(false);
    };

    const handleAddNode = () => {
        const url = newNodeUrl.trim().replace(/\/+$/, '');
        if (!url) return;
        if (!/^https?:\/\//.test(url)) {
            toast('URL must start with https:// or http://', 'error');
            return;
        }
        if (nodes.includes(url)) {
            toast('Node already exists', 'error');
            return;
        }
        bitcoinNodes.addNode(url);
        setNodes(bitcoinNodes.getNodes());
        setNewNodeUrl('');
        toast('Node added', 'success');
    };

    const handleRemoveNode = (url: string) => {
        if (nodes.length <= 1) {
            toast('Must keep at least one node', 'error');
            return;
        }
        bitcoinNodes.removeNode(url);
        setNodes(bitcoinNodes.getNodes());
        toast('Node removed', 'success');
    };

    // Level 1: Currency list
    if (level === 'currencies') {
        return (
            <div className="space-y-4 animate-fade-in">
                <button
                    onClick={onBack}
                    className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                    <ArrowLeft className="w-4 h-4" /> Back
                </button>

                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Network className="w-4.5 h-4.5" />
                            Network Currency Nodes
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <button
                            onClick={() => setLevel('bitcoin')}
                            className="flex items-center gap-3 w-full py-3 cursor-pointer group text-left hover:opacity-80 transition-opacity"
                        >
                            <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                                <Bitcoin className="w-4.5 h-4.5 text-muted-foreground" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium">Bitcoin</p>
                                <p className="text-xs text-muted-foreground">{nodes.length} node{nodes.length !== 1 ? 's' : ''} configured</p>
                            </div>
                            <ChevronRight className="w-4.5 h-4.5 text-muted-foreground shrink-0" />
                        </button>
                    </CardContent>
                </Card>
            </div>
        );
    }

    // Level 2: Bitcoin nodes
    return (
        <div className="space-y-4 animate-fade-in">
            <button
                onClick={() => setLevel('currencies')}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
                <ArrowLeft className="w-4 h-4" /> Back
            </button>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                        <span className="flex items-center gap-2">
                            <Bitcoin className="w-4.5 h-4.5" />
                            Bitcoin Nodes
                        </span>
                        <button
                            onClick={checkAllHealth}
                            disabled={checkingHealth}
                            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                            title="Check connectivity"
                        >
                            <RefreshCw className={cn("w-4 h-4", checkingHealth && "animate-spin")} />
                        </button>
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    {nodes.length === 0 ? (
                        <div className="py-6 text-center text-sm text-muted-foreground">
                            No nodes configured. Add one below.
                        </div>
                    ) : (
                        <div className="divide-y divide-border">
                            {nodes.map(url => {
                                const health = nodeHealth[url];
                                return (
                                    <div key={url} className="flex items-center gap-3 py-3 first:pt-0 group">
                                        <div className={cn(
                                            "w-2 h-2 rounded-full shrink-0",
                                            health === null ? "bg-muted-foreground animate-pulse" :
                                                health ? "bg-success" : "bg-destructive"
                                        )} />
                                        <span className="text-sm truncate flex-1">{url}</span>
                                        <Badge variant="secondary" className="text-[10px] shrink-0">
                                            {health === null ? 'checking…' : health ? 'online' : 'offline'}
                                        </Badge>
                                        <button
                                            className="text-muted-foreground hover:text-destructive transition-all cursor-pointer shrink-0 p-1"
                                            onClick={() => handleRemoveNode(url)}
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    <div className="flex gap-2 pt-3 mt-2 border-t border-border">
                        <Input
                            value={newNodeUrl}
                            onChange={e => setNewNodeUrl(e.target.value)}
                            placeholder="https://..."
                            className="flex-1 h-8 text-sm h-full"
                            onKeyDown={e => e.key === 'Enter' && handleAddNode()}
                        />
                        <Button
                            size="sm"
                            onClick={handleAddNode}
                            disabled={!newNodeUrl.trim()}
                        >
                            <Plus className="w-4 h-4" /> Add
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
