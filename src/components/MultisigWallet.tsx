/**
 * MultisigWallet — NIP-NMS multisig tab (Phase 3 UI).
 *
 * Views:
 *   - list:   existing groups (local cache) + "Create multisig group"
 *   - create: multi-select member picker → label → create (progress)
 *   - chat:   group channel messages, member roster w/ live consent status, text send
 *
 * Wallet construction / xpub exchange (the wallet icon) arrives in Phase 4.
 */
import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Plus, Shield, ArrowLeft, Loader2, Users, Send, Check, Clock, X, Sprout, Wallet as WalletIcon, RefreshCw, UserPlus, Copy, KeyRound, ChevronDown, AlertTriangle, Eye, EyeOff, Lock, History, ExternalLink, ArrowUpRight, ArrowDownLeft, Pencil } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { cn } from '@/lib/utils';
import { useFeedback } from '@/components/ui/feedback';
import { Badge } from '@/components/ui/badge';
import { NmsMemberPicker } from '@/components/NmsMemberPicker';
import { CachedImg } from '@/components/CachedImg';
import { fetchNostrProfile, type NostrProfile } from '@/services/nostrProfile';
import { hexToBytes } from '@noble/hashes/utils.js';
import { nip19 } from 'nostr-tools';
import {
    deriveGroupKeypair, wrapGroupMessage, subscribeGroupChannel, fetchChannelMessages,
    publishToRelays, type GroupKeypair, type NmsMessageType, type NmsUnwrapped,
} from '@/services/nms';
import { getCachedMessages, cacheMessages } from '@/services/nmsChatCache';
import {
    createGroupAsInitiator, getLocalGroups, saveLocalGroup,
    applyConsent, isGroupReady, publishMembershipRecord,
    fetchRecentInvites, acceptInvite, declineInvite, resendInvite,
    extractXpub, applyXpub, sendCosignerXpub, allXpubsCollected, publishXpubsCache, cosignerList,
    sendPsbtProposal, sendPsbtSignature, sendPsbtDecline, sendPsbtBroadcast, fetchGroupProfile,
    syncGroupIndex, ensureBackupsAlive,
    type PsbtSummary, type NmsGroup, type MemberStatus, type NmsInvite, type CosignerXpub, type GroupProfile,
} from '@/services/nmsGroup';
import {
    deriveCosignerXpub, deriveCosignerXpubFromNsec, cosignerAccountFromSeed, cosignerAccountFromNsec,
    deriveMultisigAddress, isValidXpub, xpubFingerprint, buildDescriptor, NMS_DERIVATION_PATH,
} from '@/services/nmsWallet';
import {
    buildMultisigPsbt, signMultisigPsbt, combinePsbts, countSignatures, finalizeMultisigPsbt, estimateVbytes,
    type SpendableUtxo,
} from '@/services/nmsPsbt';
import { scanWallet, fetchWalletHistory, type WalletScan, type NmsTx } from '@/services/nmsWalletScan';
import { List } from 'lucide-react';
import { satsToBTC, btcToSats, fetchUTXOs, broadcastTransaction, getFeeRates, npubToTaprootAddress, type FeeRates } from '@/services/bitcoin';
import { QRCodeSVG } from 'qrcode.react';
import type { HDKey } from '@scure/bip32';

interface Props {
    activePubkey: string | null; // hex
}

type View = 'list' | 'create' | 'chat' | 'invites';

interface ChatMsg {
    id: string;
    author: string;
    type: NmsMessageType;
    created_at: number;
    content: Record<string, unknown>;
    tags: string[][];
    rawCreatedAt: number; // gift-wrap time, for pagination
}

/** Aggregated state of one PSBT proposal, assembled from its channel messages. */
interface Proposal {
    uuid: string;
    proposer: string;
    summary: PsbtSummary;
    createdAt: number;
    sigs: Record<string, string>; // author → their PSBT (base64, carrying partial sig)
    declined: Set<string>;
    txid?: string;
}

/** Fold the channel's nms-psbt messages into per-uuid proposals. */
function buildProposals(messages: ChatMsg[]): Record<string, Proposal> {
    const map: Record<string, Proposal> = {};
    for (const m of messages) {
        if (m.type !== 'nms-psbt') continue;
        const uuid = m.tags.find(t => t[0] === 'psbt')?.[1];
        if (!uuid) continue;
        const approved = m.tags.find(t => t[0] === 'approved')?.[1] === 'yes';
        const psbt = m.content.psbt as string | undefined;
        const summary = m.content.summary as PsbtSummary | undefined;
        const txid = m.content.txid as string | undefined;

        let p = map[uuid];
        if (summary && !p) {
            p = map[uuid] = { uuid, proposer: m.author, summary, createdAt: m.created_at, sigs: {}, declined: new Set() };
        }
        if (!p) continue; // a signature seen before its proposal — skip until the proposal arrives
        if (txid) p.txid = txid;
        if (approved && psbt) { p.sigs[m.author] = psbt; p.declined.delete(m.author); }
        else if (!approved) { p.declined.add(m.author); delete p.sigs[m.author]; }
    }
    return map;
}

/** Derive the active member's signing account node (seed or nsec path). Never cached. */
async function deriveMyAccount(ownerHex: string, hHex: string): Promise<HDKey> {
    const st = await invoke<{ keypairs: { pubkey: string; seed_id?: string }[] }>('get_app_state');
    const kp = st.keypairs.find(k => k.pubkey === ownerHex);
    if (kp?.seed_id) {
        const mnemonic = await invoke<string>('export_seed_words', { seedId: kp.seed_id });
        return cosignerAccountFromSeed(mnemonic, hHex);
    }
    const nsec = await invoke<string>('export_private_key_hex', { pubkey: ownerHex });
    return cosignerAccountFromNsec(nsec, hHex);
}

/** Fetch spendable UTXOs across a wallet's funded addresses, tagged with chain/index. */
async function fetchWalletUtxos(scan: WalletScan): Promise<SpendableUtxo[]> {
    const funded = [...scan.receive, ...scan.change].filter(a => a.balance > 0);
    const out: SpendableUtxo[] = [];
    await Promise.all(funded.map(async a => {
        try {
            const utxos = await fetchUTXOs(a.address);
            for (const u of utxos) out.push({ txid: u.txid, vout: u.vout, value: u.value, chain: a.chain, index: a.index });
        } catch { /* skip */ }
    }));
    return out;
}

/** Greedy coin selection (largest first), recomputing the P2WSH fee as inputs are added. */
function selectUtxos(utxos: SpendableUtxo[], amountSats: number, feeRate: number, m: number, n: number): { selected: SpendableUtxo[]; feeSats: number } | null {
    const sorted = [...utxos].sort((a, b) => b.value - a.value);
    const selected: SpendableUtxo[] = [];
    let sum = 0;
    for (const u of sorted) {
        selected.push(u);
        sum += u.value;
        const feeSats = Math.ceil(estimateVbytes(selected.length, 2, m, n) * feeRate);
        if (sum >= amountSats + feeSats) return { selected, feeSats };
    }
    return null;
}

function nip19Npub(hex: string): string {
    try { const n = nip19.npubEncode(hex); return `${n.slice(0, 12)}…${n.slice(-6)}`; } catch { return `${hex.slice(0, 12)}…`; }
}

