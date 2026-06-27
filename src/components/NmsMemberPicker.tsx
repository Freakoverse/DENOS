/**
 * NmsMemberPicker — multi-select picker over the active keypair's Nostr follows.
 * Used by the multisig group-creation wizard. Modeled on FollowsSelector but selects
 * many members and returns their hex pubkeys.
 */
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { X, Search, Users, Loader2, Check, UserPlus } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { cn } from '@/lib/utils';
import { fetchFollows } from '@/services/nostrFollows';
import { fetchNostrProfile, type NostrProfile } from '@/services/nostrProfile';
import { CachedImg } from '@/components/CachedImg';
import { useFeedback } from '@/components/ui/feedback';

const DNN_NODE = 'https://node.icannot.xyz';

/** Resolve a pasted identifier (npub / hex / NIP-05 / DNN ID) to a hex pubkey. */
async function resolveIdentifier(input: string): Promise<string | null> {
    const v = input.trim();
    if (!v) return null;
    if (v.startsWith('npub1')) {
        try { const d = nip19.decode(v); return d.type === 'npub' ? (d.data as string) : null; } catch { return null; }
    }
    if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
    if (v.includes('@') || v.includes('.')) {
        // NIP-05 (name@domain, or bare domain → _@domain)
        const [name, domain] = v.includes('@') ? v.split('@') : ['_', v];
        try {
            const r = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(6000) });
            const j = await r.json();
            return j.names?.[name] ?? null;
        } catch { return null; }
    }
    // DNN ID → resolve via DNN node to an npub
    try {
        const r = await fetch(`${DNN_NODE}/dnn/resolve/${v.toLowerCase()}`, { signal: AbortSignal.timeout(6000) });
        if (r.ok) {
            const j = await r.json();
            if (j.npub) { const d = nip19.decode(String(j.npub)); return d.type === 'npub' ? d.data : null; }
        }
    } catch { /* fall through */ }
    return null;
}

interface NmsMemberPickerProps {
    isOpen: boolean;
    onClose: () => void;
    /** Returns the selected members as hex pubkeys (excludes the active user). */
    onConfirm: (memberHexes: string[]) => void;
    activePubkey: string; // hex
}

interface Contact {
    pubkeyHex: string;
    npub: string;
    profile: NostrProfile | null;
    loading: boolean;
}

