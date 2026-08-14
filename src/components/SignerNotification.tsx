/**
 * Bottom-right popup window (label `signer-notif`) that surfaces signer prompts when a client is
 * waiting AND the main DENOS window is not focused (minimized, hidden to tray, background). It
 * handles two prompt kinds with the same actions as the in-app UI:
 *   - signing requests (approve / decline / always / auto-approve-all)
 *   - reconnection prompts (reject / keep both / replace, with keep-rules + auto-replace toggles)
 *
 * Design (after many iterations — do not "simplify" back):
 *   - Pre-created ONCE, hidden, at startup, so showing it is instant (fresh webview = ~2s boot).
 *   - Visibility is decided by the MAIN window (only it knows its focus) and broadcast as an event;
 *     the popup shows/hides ITSELF (self-show is reliable, cross-window show() was not).
 *   - OPAQUE window (runtime transparent windows render unreliably on Windows); rounded via the
 *     Win11 DWM `round_window_corners` command; page bg = card colour so there's no box-in-box.
 *   - The window is resized per prompt kind (reconnect is taller) and re-pinned bottom-right.
 *
 * Exports: <SignerNotification/> (this window's UI) and <SignerNotificationManager/> (mounted in
 * the MAIN window; pre-warms the popup and broadcasts when it should be visible).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Zap, RefreshCw, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

const NOTIF_LABEL = 'signer-notif';
const VISIBILITY_EVENT = 'signer-notif-visibility';
const RECONNECT_RESOLVED_EVENT = 'reconnect-resolved';
const REQUEST_TTL = 30; // seconds — mirrors the in-app popup's auto-dismiss window
const NOTIF_W = 360;
const H_SIGN = 252, H_RECONNECT = 330, H_RECONNECT_NIP46 = 268;

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
interface Conn { id: string; policy?: string }
interface Upv2Session { session_id: string; policy: string }
interface SignerStateLite {
    pending_requests: PendingRequest[];
    connections: Conn[];
    upv2_sessions: Upv2Session[];
}
interface ReconnectPrompt {
    app_name: string;
    existing_source: string; // 'nip46' | 'pc55' | 'upv2'
}

const srcLabel = (s?: string) => (s === 'nip46' ? 'NIP-46' : s === 'pc55' ? 'PC55' : 'UPV2');

/** Minimal pill toggle (the app's Switch pulls heavier deps we keep out of this tiny webview). */
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <button type="button" onClick={() => onChange(!checked)}
            className={cn('w-9 h-5 rounded-full transition-colors relative shrink-0 cursor-pointer', checked ? 'bg-primary' : 'bg-secondary')}>
            <span className={cn('absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform', checked && 'translate-x-4')} />
        </button>
    );
}

// ──────────────────────────────────────────────────────────────────────────
//  The popup window UI
// ──────────────────────────────────────────────────────────────────────────