/** Truncate a bitcoin address like bc1q123…abc123. */
function truncAddr(addr: string): string {
    return addr.length <= 18 ? addr : `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

const statusMeta: Record<MemberStatus, { label: string; cls: string; Icon: typeof Check }> = {
    initiator: { label: 'Initiator', cls: 'text-primary', Icon: Sprout },
    accepted: { label: 'Joined', cls: 'text-green-500', Icon: Check },
    invited: { label: 'Invited', cls: 'text-muted-foreground', Icon: Clock },
    declined: { label: 'Declined', cls: 'text-red-500', Icon: X },
};

export function MultisigWallet({ activePubkey }: Props) {
    const { toast } = useFeedback();
    const [view, setView] = useState<View>('list');
    const [groups, setGroups] = useState<NmsGroup[]>([]);
    const [activeNpub, setActiveNpub] = useState<string | null>(null);
    const [invites, setInvites] = useState<NmsInvite[]>([]);
    const [loadingInvites, setLoadingInvites] = useState(false);
    const [busyInvite, setBusyInvite] = useState<string | null>(null);
    const skRef = useRef<string | null>(null);
    const backupCheckedRef = useRef<string | null>(null); // pubkey we've run the backup-alive check for

    // Build/cache/publish the personal nmsgc backup from current local groups.
    const syncBackup = useCallback(() => {
        const sk = skRef.current;
        if (sk && activePubkey) syncGroupIndex(sk, activePubkey, getLocalGroups(activePubkey)).catch(() => { });
    }, [activePubkey]);

    const loadInvites = useCallback((sk: string, pubkey: string) => {
        setLoadingInvites(true);
        fetchRecentInvites(sk, pubkey)
            .then(list => {
                // Hide invites for groups already joined locally.
                const joined = new Set(getLocalGroups(pubkey).map(g => g.groupNpub));
                setInvites(list.filter(i => !joined.has(i.groupNpub)));
            })
            .catch(() => { /* keep whatever we had */ })
            .finally(() => setLoadingInvites(false));
    }, []);

    // Load the signing key + local groups + pending invites for the active identity.
    useEffect(() => {
        skRef.current = null;
        setInvites([]);
        if (!activePubkey) { setGroups([]); return; }
        const local = getLocalGroups(activePubkey);
        setGroups(local);
        invoke<string>('export_private_key_hex', { pubkey: activePubkey })
            .then(sk => {
                skRef.current = sk;
                loadInvites(sk, activePubkey);
                // Once per session per account: rebroadcast nmsgc/msx backups if relays dropped them.
                if (backupCheckedRef.current !== activePubkey) {
                    backupCheckedRef.current = activePubkey;
                    ensureBackupsAlive(activePubkey, local.map(g => g.groupNpub)).catch(() => { });
                }
            })
            .catch(() => { skRef.current = null; });
    }, [activePubkey, loadInvites]);

    const refreshGroups = useCallback(() => {
        if (activePubkey) setGroups(getLocalGroups(activePubkey));
    }, [activePubkey]);

    const handleAccept = async (invite: NmsInvite) => {
        const sk = skRef.current;
        if (!sk || !activePubkey) { toast('Signing key unavailable', 'error'); return; }
        setBusyInvite(invite.groupNpub);
        try {
            const group = await acceptInvite(invite, sk, activePubkey);
            setInvites(prev => prev.filter(i => i.groupNpub !== invite.groupNpub));
            refreshGroups();
            syncBackup(); // record the newly-joined group in the nmsgc backup
            setActiveNpub(group.groupNpub);
            setView('chat');
            toast('Joined group', 'success');
        } catch {
            toast('Failed to accept invite', 'error');
        } finally {
            setBusyInvite(null);
        }
    };

    const handleDecline = async (invite: NmsInvite) => {
        const sk = skRef.current;
        if (!sk) return;
        setBusyInvite(invite.groupNpub);
        try {
            await declineInvite(invite, sk);
            setInvites(prev => prev.filter(i => i.groupNpub !== invite.groupNpub));
        } catch {
            toast('Failed to decline', 'error');
        } finally {
            setBusyInvite(null);
        }
    };

    if (!activePubkey) {
        return (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
                <Shield className="w-10 h-10 opacity-30" />
                <p className="text-sm">Select an account to use multisig.</p>
            </div>
        );
    }

    if (view === 'create') {
        return <CreateGroup
            activePubkey={activePubkey}
            getSk={() => skRef.current}
            onCancel={() => setView('list')}
            onCreated={(g) => { refreshGroups(); syncBackup(); setActiveNpub(g.groupNpub); setView('chat'); }}
        />;
    }

    if (view === 'chat' && activeNpub) {
        const group = groups.find(g => g.groupNpub === activeNpub);
        if (!group) { setView('list'); return null; }
        return <GroupChat
            group={group}
            ownerHex={activePubkey}
            getSk={() => skRef.current}
            onBack={() => { refreshGroups(); setView('list'); }}
            onGroupUpdate={refreshGroups}
        />;
    }

    if (view === 'invites') {
        return <InvitesPage
            invites={invites}
            busyInvite={busyInvite}
            onAccept={handleAccept}
            onDecline={handleDecline}
            onBack={() => setView('list')}
        />;
    }

    // ── list view ──
    const refreshInvites = () => { if (skRef.current && activePubkey) loadInvites(skRef.current, activePubkey); };
    const showSlab = loadingInvites || invites.length > 0;

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between mb-3 shrink-0">
                <h3 className="text-base font-semibold">Multisig Groups</h3>
                <div className="flex items-center gap-1.5">
                    <button onClick={refreshInvites} title="Check for invitations"
                        className="w-8 h-8 rounded-lg bg-secondary flex items-center justify-center hover:bg-secondary/80 transition-colors cursor-pointer">
                        <RefreshCw className={cn("w-3.5 h-3.5 text-muted-foreground", loadingInvites && "animate-spin")} />
                    </button>
                    <button onClick={() => setView('create')}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/80 transition-colors cursor-pointer">
                        <Plus className="w-3.5 h-3.5" /> New
                    </button>
                </div>
            </div>

            {/* Invitations slab — opens the invites page; shows count or an inline spinner */}
            {showSlab && (
                <button onClick={() => setView('invites')} disabled={loadingInvites && invites.length === 0}
                    className="w-full flex items-center gap-3 p-3 mb-3 rounded-xl bg-primary/5 border border-primary/20 hover:bg-primary/10 transition-colors cursor-pointer shrink-0 disabled:cursor-default">
                    <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                        <UserPlus className="w-4.5 h-4.5 text-primary" />
                    </div>
                    <div className="flex-1 text-left min-w-0">
                        <div className="text-sm font-semibold text-foreground">Invitations</div>
                        <div className="text-[11px] text-muted-foreground">
                            {loadingInvites ? 'Checking…' : `${invites.length} pending · tap to review`}
                        </div>
                    </div>
                    <div className="shrink-0">
                        {loadingInvites
                            ? <Loader2 className="w-4 h-4 animate-spin text-primary" />
                            : <span className="min-w-5 h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-[11px] font-bold flex items-center justify-center">{invites.length}</span>}
                    </div>
                </button>
            )}

            <div className="flex-1 overflow-y-auto pb-4">
                {groups.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center gap-4 text-muted-foreground">
                        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                            <Shield className="w-8 h-8 text-primary" />
                        </div>
                        <div className="text-center">
                            <h3 className="text-base font-bold text-foreground">No groups yet</h3>
                            <p className="text-sm max-w-xs mt-1">Create a shared Bitcoin wallet with people you follow on Nostr.</p>
                        </div>
                        <button onClick={() => setView('create')}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/80 transition-colors cursor-pointer">
                            <Plus className="w-4 h-4" /> Create multisig group
                        </button>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {groups.map(g => {
                            const joined = g.members.filter(m => m.status === 'accepted' || m.status === 'initiator').length;
                            const ready = isGroupReady(g);
                            return (
                                <button key={g.groupNpub} onClick={() => { setActiveNpub(g.groupNpub); setView('chat'); }}
                                    className="w-full text-left p-3.5 rounded-xl bg-secondary/40 hover:bg-secondary/70 border border-white/5 transition-colors cursor-pointer">
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
                                            {g.profile?.picture
                                                ? <CachedImg src={g.profile.picture} alt="" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                                : <Shield className="w-5 h-5 text-primary" />}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-semibold text-foreground truncate">
                                                    {g.profile?.name || g.label || `${g.members.length}-member group`}
                                                </span>
                                                {g.initiator === activePubkey && <Badge variant="secondary" className="text-[9px] py-0 px-1.5">Owner</Badge>}
                                            </div>
                                            <span className="text-[11px] text-muted-foreground font-mono truncate block">
                                                {g.groupNpub.slice(0, 14)}…{g.groupNpub.slice(-6)}
                                            </span>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <div className={cn("text-xs font-semibold", ready ? "text-green-500" : "text-amber-500")}>
                                                {ready ? 'Ready' : 'Pending'}
                                            </div>
                                            <div className="text-[10px] text-muted-foreground">{joined}/{g.members.length} joined</div>
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}

// ──────────────────────────────────────────────────────────────────────────
//  Create flow
// ──────────────────────────────────────────────────────────────────────────

function CreateGroup({ activePubkey, getSk, onCancel, onCreated }: {
    activePubkey: string;
    getSk: () => string | null;
    onCancel: () => void;
    onCreated: (g: NmsGroup) => void;
}) {
    const { toast } = useFeedback();
    const [pickerOpen, setPickerOpen] = useState(true);
    const [memberHexes, setMemberHexes] = useState<string[]>([]);
    const [label, setLabel] = useState('');
    const [creating, setCreating] = useState(false);
    const [progress, setProgress] = useState('');

    const handleCreate = async () => {
        const sk = getSk();
        if (!sk) { toast('Signing key unavailable', 'error'); return; }
        if (memberHexes.length === 0) { toast('Pick at least one member', 'error'); return; }
        setCreating(true);
        try {
            setProgress('Computing group secret…');
            // small yield so the UI paints the progress text before the CPU work
            await new Promise(r => setTimeout(r, 50));
            setProgress(`Sending invites to ${memberHexes.length} member${memberHexes.length !== 1 ? 's' : ''}…`);
            const { group, invitesSent } = await createGroupAsInitiator(sk, activePubkey, memberHexes, label.trim() || undefined);
            toast(`Group created — ${invitesSent}/${memberHexes.length} invites delivered`, 'success');
            onCreated(group);
        } catch (e) {
            toast(e instanceof Error ? e.message : 'Failed to create group', 'error');
            setCreating(false);
        }
    };

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center gap-3 shrink-0 pb-3">
                <button onClick={onCancel} disabled={creating}
                    className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors disabled:opacity-50">
                    <ArrowLeft className="w-4.5 h-4.5 text-muted-foreground" />
                </button>
                <h2 className="text-base font-semibold">Create Multisig Group</h2>
            </div>

            {creating ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                    <p className="text-sm">{progress}</p>
                    <p className="text-[11px] max-w-[260px] text-center text-muted-foreground/70">
                        Deriving the group identity and inviting members over encrypted DMs.
                    </p>
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto space-y-4">
                    <div>
                        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Group name (optional)</label>
                        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Family savings"
                            className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-sm focus:ring-2 focus:ring-primary outline-none" />
                        <p className="text-[10px] text-muted-foreground mt-1">Shared with the group (encrypted). The initiator can change it later.</p>
                    </div>

                    <div>
                        <div className="flex items-center justify-between mb-1.5">
                            <label className="text-xs font-medium text-muted-foreground">Members</label>
                            <button onClick={() => setPickerOpen(true)} className="text-xs text-primary font-semibold cursor-pointer hover:underline">
                                {memberHexes.length > 0 ? 'Change' : 'Select'}
                            </button>
                        </div>
                        {memberHexes.length === 0 ? (
                            <button onClick={() => setPickerOpen(true)}
                                className="w-full flex items-center justify-center gap-2 py-6 rounded-xl border-2 border-dashed border-border text-muted-foreground hover:border-primary/40 transition-colors cursor-pointer">
                                <Users className="w-4 h-4" /> <span className="text-sm">Pick members from your follows</span>
                            </button>
                        ) : (
                            <div className="rounded-xl bg-secondary/40 border border-white/5 p-3 space-y-1">
                                <p className="text-sm text-foreground font-medium">
                                    {memberHexes.length + 1} participants <span className="text-muted-foreground font-normal">(you + {memberHexes.length})</span>
                                </p>
                                <p className="text-[11px] text-muted-foreground">
                                    Wallets from 1-of-{memberHexes.length + 1} up to {memberHexes.length + 1}-of-{memberHexes.length + 1} will be available once everyone joins and shares keys.
                                </p>
                            </div>
                        )}
                    </div>

                    <button onClick={handleCreate} disabled={memberHexes.length === 0}
                        className={cn("w-full py-3 font-bold rounded-xl transition-colors cursor-pointer text-sm",
                            memberHexes.length > 0 ? "bg-primary hover:bg-primary/80 text-primary-foreground" : "bg-secondary text-muted-foreground cursor-not-allowed")}>
                        Create group & invite
                    </button>
                </div>
            )}

            <NmsMemberPicker
                isOpen={pickerOpen}
                onClose={() => setPickerOpen(false)}
                onConfirm={setMemberHexes}
                activePubkey={activePubkey}
            />
        </div>
    );
}

// ──────────────────────────────────────────────────────────────────────────
//  Group chat
// ──────────────────────────────────────────────────────────────────────────

function GroupChat({ group, ownerHex, getSk, onBack, onGroupUpdate }: {
    group: NmsGroup;
    ownerHex: string;
    getSk: () => string | null;
    onBack: () => void;
    onGroupUpdate: () => void;
}) {
    const { toast } = useFeedback();
    const [messages, setMessages] = useState<ChatMsg[]>([]);
    const [roster, setRoster] = useState<NmsGroup>(group);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [showMembers, setShowMembers] = useState(false);
    const [showWallet, setShowWallet] = useState(false);
    const [reinviting, setReinviting] = useState<string | null>(null);
    const [profiles, setProfiles] = useState<Record<string, NostrProfile | null>>({});
    const [groupProfileOpen, setGroupProfileOpen] = useState(false);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [reachedEnd, setReachedEnd] = useState(false);
    const groupKeyRef = useRef<GroupKeypair | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const publishedReadyRef = useRef(false);
    const olderLoadRef = useRef<number | null>(null); // prev scrollHeight while prepending older
    const didInitialScrollRef = useRef(false);

    const toChatMsg = (msg: NmsUnwrapped, raw: { id: string; created_at: number }): ChatMsg => ({
        id: raw.id, author: msg.author, type: msg.type, created_at: msg.created_at, content: msg.content, tags: msg.tags, rawCreatedAt: raw.created_at,
    });

    const handleReinvite = async (memberHex: string) => {
        const sk = getSk();
        if (!sk) { toast('Signing key unavailable', 'error'); return; }
        setReinviting(memberHex);
        try {
            const ok = await resendInvite(roster, memberHex, sk);
            toast(ok > 0 ? 'Invite re-sent' : 'No relay accepted the invite', ok > 0 ? 'success' : 'error');
        } catch {
            toast('Failed to re-send invite', 'error');
        } finally {
            setReinviting(null);
        }
    };

    // Derive the group keypair once.
    if (!groupKeyRef.current) {
        try { groupKeyRef.current = deriveGroupKeypair(hexToBytes(group.hHex)); } catch { /* shown below */ }
    }

    // Load cached history instantly, then subscribe for live + recent messages.
    useEffect(() => {
        let cancelled = false;
        didInitialScrollRef.current = false; // re-anchor to bottom for the newly-opened group
        getCachedMessages(group.groupNpub).then(cached => {
            if (cancelled || cached.length === 0) return;
            setMessages(prev => {
                const ids = new Set(prev.map(p => p.id));
                const add = cached.filter(c => !ids.has(c.id)).map(c => ({
                    id: c.id, author: c.author, type: c.type as NmsMessageType, created_at: c.created_at, content: c.content, tags: c.tags, rawCreatedAt: c.rawCreatedAt,
                }));
                return [...prev, ...add].sort((a, b) => a.created_at - b.created_at);
            });
        }).catch(() => { });
        return () => { cancelled = true; };
    }, [group.groupNpub]);

    // Subscribe to the channel (live + recent). New messages are cached locally (append-only).
    useEffect(() => {
        const gk = groupKeyRef.current;
        if (!gk) return;
        const sub = subscribeGroupChannel(gk, (msg, raw) => {
            const cm = toChatMsg(msg, raw);
            setMessages(prev => prev.some(m => m.id === raw.id) ? prev : [...prev, cm].sort((a, b) => a.created_at - b.created_at));
            cacheMessages(group.groupNpub, [cm]);

            if (msg.type === 'nms-accept' || msg.type === 'nms-decline') {
                setRoster(prev => applyConsent(prev, msg));
            }
            if (msg.type === 'nms-xpub') {
                const x = extractXpub(msg);
                if (x) setRoster(prev => applyXpub(prev, x));
            }
        });
        return () => sub.stop();
    }, [group.groupNpub]); // eslint-disable-line react-hooks/exhaustive-deps

    // Persist roster changes and, if we're the initiator of a now-ready group, publish kind:0.
    useEffect(() => {
        saveLocalGroup(ownerHex, roster);
        onGroupUpdate();
        if (ownerHex === roster.initiator && isGroupReady(roster) && !publishedReadyRef.current) {
            publishedReadyRef.current = true;
            publishMembershipRecord(roster).catch(() => { /* best-effort */ });
        }
    }, [roster]); // eslint-disable-line react-hooks/exhaustive-deps

    // Keep view pinned to bottom for new messages; preserve position when prepending older.
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        if (olderLoadRef.current != null) {
            el.scrollTop = el.scrollHeight - olderLoadRef.current; // restore after prepend
            olderLoadRef.current = null;
            return;
        }
        if (!didInitialScrollRef.current && messages.length > 0) {
            el.scrollTop = el.scrollHeight; // jump to bottom on first load (no animation)
            didInitialScrollRef.current = true;
            return;
        }
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 250;
        if (nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }, [messages]);

    // Scroll-up pagination: fetch older messages from relays when near the top.
    const loadOlder = useCallback(async () => {
        const gk = groupKeyRef.current;
        const el = scrollRef.current;
        if (!gk || !el || loadingOlder || reachedEnd || messages.length === 0) return;
        setLoadingOlder(true);
        try {
            const oldestRaw = Math.min(...messages.map(m => m.rawCreatedAt));
            const older = await fetchChannelMessages(gk, { until: oldestRaw - 1, limit: 40 });
            const existing = new Set(messages.map(m => m.id));
            const fresh = older.map(({ msg, raw }) => toChatMsg(msg, raw)).filter(m => !existing.has(m.id));
            if (fresh.length === 0) { setReachedEnd(true); return; }
            olderLoadRef.current = el.scrollHeight; // preserve position across the prepend
            setMessages(prev => {
                const ids = new Set(prev.map(p => p.id));
                return [...fresh.filter(m => !ids.has(m.id)), ...prev].sort((a, b) => a.created_at - b.created_at);
            });
            cacheMessages(group.groupNpub, fresh);
        } catch { /* ignore */ } finally {
            setLoadingOlder(false);
        }
    }, [messages, loadingOlder, reachedEnd, group.groupNpub]);

    const onScroll = () => {
        const el = scrollRef.current;
        if (el && el.scrollTop < 80 && !loadingOlder && !reachedEnd) loadOlder();
    };

    // Fetch profiles for members + message authors so messages show name/picture.
    useEffect(() => {
        let cancelled = false;
        const need = new Set<string>();
        roster.members.forEach(m => need.add(m.pubkey));
        messages.forEach(m => need.add(m.author));
        need.forEach(hex => {
            if (hex in profiles) return;
            fetchNostrProfile(hex)
                .then(p => { if (!cancelled) setProfiles(prev => (hex in prev ? prev : { ...prev, [hex]: p })); })
                .catch(() => { if (!cancelled) setProfiles(prev => (hex in prev ? prev : { ...prev, [hex]: null })); });
        });
        return () => { cancelled = true; };
    }, [roster, messages]); // eslint-disable-line react-hooks/exhaustive-deps

    // Fetch the group's encrypted profile (name/picture/about) once.
    useEffect(() => {
        let cancelled = false;
        fetchGroupProfile(group).then(pf => {
            if (cancelled || !pf) return;
            setRoster(prev => {
                const updated = { ...prev, profile: pf };
                saveLocalGroup(ownerHex, updated);
                return updated;
            });
        }).catch(() => { });
        return () => { cancelled = true; };
    }, [group.groupNpub]); // eslint-disable-line react-hooks/exhaustive-deps

    const sendText = async () => {
        const body = draft.trim();
        const sk = getSk();
        const gk = groupKeyRef.current;
        if (!body || !sk || !gk) return;
        setSending(true);
        try {
            const wrap = wrapGroupMessage({ type: 'nms-text', content: { body } }, sk, gk);
            // Optimistic local echo.
            setMessages(prev => [...prev, { id: wrap.id, author: ownerHex, type: 'nms-text', created_at: Math.floor(Date.now() / 1000), content: { body }, tags: [], rawCreatedAt: Math.floor(Date.now() / 1000) }]);
            setDraft('');
            const ok = await publishToRelays(wrap);
            if (ok === 0) toast('Message not delivered to any relay', 'error');
        } catch {
            toast('Failed to send', 'error');
        } finally {
            setSending(false);
        }
    };

    // Aggregate PSBT proposals from the channel.
    const proposals = useMemo(() => buildProposals(messages), [messages]);
    const [psbtBusy, setPsbtBusy] = useState<string | null>(null);

    const handleSign = async (p: Proposal) => {
        const sk = getSk();
        const me = roster.xpubs?.[ownerHex];
        if (!sk || !me) { toast('Cannot sign — your key is missing', 'error'); return; }
        setPsbtBusy(p.uuid);
        try {
            const account = await deriveMyAccount(ownerHex, roster.hHex);
            const merged = combinePsbts(Object.values(p.sigs));
            const signed = signMultisigPsbt(merged, account, me.fingerprint);
            await sendPsbtSignature(roster, sk, p.uuid, signed);
            toast('Signed', 'success');
        } catch {
            toast('Failed to sign', 'error');
        } finally { setPsbtBusy(null); }
    };

    const handleDecline = async (p: Proposal) => {
        const sk = getSk();
        if (!sk) return;
        setPsbtBusy(p.uuid);
        try { await sendPsbtDecline(roster, sk, p.uuid); toast('Declined', 'success'); }
        catch { toast('Failed', 'error'); }
        finally { setPsbtBusy(null); }
    };

    const handleBroadcast = async (p: Proposal) => {
        const sk = getSk();
        if (!sk) return;
        setPsbtBusy(p.uuid);
        try {
            const merged = combinePsbts(Object.values(p.sigs));
            const fin = finalizeMultisigPsbt(merged);
            if (!fin.complete || !fin.txHex) { toast('Not enough signatures yet', 'error'); return; }
            const txid = (await broadcastTransaction(fin.txHex)).trim();
            await sendPsbtBroadcast(roster, sk, p.uuid, txid);
            toast('Broadcast!', 'success');
        } catch (e) {
            toast(e instanceof Error ? `Broadcast failed: ${e.message.slice(0, 80)}` : 'Broadcast failed', 'error');
        } finally { setPsbtBusy(null); }
    };

    const saveGroupProfile = async (pf: GroupProfile) => {
        const updated = { ...roster, profile: pf };
        setRoster(updated);
        saveLocalGroup(ownerHex, updated);
        await publishMembershipRecord(updated);
    };

    if (!groupKeyRef.current) {
        return (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
                <X className="w-8 h-8 text-red-500" />
                <p className="text-sm">This group's secret is invalid. Re-create the group.</p>
                <button onClick={onBack} className="text-xs text-primary cursor-pointer">Back</button>
            </div>
        );
    }

    const ready = isGroupReady(roster);

    if (showMembers) {
        return <MembersPanel
            group={roster}
            isInitiator={ownerHex === roster.initiator}
            reinviting={reinviting}
            onReinvite={handleReinvite}
            onBack={() => setShowMembers(false)}
        />;
    }

    if (showWallet) {
        return <WalletSetup
            group={roster}
            ownerHex={ownerHex}
            getSk={getSk}
            profiles={profiles}
            onBack={() => setShowWallet(false)}
            onXpubSent={(x) => setRoster(prev => applyXpub(prev, x))}
        />;
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center gap-2.5 shrink-0 pb-3">
                <button onClick={onBack} className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors">
                    <ArrowLeft className="w-4.5 h-4.5 text-muted-foreground" />
                </button>
                <button onClick={() => setGroupProfileOpen(true)} className="flex items-center gap-2.5 flex-1 min-w-0 cursor-pointer text-left">
                    <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
                        {roster.profile?.picture
                            ? <CachedImg src={roster.profile.picture} alt="" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                            : <Shield className="w-4.5 h-4.5 text-primary" />}
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-base font-semibold truncate">{roster.profile?.name || roster.label || 'Multisig group'}</h2>
                        <p className="text-[11px] text-muted-foreground">{roster.members.length} members · {ready ? 'ready' : 'awaiting members'}</p>
                    </div>
                </button>
                {ownerHex === roster.initiator && (
                    <button onClick={() => setGroupProfileOpen(true)} title="Edit group profile"
                        className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 text-muted-foreground hover:bg-secondary/80 hover:text-foreground transition-colors cursor-pointer">
                        <Pencil className="w-4 h-4" />
                    </button>
                )}
                <button onClick={() => setShowMembers(true)} title="Members"
                    className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 text-muted-foreground hover:bg-secondary/80 hover:text-foreground transition-colors cursor-pointer">
                    <Users className="w-4.5 h-4.5" />
                </button>
                <button onClick={() => setShowWallet(true)} title="Wallet setup"
                    className="relative w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 text-muted-foreground hover:bg-secondary/80 hover:text-foreground transition-colors cursor-pointer">
                    <WalletIcon className="w-4.5 h-4.5" />
                    {!roster.xpubs?.[ownerHex] && (
                        <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-amber-500 border border-card" />
                    )}
                </button>
            </div>

            {/* Messages — anchored to the bottom */}
            <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
                <div className="min-h-full flex flex-col justify-end space-y-2 pb-2">
                    {loadingOlder && (
                        <div className="flex justify-center py-2"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
                    )}
                    {messages.length === 0 ? (
                        <div className="m-auto flex flex-col items-center justify-center gap-2 text-muted-foreground">
                            <Users className="w-8 h-8 opacity-30" />
                            <p className="text-xs">No messages yet. Say hi 👋</p>
                        </div>
                    ) : messages.map(m => {
                        if (m.type === 'nms-psbt') {
                            const uuid = m.tags.find(t => t[0] === 'psbt')?.[1];
                            const isProposal = !!m.content.summary;
                            if (isProposal && uuid && proposals[uuid]) {
                                return <PsbtCard key={m.id} proposal={proposals[uuid]} ownerHex={ownerHex} profile={profiles[proposals[uuid].proposer]} profiles={profiles}
                                    busy={psbtBusy === uuid} onSign={handleSign} onDecline={handleDecline} onBroadcast={handleBroadcast} />;
                            }
                            return <PsbtSystemLine key={m.id} msg={m} profile={profiles[m.author]} />;
                        }
                        return <MessageRow key={m.id} msg={m} mine={m.author === ownerHex} profile={profiles[m.author]} />;
                    })}
                </div>
            </div>

            {/* Composer */}
            <div className="flex items-center gap-2 shrink-0 pt-2">
                <input value={draft} onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !sending) sendText(); }}
                    placeholder="Message the group…"
                    className="flex-1 bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-sm focus:ring-2 focus:ring-primary outline-none" />
                <button onClick={sendText} disabled={sending || !draft.trim()}
                    className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-colors",
                        draft.trim() && !sending ? "bg-primary text-primary-foreground hover:bg-primary/80 cursor-pointer" : "bg-secondary text-muted-foreground cursor-not-allowed")}>
                    {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
            </div>

            {groupProfileOpen && (
                <GroupProfileModal group={roster} isInitiator={ownerHex === roster.initiator} onSave={saveGroupProfile} onClose={() => setGroupProfileOpen(false)} />
            )}
        </div>
    );
}

/** View / edit the group's encrypted profile (initiator can edit). */
function GroupProfileModal({ group, isInitiator, onSave, onClose }: {
    group: NmsGroup;
    isInitiator: boolean;
    onSave: (pf: GroupProfile) => Promise<void>;
    onClose: () => void;
}) {
    const { toast } = useFeedback();
    const [name, setName] = useState(group.profile?.name ?? '');
    const [picture, setPicture] = useState(group.profile?.picture ?? '');
    const [about, setAbout] = useState(group.profile?.about ?? '');
    const [saving, setSaving] = useState(false);

    const save = async () => {
        setSaving(true);
        try {
            await onSave({ name: name.trim() || undefined, picture: picture.trim() || undefined, about: about.trim() || undefined });
            toast('Group profile saved', 'success');
            onClose();
        } catch { toast('Failed to save', 'error'); }
        finally { setSaving(false); }
    };

    return (
        <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm animate-fade-in flex items-center justify-center px-4 py-16" onClick={onClose}>
            <div className="bg-card border border-border rounded-2xl w-[400px] max-h-[85vh] shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
                    <h3 className="text-base font-bold">Group profile</h3>
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer"><X className="w-5 h-5" /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    <div className="flex justify-center">
                        <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center overflow-hidden">
                            {(isInitiator ? picture : group.profile?.picture)
                                ? <img src={isInitiator ? picture : group.profile!.picture} alt="" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                : <Shield className="w-9 h-9 text-primary" />}
                        </div>
                    </div>
                    <div className="text-[10px] text-center text-muted-foreground">Encrypted to the group — only members can read this.</div>

                    {isInitiator ? (
                        <>
                            <div>
                                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Name</label>
                                <input value={name} onChange={e => setName(e.target.value)} placeholder="Family savings"
                                    className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-sm focus:ring-2 focus:ring-primary outline-none" />
                            </div>
                            <div>
                                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Picture URL</label>
                                <input value={picture} onChange={e => setPicture(e.target.value)} placeholder="https://…"
                                    className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-xs font-mono focus:ring-2 focus:ring-primary outline-none" />
                            </div>
                            <div>
                                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Description</label>
                                <textarea value={about} onChange={e => setAbout(e.target.value)} placeholder="What this group is for…" rows={3}
                                    className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-sm focus:ring-2 focus:ring-primary outline-none resize-none" />
                            </div>
                            <button onClick={save} disabled={saving}
                                className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/80 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5">
                                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save profile
                            </button>
                        </>
                    ) : (
                        <>
                            <div className="text-center">
                                <div className="text-lg font-bold text-foreground">{group.profile?.name || group.label || 'Multisig group'}</div>
                                {group.profile?.about && <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{group.profile.about}</p>}
                            </div>
                            <div className="text-[11px] text-center text-muted-foreground">Only the group's initiator can edit this.</div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

/** Small avatar: profile picture, or initials derived from name/npub. */
function Avatar({ profile, seed, size = 'w-8 h-8' }: { profile: NostrProfile | null | undefined; seed: string; size?: string }) {
    const name = profile?.display_name || profile?.name || null;
    return (
        <div className={cn("rounded-full bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden", size)}>
            {profile?.picture ? (
                <CachedImg src={profile.picture} alt="" className="w-full h-full object-cover"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            ) : (
                <span className="text-primary font-bold text-[11px]">{(name || seed).toUpperCase().slice(0, 2)}</span>
            )}
        </div>
    );
}

function MessageRow({ msg, mine, profile }: { msg: ChatMsg; mine: boolean; profile: NostrProfile | null | undefined }) {
    const name = profile?.display_name || profile?.name || null;
    const npub = nip19Npub(msg.author);

    if (msg.type === 'nms-accept' || msg.type === 'nms-decline') {
        const joined = msg.type === 'nms-accept';
        return (
            <div className="flex items-center gap-2.5 w-full py-2 px-3 rounded-xl bg-secondary/30 border border-white/5">
                <Avatar profile={profile} seed={npub.slice(5, 7)} />
                <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-foreground truncate">{name || npub}</div>
                    {name && <div className="text-[10px] text-muted-foreground font-mono truncate">{npub}</div>}
                </div>
                <span className={cn("text-[11px] font-medium flex items-center gap-1 shrink-0", joined ? "text-green-500" : "text-red-500")}>
                    {joined ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                    {joined ? 'joined the group' : 'declined'}
                </span>
            </div>
        );
    }

    if (msg.type === 'nms-text') {
        if (mine) {
            return (
                <div className="flex justify-end">
                    <div className="max-w-[75%] rounded-2xl rounded-br-sm px-3 py-2 bg-primary text-primary-foreground">
                        <div className="text-sm break-words">{String(msg.content.body ?? '')}</div>
                    </div>
                </div>
            );
        }
        return (
            <div className="flex justify-start gap-2">
                <Avatar profile={profile} seed={npub.slice(5, 7)} size="w-7 h-7" />
                <div className="max-w-[75%] min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                        {name && <span className="text-[11px] font-medium text-foreground truncate">{name}</span>}
                        <span className="text-[10px] text-muted-foreground font-mono truncate">{npub}</span>
                    </div>
                    <div className="rounded-2xl rounded-bl-sm px-3 py-2 bg-secondary text-foreground">
                        <div className="text-sm break-words">{String(msg.content.body ?? '')}</div>
                    </div>
                </div>
            </div>
        );
    }

    if (msg.type === 'nms-xpub') {
        return (
            <div className="flex items-center gap-2.5 w-full py-2 px-3 rounded-xl bg-secondary/30 border border-white/5">
                <Avatar profile={profile} seed={npub.slice(5, 7)} />
                <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-foreground truncate">{name || npub}</div>
                    {name && <div className="text-[10px] text-muted-foreground font-mono truncate">{npub}</div>}
                </div>
                <span className="text-[11px] font-medium flex items-center gap-1 shrink-0 text-green-500">
                    <KeyRound className="w-3.5 h-3.5" /> shared their key
                </span>
            </div>
        );
    }

    return null;
}

/** A full-width channel line for a PSBT signature / decline / broadcast event. */
function PsbtSystemLine({ msg, profile }: { msg: ChatMsg; profile: NostrProfile | null | undefined }) {
    const name = profile?.display_name || profile?.name || null;
    const npub = nip19Npub(msg.author);
    const approved = msg.tags.find(t => t[0] === 'approved')?.[1] === 'yes';
    const txid = msg.content.txid as string | undefined;
    const label = txid ? 'broadcast the transaction' : approved ? 'signed the transaction' : 'declined the transaction';
    const color = txid ? 'text-primary' : approved ? 'text-green-500' : 'text-red-500';
    const Icon = txid ? ExternalLink : approved ? Check : X;
    return (
        <div className="flex items-center gap-2.5 w-full py-2 px-3 rounded-xl bg-secondary/30 border border-white/5">
            <Avatar profile={profile} seed={npub.slice(5, 7)} />
            <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-foreground truncate">{name || npub}</div>
                {name && <div className="text-[10px] text-muted-foreground font-mono truncate">{npub}</div>}
            </div>
            <span className={cn('text-[11px] font-medium flex items-center gap-1 shrink-0', color)}>
                <Icon className="w-3.5 h-3.5" /> {label}
            </span>
        </div>
    );
}

/** Overlapping avatar stack (up to 5, then +N), clickable. */
function AvatarStack({ pubkeys, profiles, onClick }: { pubkeys: string[]; profiles: Record<string, NostrProfile | null>; onClick: () => void }) {
    const shown = pubkeys.slice(0, 5);
    const extra = pubkeys.length - shown.length;
    return (
        <button onClick={onClick} className="flex items-center -space-x-2 cursor-pointer hover:opacity-90">
            {shown.map(pk => (
                <div key={pk} className="ring-2 ring-card rounded-full">
                    <Avatar profile={profiles[pk]} seed={pk.slice(0, 2)} size="w-6 h-6" />
                </div>
            ))}
            {extra > 0 && (
                <div className="w-6 h-6 rounded-full bg-secondary ring-2 ring-card flex items-center justify-center text-[9px] font-bold text-muted-foreground">+{extra}</div>
            )}
        </button>
    );
}

/** The interactive proposal card: details, signer/decliner avatars, sign/decline/broadcast. */
function PsbtCard({ proposal: p, ownerHex, profile, profiles, busy, onSign, onDecline, onBroadcast }: {
    proposal: Proposal;
    ownerHex: string;
    profile: NostrProfile | null | undefined;
    profiles: Record<string, NostrProfile | null>;
    busy: boolean;
    onSign: (p: Proposal) => void;
    onDecline: (p: Proposal) => void;
    onBroadcast: (p: Proposal) => void;
}) {
    const { toast } = useFeedback();
    const [copied, setCopied] = useState(false);
    const [peopleTab, setPeopleTab] = useState<'approved' | 'declined' | null>(null);

    const M = parseInt(p.summary.wallet.split('-of-')[0], 10) || 1;
    const approvers = Object.keys(p.sigs);
    const decliners = [...p.declined];
    let sigCount = approvers.length;
    try { if (approvers.length) sigCount = countSignatures(combinePsbts(Object.values(p.sigs))); } catch { /* keep raw count */ }
    const enough = sigCount >= M;
    const iSigned = !!p.sigs[ownerHex];
    const iDeclined = p.declined.has(ownerHex);
    const proposerName = profile?.display_name || profile?.name || nip19Npub(p.proposer);

    const copyAddr = () => navigator.clipboard.writeText(p.summary.recipient).then(() => {
        setCopied(true); toast('Address copied', 'success'); setTimeout(() => setCopied(false), 1500);
    });

    return (
        <div className="rounded-2xl bg-secondary/50 border border-primary/20 p-3 space-y-2.5">
            <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><Send className="w-4 h-4 text-primary" /></div>
                <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-foreground">Send {satsToBTC(p.summary.amountSats)} BTC</div>
                    <div className="text-[10px] text-muted-foreground truncate">{p.summary.wallet} · by {proposerName}</div>
                </div>
            </div>
            <div className="text-[11px] space-y-0.5">
                <div className="flex justify-between gap-2 items-center">
                    <span className="text-muted-foreground">To</span>
                    <button onClick={copyAddr} className="flex items-center gap-1 font-mono text-foreground hover:text-primary transition-colors cursor-pointer">
                        {truncAddr(p.summary.recipient)}
                        {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                    </button>
                </div>
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">Amount</span><span className="text-foreground">{p.summary.amountSats.toLocaleString()} sats</span></div>
                <div className="flex justify-between gap-2"><span className="text-muted-foreground">Fee</span><span className="text-foreground">{p.summary.feeSats.toLocaleString()} sats</span></div>
            </div>

            {/* Signer / decliner avatar groups */}
            <div className="flex items-center gap-4">
                <button onClick={() => setPeopleTab('approved')} className="flex items-center gap-1.5 cursor-pointer">
                    <span className="flex items-center gap-1 text-[11px] text-green-500 font-medium"><Check className="w-3.5 h-3.5" /> {sigCount}/{M}</span>
                    {approvers.length > 0 && <AvatarStack pubkeys={approvers} profiles={profiles} onClick={() => setPeopleTab('approved')} />}
                </button>
                {decliners.length > 0 && (
                    <button onClick={() => setPeopleTab('declined')} className="flex items-center gap-1.5 cursor-pointer">
                        <span className="flex items-center gap-1 text-[11px] text-red-500 font-medium"><X className="w-3.5 h-3.5" /> {decliners.length}</span>
                        <AvatarStack pubkeys={decliners} profiles={profiles} onClick={() => setPeopleTab('declined')} />
                    </button>
                )}
            </div>

            {p.txid ? (
                <button onClick={() => openUrl(`https://mempool.space/tx/${p.txid}`)}
                    className="w-full py-2 rounded-lg bg-green-500/15 text-green-500 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer hover:bg-green-500/25 transition-colors">
                    <ExternalLink className="w-3.5 h-3.5" /> Broadcast — view transaction
                </button>
            ) : enough ? (
                <button onClick={() => onBroadcast(p)} disabled={busy}
                    className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer hover:bg-primary/80 transition-colors disabled:opacity-50">
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Broadcast transaction
                </button>
            ) : iSigned ? (
                <div className="rounded-lg bg-green-500/10 border border-green-500/20 p-2.5 flex items-center gap-2">
                    <Check className="w-4 h-4 text-green-500 shrink-0" />
                    <span className="text-[11px] text-foreground flex-1">You signed — waiting for other members.</span>
                </div>
            ) : iDeclined ? (
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-2.5 flex items-center gap-2">
                    <X className="w-4 h-4 text-red-500 shrink-0" />
                    <span className="text-[11px] text-foreground flex-1">You declined this transaction.</span>
                    <button onClick={() => onSign(p)} disabled={busy}
                        className="text-[11px] font-semibold text-primary hover:underline cursor-pointer shrink-0 flex items-center gap-1 disabled:opacity-50">
                        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Approve instead
                    </button>
                </div>
            ) : (
                <div className="flex gap-2">
                    <button onClick={() => onSign(p)} disabled={busy}
                        className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer hover:bg-primary/80 transition-colors disabled:opacity-50">
                        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Sign
                    </button>
                    <button onClick={() => onDecline(p)} disabled={busy}
                        className="flex-1 py-2 rounded-lg bg-secondary text-muted-foreground text-xs font-semibold cursor-pointer hover:bg-secondary/80 transition-colors disabled:opacity-50">
                        Decline
                    </button>
                </div>
            )}

            {/* People modal */}
            {peopleTab && (
                <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm animate-fade-in flex items-center justify-center px-4 py-16" onClick={() => setPeopleTab(null)}>
                    <div className="bg-card border border-border rounded-2xl w-[380px] max-h-[80vh] shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
                            <h3 className="text-base font-bold">Participants</h3>
                            <button onClick={() => setPeopleTab(null)} className="text-muted-foreground hover:text-foreground cursor-pointer"><X className="w-5 h-5" /></button>
                        </div>
                        <div className="flex gap-1 p-3 shrink-0">
                            <button onClick={() => setPeopleTab('approved')} className={cn("flex-1 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer", peopleTab === 'approved' ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:bg-secondary/80")}>Approved ({approvers.length})</button>
                            <button onClick={() => setPeopleTab('declined')} className={cn("flex-1 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer", peopleTab === 'declined' ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:bg-secondary/80")}>Declined ({decliners.length})</button>
                        </div>
                        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1.5">
                            {(peopleTab === 'approved' ? approvers : decliners).map(pk => {
                                const pr = profiles[pk];
                                const nm = pr?.display_name || pr?.name || null;
                                return (
                                    <div key={pk} className="flex items-center gap-3 p-2.5 rounded-xl bg-secondary/40 border border-white/5">
                                        <Avatar profile={pr} seed={pk.slice(0, 2)} />
                                        <div className="flex-1 min-w-0">
                                            {nm && <div className="text-sm font-medium text-foreground truncate">{nm}</div>}
                                            <div className="text-[10px] text-muted-foreground font-mono truncate">{nip19Npub(pk)}</div>
                                        </div>
                                        {peopleTab === 'approved' ? <Check className="w-4 h-4 text-green-500 shrink-0" /> : <X className="w-4 h-4 text-red-500 shrink-0" />}
                                    </div>
                                );
                            })}
                            {(peopleTab === 'approved' ? approvers : decliners).length === 0 && (
                                <div className="text-center text-xs text-muted-foreground py-8">Nobody yet</div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * Censored secret display: words (mnemonic) or a single string (passphrase). Hidden by
 * default (dots), with View / Copy. The secret is passed in already-derived — it is never
 * persisted; callers recompute it on demand from the keychain secret + H.
 */
function SecretReveal({ value, mode, label, caption }: { value: string; mode: 'words' | 'text'; label?: string; caption?: string }) {
    const { toast } = useFeedback();
    const [shown, setShown] = useState(false);
    const [copied, setCopied] = useState(false);
    const words = mode === 'words' ? value.split(' ') : [];
    const copy = () => navigator.clipboard.writeText(value).then(() => {
        setCopied(true); toast('Copied', 'success'); setTimeout(() => setCopied(false), 1500);
    });
    return (
        <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-2.5 space-y-2">
            {label && <div className="text-[10px] font-medium text-amber-600 dark:text-amber-400 uppercase tracking-wider">{label}</div>}
            {mode === 'words' ? (
                <div className="grid grid-cols-3 gap-1">
                    {words.map((w, i) => (
                        <span key={i} className="text-[10px] font-mono text-foreground bg-background/50 rounded px-1.5 py-0.5">
                            <span className="text-muted-foreground">{i + 1}.</span> {shown ? w : '••••'}
                        </span>
                    ))}
                </div>
            ) : (
                <div className="text-[11px] font-mono break-all text-foreground bg-background/50 rounded px-2 py-1.5">
                    {shown ? value : '•'.repeat(Math.min(value.length, 40))}
                </div>
            )}
            {caption && <div className="text-[10px] text-muted-foreground">{caption}</div>}
            <div className="flex gap-2">
                <button onClick={() => setShown(s => !s)} className="flex-1 py-1.5 rounded-lg bg-secondary text-foreground text-[11px] font-semibold hover:bg-secondary/80 transition-colors cursor-pointer flex items-center justify-center gap-1.5">
                    {shown ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />} {shown ? 'Hide' : (mode === 'words' ? 'View words' : 'View')}
                </button>
                <button onClick={copy} className="flex-1 py-1.5 rounded-lg bg-secondary text-foreground text-[11px] font-semibold hover:bg-secondary/80 transition-colors cursor-pointer flex items-center justify-center gap-1.5">
                    {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />} Copy
                </button>
            </div>
        </div>
    );
}

// ──────────────────────────────────────────────────────────────────────────
//  Wallet setup — cosigner xpub exchange
// ──────────────────────────────────────────────────────────────────────────

function WalletSetup({ group, ownerHex, getSk, profiles, onBack, onXpubSent }: {
    group: NmsGroup;
    ownerHex: string;
    getSk: () => string | null;
    profiles: Record<string, NostrProfile | null>;
    onBack: () => void;
    onXpubSent: (x: CosignerXpub) => void;
}) {
    const { toast } = useFeedback();
    const [seedId, setSeedId] = useState<string | null | undefined>(undefined); // undefined = loading
    const [modalOpen, setModalOpen] = useState(false);
    const [tab, setTab] = useState<'current' | 'imported'>('current');
    const [deriving, setDeriving] = useState(false);
    const [derived, setDerived] = useState<{ xpub: string; fingerprint: string; path: string; mnemonic?: string; fromNsec?: boolean } | null>(null);
    const [deriveError, setDeriveError] = useState<string | null>(null);
    const [importXpub, setImportXpub] = useState('');
    const [importFp, setImportFp] = useState('');
    const [sending, setSending] = useState(false);
    const [expandedMember, setExpandedMember] = useState<string | null>(null);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [detailsMnemonic, setDetailsMnemonic] = useState<string | null>(null);
    const [detailsLoading, setDetailsLoading] = useState(false);
    const [xpubCopied, setXpubCopied] = useState<string | null>(null);

    const myXpub = group.xpubs?.[ownerHex];
    const collected = allXpubsCollected(group);
    const [setupTab, setSetupTab] = useState<'wallets' | 'keys'>(collected ? 'wallets' : 'keys');

    // When the group becomes fully set up, surface the Wallets tab as the default.
    const prevCollected = useRef(collected);
    useEffect(() => {
        if (collected && !prevCollected.current) setSetupTab('wallets');
        prevCollected.current = collected;
    }, [collected]);

    // Determine whether the active account has a seed (chooses the Current derivation path).
    // Also clear any account-specific cached secrets when the active account changes.
    useEffect(() => {
        setSeedId(undefined);
        setDetailsMnemonic(null);
        setDetailsOpen(false);
        setExpandedMember(null);
        setDerived(null);
        invoke<{ keypairs: { pubkey: string; seed_id?: string }[] }>('get_app_state')
            .then(s => {
                const kp = s.keypairs.find(k => k.pubkey === ownerHex);
                setSeedId(kp?.seed_id ?? null);
            })
            .catch(() => setSeedId(null));
    }, [ownerHex]);

    const openModal = () => {
        setDerived(null); setDeriveError(null); setImportXpub(''); setImportFp('');
        setTab('current');
        setModalOpen(true);
    };

    const copyXpub = (xpub: string, key: string) => {
        navigator.clipboard.writeText(xpub).then(() => {
            setXpubCopied(key); toast('Copied', 'success'); setTimeout(() => setXpubCopied(c => (c === key ? null : c)), 1500);
        });
    };

    // Open the owner's key-details modal; for nsec accounts, re-derive the words on demand
    // (never stored — recomputed from the keychain nsec + H).
    const openDetails = async () => {
        setDetailsOpen(true);
        if (seedId === null && !detailsMnemonic) {
            setDetailsLoading(true);
            try {
                const nsec = await invoke<string>('export_private_key_hex', { pubkey: ownerHex });
                setDetailsMnemonic(deriveCosignerXpubFromNsec(nsec, group.hHex).mnemonic);
            } catch { /* leave null */ } finally {
                setDetailsLoading(false);
            }
        }
    };

    const deriveCurrent = async () => {
        if (seedId === undefined) return; // still loading which method to use
        setDeriving(true); setDeriveError(null);
        try {
            if (seedId) {
                // Seed account: derive from the existing mnemonic with H as the passphrase.
                const mnemonic = await invoke<string>('export_seed_words', { seedId });
                setDerived({ ...deriveCosignerXpub(mnemonic, group.hHex), fromNsec: false });
            } else {
                // No seed: derive a fresh mnemonic from the nsec + H via HKDF.
                const nsec = await invoke<string>('export_private_key_hex', { pubkey: ownerHex });
                const d = deriveCosignerXpubFromNsec(nsec, group.hHex);
                setDerived({ ...d, fromNsec: true });
            }
        } catch (e) {
            setDeriveError(e instanceof Error ? e.message : 'Failed to derive key');
        } finally {
            setDeriving(false);
        }
    };

    // Derive once the modal is on the Current tab and we know which method to use.
    useEffect(() => {
        if (modalOpen && tab === 'current' && seedId !== undefined && !derived && !deriving && !deriveError) {
            deriveCurrent();
        }
    }, [modalOpen, tab, seedId]); // eslint-disable-line react-hooks/exhaustive-deps

    const doSend = async (xpub: string, fingerprint: string, path: string) => {
        const sk = getSk();
        if (!sk) { toast('Signing key unavailable', 'error'); return; }
        setSending(true);
        try {
            const ok = await sendCosignerXpub(group, sk, xpub, fingerprint, path);
            const x: CosignerXpub = { pubkey: ownerHex, npub: nip19.npubEncode(ownerHex), xpub, fingerprint, path };
            onXpubSent(x);
            // Best-effort advisory cache refresh including the new key.
            publishXpubsCache(applyXpub(group, x)).catch(() => { });
            setModalOpen(false);
            toast(ok > 0 ? 'Key shared with the group' : 'Key not delivered to any relay', ok > 0 ? 'success' : 'error');
        } catch {
            toast('Failed to send key', 'error');
        } finally {
            setSending(false);
        }
    };

    const confirmImported = () => {
        const xpub = importXpub.trim();
        if (!isValidXpub(xpub)) { toast('Invalid xpub', 'error'); return; }
        const fp = importFp.trim() || xpubFingerprint(xpub);
        doSend(xpub, fp, NMS_DERIVATION_PATH);
    };

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center gap-3 shrink-0 pb-3">
                <button onClick={onBack} className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors">
                    <ArrowLeft className="w-4.5 h-4.5 text-muted-foreground" />
                </button>
                <div className="flex-1 min-w-0">
                    <h2 className="text-base font-semibold">Wallet setup</h2>
                    <p className="text-[11px] text-muted-foreground">
                        {collected ? 'All keys collected' : `${Object.keys(group.xpubs ?? {}).length}/${group.members.length} keys shared`}
                    </p>
                </div>
            </div>

            {/* Tabs: Wallets (locked until every key is shared) / Keys */}
            <div className="flex gap-1 mb-3 shrink-0 bg-secondary/30 rounded-xl p-1">
                <button onClick={() => collected && setSetupTab('wallets')} disabled={!collected}
                    className={cn("flex-1 py-2 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5",
                        setupTab === 'wallets' && collected ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                        collected ? "cursor-pointer hover:text-foreground" : "opacity-40 cursor-not-allowed")}>
                    {!collected && <Lock className="w-3 h-3" />} Wallets
                </button>
                <button onClick={() => setSetupTab('keys')}
                    className={cn("flex-1 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer",
                        setupTab === 'keys' || !collected ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                    Keys
                </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pb-4">
                {setupTab === 'wallets' && collected ? (
                    <div className="space-y-2">
                        {Array.from({ length: group.members.length }, (_, i) => i + 1).map(m => (
                            <WalletCard key={m} keys={cosignerList(group)} m={m} n={group.members.length} group={group} ownerHex={ownerHex} getSk={getSk} />
                        ))}
                    </div>
                ) : (
                  <>
                {/* Your key status / action */}
                {!myXpub ? (
                    <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30">
                        <div className="flex items-center gap-2 mb-1.5">
                            <KeyRound className="w-4 h-4 text-amber-500" />
                            <span className="text-sm font-semibold text-foreground">You haven't shared your key</span>
                        </div>
                        <p className="text-[11px] text-muted-foreground mb-2.5">
                            Each member contributes an xpub so the group's wallets can be built. Your key is derived
                            with a group-specific passphrase, isolated from your main wallet.
                        </p>
                        <button onClick={openModal}
                            className="w-full py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/80 transition-colors cursor-pointer flex items-center justify-center gap-1.5">
                            <Send className="w-3.5 h-3.5" /> Send your key
                        </button>
                    </div>
                ) : (
                    <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/30 flex items-center gap-2">
                        <Check className="w-4 h-4 text-green-500 shrink-0" />
                        <span className="text-xs text-foreground flex-1">Your key is shared with the group.</span>
                        <button onClick={openDetails} className="text-[11px] font-semibold text-primary hover:underline cursor-pointer shrink-0">View details</button>
                    </div>
                )}

                {/* Per-member key status — tap a shared key to reveal its xpub */}
                <div className="space-y-1.5">
                    <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-1">Keys</div>
                    {group.members.map(m => {
                        const profile = profiles[m.pubkey];
                        const name = profile?.display_name || profile?.name || null;
                        const entry = group.xpubs?.[m.pubkey];
                        const has = !!entry;
                        const open = expandedMember === m.pubkey;
                        return (
                            <div key={m.pubkey} className="rounded-xl bg-secondary/40 border border-white/5 overflow-hidden">
                                <button
                                    onClick={() => has && setExpandedMember(open ? null : m.pubkey)}
                                    className={cn("w-full flex items-center gap-3 p-2.5 text-left", has ? "cursor-pointer hover:bg-secondary/20 transition-colors" : "cursor-default")}>
                                    <Avatar profile={profile} seed={m.npub.slice(5, 7)} />
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm text-foreground truncate">{name || `${m.npub.slice(0, 12)}…${m.npub.slice(-6)}`}</div>
                                        {has && <div className="text-[10px] text-muted-foreground font-mono truncate">{entry.xpub.slice(0, 18)}…</div>}
                                    </div>
                                    {has
                                        ? <span className="text-[11px] text-green-500 font-medium flex items-center gap-1 shrink-0"><Check className="w-3.5 h-3.5" /> Shared <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", open && "rotate-180")} /></span>
                                        : <span className="text-[11px] text-muted-foreground flex items-center gap-1 shrink-0"><Clock className="w-3.5 h-3.5" /> Waiting</span>}
                                </button>
                                {open && entry && (
                                    <div className="px-2.5 pb-2.5 border-t border-white/5 pt-2 space-y-1.5">
                                        <div className="text-[10px] text-muted-foreground">xpub · fingerprint {entry.fingerprint || '—'}</div>
                                        <button onClick={() => copyXpub(entry.xpub, m.pubkey)}
                                            className="flex items-start gap-1.5 text-[10px] font-mono text-foreground hover:text-primary transition-colors cursor-pointer text-left w-full">
                                            <span className="break-all flex-1">{entry.xpub}</span>
                                            {xpubCopied === m.pubkey ? <Check className="w-3 h-3 text-green-500 shrink-0 mt-0.5" /> : <Copy className="w-3 h-3 shrink-0 mt-0.5" />}
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
                    </>
                )}
            </div>

            {/* Send-key modal */}
            {modalOpen && (
                <div className="fixed inset-0 z-[55] bg-black/60 backdrop-blur-sm animate-fade-in flex items-center justify-center px-4 py-20">
                    <div className="bg-card border border-border rounded-2xl w-[400px] max-h-[80vh] shadow-2xl flex flex-col">
                        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
                            <h3 className="text-base font-bold flex items-center gap-2"><KeyRound className="w-4.5 h-4.5 text-primary" /> Share your key</h3>
                            <button onClick={() => setModalOpen(false)} className="text-muted-foreground hover:text-foreground cursor-pointer"><X className="w-5 h-5" /></button>
                        </div>

                        {/* Tabs */}
                        <div className="flex gap-1 p-3 shrink-0">
                            <button onClick={() => setTab('current')}
                                className={cn("flex-1 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer",
                                    tab === 'current' ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:bg-secondary/80")}>
                                Current
                            </button>
                            <button onClick={() => setTab('imported')}
                                className={cn("flex-1 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer",
                                    tab === 'imported' ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:bg-secondary/80")}>
                                Imported
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto px-4 pb-4">
                            {tab === 'current' ? (
                                <div className="space-y-3">
                                    <p className="text-[11px] text-muted-foreground">
                                        {derived?.fromNsec
                                            ? <>Your account has no seed, so a dedicated key is derived from your account key + this group's secret on <span className="font-mono">{NMS_DERIVATION_PATH}</span>. Back up the words below to recover independently.</>
                                            : <>Derived from your seed with this group's passphrase on <span className="font-mono">{NMS_DERIVATION_PATH}</span>. Your main wallet is untouched.</>}
                                    </p>
                                    {deriving ? (
                                        <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
                                    ) : deriveError ? (
                                        <div className="text-xs text-red-500 py-4 text-center">{deriveError}</div>
                                    ) : derived ? (
                                        <div className="space-y-2">
                                            <div className="p-3 rounded-xl bg-secondary/50 border border-white/5">
                                                <div className="text-[10px] text-muted-foreground mb-1">xpub · fingerprint {derived.fingerprint}</div>
                                                <div className="text-[11px] font-mono break-all text-foreground">{derived.xpub}</div>
                                            </div>

                                            {/* Backup words — only for the nsec-derived path */}
                                            {derived.fromNsec && derived.mnemonic && (
                                                <SecretReveal value={derived.mnemonic} mode="words" label="24-word backup"
                                                    caption="Write these down — they recover your share of this wallet." />
                                            )}

                                            <button onClick={() => doSend(derived.xpub, derived.fingerprint, derived.path)} disabled={sending}
                                                className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/80 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5">
                                                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Confirm & send
                                            </button>
                                        </div>
                                    ) : null}
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <p className="text-[11px] text-muted-foreground">
                                        Paste an account-level xpub on a P2WSH multisig path. Provide its master fingerprint if you have it (needed for correct multisig recovery).
                                    </p>
                                    <textarea value={importXpub} onChange={e => setImportXpub(e.target.value)} placeholder="xpub…" rows={3}
                                        className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-xs font-mono focus:ring-2 focus:ring-primary outline-none resize-none" />
                                    <input value={importFp} onChange={e => setImportFp(e.target.value)} placeholder="Master fingerprint (optional, 8 hex)"
                                        className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-xs font-mono focus:ring-2 focus:ring-primary outline-none" />
                                    <button onClick={confirmImported} disabled={sending || !importXpub.trim()}
                                        className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/80 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5">
                                        {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Confirm & send
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Key-details modal (owner) */}
            {detailsOpen && myXpub && (
                <div className="fixed inset-0 z-[55] bg-black/60 backdrop-blur-sm animate-fade-in flex items-center justify-center px-4 py-20">
                    <div className="bg-card border border-border rounded-2xl w-[400px] max-h-[80vh] shadow-2xl flex flex-col">
                        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
                            <h3 className="text-base font-bold flex items-center gap-2"><KeyRound className="w-4.5 h-4.5 text-primary" /> Key details</h3>
                            <button onClick={() => setDetailsOpen(false)} className="text-muted-foreground hover:text-foreground cursor-pointer"><X className="w-5 h-5" /></button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-3">
                            <div>
                                <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider">xpub · fingerprint {myXpub.fingerprint || '—'}</div>
                                <button onClick={() => copyXpub(myXpub.xpub, '__self__')}
                                    className="flex items-start gap-1.5 w-full text-left p-2.5 rounded-xl bg-secondary/50 border border-white/5 text-[11px] font-mono text-foreground hover:text-primary transition-colors cursor-pointer">
                                    <span className="break-all flex-1">{myXpub.xpub}</span>
                                    {xpubCopied === '__self__' ? <Check className="w-3.5 h-3.5 text-green-500 shrink-0" /> : <Copy className="w-3.5 h-3.5 shrink-0" />}
                                </button>
                            </div>

                            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Recovery</div>
                            {seedId === null ? (
                                detailsLoading ? (
                                    <div className="flex items-center justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
                                ) : detailsMnemonic ? (
                                    <SecretReveal value={detailsMnemonic} mode="words" label="24-word backup"
                                        caption="Recovers your share independently — recomputed from your account key, never stored." />
                                ) : (
                                    <div className="text-xs text-muted-foreground py-2">Could not load backup words.</div>
                                )
                            ) : (
                                <SecretReveal value={group.hHex} mode="text" label="Recovery passphrase"
                                    caption="Recover in any BIP48 wallet with your DENOS seed + this passphrase (m/48'/0'/0'/2')." />
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

/** One threshold's wallet: balance, receive address (lazy-scanned), send, history, descriptor export. */
function WalletCard({ keys, m, n, group, ownerHex, getSk }: { keys: CosignerXpub[]; m: number; n: number; group: NmsGroup; ownerHex: string; getSk: () => string | null }) {
    const { toast } = useFeedback();
    const [scan, setScan] = useState<WalletScan | null>(null);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const [expanded, setExpanded] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);
    const [qrFull, setQrFull] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [history, setHistory] = useState<NmsTx[] | null>(null);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [addressesOpen, setAddressesOpen] = useState(false);
    const [addrTab, setAddrTab] = useState<'receive' | 'change'>('receive');
    const [sendOpen, setSendOpen] = useState(false);
    const [recipient, setRecipient] = useState('');
    const [amount, setAmount] = useState('');
    const [feeRate, setFeeRate] = useState(2);
    const [feeRates, setFeeRates] = useState<FeeRates | null>(null);
    const [proposing, setProposing] = useState(false);

    useEffect(() => { if (sendOpen) getFeeRates().then(f => { setFeeRates(f); setFeeRate(f.halfHourFee); }).catch(() => { }); }, [sendOpen]);

    const propose = async () => {
        const sk = getSk();
        if (!sk || !scan) { toast('Not ready', 'error'); return; }
        let addr = recipient.trim();
        try { if (addr.startsWith('npub1')) addr = npubToTaprootAddress(addr); } catch { toast('Invalid npub', 'error'); return; }
        if (!addr) { toast('Enter a recipient', 'error'); return; }
        const amountSats = btcToSats(parseFloat(amount));
        if (!amountSats || amountSats <= 0) { toast('Enter a valid amount', 'error'); return; }
        setProposing(true);
        try {
            const utxos = await fetchWalletUtxos(scan);
            const sel = selectUtxos(utxos, amountSats, feeRate, m, n);
            if (!sel) { toast('Insufficient funds for amount + fee', 'error'); setProposing(false); return; }
            const changeAddr = scan.change.find(a => !a.used)?.address ?? deriveMultisigAddress(keys, m, 1, scan.change.length);
            const built = buildMultisigPsbt({ keys, m, utxos: sel.selected, recipient: addr, amountSats, feeSats: sel.feeSats, changeAddress: changeAddr });
            const account = await deriveMyAccount(ownerHex, group.hHex);
            const myFp = group.xpubs?.[ownerHex]?.fingerprint ?? '';
            const signed = signMultisigPsbt(built.psbtBase64, account, myFp);
            await sendPsbtProposal(group, sk, crypto.randomUUID(), signed, { recipient: addr, amountSats, feeSats: sel.feeSats, wallet: `${m}-of-${n}` });
            toast('Proposal sent — review & sign in the group chat', 'success');
            setSendOpen(false); setRecipient(''); setAmount('');
        } catch (e) {
            toast(e instanceof Error ? e.message : 'Failed to create proposal', 'error');
        } finally { setProposing(false); }
    };

    const load = useCallback(() => {
        setLoading(true); setErr(null);
        scanWallet(keys, m).then(setScan).catch(() => setErr('Failed to load balance')).finally(() => setLoading(false));
    }, [keys, m]);

    useEffect(() => { load(); }, [load]);

    const copy = (text: string, key: string) => {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(key); toast('Copied', 'success');
            setTimeout(() => setCopied(c => (c === key ? null : c)), 1500);
        });
    };

    const openHistory = () => {
        setHistoryOpen(true);
        if (!history && scan) {
            setHistoryLoading(true);
            fetchWalletHistory(scan.usedAddresses).then(setHistory).catch(() => setHistory([])).finally(() => setHistoryLoading(false));
        }
    };

    const warn = m === n ? `All ${n} members must sign — one lost key locks funds permanently.`
        : m === 1 ? 'Any single member can spend the entire balance.'
            : null;

    return (
        <div className="rounded-xl bg-secondary/40 border border-white/5 overflow-hidden">
            <button onClick={() => setExpanded(e => !e)} className="w-full flex items-center gap-3 p-3 text-left cursor-pointer hover:bg-secondary/20 transition-colors">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                    <Shield className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-foreground">{m}-of-{n} multisig</div>
                    <div className="text-[11px] text-muted-foreground">
                        {loading ? 'Loading balance…' : err ? <span className="text-red-500">{err}</span> : `${satsToBTC(scan?.balance ?? 0)} BTC`}
                    </div>
                </div>
                {loading
                    ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />
                    : <ChevronDown className={cn("w-4 h-4 text-muted-foreground shrink-0 transition-transform", expanded && "rotate-180")} />}
            </button>

            {expanded && (
                <div className="px-3 pb-3 space-y-3 border-t border-white/5 pt-3">
                    {warn && (
                        <div className="flex items-start gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                            <span className="text-[10px] text-amber-600 dark:text-amber-400">{warn}</span>
                        </div>
                    )}

                    {scan && (
                        <div className="flex flex-col items-center gap-2">
                            <button onClick={() => setQrFull(true)} title="Tap to enlarge" className="bg-white p-2 rounded-lg cursor-pointer hover:ring-2 hover:ring-primary/40 transition-all">
                                <QRCodeSVG value={scan.nextReceiveAddress} size={120} />
                            </button>
                            <div className="text-[10px] text-muted-foreground">Receive address #{scan.nextReceiveIndex} · tap QR to enlarge</div>
                            <button onClick={() => copy(scan.nextReceiveAddress, 'addr')}
                                className="flex items-center gap-1.5 text-[11px] font-mono text-foreground hover:text-primary transition-colors cursor-pointer max-w-full">
                                <span>{truncAddr(scan.nextReceiveAddress)}</span>
                                {copied === 'addr' ? <Check className="w-3 h-3 text-green-500 shrink-0" /> : <Copy className="w-3 h-3 shrink-0" />}
                            </button>
                        </div>
                    )}

                    <div className="flex gap-2">
                        <button onClick={() => setSendOpen(true)}
                            className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/80 transition-colors cursor-pointer flex items-center justify-center gap-1.5">
                            <Send className="w-3.5 h-3.5" /> Send
                        </button>
                        <button onClick={openHistory}
                            className="flex-1 py-2 rounded-lg bg-secondary text-foreground text-xs font-semibold hover:bg-secondary/80 transition-colors cursor-pointer flex items-center justify-center gap-1.5">
                            <History className="w-3.5 h-3.5" /> History
                        </button>
                    </div>
                    <div className="flex gap-2">
                        <button onClick={() => setAddressesOpen(true)} disabled={!scan}
                            className="flex-1 py-2 rounded-lg bg-secondary text-foreground text-xs font-semibold hover:bg-secondary/80 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5">
                            <List className="w-3.5 h-3.5" /> Addresses
                        </button>
                        <button onClick={() => copy(buildDescriptor(keys, m), 'desc')}
                            className="flex-1 py-2 rounded-lg bg-secondary text-foreground text-xs font-semibold hover:bg-secondary/80 transition-colors cursor-pointer flex items-center justify-center gap-1.5">
                            {copied === 'desc' ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />} Descriptor
                        </button>
                    </div>
                    <button onClick={load} className="w-full text-[11px] text-muted-foreground hover:text-foreground flex items-center justify-center gap-1.5 cursor-pointer">
                        <RefreshCw className="w-3 h-3" /> Refresh balance
                    </button>
                </div>
            )}

            {/* Fullscreen QR */}
            {qrFull && scan && (
                <div onClick={() => setQrFull(false)} className="fixed inset-0 z-[60] bg-black/90 flex flex-col items-center justify-center gap-5 cursor-pointer p-6 animate-fade-in">
                    <div className="bg-white p-5 rounded-2xl"><QRCodeSVG value={scan.nextReceiveAddress} size={280} /></div>
                    <div className="text-white text-xs font-mono break-all text-center max-w-[320px]">{scan.nextReceiveAddress}</div>
                    <div className="text-white/50 text-[11px]">Tap anywhere to close</div>
                </div>
            )}

            {/* History modal */}
            {historyOpen && (
                <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm animate-fade-in flex items-center justify-center px-4 py-16">
                    <div className="bg-card border border-border rounded-2xl w-[400px] max-h-[85vh] shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
                            <h3 className="text-base font-bold flex items-center gap-2"><History className="w-4.5 h-4.5 text-primary" /> {m}-of-{n} history</h3>
                            <button onClick={() => setHistoryOpen(false)} className="text-muted-foreground hover:text-foreground cursor-pointer"><X className="w-5 h-5" /></button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
                            {historyLoading ? (
                                <div className="flex items-center justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
                            ) : !history || history.length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
                                    <History className="w-8 h-8 opacity-30" />
                                    <p className="text-sm">No transactions yet</p>
                                </div>
                            ) : history.map(tx => <TxRow key={tx.txid} tx={tx} onCopy={copy} copied={copied} />)}
                        </div>
                    </div>
                </div>
            )}

            {/* Addresses page */}
            {addressesOpen && scan && (
                <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm animate-fade-in flex items-center justify-center px-4 py-16">
                    <div className="bg-card border border-border rounded-2xl w-[400px] max-h-[85vh] shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-3 p-4 border-b border-border shrink-0">
                            <button onClick={() => setAddressesOpen(false)} className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors">
                                <ArrowLeft className="w-4.5 h-4.5 text-muted-foreground" />
                            </button>
                            <h3 className="text-base font-bold flex-1">Addresses</h3>
                        </div>
                        <div className="flex gap-1 p-3 shrink-0">
                            {(['receive', 'change'] as const).map(t => (
                                <button key={t} onClick={() => setAddrTab(t)}
                                    className={cn("flex-1 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer capitalize",
                                        addrTab === t ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:bg-secondary/80")}>
                                    {t} <span className="opacity-60">({(t === 'receive' ? scan.receive : scan.change).length})</span>
                                </button>
                            ))}
                        </div>
                        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1.5">
                            {(addrTab === 'receive' ? scan.receive : scan.change).map(a => (
                                <div key={a.address} className="flex items-center gap-2.5 p-2.5 rounded-xl bg-secondary/40 border border-white/5">
                                    <span className="text-[10px] text-muted-foreground font-mono w-7 shrink-0">#{a.index}</span>
                                    <button onClick={() => copy(a.address, a.address)}
                                        className="flex-1 min-w-0 flex items-center gap-1.5 text-[11px] font-mono text-foreground hover:text-primary transition-colors cursor-pointer text-left">
                                        <span>{truncAddr(a.address)}</span>
                                        {copied === a.address ? <Check className="w-3 h-3 text-green-500 shrink-0" /> : <Copy className="w-3 h-3 shrink-0" />}
                                    </button>
                                    {a.balance > 0
                                        ? <span className="text-[10px] text-green-500 font-medium shrink-0">{satsToBTC(a.balance)}</span>
                                        : <span className={cn("text-[10px] shrink-0", a.used ? "text-muted-foreground" : "text-muted-foreground/50")}>{a.used ? 'used' : 'unused'}</span>}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Send / propose modal */}
            {sendOpen && (
                <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm animate-fade-in flex items-center justify-center px-4 py-16">
                    <div className="bg-card border border-border rounded-2xl w-[400px] max-h-[85vh] shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
                            <h3 className="text-base font-bold flex items-center gap-2"><Send className="w-4.5 h-4.5 text-primary" /> Send from {m}-of-{n}</h3>
                            <button onClick={() => setSendOpen(false)} className="text-muted-foreground hover:text-foreground cursor-pointer"><X className="w-5 h-5" /></button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-3">
                            <div className="text-[11px] text-muted-foreground">Balance: {satsToBTC(scan?.balance ?? 0)} BTC</div>
                            <div>
                                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Recipient (address or npub)</label>
                                <textarea value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="bc1q… or npub1…" rows={2}
                                    className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-xs font-mono focus:ring-2 focus:ring-primary outline-none resize-none" />
                                {recipient.trim().startsWith('npub1') && <div className="text-[10px] text-muted-foreground mt-1">→ derives the recipient's Taproot address</div>}
                            </div>
                            <div>
                                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Amount (BTC)</label>
                                <input value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.001" inputMode="decimal"
                                    className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-sm focus:ring-2 focus:ring-primary outline-none" />
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-xs font-medium text-muted-foreground block">Fee rate: {feeRate} sat/vB</label>
                                {feeRates && (
                                    <div className="grid grid-cols-3 gap-1.5">
                                        {[
                                            { label: 'Economy', rate: feeRates.economyFee },
                                            { label: 'Normal', rate: feeRates.hourFee },
                                            { label: 'Fast', rate: feeRates.fastestFee },
                                        ].map(({ label, rate }) => (
                                            <button key={label} onClick={() => setFeeRate(rate)}
                                                className={cn("py-1.5 px-2 rounded-lg text-center transition-colors cursor-pointer border",
                                                    feeRate === rate ? "bg-primary/10 border-primary/30 text-primary" : "bg-secondary border-transparent text-muted-foreground hover:text-foreground")}>
                                                <div className="text-[10px] font-medium">{label}</div>
                                                <div className="text-xs font-bold">{rate}</div>
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <input type="range" min={1} max={Math.max(50, feeRates?.fastestFee ?? 50)} value={feeRate} onChange={e => setFeeRate(parseInt(e.target.value, 10))} className="w-full accent-primary cursor-pointer" />
                            </div>
                            <div className="rounded-lg bg-secondary/40 border border-white/5 p-2.5 text-[10px] text-muted-foreground">
                                You'll sign first, then the proposal goes to the group chat where {m - 1} more member{m - 1 !== 1 ? 's' : ''} must sign before it can be broadcast.
                            </div>
                            <button onClick={propose} disabled={proposing || !recipient.trim() || !amount.trim()}
                                className="w-full py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/80 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5">
                                {proposing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Sign & propose
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

/** A transaction row in the wallet history; expands to show txid + explorer link. */
function TxRow({ tx, onCopy, copied }: { tx: NmsTx; onCopy: (text: string, key: string) => void; copied: string | null }) {
    const [open, setOpen] = useState(false);
    const incoming = tx.delta >= 0;
    const date = tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleString() : 'Pending';
    return (
        <div className="rounded-xl bg-secondary/40 border border-white/5 overflow-hidden">
            <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-3 p-2.5 text-left cursor-pointer hover:bg-secondary/20 transition-colors">
                <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0", incoming ? "bg-green-500/15" : "bg-red-500/15")}>
                    {incoming ? <ArrowDownLeft className="w-4 h-4 text-green-500" /> : <ArrowUpRight className="w-4 h-4 text-red-500" />}
                </div>
                <div className="flex-1 min-w-0">
                    <div className={cn("text-sm font-semibold", incoming ? "text-green-500" : "text-foreground")}>
                        {incoming ? '+' : '−'}{satsToBTC(Math.abs(tx.delta))} BTC
                    </div>
                    <div className="text-[10px] text-muted-foreground">{date}{!tx.confirmed && ' · unconfirmed'}</div>
                </div>
                <ChevronDown className={cn("w-4 h-4 text-muted-foreground shrink-0 transition-transform", open && "rotate-180")} />
            </button>
            {open && (
                <div className="px-2.5 pb-2.5 border-t border-white/5 pt-2 space-y-1.5">
                    <div className="text-[10px] text-muted-foreground">Transaction ID</div>
                    <button onClick={() => onCopy(tx.txid, tx.txid)}
                        className="flex items-start gap-1.5 text-[10px] font-mono text-foreground hover:text-primary transition-colors cursor-pointer text-left w-full">
                        <span className="break-all flex-1">{tx.txid}</span>
                        {copied === tx.txid ? <Check className="w-3 h-3 text-green-500 shrink-0 mt-0.5" /> : <Copy className="w-3 h-3 shrink-0 mt-0.5" />}
                    </button>
                    {tx.fee > 0 && <div className="text-[10px] text-muted-foreground">Fee: {tx.fee.toLocaleString()} sats</div>}
                    <button onClick={() => openUrl(`https://mempool.space/tx/${tx.txid}`)}
                        className="flex items-center gap-1.5 text-[11px] text-primary font-semibold hover:underline cursor-pointer">
                        <ExternalLink className="w-3 h-3" /> View on mempool.space
                    </button>
                </div>
            )}
        </div>
    );
}

// ──────────────────────────────────────────────────────────────────────────
//  Members panel
// ──────────────────────────────────────────────────────────────────────────

function MembersPanel({ group, isInitiator, reinviting, onReinvite, onBack }: {
    group: NmsGroup;
    isInitiator: boolean;
    reinviting: string | null;
    onReinvite: (memberHex: string) => void;
    onBack: () => void;
}) {
    const { toast } = useFeedback();
    const [profiles, setProfiles] = useState<Record<string, NostrProfile | null>>({});
    const [copied, setCopied] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        group.members.forEach(m => {
            if (m.pubkey in profiles) return;
            fetchNostrProfile(m.pubkey)
                .then(p => { if (!cancelled) setProfiles(prev => ({ ...prev, [m.pubkey]: p })); })
                .catch(() => { if (!cancelled) setProfiles(prev => ({ ...prev, [m.pubkey]: null })); });
        });
        return () => { cancelled = true; };
    }, [group.groupNpub]); // eslint-disable-line react-hooks/exhaustive-deps

    const copyNpub = (npub: string, key: string) => {
        navigator.clipboard.writeText(npub).then(() => {
            setCopied(key);
            toast('npub copied', 'success');
            setTimeout(() => setCopied(c => (c === key ? null : c)), 1500);
        });
    };

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center gap-3 shrink-0 pb-3">
                <button onClick={onBack}
                    className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors">
                    <ArrowLeft className="w-4.5 h-4.5 text-muted-foreground" />
                </button>
                <div className="flex-1 min-w-0">
                    <h2 className="text-base font-semibold truncate">Members</h2>
                    <p className="text-[11px] text-muted-foreground">{group.members.length} participants</p>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pb-4">
                {/* Group channel npub — the shared NIP-17 address everyone messages */}
                <div className="p-3 rounded-xl bg-primary/5 border border-primary/20">
                    <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Group channel</div>
                    <button onClick={() => copyNpub(group.groupNpub, '__group__')}
                        className="flex items-center gap-2 w-full text-left text-[11px] text-foreground font-mono hover:text-primary transition-colors cursor-pointer">
                        <span className="truncate">{group.groupNpub}</span>
                        {copied === '__group__' ? <Check className="w-3.5 h-3.5 text-green-500 shrink-0" /> : <Copy className="w-3.5 h-3.5 shrink-0" />}
                    </button>
                    <div className="text-[10px] text-muted-foreground/70 mt-1">The npub all members message for this group.</div>
                </div>

                <div className="border-t border-white/5 my-1" />

                {group.members.map(m => {
                    const profile = profiles[m.pubkey];
                    const name = profile?.display_name || profile?.name || null;
                    const meta = statusMeta[m.status];
                    const canReinvite = isInitiator && (m.status === 'invited' || m.status === 'declined');
                    const busy = reinviting === m.pubkey;
                    return (
                        <div key={m.pubkey} className="p-3 rounded-xl bg-secondary/40 border border-white/5">
                            <div className="flex items-center gap-3">
                                <div className="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
                                    {profile?.picture ? (
                                        <CachedImg src={profile.picture} alt="" className="w-full h-full object-cover"
                                            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                    ) : (
                                        <span className="text-primary font-bold text-sm">{(name || m.npub.slice(5, 7)).toUpperCase().slice(0, 2)}</span>
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    {name && <div className="text-sm font-semibold text-foreground truncate">{name}</div>}
                                    <button onClick={() => copyNpub(m.npub, m.pubkey)}
                                        className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono hover:text-foreground transition-colors cursor-pointer">
                                        {m.npub.slice(0, 12)}…{m.npub.slice(-6)}
                                        {copied === m.pubkey ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                                    </button>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                    <meta.Icon className={cn("w-3.5 h-3.5", meta.cls)} />
                                    <span className={cn("text-[10px] font-medium", meta.cls)}>{meta.label}</span>
                                </div>
                            </div>
                            {canReinvite && (
                                <button onClick={() => onReinvite(m.pubkey)} disabled={busy}
                                    className="mt-2.5 w-full py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-semibold hover:bg-primary/20 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5">
                                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                                    Reinvite
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ──────────────────────────────────────────────────────────────────────────
//  Invites page
// ──────────────────────────────────────────────────────────────────────────

function InvitesPage({ invites, busyInvite, onAccept, onDecline, onBack }: {
    invites: NmsInvite[];
    busyInvite: string | null;
    onAccept: (inv: NmsInvite) => void;
    onDecline: (inv: NmsInvite) => void;
    onBack: () => void;
}) {
    const { toast } = useFeedback();
    const [profiles, setProfiles] = useState<Record<string, NostrProfile | null>>({});
    const [copied, setCopied] = useState<string | null>(null);

    // Fetch inviter profiles.
    useEffect(() => {
        let cancelled = false;
        const missing = invites.map(i => i.initiator).filter(hex => !(hex in profiles));
        missing.forEach(hex => {
            fetchNostrProfile(hex)
                .then(p => { if (!cancelled) setProfiles(prev => ({ ...prev, [hex]: p })); })
                .catch(() => { if (!cancelled) setProfiles(prev => ({ ...prev, [hex]: null })); });
        });
        return () => { cancelled = true; };
    }, [invites]); // eslint-disable-line react-hooks/exhaustive-deps

    const copyNpub = (hex: string) => {
        const npub = (() => { try { return nip19.npubEncode(hex); } catch { return hex; } })();
        navigator.clipboard.writeText(npub).then(() => {
            setCopied(hex);
            toast('npub copied', 'success');
            setTimeout(() => setCopied(c => (c === hex ? null : c)), 1500);
        });
    };

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center gap-3 shrink-0 pb-3">
                <button onClick={onBack}
                    className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors">
                    <ArrowLeft className="w-4.5 h-4.5 text-muted-foreground" />
                </button>
                <div className="flex-1 min-w-0">
                    <h2 className="text-base font-semibold">Invitations</h2>
                    <p className="text-[11px] text-muted-foreground">{invites.length} pending</p>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2.5 pb-4">
                {invites.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center gap-2 text-muted-foreground">
                        <UserPlus className="w-8 h-8 opacity-30" />
                        <p className="text-sm">No pending invitations</p>
                    </div>
                ) : invites.map(inv => {
                    const profile = profiles[inv.initiator];
                    const name = profile?.display_name || profile?.name || null;
                    const npub = nip19Npub(inv.initiator);
                    const busy = busyInvite === inv.groupNpub;
                    return (
                        <div key={inv.groupNpub} className="p-3.5 rounded-xl bg-primary/5 border border-primary/20">
                            <div className="flex items-center gap-3 mb-3">
                                <div className="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
                                    {profile?.picture ? (
                                        <CachedImg src={profile.picture} alt="" className="w-full h-full object-cover"
                                            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                    ) : (
                                        <span className="text-primary font-bold text-sm">{(name || npub.slice(5, 7)).toUpperCase().slice(0, 2)}</span>
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    {name && <div className="text-sm font-semibold text-foreground truncate">{name}</div>}
                                    <button onClick={() => copyNpub(inv.initiator)}
                                        className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono hover:text-foreground transition-colors cursor-pointer">
                                        {npub}
                                        {copied === inv.initiator ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                                    </button>
                                    <div className="text-[10px] text-muted-foreground/70 mt-0.5">{inv.members.length}-participant group</div>
                                </div>
                            </div>
                            <div className="flex gap-2">
                                <button onClick={() => onAccept(inv)} disabled={busy}
                                    className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/80 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5">
                                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Accept
                                </button>
                                <button onClick={() => onDecline(inv)} disabled={busy}
                                    className="flex-1 py-2 rounded-lg bg-secondary text-muted-foreground text-xs font-semibold hover:bg-secondary/80 transition-colors cursor-pointer disabled:opacity-50">
                                    Decline
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
