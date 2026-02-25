import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

import SignerDashboard from './components/SignerDashboard';
import { Settings } from './components/Settings';
import { Profile } from './components/Profile';
import { Wallet } from './components/Wallet';
import { IdsView } from './components/IdsView';
import { LockScreen } from './components/LockScreen';
import { Onboarding } from './components/Onboarding';
import { Fingerprint, Users, Settings as SettingsIcon, User, Minus, Square, X, WalletMinimal, AtSign, Store } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDragScroll } from '@/hooks/useDragScroll';

type Tab = 'dashboard' | 'wallet' | 'ids' | 'commerce' | 'settings';

export interface Keypair {
    pubkey: string;
    npub: string;
    name?: string;
    seed_id?: string;
    account_index?: number;
}

export interface SeedInfo {
    id: string;
    name: string;
    keypair_pubkeys: string[];
}

export interface AppState {
    keypairs: Keypair[];
    active_keypair: string | null;
    seeds: SeedInfo[];
    active_seed: string | null;
    initialized: boolean;
    pin_set: boolean;
    lock_timeout_minutes: number;
}

/* ── Fetch profile picture from kind:0 ── */
const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];

async function fetchProfilePicture(pubkey: string): Promise<string | null> {
    return new Promise((resolve) => {
        const subId = 'av_' + Math.random().toString(36).slice(2, 8);
        let best: { created_at: number; picture: string | null } | null = null;
        let resolved = false;
        const sockets: WebSocket[] = [];

        const finish = () => {
            if (resolved) return;
            resolved = true;
            sockets.forEach(s => { try { s.close(); } catch { } });
            resolve(best?.picture ?? null);
        };

        setTimeout(finish, 5000);

        for (const url of DEFAULT_RELAYS) {
            try {
                const ws = new WebSocket(url);
                sockets.push(ws);
                ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, { kinds: [0], authors: [pubkey], limit: 1 }]));
                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'EVENT' && data[2]) {
                            const event = data[2];
                            const createdAt = event.created_at ?? 0;
                            if (!best || createdAt > best.created_at) {
                                const meta = JSON.parse(event.content);
                                best = { created_at: createdAt, picture: meta.picture || null };
                            }
                        }
                        if (data[0] === 'EOSE') ws.close();
                    } catch { }
                };
                ws.onerror = () => ws.close();
            } catch { }
        }
    });
}