export function SignerNotification() {
    const [state, setState] = useState<SignerStateLite>({ pending_requests: [], connections: [], upv2_sessions: [] });
    const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
    const [busy, setBusy] = useState(false);
    const [reconnect, setReconnect] = useState<ReconnectPrompt | null>(null);
    const [keepRules, setKeepRules] = useState(true);
    const [autoReplace, setAutoReplace] = useState(false);
    const targetHRef = useRef(H_SIGN);

    // Size + bottom-right placement are computed entirely in Rust (`place_notif`) from the real
    // work area + actual window size — no JS coordinate/DPI/size assumptions. Reads a ref so it's
    // always current; applied on height changes and right before every show.
    const applyGeometry = useCallback(async () => {
        await invoke('place_notif', { width: NOTIF_W, height: targetHRef.current }).catch(() => { });
    }, []);

    useEffect(() => {
        invoke<SignerStateLite>('get_signer_state').then(setState).catch(() => { });
        const uns: Array<() => void> = [];
        listen<SignerStateLite>('signer-state', e => setState(e.payload)).then(f => uns.push(f));
        listen<ReconnectPrompt>('reconnect-prompt', e => { setReconnect(e.payload); setKeepRules(true); setAutoReplace(false); }).then(f => uns.push(f));
        listen(RECONNECT_RESOLVED_EVENT, () => setReconnect(null)).then(f => uns.push(f));
        const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
        return () => { uns.forEach(f => f()); clearInterval(t); };
    }, []);

    // Opaque uniform window + rounded corners (DWM). Page bg = card colour.
    useEffect(() => {
        document.documentElement.style.background = 'var(--color-card)';
        document.body.style.background = 'var(--color-card)';
        const rootEl = document.getElementById('root');
        if (rootEl) rootEl.style.background = 'var(--color-card)';
        invoke('round_window_corners').catch(() => { });
    }, []);

    // The main window broadcasts whether we should be visible; show/hide OURSELVES (reliable).
    // Re-apply geometry right before showing so the window is correctly sized+placed at reveal.
    useEffect(() => {
        const win = getCurrentWindow();
        let un: (() => void) | undefined;
        listen<{ show: boolean }>(VISIBILITY_EVENT, async e => {
            if (e.payload?.show) { await applyGeometry(); await win.show().catch(() => { }); }
            else await win.hide().catch(() => { });
        }).then(f => { un = f; });
        return () => un?.();
    }, [applyGeometry]);

    const active = useMemo(
        () => (state.pending_requests || []).filter(r => now - r.created_at < REQUEST_TTL),
        [state.pending_requests, now],
    );
    const req = active[0];

    // Re-enable the buttons for each new front request (busy stays set after an action fires).
    useEffect(() => { setBusy(false); }, [req?.id, reconnect?.app_name]);

    const mode: 'reconnect' | 'signing' | 'none' = reconnect ? 'reconnect' : req ? 'signing' : 'none';
    const targetH = mode === 'reconnect'
        ? (reconnect?.existing_source === 'nip46' ? H_RECONNECT_NIP46 : H_RECONNECT)
        : H_SIGN;
    targetHRef.current = targetH;

    // Re-size + re-pin whenever the prompt height changes (also covers a signing→reconnect swap
    // while already visible). Runs while hidden on mount too, so the first show is already correct.
    useEffect(() => { void applyGeometry(); }, [targetH, applyGeometry]);

    if (mode === 'none') return null;

    // ── Reconnect prompt ──
    if (mode === 'reconnect' && reconnect) {
        const resolveReconnect = async (action: 'reject' | 'keep' | 'replace') => {
            setBusy(true);
            const args = action === 'replace'
                ? { action, keepRules, autoReplace: autoReplace || null }
                : { action, keepRules: false, autoReplace: null };
            try { await invoke('resolve_reconnect', args); } catch { /* */ }
            await emit(RECONNECT_RESOLVED_EVENT, {}).catch(() => { });
            setReconnect(null);
        };
        return (
            <div className="h-screen w-screen overflow-hidden bg-card text-foreground flex flex-col p-4 select-none rounded-lg border border-border">
                <div className="flex items-center gap-2 text-sm font-bold">
                    <RefreshCw className="w-4.5 h-4.5" /> Reconnection Detected
                </div>
                <p className="text-[11px] text-muted-foreground leading-snug mt-1.5">
                    <strong className="text-foreground">{reconnect.app_name}</strong> is trying to connect, but an existing {srcLabel(reconnect.existing_source)} connection already exists. What would you like to do with it?
                </p>
                <label className="flex items-center justify-between gap-3 text-xs text-foreground p-2.5 bg-secondary rounded-xl mt-3 cursor-pointer">
                    Keep existing policy &amp; custom rules
                    <Toggle checked={keepRules} onChange={setKeepRules} />
                </label>
                {reconnect.existing_source !== 'nip46' && (
                    <label className="flex items-center justify-between gap-3 text-xs text-foreground p-2.5 bg-secondary/40 rounded-xl border border-border/50 mt-2 cursor-pointer">
                        <span className="flex items-center gap-1.5"><AlertTriangle className="w-4 h-4 text-warning" /> Always replace (unsafe)</span>
                        <Toggle checked={autoReplace} onChange={setAutoReplace} />
                    </label>
                )}
                <div className="flex gap-2 mt-auto pt-3">
                    <button disabled={busy} onClick={() => resolveReconnect('reject')}
                        className="flex-1 py-2 rounded-xl border border-destructive/40 text-destructive text-xs font-semibold hover:bg-destructive/10 transition-colors cursor-pointer disabled:opacity-50">
                        Reject
                    </button>
                    <button disabled={busy} onClick={() => resolveReconnect('keep')}
                        className="flex-1 py-2 rounded-xl border border-border text-xs font-semibold hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50">
                        Keep Both
                    </button>
                    <button disabled={busy} onClick={() => resolveReconnect('replace')}
                        className="flex-1 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/80 transition-colors cursor-pointer disabled:opacity-50">
                        Replace
                    </button>
                </div>
            </div>
        );
    }

    // ── Signing request ──
    const ruleKey = req.method === 'sign_event' && req.kind != null ? `sign_event:${req.kind}` : req.method;
    const npubShort = req.client_pubkey ? `${req.client_pubkey.slice(0, 10)}…${req.client_pubkey.slice(-4)}` : '';
    const remaining = Math.max(0, REQUEST_TTL - (now - req.created_at));

    const approve = async (id: string) => { setBusy(true); try { await invoke('approve_request', { requestId: id }); } catch { /* */ } };
    const reject = async (id: string) => { setBusy(true); try { await invoke('reject_request', { requestId: id }); } catch { /* */ } };

    const applyAlways = async (action: 'approve' | 'reject') => {
        if (req.source === 'upv2') {
            const s = state.upv2_sessions.find(x => x.session_id === req.upv2_session_id);
            if (s) {
                if (s.policy === 'manual') await invoke('set_upv2_session_policy', { sessionId: s.session_id, policy: 'custom' }).catch(() => { });
                await invoke('set_upv2_custom_rule', { sessionId: s.session_id, method: ruleKey, action }).catch(() => { });
            }
        } else {
            const c = state.connections.find(x => x.id === req.connection_id);
            if (c) {
                if ((c.policy || 'manual') === 'manual') await invoke('set_connection_policy', { connectionId: c.id, policy: 'custom' }).catch(() => { });
                await invoke('set_custom_rule', { connectionId: c.id, method: ruleKey, action }).catch(() => { });
            }
        }
    };
    const approveAlways = async () => { setBusy(true); await applyAlways('approve'); await invoke('approve_request', { requestId: req.id }).catch(() => { }); };
    const rejectAlways = async () => { setBusy(true); await applyAlways('reject'); await invoke('reject_request', { requestId: req.id }).catch(() => { }); };

    const autoApproveAll = async () => {
        setBusy(true);
        try {
            if (req.source === 'upv2' && req.upv2_session_id) {
                await invoke('set_upv2_session_policy', { sessionId: req.upv2_session_id, policy: 'auto_approve' });
            } else {
                await invoke('set_connection_policy', { connectionId: req.connection_id, policy: 'auto_approve' });
            }
        } catch { /* */ }
        const nowS = Math.floor(Date.now() / 1000);
        const recent = (state.pending_requests || []).filter(r => r.connection_id === req.connection_id && (nowS - r.created_at) <= 5);
        for (const r of recent) await invoke('approve_request', { requestId: r.id }).catch(() => { });
        if (!recent.find(r => r.id === req.id)) await invoke('approve_request', { requestId: req.id }).catch(() => { });
    };

    return (
        <div className="h-screen w-screen overflow-hidden bg-card text-foreground flex flex-col p-4 select-none rounded-lg border border-border">
            <div className="flex items-start gap-2.5">
                <div className="w-9 h-9 rounded-full bg-warning/15 flex items-center justify-center shrink-0 mt-0.5">
                    <Zap className="w-4.5 h-4.5 text-warning" />
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm leading-snug truncate">
                        <strong>{req.app_name}</strong>
                        <span className="text-muted-foreground"> · </span>
                        <strong>{req.method}</strong>
                        {req.kind != null && <span className="text-muted-foreground"> (kind {req.kind})</span>}
                    </p>
                    <p className="text-[11px] text-muted-foreground font-mono truncate">
                        {npubShort}{active.length > 1 ? `  ·  +${active.length - 1} more` : ''}
                    </p>
                </div>
                <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">{remaining}s</span>
            </div>

            <div className="mt-auto space-y-2 pt-3">
                <div className="flex gap-2">
                    <button disabled={busy} onClick={() => reject(req.id)}
                        className="flex-1 py-2.5 rounded-xl border border-border text-sm font-semibold hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50">
                        Decline
                    </button>
                    <button disabled={busy} onClick={() => approve(req.id)}
                        className="flex-1 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/80 transition-colors cursor-pointer disabled:opacity-50">
                        Approve
                    </button>
                </div>
                <div className="flex gap-2">
                    <button disabled={busy} onClick={rejectAlways}
                        className="flex-1 py-2 rounded-xl bg-secondary/60 text-xs font-medium text-muted-foreground hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50">
                        Always reject
                    </button>
                    <button disabled={busy} onClick={approveAlways}
                        className="flex-1 py-2 rounded-xl bg-secondary/60 text-xs font-medium text-muted-foreground hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50">
                        Always approve
                    </button>
                </div>
                <button disabled={busy} onClick={autoApproveAll}
                    className="w-full py-2 rounded-xl bg-primary/10 text-xs font-semibold text-primary hover:bg-primary/20 transition-colors cursor-pointer disabled:opacity-50">
                    Auto-approve all from this app
                </button>
            </div>

            <div className="mt-3 h-[2px] rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-muted-foreground/40 rounded-full transition-[width] duration-1000 ease-linear"
                    style={{ width: `${(remaining / REQUEST_TTL) * 100}%` }} />
            </div>
        </div>
    );
}

