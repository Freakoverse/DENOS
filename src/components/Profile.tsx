import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useFeedback } from '@/components/ui/feedback';
import {
    ArrowLeft, Pencil, Save, X, User, AtSign,
    BadgeCheck, Zap, Globe, FileText, Loader2, ShieldAlert, Copy, Check,
} from 'lucide-react';
import { dnnService } from '@/services/dnn';

/* ── Types ── */
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

interface Props {
    pubkey: string | null;
    npub: string;
    onBack: () => void;
}

/* ── Helpers ── */
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

        // Timeout after 6s
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

        // Resolve after getting all EOSE or timeout
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

/* ── Component ── */
export function Profile({ pubkey, npub, onBack }: Props) {
    const [meta, setMeta] = useState<ProfileMeta | null>(null);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(false);
    const [editMeta, setEditMeta] = useState<ProfileMeta>({});
    const [saving, setSaving] = useState(false);
    const [relayUrls, setRelayUrls] = useState<string[]>([]);
    const [verifiedDnnName, setVerifiedDnnName] = useState<string | null>(null);
    const [dnnVerified, setDnnVerified] = useState<boolean | null>(null); // null=loading, true=verified, false=unverified
    const [copiedField, setCopiedField] = useState<string | null>(null);
    const { toast } = useFeedback();

    const copyToClipboard = (text: string, field: string) => {
        navigator.clipboard.writeText(text);
        setCopiedField(field);
        toast('Copied to clipboard', 'success');
        setTimeout(() => setCopiedField(null), 2000);
    };

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

    // Fetch kind:0
    const fetchProfile = useCallback(async () => {
        if (!pubkey) return;
        setLoading(true);
        const result = await fetchKind0(pubkey, relayUrls);
        setMeta(result);
        if (result) setEditMeta(result);
        setLoading(false);
    }, [pubkey, relayUrls]);

    useEffect(() => { fetchProfile(); }, [fetchProfile]);

    // Verify DNN ID ownership (use profile's nip05 — if no '@', it's a DNN ID)
    useEffect(() => {
        if (!npub || !meta?.nip05) {
            setVerifiedDnnName(null);
            setDnnVerified(null);
            return;
        }
        const nip05 = meta.nip05;
        // DNN IDs don't contain '@' — regular NIP-05 does
        const isDnn = !nip05.includes('@');
        if (!isDnn) {
            setVerifiedDnnName(null);
            setDnnVerified(null);
            return;
        }
        setVerifiedDnnName(nip05);
        dnnService.initialize().then(() => {
            dnnService.verifyDnnId(nip05, npub).then(verified => {
                setDnnVerified(verified);
            }).catch(() => setDnnVerified(false));
        }).catch(() => setDnnVerified(false));
    }, [npub, meta?.nip05]);

    const startEdit = () => {
        setEditMeta(meta ? { ...meta } : {});
        setEditing(true);
    };

    const cancelEdit = () => {
        setEditing(false);
        setEditMeta(meta ?? {});
    };

    const saveProfile = async () => {
        if (!pubkey) return;
        setSaving(true);
        try {
            const content = JSON.stringify(editMeta);
            // Sign via Tauri backend
            const signedJson = await invoke<string>('sign_event_local', {
                kind: 0,
                content,
                tags: [],
            });
            // Publish to relays via WebSocket
            await publishToRelays(signedJson, relayUrls);
            setMeta(editMeta);
            setEditing(false);
            toast('Profile updated!', 'success');
        } catch (e: any) {
            toast('Failed to save profile: ' + e);
        }
        setSaving(false);
    };

    const updateField = (key: string, value: string) => {
        setEditMeta(prev => ({ ...prev, [key]: value || undefined }));
    };


    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center h-[60vh] gap-3 text-muted-foreground animate-fade-in">
                <Loader2 className="w-8 h-8 animate-spin text-primary" />
                <p className="text-sm">Loading profile…</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-[calc(100vh-115px)] animate-fade-in">
            {/* ── Sticky header ── */}
            <div className="flex items-center gap-3 shrink-0 pb-3">
                <button
                    onClick={onBack}
                    className="w-8 h-8 rounded-lg bg-secondary hover:bg-secondary/80 flex items-center justify-center transition-colors cursor-pointer shrink-0"
                >
                    <ArrowLeft className="w-4 h-4" />
                </button>
                <h2 className="text-lg font-semibold">Profile</h2>
            </div>

            {/* ── Scrollable content ── */}
            <div className="flex-1 overflow-y-auto space-y-4 pb-[100px]">

                {/* Banner + Avatar */}
                <div className="relative">
                    {/* Banner */}
                    <div
                        className="w-full h-28 bg-gradient-to-br from-primary/30 to-primary/5 rounded-2xl overflow-hidden"
                        style={meta?.banner ? { backgroundImage: `url(${meta.banner})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}}
                    />
                    {/* Avatar */}
                    <div className="absolute -bottom-10 left-4">
                        <div className="w-20 h-20 rounded-full border-4 border-background overflow-hidden bg-secondary">
                            {meta?.picture ? (
                                <img src={meta.picture} alt="" className="w-full h-full object-cover" />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                    <User className="w-8 h-8 text-muted-foreground" />
                                </div>
                            )}
                        </div>
                    </div>
                    {/* Edit button */}
                    <div className="absolute top-2 right-2">
                        {!editing ? (
                            <Button size="sm" variant="secondary" onClick={startEdit} className="gap-1.5 rounded-xl text-xs">
                                <Pencil className="w-3.5 h-3.5" /> Edit Profile
                            </Button>
                        ) : (
                            <div className="flex gap-1.5">
                                <Button size="sm" variant="ghost" onClick={cancelEdit} className="gap-1 rounded-xl text-xs bg-secondary text-secondary-foreground hover:bg-secondary/80">
                                    <X className="w-3.5 h-3.5" /> Cancel
                                </Button>
                                <Button size="sm" onClick={saveProfile} disabled={saving} className="gap-1 rounded-xl text-xs bg-primary text-primary-foreground hover:bg-primary/80">
                                    {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                                    Save
                                </Button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Name / handle area */}
                <div className="pt-8 px-1 space-y-1">
                    {editing ? (
                        <div className="space-y-2">
                            <Input
                                value={editMeta.display_name ?? editMeta.name ?? ''}
                                onChange={e => { updateField('display_name', e.target.value); updateField('name', e.target.value); }}
                                placeholder="Display name"
                                className="text-lg font-bold"
                            />
                        </div>
                    ) : (
                        <>
                            <h2 className="text-xl font-bold">{meta?.display_name || meta?.name || 'Anonymous'}</h2>
                            {verifiedDnnName && dnnVerified === true && (
                                <p className="text-sm text-primary flex items-center gap-1">
                                    <BadgeCheck className="w-3.5 h-3.5" /> {verifiedDnnName}
                                    <button
                                        onClick={() => copyToClipboard(verifiedDnnName, 'dnn')}
                                        className="p-0.5 text-primary/60 hover:text-primary transition-colors cursor-pointer"
                                        title="Copy DNN ID"
                                    >
                                        {copiedField === 'dnn' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                    </button>
                                </p>
                            )}
                            {!verifiedDnnName && meta?.nip05 && (
                                <p className="text-sm text-muted-foreground flex items-center gap-1">
                                    <ShieldAlert className="w-3.5 h-3.5" /> {meta.nip05} <span className="text-xs opacity-60">(unverified)</span>
                                    <button
                                        onClick={() => copyToClipboard(meta.nip05!, 'nip05')}
                                        className="p-0.5 text-muted-foreground/60 hover:text-foreground transition-colors cursor-pointer"
                                        title="Copy NIP-05"
                                    >
                                        {copiedField === 'nip05' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                    </button>
                                </p>
                            )}
                            <p className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                                {npub.slice(0, 20)}…{npub.slice(-8)}
                                <button
                                    onClick={() => copyToClipboard(npub, 'npub')}
                                    className="p-0.5 text-muted-foreground/60 hover:text-foreground transition-colors cursor-pointer"
                                    title="Copy npub"
                                >
                                    {copiedField === 'npub' ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                                </button>
                            </p>
                        </>
                    )}
                </div>

                {/* Profile fields */}
                <Card>
                    <CardContent className="pt-4 space-y-4">
                        <ProfileField
                            icon={<FileText className="w-4 h-4" />}
                            label="Bio"
                            value={editing ? editMeta.about : meta?.about}
                            editing={editing}
                            multiline
                            onChange={v => updateField('about', v)}
                        />
                        <ProfileField
                            icon={<AtSign className="w-4 h-4" />}
                            label="NIP-05"
                            value={editing ? editMeta.nip05 : meta?.nip05}
                            editing={editing}
                            onChange={v => updateField('nip05', v)}
                            placeholder="you@example.com"
                        />
                        <ProfileField
                            icon={<Zap className="w-4 h-4" />}
                            label="Lightning Address"
                            value={editing ? editMeta.lud16 : meta?.lud16}
                            editing={editing}
                            onChange={v => updateField('lud16', v)}
                            placeholder="you@wallet.com"
                        />
                        <ProfileField
                            icon={<Globe className="w-4 h-4" />}
                            label="Website"
                            value={editing ? editMeta.website : meta?.website}
                            editing={editing}
                            onChange={v => updateField('website', v)}
                            placeholder="https://example.com"
                        />
                        {editing && (
                            <>
                                <ProfileField
                                    icon={<User className="w-4 h-4" />}
                                    label="Profile Picture URL"
                                    value={editMeta.picture}
                                    editing
                                    onChange={v => updateField('picture', v)}
                                    placeholder="https://..."
                                />
                                <ProfileField
                                    icon={<FileText className="w-4 h-4" />}
                                    label="Banner URL"
                                    value={editMeta.banner}
                                    editing
                                    onChange={v => updateField('banner', v)}
                                    placeholder="https://..."
                                />
                            </>
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}

/* ── Field subcomponent ── */
function ProfileField({
    icon, label, value, editing, multiline, onChange, placeholder,
}: {
    icon: React.ReactNode;
    label: string;
    value?: string;
    editing: boolean;
    multiline?: boolean;
    onChange?: (v: string) => void;
    placeholder?: string;
}) {
    if (!editing && !value) return null;

    return (
        <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium pb-1">
                {icon} {label}
            </div>
            {editing ? (
                multiline ? (
                    <textarea
                        value={value ?? ''}
                        onChange={e => onChange?.(e.target.value)}
                        placeholder={placeholder}
                        rows={3}
                        className="w-full rounded-lg bg-secondary border border-border px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                ) : (
                    <Input
                        value={value ?? ''}
                        onChange={e => onChange?.(e.target.value)}
                        placeholder={placeholder}
                    />
                )
            ) : (
                <p className="text-sm">{value}</p>
            )}
        </div>
    );
}
