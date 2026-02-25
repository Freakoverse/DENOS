import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { createPortal } from 'react-dom';
import { dnnService } from '@/services/dnn';
import { fetchNostrProfile } from '@/services/nostrProfile';
import { invoke } from '@tauri-apps/api/core';
import { useFeedback } from '@/components/ui/feedback';
import { listen } from '@tauri-apps/api/event';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { CustomSelect } from '@/components/ui/custom-select';

import { Switch } from '@/components/ui/switch';
import {
    Dialog, DialogContent, DialogHeader, DialogTitle,
    DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
    Zap, Lock, Bell, Settings2,
    Check, Ban, X, Trash2, Eye, EyeOff, RefreshCw,
    AlertTriangle, Shield, ShieldCheck, ShieldX,
    Link2, Unlink, Clock, History,
    Repeat2, ScanLine, QrCode, Copy, Radio,
    ChevronRight, ArrowLeft, Plug, Loader2,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import jsQR from 'jsqr';

interface Connection {
    id: string;
    app_name: string;
    app_url: string | null;
    app_icon: string | null;
    client_pubkey: string;
    relay_urls: string[];
    created_at: number;
    auto_approve: boolean;
    auto_reject: boolean;
    auto_approve_kinds: number[];
    policy: string;
    custom_rules: Record<string, string>;
}

interface PendingRequest {
    id: string;
    connection_id: string;
    app_name: string;
    method: string;
    params_preview: string;
    raw_event_json: string | null;
    event_id: string;
    client_pubkey: string;
    created_at: number;
    kind: number | null;
    source: string;
    upv2_session_id: string | null;
}

interface RelayInfo {
    url: string;
    connected: boolean;
}

interface Upv2LoginKey {
    login_pk: string;
    fingerprint: string;
    enabled: boolean;
    created_at: number;
}

interface Upv2Session {
    session_id: string;
    login_pk: string;
    client_name: string;
    instance_id: string;
    created_at: number;
    last_active: number;
    policy: string;
    custom_rules: Record<string, string>;
}

interface LoginAttempt {
    id: string;
    event_id: string;
    login_pk: string;
    timestamp: number;
    client_name: string | null;
    instance_id: string | null;
    status: string;
    dismissed: boolean;
}

interface Pc55Connection {
    client_id: string;
    app_name: string;
    approved: boolean;
    connected_at: number;
}

/** Countdown bar — uses ref + CSS transition to avoid React re-render interruptions */
const CountdownBar = memo(({ createdAt }: { createdAt: number }) => {
    const barRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = barRef.current;
        if (!el) return;
        const remaining = Math.max(0, 30 - (Math.floor(Date.now() / 1000) - createdAt) - 0.5);
        // Start full, force reflow, then animate to zero
        el.style.width = '100%';
        el.style.transition = 'none';
        void el.offsetHeight; // force reflow
        el.style.transition = `width ${remaining}s linear`;
        el.style.width = '0%';
    }, [createdAt]);
    return (
        <div className="mt-2 -mb-1 h-[2px] rounded-full bg-muted overflow-hidden">
            <div ref={barRef} className="h-full bg-muted-foreground/40 rounded-full" />
        </div>
    );
});

interface SignerState {
    running: boolean;
    connections: Connection[];
    pending_requests: PendingRequest[];
    relays: RelayInfo[];
    user_relays: RelayInfo[];
    nip46_enabled: boolean;
    upv2_login_key: Upv2LoginKey | null;
    upv2_sessions: Upv2Session[];
    login_attempts: LoginAttempt[];
    pc55_running: boolean;
    pc55_connections: Pc55Connection[];
}

interface SigningHistoryEntry {
    id: string;
    timestamp: number;
    method: string;
    kind: number | null;
    app_name: string;
    source: string;
    outcome: string;
    raw_event_json: string | null;
}

interface SignerDashboardProps {
    activePubkey: string | null;
    activeNpub?: string;
}

/* ── Policy constants ── */
const POLICIES = [
    { id: 'manual', label: 'Manual', Icon: Bell },
    { id: 'custom', label: 'Custom', Icon: Settings2 },
    { id: 'auto_approve', label: 'Auto Approve', Icon: ShieldCheck },
    { id: 'auto_reject', label: 'Auto Reject', Icon: ShieldX },
] as const;

function PolicySelector({ current, onChange }: { current: string; onChange: (p: string) => void }) {
    return (
        <div className="grid grid-cols-2 gap-1.5 mt-3 w-full">
            {POLICIES.map(p => (
                <button
                    key={p.id}
                    onClick={(e) => { e.stopPropagation(); onChange(p.id); }}
                    className={cn(
                        "flex items-center justify-center gap-1.5 py-2 px-2 text-xs font-medium rounded-lg cursor-pointer transition-all duration-150",
                        current === p.id
                            ? "bg-secondary text-foreground"
                            : "text-muted-foreground hover:bg-secondary/60"
                    )}
                >
                    <p.Icon className="w-3.5 h-3.5 shrink-0" />
                    {p.label}
                </button>
            ))}
        </div>
    );
}