const baseTabs: { id: Tab; label: string; icon: typeof Users }[] = [
    { id: 'dashboard', label: 'Signer', icon: Fingerprint },
    { id: 'wallet', label: 'Wallet', icon: WalletMinimal },
    { id: 'ids', label: 'ID', icon: AtSign },
    { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

function App() {
    const [isLight, setIsLight] = useState(() => document.documentElement.classList.contains('light'));
    const logoSrc = isLight ? '/denos-logo-reverse.png' : '/denos-logo.png';

    // Watch for theme class changes on <html> so logo swaps reactively
    useEffect(() => {
        const observer = new MutationObserver(() => {
            setIsLight(document.documentElement.classList.contains('light'));
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);
    const [tab, setTab] = useState<Tab>('dashboard');
    const [showProfile, setShowProfile] = useState(false);
    const [sendPrefill, setSendPrefill] = useState<{ recipient: string; amount: number; feeRate?: number } | null>(null);
    const [ecashPrefill, setEcashPrefill] = useState<{ recipient: string; autoSend: boolean } | null>(null);
    const [appState, setAppState] = useState<AppState>({
        keypairs: [],
        active_keypair: null,
        seeds: [],
        active_seed: null,
        initialized: false,
        pin_set: false,
        lock_timeout_minutes: 5,
    });
    const [logs, setLogs] = useState<string[]>([]);
    const [profilePic, setProfilePic] = useState<string | null>(null);
    const [isLocked, setIsLocked] = useState(true); // Start locked
    const [showOnboarding, setShowOnboarding] = useState(true); // stays true until explicitly dismissed
    const [signerStarted, setSignerStarted] = useState(false);
    const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mainDrag = useDragScroll();
    const navDrag = useDragScroll();
    const [commerceEnabled, setCommerceEnabled] = useState(() => localStorage.getItem('denos-commerce-enabled') === 'true');

    // Listen for commerce toggle changes from Settings
    useEffect(() => {
        const handler = () => setCommerceEnabled(localStorage.getItem('denos-commerce-enabled') === 'true');
        window.addEventListener('commerce-toggle', handler);
        return () => window.removeEventListener('commerce-toggle', handler);
    }, []);

    const tabs = commerceEnabled
        ? [...baseTabs.slice(0, 3), { id: 'commerce' as Tab, label: 'Commerce', icon: Store }, baseTabs[3]]
        : baseTabs;

    useEffect(() => {
        const unlisten = listen<AppState>('app-state', (event) => {
            setAppState(event.payload);
        });
        const unlistenLogs = listen<string>('log-event', (event) => {
            setLogs((prev) => [...prev.slice(-200), event.payload]);
        });
        invoke<AppState>('get_app_state')
            .then((state) => {
                setAppState(state);
                if (state.keypairs.length > 0) setShowOnboarding(false);
            })
            .catch((e) => console.error('Failed to get app state:', e));
        return () => {
            unlisten.then((f) => f());
            unlistenLogs.then((f) => f());
        };
    }, []);

    // Fetch profile picture when active keypair changes
    useEffect(() => {
        if (appState.active_keypair) {
            fetchProfilePicture(appState.active_keypair).then(setProfilePic);
        } else {
            setProfilePic(null);
        }
    }, [appState.active_keypair]);

    // Auto-start the signer when we have an active keypair AND user has unlocked
    useEffect(() => {
        if (appState.active_keypair && !isLocked && !signerStarted) {
            invoke('start_signer').catch(() => { });
            setSignerStarted(true);
        }
    }, [appState.active_keypair, isLocked, signerStarted]);

    // Inactivity timer — lock after timeout (only when PIN is set)
    const resetInactivityTimer = useCallback(() => {
        if (!appState.pin_set || isLocked) return;
        if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = setTimeout(() => {
            setIsLocked(true);
        }, appState.lock_timeout_minutes * 60 * 1000);
    }, [appState.pin_set, appState.lock_timeout_minutes, isLocked]);

    useEffect(() => {
        if (!appState.pin_set || isLocked) return;
        const events = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll'];
        const handler = () => resetInactivityTimer();
        events.forEach(e => window.addEventListener(e, handler, { passive: true }));
        resetInactivityTimer(); // Start the timer
        return () => {
            events.forEach(e => window.removeEventListener(e, handler));
            if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
        };
    }, [appState.pin_set, isLocked, resetInactivityTimer]);

    const handleUnlock = () => {
        setIsLocked(false);
        resetInactivityTimer();
    };

    const hasKeypairs = appState.keypairs.length > 0;
    const activeKeypair = appState.keypairs.find(k => k.pubkey === appState.active_keypair);

    const openProfile = () => setShowProfile(true);
    const closeProfile = () => setShowProfile(false);

    const appWindow = getCurrentWindow();
    const handleMinimize = () => appWindow.minimize();
    const handleMaximize = () => appWindow.toggleMaximize();
    const handleClose = () => appWindow.hide();

    // Native DOM listener for window dragging — React synthetic events fire too late for Wayland
    const titlebarRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = titlebarRef.current;
        if (!el) return;
        const win = getCurrentWindow();
        const onMouseDown = (e: MouseEvent) => {
            if (e.buttons === 1 && !(e.target as HTMLElement).closest('button')) {
                win.startDragging();
            }
        };
        el.addEventListener('mousedown', onMouseDown);
        return () => el.removeEventListener('mousedown', onMouseDown);
    }, []);

    return (
        <div
            ref={mainDrag.ref as React.RefObject<HTMLDivElement>}
            onMouseDown={mainDrag.onMouseDown}
            onMouseMove={mainDrag.onMouseMove}
            onMouseUp={mainDrag.onMouseUp}
            onMouseLeave={mainDrag.onMouseLeave}
            className="h-full bg-background overflow-y-auto select-none"
        >
            {/* Lock Screen */}
            {isLocked && appState.initialized && (
                <LockScreen
                    pinSet={appState.pin_set}
                    signerRunning={signerStarted}
                    onUnlock={handleUnlock}
                />
            )}
            {/* Window controls bar — separate stacking context above modals */}
            <div
                ref={titlebarRef}
                className="fixed top-0 left-0 right-0 z-[100] flex items-center justify-between bg-card px-1 py-1 pointer-events-auto"
            >
                <div className="flex items-center gap-1.5 pl-1.5">
                    <img src={logoSrc} alt="DENOS" className="w-4 h-4" />
                </div>
                <div className="flex items-center">
                    <button onClick={handleMinimize} className="window-control w-8 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors cursor-pointer">
                        <Minus className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={handleMaximize} className="window-control w-8 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors cursor-pointer">
                        <Square className="w-3 h-3" />
                    </button>
                    <button onClick={handleClose} className="w-8 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:bg-red-500/80 hover:text-white transition-colors cursor-pointer">
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>
            {/* App header */}
            <nav className="fixed top-[36px] left-0 right-0 z-50 flex flex-col gap-2.5 pt-2 pointer-events-none">
                <div className="px-2.5 pointer-events-auto">
                    <div className="top-bar-inner flex w-full items-center justify-between bg-card/85 backdrop-blur-lg rounded-xl px-4 py-2.5 border border-white/5">
                        <button onClick={() => setTab('dashboard')} className="flex items-center gap-2.5 cursor-pointer">
                            <img src={logoSrc} alt="DENOS" className="w-7 h-7 rounded-lg" />
                            <span className="text-base font-bold tracking-tight text-foreground">DENOS</span>
                        </button>
                        {hasKeypairs && (
                            <button
                                onClick={openProfile}
                                className="w-8 h-8 rounded-full overflow-hidden border-2 border-primary/30 hover:border-primary transition-colors cursor-pointer shrink-0"
                            >
                                {profilePic ? (
                                    <img src={profilePic} alt="" className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full bg-secondary flex items-center justify-center">
                                        <User className="w-4 h-4 text-muted-foreground" />
                                    </div>
                                )}
                            </button>
                        )}
                    </div>
                </div>
            </nav>

            {/* Content */}
            <main className="px-4 h-full">
                {showProfile ? (
                    <div className="animate-fade-in pt-[115px]">
                        <Profile
                            pubkey={appState.active_keypair}
                            npub={activeKeypair?.npub ?? ''}
                            onBack={closeProfile}
                        />
                    </div>
                ) : showOnboarding && !hasKeypairs ? (
                    <div className="animate-fade-in h-full pt-[115px]">
                        <Onboarding onComplete={() => setShowOnboarding(false)} />
                    </div>
                ) : showOnboarding ? (
                    <div className="animate-fade-in h-full pt-[115px]">
                        <Onboarding onComplete={() => setShowOnboarding(false)} />
                    </div>
                ) : (
                    <div className="animate-fade-in h-full pt-[115px]">
                        {tab === 'dashboard' && <SignerDashboard activePubkey={appState.active_keypair} activeNpub={appState.keypairs.find(k => k.pubkey === appState.active_keypair)?.npub} />}
                        {tab === 'wallet' && <Wallet activePubkey={appState.active_keypair} sendPrefill={sendPrefill} onPrefillConsumed={() => setSendPrefill(null)} ecashRecipient={ecashPrefill?.recipient} ecashAutoSend={ecashPrefill?.autoSend} onEcashPrefillConsumed={() => setEcashPrefill(null)} />}
                        {tab === 'ids' && <IdsView activePubkey={appState.active_keypair} activeNpub={appState.keypairs.find(k => k.pubkey === appState.active_keypair)?.npub} onNavigateToWallet={(recipient, feeRate, amount) => { setSendPrefill({ recipient, amount: amount || 546, feeRate }); setTab('wallet'); }} />}
                        {tab === 'settings' && <Settings logs={logs} appState={appState} onNavigateToWallet={(recipient) => { setSendPrefill({ recipient, amount: 546, feeRate: undefined }); setTab('wallet'); }} onNavigateToEcashSend={(recipient) => { setEcashPrefill({ recipient, autoSend: true }); setTab('wallet'); }} />}
                        {tab === 'commerce' && (
                            <div className="flex flex-col items-center justify-center text-center py-20 px-6 animate-fade-in">
                                <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-5">
                                    <Store className="w-8 h-8 text-primary" />
                                </div>
                                <h2 className="text-xl font-bold mb-2">Commerce</h2>
                                <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">
                                    Coming soon — start accepting payments with network and traditional state currencies.
                                </p>
                            </div>
                        )}
                    </div>
                )}
            </main>

            {/* Bottom nav */}
            <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around px-2.5 py-2.5">
                <div
                    ref={navDrag.ref as React.RefObject<HTMLDivElement>}
                    onMouseDown={navDrag.onMouseDown}
                    onMouseMove={navDrag.onMouseMove}
                    onMouseUp={navDrag.onMouseUp}
                    onMouseLeave={navDrag.onMouseLeave}
                    className="bottom-nav-inner flex w-full gap-1 justify-between bg-card/85 backdrop-blur-lg rounded-xl px-1.5 py-1.5 border border-white/5 overflow-x-auto scrollbar-hide select-none"
                >
                    {tabs.map(({ id, label, icon: Icon }) => {
                        const isActive = tab === id && !showProfile;
                        return (
                            <button
                                key={id}
                                className={cn(
                                    "flex flex-col items-center gap-1 px-4 py-2 rounded-2xl cursor-pointer transition-all duration-200",
                                    isActive
                                        ? "text-primary"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                                onClick={() => { setTab(id); setShowProfile(false); }}
                            >
                                <Icon className="w-5 h-5" strokeWidth={isActive ? 2.5 : 1.8} />
                                <span className={cn(
                                    "text-[11px] leading-none",
                                    isActive ? "font-semibold" : "font-medium"
                                )}>{label}</span>
                            </button>
                        );
                    })}
                </div>
            </nav>
        </div>
    );
}

export default App;