// ──────────────────────────────────────────────────────────────────────────
//  Lifecycle manager (runs in the MAIN window)
// ──────────────────────────────────────────────────────────────────────────

let creating = false;
/** Create the popup window ONCE, hidden and pre-warmed, so showing it later is instant. Opaque
 *  (runtime transparent windows render unreliably on Windows) with an OS shadow; corners are
 *  rounded by the popup itself via the DWM `round_window_corners` command. */
async function ensureNotifWindow(): Promise<WebviewWindow | null> {
    const existing = await WebviewWindow.getByLabel(NOTIF_LABEL);
    if (existing) return existing;
    if (creating) return null;
    creating = true;
    try {
        const w = new WebviewWindow(NOTIF_LABEL, {
            url: 'index.html',
            width: NOTIF_W, height: H_SIGN,
            visible: false,
            resizable: false, decorations: false, alwaysOnTop: true,
            skipTaskbar: true, focus: false, shadow: true,
            title: 'DENOS signer',
        });
        await new Promise<void>(resolve => {
            w.once('tauri://created', () => resolve());
            w.once('tauri://error', () => resolve());
            setTimeout(resolve, 1500);
        });
        return w;
    } finally {
        creating = false;
    }
}

/** Mounted once in the main window. Pre-warms the popup and broadcasts whether it should be
 *  visible (a signing request OR a reconnect prompt is pending, AND the main window isn't
 *  focused). The popup shows/hides itself. */