export const NmsMemberPicker: React.FC<NmsMemberPickerProps> = ({ isOpen, onClose, onConfirm, activePubkey }) => {
    const { toast } = useFeedback();
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [manual, setManual] = useState<Contact[]>([]);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [search, setSearch] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [addInput, setAddInput] = useState('');
    const [adding, setAdding] = useState(false);
    const fetchedRef = useRef(false);

    const handleAdd = async () => {
        const val = addInput.trim();
        if (!val || adding) return;
        setAdding(true);
        try {
            const hex = await resolveIdentifier(val);
            if (!hex) { toast('Could not resolve that identifier', 'error'); return; }
            if (hex === activePubkey) { toast("That's your own account", 'error'); return; }
            let npub = ''; try { npub = nip19.npubEncode(hex); } catch { npub = hex; }
            // Add to the manual list (if new) and select it.
            setManual(prev => prev.some(c => c.pubkeyHex === hex) ? prev : [{ pubkeyHex: hex, npub, profile: null, loading: true }, ...prev]);
            setSelected(prev => new Set(prev).add(hex));
            setAddInput('');
            fetchNostrProfile(hex)
                .then(p => setManual(prev => prev.map(c => c.pubkeyHex === hex ? { ...c, profile: p, loading: false } : c)))
                .catch(() => setManual(prev => prev.map(c => c.pubkeyHex === hex ? { ...c, loading: false } : c)));
        } finally {
            setAdding(false);
        }
    };

    useEffect(() => {
        if (!isOpen) {
            fetchedRef.current = false;
            setContacts([]); setManual([]); setSelected(new Set()); setSearch(''); setError(null); setAddInput('');
            return;
        }
        if (fetchedRef.current) return;
        fetchedRef.current = true;

        (async () => {
            setLoading(true);
            try {
                const pubkeys = (await fetchFollows(activePubkey)).filter(p => p !== activePubkey);
                if (pubkeys.length === 0) {
                    setError('No follows found. A kind:3 contact list is needed to pick members.');
                    setLoading(false);
                    return;
                }
                setContacts(pubkeys.map(hex => ({
                    pubkeyHex: hex,
                    npub: (() => { try { return nip19.npubEncode(hex); } catch { return hex; } })(),
                    profile: null,
                    loading: true,
                })));
                setLoading(false);

                const BATCH = 5;
                for (let i = 0; i < pubkeys.length; i += BATCH) {
                    const batch = pubkeys.slice(i, i + BATCH);
                    const results = await Promise.allSettled(batch.map(async hex => ({ hex, profile: await fetchNostrProfile(hex) })));
                    setContacts(prev => prev.map(c => {
                        const f = results.find(r => r.status === 'fulfilled' && r.value.hex === c.pubkeyHex);
                        return f && f.status === 'fulfilled' ? { ...c, profile: f.value.profile, loading: false } : c;
                    }));
                }
                setContacts(prev => prev.map(c => ({ ...c, loading: false })));
            } catch {
                setError('Failed to fetch follows. Please try again.');
                setLoading(false);
            }
        })();
    }, [isOpen, activePubkey]);

    // Manually-added contacts on top, then follows (deduped).
    const allContacts = useMemo(() => {
        const seen = new Set(manual.map(c => c.pubkeyHex));
        return [...manual, ...contacts.filter(c => !seen.has(c.pubkeyHex))];
    }, [manual, contacts]);

    const filtered = useMemo(() => {
        if (!search.trim()) return allContacts;
        const q = search.toLowerCase().trim();
        return allContacts.filter(c => {
            const name = (c.profile?.display_name || c.profile?.name || '').toLowerCase();
            return name.includes(q) || c.npub.toLowerCase().includes(q) || (c.profile?.nip05 || '').toLowerCase().includes(q);
        });
    }, [allContacts, search]);

    const toggle = (hex: string) => setSelected(prev => {
        const next = new Set(prev);
        next.has(hex) ? next.delete(hex) : next.add(hex);
        return next;
    });

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[55] overflow-hidden bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="flex h-full items-center justify-center px-4 py-20">
                <div className="bg-card border border-border rounded-2xl w-[400px] max-h-[80vh] shadow-2xl flex flex-col">
                    <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
                        <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                            <Users className="w-5 h-5 text-primary" />
                            Select Members
                        </h3>
                        <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    <div className="p-4 pb-2 shrink-0 space-y-2">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <input
                                type="text" value={search} onChange={e => setSearch(e.target.value)}
                                placeholder="Search your follows..."
                                className="w-full bg-background border border-border rounded-xl pl-10 pr-3 py-2.5 text-foreground text-sm focus:ring-2 focus:ring-primary outline-none"
                                autoFocus
                            />
                        </div>
                        <div className="flex gap-2">
                            <input
                                type="text" value={addInput} onChange={e => setAddInput(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
                                placeholder="Add by npub / NIP-05 / DNN ID"
                                className="flex-1 min-w-0 bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-xs focus:ring-2 focus:ring-primary outline-none"
                            />
                            <button onClick={handleAdd} disabled={adding || !addInput.trim()}
                                className="px-3 rounded-xl bg-primary text-primary-foreground text-xs font-semibold cursor-pointer hover:bg-primary/80 transition-colors disabled:opacity-50 flex items-center gap-1.5 shrink-0">
                                {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />} Add
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-2">
                        {loading ? (
                            <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
                                <Loader2 className="w-6 h-6 animate-spin" /><span className="text-sm">Loading follows...</span>
                            </div>
                        ) : error && allContacts.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                                <Users className="w-8 h-8 opacity-30" /><p className="text-sm text-center">{error}</p>
                                <p className="text-xs text-center text-muted-foreground/70">You can still add members by npub / NIP-05 / DNN ID above.</p>
                            </div>
                        ) : filtered.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                                <Search className="w-8 h-8 opacity-30" /><p className="text-sm">No matches found</p>
                            </div>
                        ) : (
                            <div className="space-y-1.5">
                                {filtered.map(c => {
                                    const isSel = selected.has(c.pubkeyHex);
                                    const name = c.profile?.display_name || c.profile?.name || null;
                                    const npubShort = c.npub.slice(0, 12) + '...' + c.npub.slice(-6);
                                    return (
                                        <button key={c.pubkeyHex} onClick={() => toggle(c.pubkeyHex)}
                                            className={cn("w-full text-left p-3 rounded-xl transition-all cursor-pointer",
                                                isSel ? "bg-primary/15 border-2 border-primary/50" : "bg-secondary/30 hover:bg-secondary/60 border-2 border-transparent")}>
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
                                                    {c.profile?.picture ? (
                                                        <CachedImg src={c.profile.picture} alt="" className="w-full h-full object-cover"
                                                            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                                    ) : c.loading ? (
                                                        <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                                                    ) : (
                                                        <span className="text-primary font-bold text-sm">{(name || c.npub.slice(5, 7)).toUpperCase().slice(0, 2)}</span>
                                                    )}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    {name ? (
                                                        <>
                                                            <div className="text-sm font-medium text-foreground truncate">{name}</div>
                                                            <div className="text-[11px] text-muted-foreground font-mono truncate">{npubShort}</div>
                                                        </>
                                                    ) : (
                                                        <div className="text-sm text-foreground font-mono truncate">{npubShort}</div>
                                                    )}
                                                </div>
                                                {isSel && (
                                                    <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center shrink-0">
                                                        <Check className="w-3.5 h-3.5 text-primary-foreground" />
                                                    </div>
                                                )}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    <div className="p-4 border-t border-border shrink-0">
                        <button
                            onClick={() => { onConfirm(Array.from(selected)); onClose(); }}
                            disabled={selected.size === 0}
                            className={cn("w-full py-3 font-bold rounded-xl transition-colors cursor-pointer text-sm",
                                selected.size > 0 ? "bg-primary hover:bg-primary/80 text-primary-foreground" : "bg-secondary text-muted-foreground cursor-not-allowed")}>
                            {selected.size > 0 ? `Continue with ${selected.size} member${selected.size !== 1 ? 's' : ''}` : 'Select members'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
