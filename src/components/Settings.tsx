import { useState, useEffect, useRef } from 'react';
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
    Copy, Check, RefreshCw, Heart, Bitcoin, Banknote, ChevronDown, Sun, Moon, Palette, Store, Network,
} from 'lucide-react';
import { useFeedback } from '@/components/ui/feedback';
import { KeypairManager } from '@/components/KeypairManager';
import { bitcoinNodes } from '@/services/bitcoin';
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

type SubPage = 'accounts' | 'relays' | 'debug' | 'about' | 'security' | 'preferences' | 'merchant' | 'currency-nodes' | null;

interface Props {
    logs: string[];
    appState: AppState;
    onNavigateToWallet?: (recipient: string) => void;
    onNavigateToEcashSend?: (recipient: string) => void;
}

export function Settings({ logs, appState, onNavigateToWallet, onNavigateToEcashSend }: Props) {
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
            await invoke('add_relay', { relayUrl: url });
            setNewRelay('');
        } catch (e: any) {
            toast('Error adding relay: ' + e);
        }
        setAddingRelay(false);
    };

    const handleRemoveRelay = async (url: string) => {
        try { await invoke('remove_relay', { relayUrl: url }); } catch (e: any) { toast('Error: ' + e); }
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
                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Signer's local relays</div>

                        <div className="flex gap-2 mb-3">
                            <Input
                                value={newRelay}
                                onChange={e => setNewRelay(e.target.value)}
                                placeholder="wss://..."
                                className="flex-1 h-8 text-sm"
                                onKeyDown={e => e.key === 'Enter' && handleAddRelay()}
                            />
                            <Button
                                size="sm"
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
                                className="flex-1 h-8 text-sm"
                                onKeyDown={e => e.key === 'Enter' && handleAddUserRelay()}
                            />
                            <Button
                                size="sm"
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
        return <AboutPage onBack={() => setSubPage(null)} toast={toast} onNavigateToWallet={onNavigateToWallet} onNavigateToEcashSend={onNavigateToEcashSend} />;
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
        return <SecuritySettings onBack={() => setSubPage(null)} toast={toast} />;
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
            <div className="h-[100px]" />
        </div>
    );
}

// ── Security Settings Sub-Page ──
function SecuritySettings({ onBack, toast }: { onBack: () => void; toast: (msg: string, type?: 'error' | 'success' | 'info') => void }) {
    const [step, setStep] = useState<'menu' | 'change-pin'>('menu');
    const [currentPin, setCurrentPin] = useState('');
    const [newPin, setNewPin] = useState('');
    const [confirmPin, setConfirmPin] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [showCurrent, setShowCurrent] = useState(false);
    const [showNew, setShowNew] = useState(false);
    const [lockTimeout, setLockTimeout] = useState(5);

    useEffect(() => {
        invoke<{ lock_timeout_minutes: number }>('get_app_state')
            .then(state => setLockTimeout(state.lock_timeout_minutes))
            .catch(() => { });
    }, []);

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
            'UPv2 password-based authentication',
            'Built-in Bitcoin wallet (on-chain)',
            'Cashu eCash wallet with NUT-11 P2PK locking',
            'DNN identity system integration',
            'Per-app policy controls (Manual, Custom, Auto Approve, Auto Reject)',
            'Custom signing rules per event kind',
            'PIN-based lock screen with auto-lock timeout',
            'Offline login attempt detection',
            'Multi-keypair management with account switching',
            'Cross-platform support (Windows, Linux (Android coming soon))',
        ],
    },
];

const DEV_NPUB = 'npub18n4ysp43ux5c98fs6h9c57qpr4p8r3j8f6e32v0vj8egzy878aqqyzzk9r';

// ── About Page Component ──
function AboutPage({ onBack, toast, onNavigateToWallet, onNavigateToEcashSend }: {
    onBack: () => void;
    toast: (msg: string, type?: 'error' | 'success' | 'info') => void;
    onNavigateToWallet?: (recipient: string) => void;
    onNavigateToEcashSend?: (recipient: string) => void;
}) {
    const [expandedVersion, setExpandedVersion] = useState<string | null>(null);
    const [devProfile, setDevProfile] = useState<NostrProfile | null>(null);
    const [devDnnName, setDevDnnName] = useState<string | null>(null);
    const [showDnnId, setShowDnnId] = useState(false);
    const [copied, setCopied] = useState(false);
    const [showTipModal, setShowTipModal] = useState(false);
    const [tipView, setTipView] = useState<'menu' | 'bitcoin' | 'ecash'>('menu');
    const [tipCopied, setTipCopied] = useState(false);

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

            {/* ── Version History ── */}
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm">
                        Version History
                    </CardTitle>
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