export function SignerNotificationManager() {
    const pendingRef = useRef<PendingRequest[]>([]);
    const focusedRef = useRef(true);
    const reconnectRef = useRef(false);

    useEffect(() => {
        const w = getCurrentWindow();
        const uns: Array<() => void> = [];

        const evaluate = async () => {
            const now = Math.floor(Date.now() / 1000);
            const active = pendingRef.current.filter(r => now - r.created_at < REQUEST_TTL);
            const shouldShow = (active.length > 0 || reconnectRef.current) && !focusedRef.current;
            if (shouldShow) await ensureNotifWindow(); // must exist to receive the event
            await emit(VISIBILITY_EVENT, { show: shouldShow }).catch(() => { });
        };

        void ensureNotifWindow(); // pre-warm so the first show is instant

        w.isFocused().then(f => { focusedRef.current = f; void evaluate(); }).catch(() => { });
        invoke<SignerStateLite>('get_signer_state')
            .then(s => { pendingRef.current = s.pending_requests || []; void evaluate(); })
            .catch(() => { });
        listen<SignerStateLite>('signer-state', e => { pendingRef.current = e.payload.pending_requests || []; void evaluate(); })
            .then(f => uns.push(f));
        listen('reconnect-prompt', () => { reconnectRef.current = true; void evaluate(); }).then(f => uns.push(f));
        listen(RECONNECT_RESOLVED_EVENT, () => { reconnectRef.current = false; void evaluate(); }).then(f => uns.push(f));
        w.onFocusChanged(({ payload }) => { focusedRef.current = payload; void evaluate(); })
            .then(f => uns.push(f));
        const iv = window.setInterval(() => void evaluate(), 3000);

        return () => { uns.forEach(f => f()); clearInterval(iv); };
    }, []);

    return null;
}