export default function SignerDashboard({ activePubkey, activeNpub }: SignerDashboardProps) {
    const [signerState, setSignerState] = useState<SignerState>({
        running: false, connections: [], pending_requests: [], relays: [], user_relays: [],
        nip46_enabled: true,
        upv2_login_key: null, upv2_sessions: [], login_attempts: [],
        pc55_running: false, pc55_connections: [],
    });
    const [bunkerUri, setBunkerUri] = useState('');
    const [nostrconnectInput, setNostrconnectInput] = useState('');
    const [connectMode, setConnectMode] = useState<'nostrconnect' | 'bunker'>('nostrconnect');
    const [upv2Password, setUpv2Password] = useState('');
    const [upv2ConfirmPassword, setUpv2ConfirmPassword] = useState('');
    const [upv2ShowPassword, setUpv2ShowPassword] = useState(false);
    const [upv2SetupMode, setUpv2SetupMode] = useState<'idle' | 'setup' | 'change'>('idle');
    const [upv2Error, setUpv2Error] = useState('');
    const [upv2Loading, setUpv2Loading] = useState(false);
    const [reconnectPrompt, setReconnectPrompt] = useState<any>(null);
    const [reconnectKeepRules, setReconnectKeepRules] = useState(true);
    const [showLoginHistory, setShowLoginHistory] = useState(false);
    const [showBunkerQr, setShowBunkerQr] = useState(false);
    const [expandedRawEvent, setExpandedRawEvent] = useState<string | null>(null);
    const [showScanner, setShowScanner] = useState(false);
    const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
    const [selectedCamera, setSelectedCamera] = useState('');
    const [copied, setCopied] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const [npubCopied, setNpubCopied] = useState(false);
    const [showConnectedApps, setShowConnectedApps] = useState(false);
    const [connTab, setConnTab] = useState<'bunker' | 'password' | 'local'>('bunker');
    const [customRulesModal, setCustomRulesModal] = useState<{ id: string; name: string; type: 'nip46' | 'upv2' } | null>(null);
    const [disconnectConfirm, setDisconnectConfirm] = useState<{ name: string; onConfirm: () => void } | null>(null);
    const [dismissedRequests, setDismissedRequests] = useState<Set<string>>(new Set());
    const [exitingRequests, setExitingRequests] = useState<Set<string>>(new Set());
    // Signing History modal state
    const [showHistory, setShowHistory] = useState(false);
    const [historyEntries, setHistoryEntries] = useState<SigningHistoryEntry[]>([]);
    const [selectedHistoryEntry, setSelectedHistoryEntry] = useState<SigningHistoryEntry | null>(null);
    const [showRelayModal, setShowRelayModal] = useState(false);
    const dismissTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());
    // DNN ID state
    const [dnnId, setDnnId] = useState<string | null>(null);
    const [dnnVerified, setDnnVerified] = useState<boolean | null>(null);
    const [dnnVerifying, setDnnVerifying] = useState(false);
    const [addressDisplay, setAddressDisplay] = useState<'npub' | 'dnn'>('npub');
    const [dnnServiceReady, setDnnServiceReady] = useState(false);
    // Ticking clock for toast expiry (re-renders every second when requests exist)
    const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const scanIntervalRef = useRef<number | null>(null);
    const { toast, confirm: showConfirm } = useFeedback();

    // Initialize DNN service on mount
    useEffect(() => {
        dnnService.initialize().then(() => setDnnServiceReady(true));
    }, []);

    // Auto-start PC55 local signer server on mount
    useEffect(() => {
        invoke('start_pc55_server').catch((e: unknown) => {
            console.log('PC55 auto-start:', e);
        });
    }, []);

    // Tick every second while pending requests exist so expired toasts auto-vanish
    useEffect(() => {
        if (signerState.pending_requests.length === 0) return;
        const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
        return () => clearInterval(id);
    }, [signerState.pending_requests.length]);

    // Fetch kind:0 profile and check for DNN ID when npub/pubkey changes
    useEffect(() => {
        if (!activePubkey || !activeNpub) {
            setDnnId(null);
            setDnnVerified(null);
            return;
        }

        let cancelled = false;

        (async () => {
            try {
                // Fetch kind:0 from relays
                const relayUrls = signerState.relays.map(r => r.url);
                const profile = await fetchNostrProfile(activePubkey, relayUrls.length > 0 ? relayUrls : undefined);
                if (cancelled) return;

                const nip05 = profile?.nip05;
                if (!nip05) {
                    setDnnId(null);
                    setDnnVerified(null);
                    return;
                }

                // Detect DNN ID: no '@' means it's a DNN ID
                const isDnn = !nip05.includes('@');
                if (!isDnn) {
                    setDnnId(null);
                    setDnnVerified(null);
                    return;
                }

                setDnnId(nip05);
                setAddressDisplay('dnn');

                // Wait for DNN service to be ready then verify
                if (!dnnServiceReady) return;
                setDnnVerifying(true);
                const verified = await dnnService.verifyDnnId(nip05, activeNpub);
                if (cancelled) return;
                setDnnVerified(verified);
                setDnnVerifying(false);
            } catch (e) {
                console.error('[DNN] Failed to fetch/verify:', e);
                if (!cancelled) {
                    setDnnVerified(false);
                    setDnnVerifying(false);
                }
            }
        })();

        return () => { cancelled = true; };
    }, [activePubkey, activeNpub, dnnServiceReady]);

    const stopScanner = useCallback(() => {
        if (scanIntervalRef.current) {
            clearInterval(scanIntervalRef.current);
            scanIntervalRef.current = null;
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
        }
    }, []);

    const startScanner = useCallback(async (deviceId?: string) => {
        stopScanner();
        try {
            const constraints: MediaStreamConstraints = {
                video: deviceId
                    ? { deviceId: { exact: deviceId } }
                    : { facingMode: 'environment' }
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                videoRef.current.play();
            }
            // Enumerate cameras after getting permission
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(d => d.kind === 'videoinput');
            setCameras(videoDevices);
            if (!deviceId && videoDevices.length > 0) {
                // Set selected to the active track's device
                const activeTrack = stream.getVideoTracks()[0];
                const activeDeviceId = activeTrack?.getSettings()?.deviceId || videoDevices[0].deviceId;
                setSelectedCamera(activeDeviceId);
            }
            // Start scanning loop
            scanIntervalRef.current = window.setInterval(() => {
                const video = videoRef.current;
                const canvas = canvasRef.current;
                if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) return;
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const code = jsQR(imageData.data, imageData.width, imageData.height);
                if (code && code.data) {
                    setNostrconnectInput(code.data);
                    setShowScanner(false);
                    stopScanner();
                    toast('QR code scanned!');
                }
            }, 200);
        } catch (e: any) {
            toast('Camera error: ' + (e.message || e));
            setShowScanner(false);
        }
    }, [stopScanner, toast]);

    // Clean up camera on dialog close
    useEffect(() => {
        if (!showScanner) stopScanner();
    }, [showScanner, stopScanner]);

    useEffect(() => {
        const unlisten = listen<SignerState>('signer-state', (event) => setSignerState(event.payload));
        return () => { unlisten.then(fn => fn()); };
    }, []);

    useEffect(() => {
        const unlisten = listen<any>('reconnect-prompt', (event) => {
            setReconnectPrompt(event.payload);
            setReconnectKeepRules(true);
        });
        return () => { unlisten.then(fn => fn()); };
    }, []);


    useEffect(() => {
        invoke<SignerState>('get_signer_state').then(setSignerState).catch(() => { });
    }, []);



    // Auto-dismiss pending requests after 30s at front of stack
    useEffect(() => {
        const activeRequests = signerState.pending_requests.filter(r => !dismissedRequests.has(r.id));
        if (activeRequests.length === 0) return;
        const frontReq = activeRequests[0];
        if (dismissTimers.current.has(frontReq.id)) return;
        const timer = setTimeout(() => {
            exitRequest(frontReq.id);
            dismissTimers.current.delete(frontReq.id);
        }, 30000);
        dismissTimers.current.set(frontReq.id, timer);
        return () => {
            // Clean up timers for requests that no longer exist
            for (const [id, t] of dismissTimers.current.entries()) {
                if (!signerState.pending_requests.find(r => r.id === id)) {
                    clearTimeout(t);
                    dismissTimers.current.delete(id);
                }
            }
        };
    }, [signerState.pending_requests, dismissedRequests]);

    // Clean dismissed set when requests disappear from state
    useEffect(() => {
        const currentIds = new Set(signerState.pending_requests.map(r => r.id));
        setDismissedRequests(prev => {
            const next = new Set<string>();
            for (const id of prev) {
                if (currentIds.has(id)) next.add(id);
            }
            return next.size !== prev.size ? next : prev;
        });
    }, [signerState.pending_requests]);

    // Reset per-keypair transient state when active keypair changes
    useEffect(() => {
        setUpv2Password('');
        setUpv2ConfirmPassword('');
        setUpv2ShowPassword(false);
        setUpv2SetupMode('idle');
        setUpv2Error('');
        setBunkerUri('');
        setShowConnectedApps(false);
        setShowLoginHistory(false);
        setShowBunkerQr(false);
    }, [activePubkey]);

    // Auto-generate bunker URI
    useEffect(() => {
        if (activePubkey && !bunkerUri) {
            invoke<{ uri: string; secret: string }>('get_bunker_uri')
                .then(result => setBunkerUri(result.uri))
                .catch(() => { });
        }
    }, [activePubkey]);

    /* ── Handlers ── */
    const handleNostrconnect = async () => {
        if (!nostrconnectInput.trim() || connecting) return;
        setConnecting(true);
        try {
            const info = await invoke<any>('parse_nostrconnect_uri', { uri: nostrconnectInput });
            await invoke('connect_nostrconnect', { info });
            setNostrconnectInput('');
            toast('Connected successfully!', 'success');
        } catch (e: any) { toast('Connect error: ' + e); }
        finally { setConnecting(false); }
    };
    const deleteConnection = async (id: string) => {
        try { await invoke('delete_connection', { connectionId: id }); } catch (e: any) { toast('Error: ' + e); }
    };
    const setConnectionPolicy = async (connectionId: string, policy: string) => {
        try { await invoke('set_connection_policy', { connectionId, policy }); } catch (e: any) { toast('Error: ' + e); }
    };
    const exitRequest = (id: string) => {
        setExitingRequests(prev => new Set(prev).add(id));
        setTimeout(() => {
            setDismissedRequests(prev => new Set(prev).add(id));
            setExitingRequests(prev => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }, 300);
    };
    const approveRequest = async (id: string) => {
        exitRequest(id);
        try { await invoke('approve_request', { requestId: id }); } catch (e: any) { toast('Error: ' + e); }
    };
    const rejectRequest = async (id: string) => {
        exitRequest(id);
        try { await invoke('reject_request', { requestId: id }); } catch (e: any) { toast('Error: ' + e); }
    };
    const setCustomRule = async (connectionId: string, method: string, action: string) => {
        try { await invoke('set_custom_rule', { connectionId, method, action }); } catch (e: any) { toast('Error: ' + e); }
    };
    const removeCustomRule = async (connectionId: string, method: string) => {
        try { await invoke('remove_custom_rule', { connectionId, method }); } catch (e: any) { toast('Error: ' + e); }
    };
    const getPolicy = (conn: Connection): string => conn.policy || 'manual';
    const getRuleKey = (req: PendingRequest): string => {
        if (req.method === 'sign_event' && req.kind != null) return `sign_event:${req.kind}`;
        return req.method;
    };
    const approveAlways = async (req: PendingRequest) => {
        await approveRequest(req.id);
        if (req.source === 'upv2') {
            const session = signerState.upv2_sessions.find(s => s.session_id === req.upv2_session_id);
            if (session) {
                if (session.policy === 'manual') await invoke('set_upv2_session_policy', { sessionId: session.session_id, policy: 'custom' });
                await invoke('set_upv2_custom_rule', { sessionId: session.session_id, method: getRuleKey(req), action: 'approve' });
            }
        } else {
            const conn = signerState.connections.find(c => c.id === req.connection_id);
            if (conn) {
                if (getPolicy(conn) === 'manual') await invoke('set_connection_policy', { connectionId: conn.id, policy: 'custom' });
                await invoke('set_custom_rule', { connectionId: conn.id, method: getRuleKey(req), action: 'approve' });
            }
        }
    };
    const rejectAlways = async (req: PendingRequest) => {
        await rejectRequest(req.id);
        if (req.source === 'upv2') {
            const session = signerState.upv2_sessions.find(s => s.session_id === req.upv2_session_id);
            if (session) {
                if (session.policy === 'manual') await invoke('set_upv2_session_policy', { sessionId: session.session_id, policy: 'custom' });
                await invoke('set_upv2_custom_rule', { sessionId: session.session_id, method: getRuleKey(req), action: 'reject' });
            }
        } else {
            const conn = signerState.connections.find(c => c.id === req.connection_id);
            if (conn) {
                if (getPolicy(conn) === 'manual') await invoke('set_connection_policy', { connectionId: conn.id, policy: 'custom' });
                await invoke('set_custom_rule', { connectionId: conn.id, method: getRuleKey(req), action: 'reject' });
            }
        }
    };

    if (!activePubkey) {
        return (
            <Card>
                <CardContent className="py-12 text-center">
                    <Shield className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                    <p className="text-muted-foreground text-base">Create or import a key first</p>
                </CardContent>
            </Card>
        );
    }

    const offlineAttempts = signerState.login_attempts.filter(a => a.status === 'offline_missed' && !a.dismissed);

    const totalConnections = signerState.connections.length + signerState.upv2_sessions.length;

    /* ── Connected Apps sub-view ── */
    if (showConnectedApps) {
        return (
            <div className="flex flex-col gap-4 h-[calc(100vh-115px)] animate-fade-in">
                {/* Header */}
                <div className="flex items-center gap-3 shrink-0">
                    <button
                        onClick={() => setShowConnectedApps(false)}
                        className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors"
                    >
                        <ArrowLeft className="w-4.5 h-4.5 text-muted-foreground" />
                    </button>
                    <div className="flex-1">
                        <h2 className="text-base font-semibold">Connected Apps</h2>
                        <p className="text-xs text-muted-foreground">{totalConnections} connection{totalConnections !== 1 ? 's' : ''}</p>
                    </div>
                </div>

                {/* Signing History button */}
                <button
                    onClick={() => {
                        invoke<SigningHistoryEntry[]>('get_signing_history').then(entries => {
                            setHistoryEntries(entries);
                            setShowHistory(true);
                        });
                    }}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-secondary border border-border hover:bg-secondary/80 transition-colors cursor-pointer shrink-0"
                >
                    <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 bg-muted">
                        <History className="w-5 h-5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 text-left">
                        <div className="text-sm font-semibold">Signing History</div>
                        <div className="text-xs text-muted-foreground">View recent signing requests</div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </button>

                {/* Connection type tabs */}
                {(() => {
                    const bunkerConns = signerState.connections.filter(c => !c.client_pubkey.startsWith('pc55:'));
                    const localConns = signerState.connections.filter(c => c.client_pubkey.startsWith('pc55:'));
                    const passwordSessions = signerState.upv2_sessions;
                    type ConnTab = 'bunker' | 'password' | 'local';
                    const tabs: { id: ConnTab; label: string; count: number }[] = [
                        { id: 'bunker', label: 'Bunker', count: bunkerConns.length },
                        { id: 'password', label: 'Password', count: passwordSessions.length },
                        { id: 'local', label: 'Local', count: localConns.length },
                    ];
                    return (
                        <>
                            <div className="flex gap-1 bg-secondary p-1 rounded-xl border border-border shrink-0">
                                {tabs.map(t => (
                                    <button
                                        key={t.id}
                                        onClick={() => setConnTab(t.id)}
                                        className={cn(
                                            "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-all cursor-pointer",
                                            connTab === t.id
                                                ? "bg-primary text-primary-foreground shadow-md"
                                                : "text-muted-foreground hover:text-foreground"
                                        )}
                                    >
                                        {t.label}
                                        <span className={cn(
                                            "text-[10px] min-w-[18px] h-[18px] flex items-center justify-center rounded-full px-1",
                                            connTab === t.id ? "bg-white/20 text-primary-foreground" : "bg-muted text-muted-foreground"
                                        )}>{t.count}</span>
                                    </button>
                                ))}
                            </div>

                            <div className="flex-1 overflow-y-auto space-y-3 pb-[100px]">
                                {connTab === 'bunker' && bunkerConns.map(conn => {
                                    const policy = getPolicy(conn);
                                    const rules = conn.custom_rules || {};
                                    return (
                                        <Card key={`nip46-${conn.id}`}>
                                            <CardContent className="pt-4 space-y-3">
                                                <div className="flex justify-between items-start">
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-2">
                                                            <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                                                                <Link2 className="w-4 h-4 text-primary" />
                                                            </div>
                                                            <div>
                                                                <span className="text-sm font-semibold">{conn.app_name}</span>
                                                            </div>
                                                        </div>
                                                        <div className="text-xs text-muted-foreground font-mono mt-2 pl-10">
                                                            {conn.client_pubkey.slice(0, 12)}...{conn.client_pubkey.slice(-8)}
                                                        </div>
                                                        {conn.created_at && (
                                                            <div className="text-xs text-muted-foreground mt-1 pl-10 flex items-center gap-1">
                                                                <Clock className="w-3 h-3" />
                                                                Connected {new Date(conn.created_at * 1000).toLocaleDateString()}
                                                            </div>
                                                        )}
                                                    </div>
                                                    <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive" onClick={() => setDisconnectConfirm({ name: conn.app_name, onConfirm: () => { deleteConnection(conn.id); setDisconnectConfirm(null); } })}>
                                                        <Unlink className="w-4 h-4" />
                                                    </Button>
                                                </div>
                                                <div className="border-t border-border flex flex-wrap">
                                                    <PolicySelector current={policy} onChange={(p) => setConnectionPolicy(conn.id, p)} />
                                                    {policy === 'custom' && (
                                                        <button
                                                            onClick={() => setCustomRulesModal({
                                                                id: conn.id,
                                                                name: conn.app_name,
                                                                type: 'nip46',
                                                            })}
                                                            className="mt-3 w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg cursor-pointer bg-secondary text-muted-foreground hover:bg-secondary/80 transition-colors"
                                                        >
                                                            <span className="flex items-center gap-1.5">
                                                                <Settings2 className="w-3.5 h-3.5" />
                                                                {Object.keys(rules).length === 0 ? 'No rules set' : `${Object.keys(rules).length} rule${Object.keys(rules).length !== 1 ? 's' : ''}`}
                                                            </span>
                                                            <ChevronRight className="w-3.5 h-3.5" />
                                                        </button>
                                                    )}
                                                </div>
                                            </CardContent>
                                        </Card>
                                    );
                                })}

                                {connTab === 'local' && localConns.map(conn => {
                                    const policy = getPolicy(conn);
                                    const rules = conn.custom_rules || {};
                                    return (
                                        <Card key={`pc55-${conn.id}`}>
                                            <CardContent className="pt-4 space-y-3">
                                                <div className="flex justify-between items-start">
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-2">
                                                            <div className="w-8 h-8 rounded-full bg-green-500/15 flex items-center justify-center shrink-0">
                                                                <Link2 className="w-4 h-4 text-green-500" />
                                                            </div>
                                                            <div>
                                                                <span className="text-sm font-semibold">{conn.app_name}</span>
                                                            </div>
                                                        </div>
                                                        <div className="text-xs text-muted-foreground font-mono mt-2 pl-10">
                                                            {conn.client_pubkey.replace('pc55:', '').slice(0, 12)}...{conn.client_pubkey.slice(-8)}
                                                        </div>
                                                        {conn.created_at && (
                                                            <div className="text-xs text-muted-foreground mt-1 pl-10 flex items-center gap-1">
                                                                <Clock className="w-3 h-3" />
                                                                Connected {new Date(conn.created_at * 1000).toLocaleDateString()}
                                                            </div>
                                                        )}
                                                    </div>
                                                    <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive" onClick={() => setDisconnectConfirm({ name: conn.app_name, onConfirm: () => { deleteConnection(conn.id); setDisconnectConfirm(null); } })}>
                                                        <Unlink className="w-4 h-4" />
                                                    </Button>
                                                </div>
                                                <div className="border-t border-border flex flex-wrap">
                                                    <PolicySelector current={policy} onChange={(p) => setConnectionPolicy(conn.id, p)} />
                                                    {policy === 'custom' && (
                                                        <button
                                                            onClick={() => setCustomRulesModal({
                                                                id: conn.id,
                                                                name: conn.app_name,
                                                                type: 'nip46',
                                                            })}
                                                            className="mt-3 w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg cursor-pointer bg-secondary text-muted-foreground hover:bg-secondary/80 transition-colors"
                                                        >
                                                            <span className="flex items-center gap-1.5">
                                                                <Settings2 className="w-3.5 h-3.5" />
                                                                {Object.keys(rules).length === 0 ? 'No rules set' : `${Object.keys(rules).length} rule${Object.keys(rules).length !== 1 ? 's' : ''}`}
                                                            </span>
                                                            <ChevronRight className="w-3.5 h-3.5" />
                                                        </button>
                                                    )}
                                                </div>
                                            </CardContent>
                                        </Card>
                                    );
                                })}

                                {connTab === 'password' && passwordSessions.map(session => {
                                    const sessionPolicy = session.policy || 'manual';
                                    const sessionRules = session.custom_rules || {};
                                    const ago = Math.floor((Date.now() / 1000) - session.last_active);
                                    const agoStr = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.floor(ago / 60)}m ago` : `${Math.floor(ago / 3600)}h ago`;
                                    return (
                                        <Card key={`upv2-${session.session_id}`}>
                                            <CardContent className="pt-4 space-y-3">
                                                <div className="flex justify-between items-start">
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-2">
                                                            <div className="w-8 h-8 rounded-full bg-warning/15 flex items-center justify-center shrink-0">
                                                                <Lock className="w-4 h-4 text-warning" />
                                                            </div>
                                                            <div>
                                                                <span className="text-sm font-semibold">{session.client_name}</span>
                                                            </div>
                                                        </div>
                                                        <div className="text-xs text-muted-foreground mt-2 flex flex-wrap items-center gap-1.5">
                                                            <Clock className="w-3 h-3" />
                                                            Last active {agoStr}
                                                            {session.instance_id && <span className="text-muted-foreground/60">· {session.instance_id.slice(0, 8)}…</span>}
                                                        </div>
                                                    </div>
                                                    <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive" onClick={() => setDisconnectConfirm({ name: session.client_name, onConfirm: () => { invoke('revoke_upv2_session', { sessionId: session.session_id }); setDisconnectConfirm(null); } })}>
                                                        <Unlink className="w-4 h-4" />
                                                    </Button>
                                                </div>
                                                <div className="border-t border-border flex flex-wrap">
                                                    <PolicySelector
                                                        current={sessionPolicy}
                                                        onChange={(p) => invoke('set_upv2_session_policy', { sessionId: session.session_id, policy: p })}
                                                    />
                                                    {sessionPolicy === 'custom' && (
                                                        <button
                                                            onClick={() => setCustomRulesModal({
                                                                id: session.session_id,
                                                                name: session.client_name,
                                                                type: 'upv2',
                                                            })}
                                                            className="mt-3 w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg cursor-pointer bg-secondary text-muted-foreground hover:bg-secondary/80 transition-colors"
                                                        >
                                                            <span className="flex items-center gap-1.5">
                                                                <Settings2 className="w-3.5 h-3.5" />
                                                                {Object.keys(sessionRules).length === 0 ? 'No rules set' : `${Object.keys(sessionRules).length} rule${Object.keys(sessionRules).length !== 1 ? 's' : ''}`}
                                                            </span>
                                                            <ChevronRight className="w-3.5 h-3.5" />
                                                        </button>
                                                    )}
                                                </div>
                                            </CardContent>
                                        </Card>
                                    );
                                })}

                                {/* Empty state for current tab */}
                                {((connTab === 'bunker' && bunkerConns.length === 0) ||
                                    (connTab === 'password' && passwordSessions.length === 0) ||
                                    (connTab === 'local' && localConns.length === 0)) && (
                                        <Card>
                                            <CardContent className="py-12 text-center">
                                                <Shield className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                                                <p className="text-muted-foreground text-sm">No {connTab} connections</p>
                                            </CardContent>
                                        </Card>
                                    )}
                            </div>
                        </>
                    );
                })()}

                {/* Reconnect Dialog needs to be here too */}
                <Dialog open={!!reconnectPrompt} onOpenChange={() => { }} modal={false}>
                    <DialogContent hideClose>
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                <RefreshCw className="w-5 h-5" /> Reconnection Detected
                            </DialogTitle>
                            <DialogDescription>
                                <strong>{reconnectPrompt?.app_name}</strong> is trying to connect, but an existing {reconnectPrompt?.existing_source === 'nip46' ? 'NIP-46' : reconnectPrompt?.existing_source === 'pc55' ? 'PC55' : 'UPV2'} connection already exists.
                            </DialogDescription>
                        </DialogHeader>
                        <p className="text-sm text-muted-foreground">What would you like to do with the existing connection?</p>
                        <label className="flex items-center justify-between gap-3 text-sm text-foreground cursor-pointer p-3 bg-secondary rounded-xl">
                            Keep existing policy & custom rules
                            <Switch checked={reconnectKeepRules} onCheckedChange={setReconnectKeepRules} />
                        </label>
                        <DialogFooter>
                            <Button variant="destructive" onClick={() => { invoke('resolve_reconnect', { action: 'reject', keepRules: false }); setReconnectPrompt(null); }}>Reject</Button>
                            <Button variant="outline" onClick={() => { invoke('resolve_reconnect', { action: 'keep', keepRules: false }); setReconnectPrompt(null); }}>Keep Both</Button>
                            <Button onClick={() => { invoke('resolve_reconnect', { action: 'replace', keepRules: reconnectKeepRules }); setReconnectPrompt(null); }}>Replace</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                {/* Custom Rules Modal */}
                <Dialog open={!!customRulesModal} onOpenChange={(open) => { if (!open) setCustomRulesModal(null); }}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                <Settings2 className="w-5 h-5" />
                                Custom Rules
                            </DialogTitle>
                            <DialogDescription>
                                Per-method rules for <strong>{customRulesModal?.name}</strong>
                            </DialogDescription>
                        </DialogHeader>
                        {(() => {
                            if (!customRulesModal) return null;
                            const conn = customRulesModal.type === 'nip46'
                                ? signerState.connections.find(c => c.id === customRulesModal.id)
                                : null;
                            const session = customRulesModal.type === 'upv2'
                                ? signerState.upv2_sessions?.find(s => s.session_id === customRulesModal.id)
                                : null;
                            const liveRules = (customRulesModal.type === 'nip46' ? conn?.custom_rules : session?.custom_rules) || {};
                            const handleSetRule = (method: string, action: string) => {
                                if (customRulesModal.type === 'nip46') setCustomRule(customRulesModal.id, method, action);
                                else invoke('set_upv2_custom_rule', { sessionId: customRulesModal.id, method, action });
                            };
                            const handleRemoveRule = (method: string) => {
                                if (customRulesModal.type === 'nip46') removeCustomRule(customRulesModal.id, method);
                                else invoke('remove_upv2_custom_rule', { sessionId: customRulesModal.id, method });
                            };
                            if (Object.keys(liveRules).length === 0) return (
                                <div className="py-8 text-center">
                                    <Settings2 className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                                    <p className="text-sm text-muted-foreground">No rules set yet</p>
                                    <p className="text-xs text-muted-foreground/60 mt-1">Use the + buttons on a pending request to add rules</p>
                                </div>
                            );
                            return (
                                <div className="space-y-1">
                                    {Object.entries(liveRules).map(([method, action]) => (
                                        <div key={method} className="flex items-center justify-between p-3 bg-secondary rounded-lg">
                                            <span className="text-sm font-mono text-foreground">{method}</span>
                                            <div className="flex gap-1">
                                                <button
                                                    onClick={() => handleSetRule(method, 'approve')}
                                                    className={cn(
                                                        "p-2 rounded-lg cursor-pointer transition-colors",
                                                        action === 'approve' ? "bg-success/20 text-success" : "text-muted-foreground hover:bg-background"
                                                    )}
                                                ><Check className="w-4 h-4" /></button>
                                                <button
                                                    onClick={() => handleSetRule(method, 'reject')}
                                                    className={cn(
                                                        "p-2 rounded-lg cursor-pointer transition-colors",
                                                        action === 'reject' ? "bg-destructive/20 text-destructive" : "text-muted-foreground hover:bg-background"
                                                    )}
                                                ><Ban className="w-4 h-4" /></button>
                                                <button
                                                    onClick={() => handleRemoveRule(method)}
                                                    className="p-2 rounded-lg text-muted-foreground cursor-pointer hover:bg-background transition-colors"
                                                ><Trash2 className="w-4 h-4" /></button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            );
                        })()}
                    </DialogContent>
                </Dialog>

                {/* Disconnect Confirmation */}
                <Dialog open={!!disconnectConfirm} onOpenChange={(open) => { if (!open) setDisconnectConfirm(null); }}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                <Unlink className="w-5 h-5" />
                                Disconnect App
                            </DialogTitle>
                            <DialogDescription>
                                Are you sure you want to disconnect <strong>{disconnectConfirm?.name}</strong>? This will revoke its access.
                            </DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setDisconnectConfirm(null)}>Cancel</Button>
                            <Button variant="destructive" onClick={() => disconnectConfirm?.onConfirm()}>Disconnect</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                {/* ── Signing History Modal ── */}
                <Dialog open={showHistory} onOpenChange={(open) => { if (!open) { setShowHistory(false); setSelectedHistoryEntry(null); } }}>
                    <DialogContent className="max-w-md max-h-[80vh] flex flex-col">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                <History className="w-5 h-5" />
                                Signing History
                            </DialogTitle>
                            <DialogDescription>
                                Latest {historyEntries.length} signing request{historyEntries.length !== 1 ? 's' : ''}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="overflow-y-auto flex-1 -mx-6 px-6 space-y-2">
                            {historyEntries.length === 0 ? (
                                <div className="py-12 text-center">
                                    <History className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                                    <p className="text-muted-foreground text-sm">No signing history yet</p>
                                </div>
                            ) : historyEntries.map(entry => (
                                <div
                                    key={entry.id}
                                    className="rounded-xl bg-secondary/40 p-3 cursor-pointer hover:bg-secondary/60 transition-colors"
                                    onClick={() => setSelectedHistoryEntry(selectedHistoryEntry?.id === entry.id ? null : entry)}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <Badge variant={
                                                entry.outcome === 'approved' || entry.outcome === 'auto_approved'
                                                    ? 'default'
                                                    : 'destructive'
                                            } className={cn(
                                                "text-[10px] px-1.5 py-0 shrink-0",
                                                (entry.outcome === 'approved' || entry.outcome === 'auto_approved') && "bg-success text-success-foreground"
                                            )}>
                                                {entry.outcome === 'auto_approved' ? 'Auto ✓' :
                                                    entry.outcome === 'auto_rejected' ? 'Auto ✗' :
                                                        entry.outcome === 'approved' ? 'Approved' : 'Rejected'}
                                            </Badge>
                                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                                                {entry.source === 'nip46' ? 'Bunker' : entry.source === 'pc55' ? 'Local' : 'Password'}
                                            </Badge>
                                            <span className="text-sm font-medium truncate">{entry.app_name}</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-between mt-1.5">
                                        <span className="text-xs text-muted-foreground">
                                            {entry.method}{entry.kind != null ? ` (kind ${entry.kind})` : ''}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {new Date(entry.timestamp * 1000).toLocaleString()}
                                        </span>
                                    </div>
                                    {selectedHistoryEntry?.id === entry.id && entry.raw_event_json && (
                                        <pre className="mt-2 p-2 bg-background rounded-lg text-xs overflow-x-auto max-h-[200px] overflow-y-auto border border-border">
                                            {(() => {
                                                try { return JSON.stringify(JSON.parse(entry.raw_event_json), null, 2); }
                                                catch { return entry.raw_event_json; }
                                            })()}
                                        </pre>
                                    )}
                                    {selectedHistoryEntry?.id === entry.id && !entry.raw_event_json && (
                                        <p className="mt-2 text-xs text-muted-foreground italic">No event data available</p>
                                    )}
                                </div>
                            ))}
                        </div>
                    </DialogContent>
                </Dialog>
            </div>
        );
    }

    return (
        <div className="space-y-4 pb-[100px]">


            {/* ── Pending Request Toasts (floating, rendered via portal) ── */}
            {(() => {
                const visibleRequests = signerState.pending_requests.filter(r => !dismissedRequests.has(r.id) && (nowSec - r.created_at) < 30);
                if (visibleRequests.length === 0) return null;
                const nonExiting = visibleRequests.filter(r => !exitingRequests.has(r.id));
                const stackItems = visibleRequests.slice(0, 3);
                return createPortal(
                    <div className="fixed bottom-[60px] left-0 right-0 z-[60] px-3 pointer-events-none flex flex-col gap-4 mb-[30px]">
                        <div className="relative mx-auto w-full max-w-md" style={{ height: '230px' }}>
                            {/* Render in reverse so the front card (index 0) renders last and is on top */}
                            {[...stackItems].reverse().map((req) => {
                                const index = stackItems.indexOf(req);
                                const isExiting = exitingRequests.has(req.id);
                                const activeIndex = isExiting ? index : nonExiting.indexOf(req);
                                const isTop = activeIndex === 0 && !isExiting;
                                const stackScale = isExiting ? 1 : 1 - (activeIndex * 0.03);
                                return (
                                    <div
                                        key={req.id}
                                        className={cn(
                                            "absolute left-0 right-0 pointer-events-auto transition-[transform,opacity] duration-300 ease-out",
                                            isTop && "animate-toast-in",
                                            isExiting && "animate-toast-exit"
                                        )}
                                        style={{
                                            bottom: isExiting ? '0px' : `${activeIndex * 12}px`,
                                            transform: `scale(${stackScale})`,
                                            transformOrigin: 'top center',
                                            zIndex: isExiting ? 4 : 3 - activeIndex,
                                        }}
                                    >
                                        <div className="bg-card border border-border rounded-2xl shadow-lg shadow-black/30 p-4">
                                            <div className="flex items-start gap-3">
                                                <div className="w-9 h-9 rounded-full bg-warning/15 flex items-center justify-center shrink-0 mt-0.5">
                                                    <Zap className="w-4.5 h-4.5 text-warning" />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm">
                                                        <strong>{req.app_name}</strong>
                                                        <span className="text-muted-foreground"> requests </span>
                                                        <strong>{req.method}</strong>
                                                        {req.kind != null && <span className="text-muted-foreground"> (kind {req.kind})</span>}
                                                    </p>
                                                    <div className="flex items-center gap-1.5 mt-1">
                                                        {req.source === 'upv2' && (
                                                            <Badge variant="warning" className="text-[10px] py-0">Password</Badge>
                                                        )}
                                                        {req.raw_event_json && (
                                                            <button
                                                                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                                                onClick={() => setExpandedRawEvent(expandedRawEvent === req.id ? null : req.id)}
                                                            >
                                                                <Eye className="w-3 h-3" /> {expandedRawEvent === req.id ? 'Hide Raw' : 'View Raw'}
                                                            </button>
                                                        )}
                                                    </div>
                                                    {expandedRawEvent === req.id && req.raw_event_json && (
                                                        <div className="mt-2 max-h-[150px] overflow-auto rounded-lg bg-secondary p-2">
                                                            <pre className="text-[10px] font-mono text-foreground whitespace-pre-wrap break-all">
                                                                {(() => {
                                                                    try { return JSON.stringify(JSON.parse(req.raw_event_json), null, 2); }
                                                                    catch { return req.raw_event_json; }
                                                                })()}
                                                            </pre>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            <div className={cn(!isTop && "invisible pointer-events-none")}>
                                                <>
                                                    <div className="flex items-center gap-2 mt-3">
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            className="flex-1"
                                                            onClick={() => rejectRequest(req.id)}
                                                        >
                                                            Decline
                                                        </Button>
                                                        <Button
                                                            size="sm"
                                                            className="flex-1"
                                                            onClick={() => approveRequest(req.id)}
                                                        >
                                                            Approve
                                                        </Button>
                                                    </div>
                                                    <div className="flex items-center gap-2 mt-1.5">
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            className="flex-1 text-xs text-muted-foreground bg-secondary/60 hover:bg-secondary"
                                                            onClick={() => { rejectAlways(req); exitRequest(req.id); }}
                                                        >
                                                            Always Reject
                                                        </Button>
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            className="flex-1 text-xs text-muted-foreground bg-secondary/60 hover:bg-secondary"
                                                            onClick={() => { approveAlways(req); exitRequest(req.id); }}
                                                        >
                                                            Always Approve
                                                        </Button>
                                                    </div>
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        className="w-full mt-1 text-xs text-red-400 bg-red-500/5 hover:text-red-300 hover:bg-red-500/10"
                                                        onClick={async () => {
                                                            try {
                                                                if (req.source === 'upv2' && req.upv2_session_id) {
                                                                    await invoke('set_upv2_session_policy', { sessionId: req.upv2_session_id, policy: 'auto_approve' });
                                                                } else {
                                                                    await invoke('set_connection_policy', { connectionId: req.connection_id, policy: 'auto_approve' });
                                                                }
                                                            } catch (e: any) {
                                                                toast('Error setting policy: ' + e);
                                                            }
                                                            // Approve this request + any other recent requests (≤5s old) from the same connection
                                                            const now = Math.floor(Date.now() / 1000);
                                                            const recentFromSame = signerState.pending_requests.filter(r =>
                                                                r.connection_id === req.connection_id &&
                                                                !dismissedRequests.has(r.id) &&
                                                                (now - r.created_at) <= 5
                                                            );
                                                            for (const r of recentFromSame) {
                                                                approveRequest(r.id);
                                                            }
                                                            // Also approve the clicked one if it wasn't in the recent set
                                                            if (!recentFromSame.find(r => r.id === req.id)) {
                                                                approveRequest(req.id);
                                                            }
                                                        }}
                                                    >
                                                        <ShieldCheck className="w-3.5 h-3.5" /> Auto Approve All from this App
                                                    </Button>
                                                </>
                                            </div>
                                            {/* Countdown bar */}
                                            <CountdownBar createdAt={req.created_at} />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        {visibleRequests.length > 3 && (
                            <p className="text-xs text-muted-foreground text-center pointer-events-auto">+{visibleRequests.length - 3} more</p>
                        )}
                    </div>,
                    document.body
                );
            })()}

            {/* ── Connected Apps (compact row) ── */}
            <Card
                className="cursor-pointer hover:bg-secondary/40 transition-colors"
                onClick={() => setShowConnectedApps(true)}
            >
                <CardContent className="py-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                            <Shield className="w-5 h-5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-semibold">Connected Apps</div>
                            <div className="text-xs text-muted-foreground mt-0.5">
                                {totalConnections === 0 ? 'No connections' : `${totalConnections} active connection${totalConnections !== 1 ? 's' : ''}`}
                            </div>
                        </div>
                        <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0" />
                    </div>
                </CardContent>
            </Card>

            {/* ── NIP-PC55 Local Signer ── */}
            <Card>
                <CardHeader className="pb-5 flex flex-row items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                        <div className={cn(
                            "w-10 h-10 rounded-full flex items-center justify-center shrink-0",
                            signerState.pc55_running ? "bg-green-500/15" : "bg-muted"
                        )}>
                            <Radio className={cn(
                                "w-5 h-5",
                                signerState.pc55_running ? "text-green-500" : "text-muted-foreground"
                            )} />
                        </div>
                        <div>
                            <div>Local Signer</div>
                            <div className="text-xs text-muted-foreground font-mono mt-0.5 font-normal">
                                {signerState.pc55_running
                                    ? `ws://localhost:7777 · ${signerState.pc55_connections.length} client${signerState.pc55_connections.length !== 1 ? 's' : ''}`
                                    : 'NIP-PC55 · not running'
                                }
                            </div>
                        </div>
                    </CardTitle>
                    <Switch
                        checked={signerState.pc55_running}
                        onCheckedChange={async () => {
                            try {
                                if (signerState.pc55_running) {
                                    await invoke('stop_pc55_server');
                                } else {
                                    await invoke('start_pc55_server');
                                }
                            } catch (e) {
                                console.error('PC55 toggle error:', e);
                            }
                        }}
                    />
                </CardHeader>
            </Card>

            {/* ── Bunker Connection ── */}
            <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                        <div className={cn(
                            "w-10 h-10 rounded-full flex items-center justify-center shrink-0",
                            signerState.nip46_enabled ? "bg-primary/15" : "bg-muted"
                        )}>
                            <Link2 className={cn(
                                "w-5 h-5",
                                signerState.nip46_enabled ? "text-primary" : "text-muted-foreground"
                            )} />
                        </div>
                        <div>
                            <div>Bunker Connection</div>
                            <div className="text-xs text-muted-foreground font-mono mt-0.5 font-normal">
                                {(() => {
                                    const signerRelays = signerState.relays ?? [];
                                    const userRelays = signerState.user_relays ?? [];
                                    const signerUrlSet = new Set(signerRelays.map(r => r.url.replace(/\/$/, '')));
                                    const extraUserRelays = userRelays.filter(r => !signerUrlSet.has(r.url.replace(/\/$/, '')));
                                    const totalRelays = signerRelays.length + extraUserRelays.length;
                                    const connectedCount = signerRelays.filter(r => r.connected).length + extraUserRelays.filter(r => r.connected).length;
                                    return (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); setShowRelayModal(true); }}
                                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                        >
                                            <Radio className="w-3 h-3" />
                                            listening on {connectedCount}/{totalRelays} relay{totalRelays !== 1 ? 's' : ''}
                                        </button>
                                    );
                                })()}
                            </div>
                        </div>
                    </CardTitle>
                    <Switch
                        checked={signerState.nip46_enabled}
                        onCheckedChange={() => invoke('toggle_nip46_enabled')}
                    />
                </CardHeader>
                <CardContent>
                    {/* URI display / input row */}
                    <div className="flex items-center gap-2 mb-2">
                        {/* URI field */}
                        {connectMode === 'nostrconnect' ? (
                            <Input
                                value={nostrconnectInput}
                                onChange={e => setNostrconnectInput(e.target.value)}
                                placeholder="nostrconnect://..."
                                className="flex-1 text-sm h-10"
                                onKeyDown={e => e.key === 'Enter' && handleNostrconnect()}
                            />
                        ) : (
                            <div className="flex-1 bg-secondary rounded-lg px-3 h-10 flex items-center min-w-0">
                                <span className="text-sm text-muted-foreground truncate font-mono">
                                    {bunkerUri || 'bunker://...'}
                                </span>
                            </div>
                        )}
                    </div>

                    {/* Action button row */}
                    <div className="flex items-center gap-2">
                        {/* Toggle switch — left */}
                        <button
                            className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors"
                            title={connectMode === 'nostrconnect' ? 'Switch to Bunker URI' : 'Switch to nostrconnect'}
                            onClick={() => setConnectMode(m => m === 'nostrconnect' ? 'bunker' : 'nostrconnect')}
                        >
                            <Repeat2 className="w-4 h-4 text-muted-foreground" />
                        </button>

                        {/* Main action button — center */}
                        {connectMode === 'nostrconnect' ? (
                            <Button
                                size="sm"
                                className="flex-1"
                                disabled={!nostrconnectInput.trim() || connecting}
                                onClick={handleNostrconnect}
                            >
                                {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
                                {connecting ? 'Connecting...' : 'Connect'}
                            </Button>
                        ) : (
                            <Button
                                variant="outline"
                                size="sm"
                                className="flex-1"
                                onClick={() => {
                                    if (bunkerUri) {
                                        navigator.clipboard.writeText(bunkerUri);
                                        setCopied(true);
                                        setTimeout(() => setCopied(false), 2000);
                                    }
                                }}
                            >
                                {copied ? <><Check className="w-3.5 h-3.5 text-success" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy Connection</>}
                            </Button>
                        )}

                        {/* QR / Scan button — right */}
                        {connectMode === 'nostrconnect' ? (
                            <button
                                className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors"
                                title="Scan QR code"
                                onClick={() => { setShowScanner(true); setTimeout(startScanner, 300); }}
                            >
                                <ScanLine className="w-4 h-4 text-muted-foreground" />
                            </button>
                        ) : (
                            <button
                                className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors"
                                title="Show QR code"
                                onClick={() => setShowBunkerQr(true)}
                            >
                                <QrCode className="w-4 h-4 text-muted-foreground" />
                            </button>
                        )}
                    </div>
                </CardContent>
            </Card>

            {/* Bunker QR Dialog */}
            <Dialog open={showBunkerQr} onOpenChange={setShowBunkerQr}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Bunker QR Code</DialogTitle>
                        <DialogDescription>Scan this QR code from your Nostr client to connect.</DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-center py-4">
                        {bunkerUri && (
                            <div className="bg-white p-4 rounded-xl">
                                <QRCodeSVG value={bunkerUri} size={240} />
                            </div>
                        )}
                    </div>
                    <p className="text-xs text-muted-foreground text-center font-mono break-all px-2">{bunkerUri}</p>
                </DialogContent>
            </Dialog>

            {/* Camera Scanner Dialog */}



            {/* Camera Scanner Dialog */}
            <Dialog open={showScanner} onOpenChange={setShowScanner}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Scan QR Code</DialogTitle>
                        <DialogDescription>Point your camera at a nostrconnect:// QR code.</DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-center py-2">
                        <div className="relative w-full max-w-[320px] aspect-square rounded-xl overflow-hidden bg-black">
                            <video
                                ref={videoRef}
                                className="w-full h-full object-cover"
                                playsInline
                                muted
                            />
                            {/* Scan overlay */}
                            <div className="absolute inset-0 border-2 border-primary/40 rounded-xl pointer-events-none" />
                            <div className="absolute inset-[20%] border-2 border-primary rounded-lg pointer-events-none animate-pulse" />
                        </div>
                    </div>
                    <canvas ref={canvasRef} className="hidden" />
                    {cameras.length > 1 && (
                        <CustomSelect
                            value={selectedCamera}
                            onChange={(val) => {
                                setSelectedCamera(val);
                                startScanner(val);
                            }}
                            options={cameras.map((cam, i) => ({
                                value: cam.deviceId,
                                label: cam.label || `Camera ${i + 1}`,
                            }))}
                            variant="overlay"
                            placeholder="Select camera"
                        />
                    )}
                    <p className="text-xs text-muted-foreground text-center mt-2">Scanning...</p>
                </DialogContent>
            </Dialog>
            {/* ── Password Login (UPV2) ── */}
            {
                signerState.running && (
                    <Card>
                        <CardContent className="space-y-3 pt-5">

                            {offlineAttempts.length > 0 && (
                                <div
                                    className="flex items-center gap-3 p-3 bg-destructive/10 border border-destructive/20 rounded-xl cursor-pointer hover:bg-destructive/15 transition-colors"
                                    onClick={() => setShowLoginHistory(true)}
                                >
                                    <AlertTriangle className="w-5 h-5 text-destructive shrink-0" />
                                    <span className="flex-1 text-sm font-medium text-destructive">
                                        {offlineAttempts.length} security alert{offlineAttempts.length > 1 ? 's' : ''}
                                    </span>
                                    <ChevronRight className="w-5 h-5 text-destructive/60 shrink-0" />
                                </div>
                            )}

                            {/* Security Alerts Modal */}
                            <Dialog open={showLoginHistory} onOpenChange={setShowLoginHistory}>
                                <DialogContent>
                                    <DialogHeader>
                                        <DialogTitle className="flex items-center gap-2">
                                            <AlertTriangle className="w-5 h-5 text-destructive" /> Security Alerts
                                        </DialogTitle>
                                        <DialogDescription>
                                            Someone tried to log in while your signer was offline. Review the attempts below.
                                        </DialogDescription>
                                    </DialogHeader>
                                    <div className="max-h-64 overflow-y-auto rounded-xl border border-border">
                                        {signerState.login_attempts.slice().sort((a, b) => b.timestamp - a.timestamp).map(attempt => (
                                            <div key={attempt.id} className={cn(
                                                "flex justify-between items-center px-4 py-2.5 text-sm border-b border-border last:border-0",
                                                attempt.status === 'offline_missed' && !attempt.dismissed && "bg-destructive/5"
                                            )}>
                                                <div className="flex items-center gap-2.5">
                                                    <div className={cn(
                                                        "w-2 h-2 rounded-full shrink-0",
                                                        attempt.status === 'offline_missed' && !attempt.dismissed ? "bg-destructive" : "bg-success"
                                                    )} />
                                                    <div>
                                                        <div className="font-medium">{attempt.client_name || 'Unknown client'}</div>
                                                        <div className="text-xs text-muted-foreground">
                                                            {new Date(attempt.timestamp * 1000).toLocaleString()}
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <Badge variant={attempt.status === 'offline_missed' ? 'destructive' : 'success'}>
                                                        {attempt.status === 'offline_missed' ? (attempt.dismissed ? 'Dismissed' : 'Offline') : 'OK'}
                                                    </Badge>
                                                    {attempt.status === 'offline_missed' && !attempt.dismissed && (
                                                        <Button variant="ghost" size="xs" onClick={() => invoke('dismiss_login_attempt', { attemptId: attempt.id })}>
                                                            <X className="w-3.5 h-3.5" />
                                                        </Button>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                        {signerState.login_attempts.length === 0 && (
                                            <div className="py-8 text-center text-sm text-muted-foreground">
                                                No login attempts recorded yet.
                                            </div>
                                        )}
                                    </div>
                                    <DialogFooter>
                                        <Button variant="outline" size="sm" onClick={() => { invoke('dismiss_all_offline_attempts'); setShowLoginHistory(false); }}>
                                            Dismiss All
                                        </Button>
                                    </DialogFooter>
                                </DialogContent>
                            </Dialog>

                            {signerState.upv2_login_key ? (
                                <>
                                    {/* Main row: icon + title/key + toggle */}
                                    <div className="flex items-center gap-3">
                                        <div className={cn(
                                            "w-10 h-10 rounded-full flex items-center justify-center shrink-0",
                                            signerState.upv2_login_key.enabled ? "bg-success/15" : "bg-muted"
                                        )}>
                                            <ShieldCheck className={cn(
                                                "w-5 h-5",
                                                signerState.upv2_login_key.enabled ? "text-success" : "text-muted-foreground"
                                            )} />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-semibold">Password Login</div>
                                            <div className="text-xs text-muted-foreground font-mono mt-0.5">
                                                {(() => {
                                                    const signerRelays = signerState.relays ?? [];
                                                    const userRelays = signerState.user_relays ?? [];
                                                    // Deduplicate: count user relays not already in signer list
                                                    const signerUrlSet = new Set(signerRelays.map(r => r.url.replace(/\/$/, '')));
                                                    const extraUserRelays = userRelays.filter(r => !signerUrlSet.has(r.url.replace(/\/$/, '')));
                                                    const totalRelays = signerRelays.length + extraUserRelays.length;
                                                    const connectedCount = signerRelays.filter(r => r.connected).length + extraUserRelays.filter(r => r.connected).length;
                                                    return (
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); setShowRelayModal(true); }}
                                                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                                        >
                                                            <Radio className="w-3 h-3" />
                                                            listening on {connectedCount}/{totalRelays} relay{totalRelays !== 1 ? 's' : ''}
                                                        </button>
                                                    );
                                                })()}
                                            </div>
                                        </div>
                                        <Switch
                                            checked={signerState.upv2_login_key.enabled}
                                            onCheckedChange={() => invoke('toggle_upv2_enabled')}
                                        />
                                    </div>
                                    {/* Username / DNN ID row */}
                                    {activeNpub && (
                                        <div className="flex items-center gap-2">
                                            {/* Toggle button — only show if DNN ID exists */}
                                            {dnnId && (
                                                <button
                                                    onClick={() => setAddressDisplay(prev => prev === 'npub' ? 'dnn' : 'npub')}
                                                    className="p-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0"
                                                    title={addressDisplay === 'dnn' ? 'Show npub' : 'Show DNN ID'}
                                                >
                                                    <Repeat2 className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                            <div className="flex-1 bg-secondary rounded-lg px-3 py-2 text-sm text-muted-foreground font-mono truncate">
                                                {addressDisplay === 'dnn' && dnnId ? (
                                                    <span className="truncate flex items-center gap-1.5">
                                                        @{dnnId}
                                                        {dnnVerifying ? (
                                                            <RefreshCw className="w-3 h-3 animate-spin text-muted-foreground shrink-0" />
                                                        ) : dnnVerified === true ? (
                                                            <Check className="w-3 h-3 text-success shrink-0" />
                                                        ) : dnnVerified === false ? (
                                                            <AlertTriangle className="w-3 h-3 text-warning shrink-0" />
                                                        ) : null}
                                                    </span>
                                                ) : (
                                                    <span className="truncate">@{activeNpub.slice(0, 12)}…{activeNpub.slice(-5)}</span>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                    {/* Action row: trash | copy username | gear */}
                                    <div className="flex gap-2">
                                        <Button
                                            variant="destructive"
                                            size="sm"
                                            className="px-2.5"
                                            onClick={() => showConfirm({ title: 'Delete Password?', description: 'All active sessions will be invalidated. This cannot be undone.', confirmLabel: 'Delete', variant: 'destructive', onConfirm: () => invoke('delete_upv2_password') })}
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="flex-1"
                                            onClick={() => {
                                                const text = addressDisplay === 'dnn' && dnnId ? dnnId : (activeNpub ?? '');
                                                navigator.clipboard.writeText(text);
                                                toast('Copied!', 'success');
                                                setNpubCopied(true);
                                                setTimeout(() => setNpubCopied(false), 2000);
                                            }}
                                        >
                                            {npubCopied ? <><Check className="w-3 h-3 text-success" /> Copied</> : <><Copy className="w-3 h-3" /> Copy Username</>}
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="px-2.5"
                                            onClick={() => { setUpv2SetupMode('change'); setUpv2Error(''); setUpv2Password(''); setUpv2ConfirmPassword(''); }}
                                        >
                                            <Settings2 className="w-3.5 h-3.5" />
                                        </Button>
                                    </div>
                                </>
                            ) : (
                                /* No password set */
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                                        <Lock className="w-5 h-5 text-muted-foreground" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-semibold">Password Login</div>
                                        <div className="text-xs text-muted-foreground mt-0.5">
                                            Not configured
                                        </div>
                                    </div>
                                    <Button size="sm" onClick={() => { setUpv2SetupMode('setup'); setUpv2Error(''); setUpv2Password(''); setUpv2ConfirmPassword(''); }}>
                                        Set Up
                                    </Button>
                                </div>
                            )}

                        </CardContent>
                    </Card>
                )
            }

            {/* Connected Apps row moved above Bunker Connection */}

            {/* ── Relay Status Modal ── */}
            <Dialog open={showRelayModal} onOpenChange={setShowRelayModal}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Relay Connections</DialogTitle>
                        <DialogDescription>
                            Relays your signer is listening on for login requests.
                        </DialogDescription>
                    </DialogHeader>
                    {(() => {
                        const sRelays = signerState.relays ?? [];
                        const uRelays = signerState.user_relays ?? [];
                        const activeRelays = sRelays.filter(r => r.connected);
                        const topActive = activeRelays.slice(0, 3);
                        // Merge for copy: signer active + user relays (deduplicated)
                        const allActiveCopy = [...topActive.map(r => r.url)];
                        const signerUrlSet = new Set(sRelays.map(r => r.url.replace(/\/$/, '')));
                        for (const u of uRelays) {
                            if (!signerUrlSet.has(u.url.replace(/\/$/, '')) && !allActiveCopy.includes(u.url)) {
                                allActiveCopy.push(u.url);
                            }
                        }
                        return (
                            <div className="space-y-4">
                                {allActiveCopy.length > 0 && (
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        className="w-full"
                                        onClick={() => {
                                            navigator.clipboard.writeText(allActiveCopy.join(','));
                                            toast(`Copied ${allActiveCopy.length} relay${allActiveCopy.length !== 1 ? 's' : ''}`, 'success');
                                        }}
                                    >
                                        <Copy className="w-3.5 h-3.5 mr-1.5" />
                                        Copy all active relays ({allActiveCopy.length})
                                    </Button>
                                )}

                                {/* Signer relays */}
                                <div>
                                    <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Signer's local relays</div>
                                    <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
                                        {sRelays.length === 0 ? (
                                            <div className="py-4 text-center text-sm text-muted-foreground">
                                                No signer relays configured.
                                            </div>
                                        ) : (
                                            sRelays.map(relay => (
                                                <div key={relay.url} className="flex items-center gap-3 px-3 py-2.5">
                                                    <div className={cn(
                                                        "w-2 h-2 rounded-full shrink-0",
                                                        relay.connected ? "bg-success" : "bg-muted-foreground"
                                                    )} />
                                                    <span className="text-sm truncate flex-1">{relay.url}</span>
                                                    <Badge variant="secondary" className="text-[10px] shrink-0">
                                                        {relay.connected ? 'connected' : 'offline'}
                                                    </Badge>
                                                    <button
                                                        className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0 p-1"
                                                        onClick={() => {
                                                            navigator.clipboard.writeText(relay.url);
                                                            toast('Copied relay URL', 'success');
                                                        }}
                                                    >
                                                        <Copy className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </div>

                                {/* User relays */}
                                {uRelays.length > 0 && (
                                    <div>
                                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">User's relays</div>
                                        <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
                                            {uRelays.map((relay) => (
                                                <div key={relay.url} className="flex items-center gap-3 px-3 py-2.5">
                                                    <div className={cn(
                                                        "w-2 h-2 rounded-full shrink-0",
                                                        relay.connected ? "bg-success" : "bg-muted-foreground"
                                                    )} />
                                                    <span className="text-sm truncate flex-1">{relay.url}</span>
                                                    <Badge variant="secondary" className="text-[10px] shrink-0">
                                                        {relay.connected ? 'connected' : 'offline'}
                                                    </Badge>
                                                    <button
                                                        className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0 p-1"
                                                        onClick={() => {
                                                            navigator.clipboard.writeText(relay.url);
                                                            toast('Copied relay URL', 'success');
                                                        }}
                                                    >
                                                        <Copy className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })()}
                </DialogContent>
            </Dialog>
            {/* ── Set/Change Password Modal ── */}
            <Dialog open={upv2SetupMode === 'setup' || upv2SetupMode === 'change'} onOpenChange={(open) => { if (!open) { setUpv2SetupMode('idle'); setUpv2Error(''); } }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {upv2SetupMode === 'setup' ? 'Set Password' : 'Change Password'}
                        </DialogTitle>
                        <DialogDescription>
                            {upv2SetupMode === 'setup'
                                ? 'Set a password to allow logging in from any Nostr client.'
                                : 'Enter a new password. All active sessions will be invalidated.'}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                        <div className="relative">
                            <Input
                                type={upv2ShowPassword ? 'text' : 'password'}
                                value={upv2Password}
                                onChange={e => setUpv2Password(e.target.value)}
                                placeholder="Password (min 8 characters)"
                            />
                            <button
                                onClick={() => setUpv2ShowPassword(!upv2ShowPassword)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground cursor-pointer hover:text-foreground transition-colors"
                            >
                                {upv2ShowPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                        </div>
                        <Input
                            type={upv2ShowPassword ? 'text' : 'password'}
                            value={upv2ConfirmPassword}
                            onChange={e => setUpv2ConfirmPassword(e.target.value)}
                            placeholder="Confirm password"
                        />
                        {upv2Error && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{upv2Error}</p>}
                        {upv2SetupMode === 'change' && (
                            <p className="text-sm text-warning flex items-center gap-1.5">
                                <AlertTriangle className="w-3.5 h-3.5" /> Changing password invalidates all active sessions.
                            </p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => { setUpv2SetupMode('idle'); setUpv2Error(''); }}>
                            Cancel
                        </Button>
                        <Button
                            disabled={upv2Loading || upv2Password.length < 8 || upv2Password !== upv2ConfirmPassword}
                            onClick={async () => {
                                if (upv2Password.length < 8) { setUpv2Error('Password must be at least 8 characters'); return; }
                                if (upv2Password !== upv2ConfirmPassword) { setUpv2Error('Passwords do not match'); return; }
                                if (!activePubkey) { setUpv2Error('No active keypair'); return; }
                                setUpv2Loading(true); setUpv2Error('');
                                try {
                                    const state: any = await invoke('get_app_state');
                                    const kp = state.keypairs.find((k: any) => k.pubkey === activePubkey);
                                    const npub = kp?.npub || '';
                                    await invoke('set_upv2_password', { password: upv2Password, npub });
                                    setUpv2SetupMode('idle'); setUpv2Password(''); setUpv2ConfirmPassword('');
                                } catch (e: any) { setUpv2Error(String(e)); }
                                setUpv2Loading(false);
                            }}
                        >
                            {upv2Loading ? '...' : (upv2SetupMode === 'setup' ? 'Enable' : 'Change')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ── Reconnect Dialog ── */}
            <Dialog open={!!reconnectPrompt} onOpenChange={() => { }} modal={false}>
                <DialogContent hideClose>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <RefreshCw className="w-5 h-5" /> Reconnection Detected
                        </DialogTitle>
                        <DialogDescription>
                            <strong>{reconnectPrompt?.app_name}</strong> is trying to connect, but an existing {reconnectPrompt?.existing_source === 'nip46' ? 'NIP-46' : reconnectPrompt?.existing_source === 'pc55' ? 'PC55' : 'UPV2'} connection already exists.
                        </DialogDescription>
                    </DialogHeader>

                    <p className="text-sm text-muted-foreground">What would you like to do with the existing connection?</p>

                    <label className="flex items-center justify-between gap-3 text-sm text-foreground cursor-pointer p-3 bg-secondary rounded-xl">
                        Keep existing policy & custom rules
                        <Switch checked={reconnectKeepRules} onCheckedChange={setReconnectKeepRules} />
                    </label>

                    <DialogFooter>
                        <Button variant="destructive" onClick={() => { invoke('resolve_reconnect', { action: 'reject', keepRules: false }); setReconnectPrompt(null); }}>
                            Reject
                        </Button>
                        <Button variant="outline" onClick={() => { invoke('resolve_reconnect', { action: 'keep', keepRules: false }); setReconnectPrompt(null); }}>
                            Keep Both
                        </Button>
                        <Button onClick={() => { invoke('resolve_reconnect', { action: 'replace', keepRules: reconnectKeepRules }); setReconnectPrompt(null); }}>
                            Replace
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div >
    );
}
