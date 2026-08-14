/**
 * NIP-NBMS — Phase 2: group creation, bootstrap & consent.
 *
 * Orchestration on top of the channel primitives in nbms.ts:
 *   - Initiator computes H, derives the group keypair, sends NIP-17 invites carrying H.
 *   - Invitees parse/verify the invite and accept or decline over the channel.
 *   - The group npub publishes an encrypted kind:0 membership record.
 *   - Each member backs up its groups + H in a personal NIP-78 `nbmsgc` event.
 *
 * Network publish/fetch is kept separate from the pure builders so the protocol logic
 * is testable without relays. See docs/NIP-NBMS.md.
 */
import { nip19, nip59, finalizeEvent, type Event } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
    computeGroupSecret, deriveGroupKeypair, wrapGroupMessage, encryptToSelf, decryptToSelf,
    backupOwnWrap, deriveBackupKeypair, publishToRelays, NBMS_DEFAULT_RELAYS,
    KIND_GROUP_META, KIND_APP_DATA, KIND_GIFT_WRAP, DTAG_GROUP_INDEX, DTAG_XPUBS, TAG_XPUB, TAG_PSBT, TAG_APPROVED,
    type GroupKeypair, type NbmsUnwrapped,
} from './nbms';

// ── Types ──

export type MemberStatus = 'initiator' | 'invited' | 'accepted' | 'declined';

export interface NbmsMember {
    pubkey: string; // hex
    npub: string;
    status: MemberStatus;
}

export type GroupRole = 'initiator' | 'member';

/** A member's contributed cosigner key, bound to the member by their inner-signed message. */
export interface CosignerXpub {
    pubkey: string; // hex — the contributing member
    npub: string;
    xpub: string;
    fingerprint: string;
    path: string;
}

/** Group identity, NIP-44 self-encrypted in the group's kind:0 (only members can read). */
export interface GroupProfile {
    name?: string;
    picture?: string;
    about?: string;
}

export interface NbmsGroup {
    groupNpub: string;
    groupPubkey: string; // hex
    hHex: string;        // group secret (local + nbmsgc backup)
    initiator: string;   // hex pubkey
    members: NbmsMember[];
    role: GroupRole;
    label?: string;
    createdAt: number;
    /** Verified cosigner xpubs collected from signed nbms-xpub messages, keyed by member pubkey. */
    xpubs?: Record<string, CosignerXpub>;
    /** Encrypted group identity (name/picture/about) from the group kind:0. */
    profile?: GroupProfile;
}

export interface NbmsInvite {
    groupNpub: string;
    groupPubkey: string; // hex
    initiator: string;   // hex
    members: string[];   // hex pubkeys (incl. initiator)
    hHex: string;
    createdAt: number;
}

const hexToNpub = (hex: string) => nip19.npubEncode(hex);
function npubToHex(npub: string): string {
    const d = nip19.decode(npub);
    if (d.type !== 'npub') throw new Error('NBMS: expected npub');
    return d.data as string;
}

// ──────────────────────────────────────────────────────────────────────────
//  Invites (standard NIP-17 → each member's personal npub, carrying H)
// ──────────────────────────────────────────────────────────────────────────

/** Build the invite gift wrap for one member (standard NIP-17, ephemeral sender). */
export function buildInviteWrap(invite: NbmsInvite, initiatorSkHex: string, memberPubHex: string): Event {
    const rumor = {
        kind: 14,
        created_at: invite.createdAt,
        tags: [],
        content: JSON.stringify({
            type: 'nbms-invite',
            group_npub: invite.groupNpub,
            initiator: hexToNpub(invite.initiator),
            members: invite.members.map(hexToNpub),
            h: invite.hHex,
            created_at: invite.createdAt,
        }),
    };
    return nip59.wrapEvent(rumor, hexToBytes(initiatorSkHex), memberPubHex);
}

/**
 * Parse + verify an incoming NIP-17 DM as an NBMS invite. Returns null if it is not an
 * invite or the advertised group npub does not match derive(H) — a mismatch means the
 * inviter lied about the membership/secret binding and MUST be rejected.
 */
export function parseInvite(wrap: Event, recipientSkHex: string): NbmsInvite | null {
    try {
        const rumor = nip59.unwrapEvent(wrap, hexToBytes(recipientSkHex));
        const body = JSON.parse(rumor.content);
        if (body.type !== 'nbms-invite' || typeof body.h !== 'string') return null;

        const group = deriveGroupKeypair(hexToBytes(body.h));
        if (group.npub !== body.group_npub) return null; // H must bind to the advertised npub

        return {
            groupNpub: body.group_npub,
            groupPubkey: group.pubkey,
            initiator: npubToHex(body.initiator),
            members: (body.members as string[]).map(npubToHex),
            hHex: body.h,
            createdAt: body.created_at ?? rumor.created_at,
        };
    } catch {
        return null;
    }
}

/**
 * Scan recent NIP-17 gift wraps addressed to the user and return any that are NBMS
 * invites. Gift wraps carry jittered timestamps, so "recent" is approximate — we pull a
 * batch, take the newest `limit`, and parse. Invites for groups already joined are NOT
 * filtered here (the caller knows the local cache); duplicates per group are collapsed.
 */
export function fetchRecentInvites(
    personalSkHex: string,
    personalPubHex: string,
    relays: string[] = NBMS_DEFAULT_RELAYS,
    limit = 30,
): Promise<NbmsInvite[]> {
    return new Promise(resolve => {
        const sockets: WebSocket[] = [];
        const subId = 'nbmsinv_' + Math.random().toString(36).slice(2, 8);
        const wraps = new Map<string, Event>();
        let done = false;
        let eose = 0;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            sockets.forEach(ws => { try { ws.close(); } catch { } });
            const newest = [...wraps.values()].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
            const byGroup = new Map<string, NbmsInvite>();
            for (const w of newest) {
                const inv = parseInvite(w, personalSkHex);
                if (inv && !byGroup.has(inv.groupNpub)) byGroup.set(inv.groupNpub, inv);
            }
            resolve([...byGroup.values()]);
        };
        const timer = setTimeout(finish, 5000);
        for (const url of relays) {
            try {
                const ws = new WebSocket(url);
                sockets.push(ws);
                ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, { kinds: [KIND_GIFT_WRAP], '#p': [personalPubHex], limit: 100 }]));
                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'EVENT' && data[2]) { const ev = data[2] as Event; wraps.set(ev.id, ev); }
                        if (data[0] === 'EOSE' && ++eose >= sockets.length) finish();
                    } catch { }
                };
                ws.onerror = () => { };
            } catch { }
        }
    });
}

// ──────────────────────────────────────────────────────────────────────────
//  Group construction (initiator side)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Initiator entry point: compute H, derive the group, persist locally, and publish an
 * invite to every other member. Returns the group plus the invite wraps that were sent.
 */
export async function createGroupAsInitiator(
    initiatorSkHex: string,
    initiatorPubHex: string,
    memberPubHexes: string[],
    groupName?: string,
    relays: string[] = NBMS_DEFAULT_RELAYS,
): Promise<{ group: NbmsGroup; invitesSent: number }> {
    if (memberPubHexes.includes(initiatorPubHex)) {
        memberPubHexes = memberPubHexes.filter(p => p !== initiatorPubHex);
    }
    if (memberPubHexes.length === 0) throw new Error('NBMS: select at least one other member');

    const H = computeGroupSecret(initiatorSkHex, memberPubHexes);
    const group = deriveGroupKeypair(H);
    const createdAt = Math.floor(Date.now() / 1000);
    const profile: GroupProfile | undefined = groupName?.trim() ? { name: groupName.trim() } : undefined;

    const nbmsGroup: NbmsGroup = {
        groupNpub: group.npub,
        groupPubkey: group.pubkey,
        hHex: group.skHex,
        initiator: initiatorPubHex,
        members: [
            { pubkey: initiatorPubHex, npub: hexToNpub(initiatorPubHex), status: 'initiator' },
            ...memberPubHexes.map<NbmsMember>(hex => ({ pubkey: hex, npub: hexToNpub(hex), status: 'invited' })),
        ],
        role: 'initiator',
        profile,
        createdAt,
    };

    const invite: NbmsInvite = {
        groupNpub: group.npub,
        groupPubkey: group.pubkey,
        initiator: initiatorPubHex,
        members: [initiatorPubHex, ...memberPubHexes],
        hHex: group.skHex,
        createdAt,
    };

    // Persist before network so a failed publish still leaves a recoverable local group.
    saveLocalGroup(initiatorPubHex, nbmsGroup);

    let invitesSent = 0;
    for (const memberHex of memberPubHexes) {
        const wrap = buildInviteWrap(invite, initiatorSkHex, memberHex);
        const ok = await publishToRelays(wrap, relays);
        if (ok > 0) invitesSent++;
    }

    // Publish the group profile early (if named) so invitees see the name as they join.
    if (profile) { try { await publishMembershipRecord(nbmsGroup, relays); } catch { /* best-effort */ } }

    return { group: nbmsGroup, invitesSent };
}

/** Re-send the invite (with H) to a single member — used by the initiator to nudge
 *  members who haven't joined yet. Reconstructs the original invite from the group. */
export async function resendInvite(
    group: NbmsGroup,
    memberHex: string,
    selfSkHex: string,
    relays: string[] = NBMS_DEFAULT_RELAYS,
): Promise<number> {
    const invite: NbmsInvite = {
        groupNpub: group.groupNpub,
        groupPubkey: group.groupPubkey,
        initiator: group.initiator,
        members: group.members.map(m => m.pubkey),
        hHex: group.hHex,
        createdAt: group.createdAt,
    };
    const wrap = buildInviteWrap(invite, selfSkHex, memberHex);
    return publishToRelays(wrap, relays);
}

// ──────────────────────────────────────────────────────────────────────────
//  Consent (invitee side)
// ──────────────────────────────────────────────────────────────────────────

/** Accept an invite: derive the group, announce acceptance on the channel, persist. */
export async function acceptInvite(
    invite: NbmsInvite,
    selfSkHex: string,
    selfPubHex: string,
    label?: string,
    relays: string[] = NBMS_DEFAULT_RELAYS,
): Promise<NbmsGroup> {
    const group = deriveGroupKeypair(hexToBytes(invite.hHex));
    const others = invite.members.filter(p => p !== invite.initiator);

    const nbmsGroup: NbmsGroup = {
        groupNpub: group.npub,
        groupPubkey: group.pubkey,
        hHex: invite.hHex,
        initiator: invite.initiator,
        members: [
            { pubkey: invite.initiator, npub: hexToNpub(invite.initiator), status: 'initiator' },
            ...others.map<NbmsMember>(hex => ({
                pubkey: hex,
                npub: hexToNpub(hex),
                status: hex === selfPubHex ? 'accepted' : 'invited',
            })),
        ],
        role: 'member',
        label,
        createdAt: invite.createdAt,
    };

    saveLocalGroup(selfPubHex, nbmsGroup);
    const wrap = wrapGroupMessage({ type: 'nbms-accept', content: {} }, selfSkHex, group);
    await publishToRelays(wrap, relays);
    return nbmsGroup;
}

/** Decline an invite: announce on the channel; nothing is persisted locally. */
export async function declineInvite(
    invite: NbmsInvite,
    selfSkHex: string,
    relays: string[] = NBMS_DEFAULT_RELAYS,
): Promise<void> {
    const group = deriveGroupKeypair(hexToBytes(invite.hHex));
    const wrap = wrapGroupMessage({ type: 'nbms-decline', content: {} }, selfSkHex, group);
    await publishToRelays(wrap, relays);
}

/** Apply an inbound accept/decline channel message to a group's member roster (immutably). */
export function applyConsent(group: NbmsGroup, msg: NbmsUnwrapped): NbmsGroup {
    if (msg.type !== 'nbms-accept' && msg.type !== 'nbms-decline') return group;
    const status: MemberStatus = msg.type === 'nbms-accept' ? 'accepted' : 'declined';
    return {
        ...group,
        members: group.members.map(m =>
            m.pubkey === msg.author && m.status === 'invited' ? { ...m, status } : m,
        ),
    };
}

/** True once every non-initiator member has accepted. */
export function isGroupReady(group: NbmsGroup): boolean {
    return group.members.every(m => m.status === 'initiator' || m.status === 'accepted');
}

// ──────────────────────────────────────────────────────────────────────────
//  Cosigner xpub exchange
// ──────────────────────────────────────────────────────────────────────────

/** Best-effort mirror of one of my own channel wraps to my derived personal backup channel, so a
 *  deletion by another member never costs me the original. Funds-affecting messages (xpub, PSBT)
 *  go through here just like chat text does. Fire-and-forget. */
function mirrorToBackup(wrap: Event, selfSkHex: string, hHex: string, relays: string[]): void {
    try { backupOwnWrap(wrap, deriveBackupKeypair(selfSkHex, hexToBytes(hHex)), relays).catch(() => { }); } catch { /* ignore */ }
}

/** Send the active member's cosigner xpub to the channel as an inner-signed nbms-xpub message. */
export async function sendCosignerXpub(
    group: NbmsGroup,
    selfSkHex: string,
    xpub: string,
    fingerprint: string,
    path: string,
    relays: string[] = NBMS_DEFAULT_RELAYS,
): Promise<number> {
    const gk = deriveGroupKeypair(hexToBytes(group.hHex));
    const wrap = wrapGroupMessage(
        { type: 'nbms-xpub', content: { xpub, fingerprint }, tags: [[TAG_XPUB, xpub, path]] },
        selfSkHex, gk,
    );
    mirrorToBackup(wrap, selfSkHex, group.hHex, relays);
    return publishToRelays(wrap, relays);
}

/**
 * Parse a verified nbms-xpub channel message into a cosigner key. The message's author was
 * already cryptographically verified during unwrap, so the returned xpub is bound to that
 * member — this is the only trustworthy source for wallet construction (NOT the msx cache).
 */
export function extractXpub(msg: NbmsUnwrapped): CosignerXpub | null {
    if (msg.type !== 'nbms-xpub') return null;
    const tag = msg.tags.find(t => t[0] === TAG_XPUB);
    const xpub = (msg.content.xpub as string) || tag?.[1];
    if (!xpub) return null;
    return {
        pubkey: msg.author,
        npub: hexToNpub(msg.author),
        xpub,
        fingerprint: (msg.content.fingerprint as string) || '',
        path: tag?.[2] || "m/48'/0'/0'/2'",
    };
}

/** Merge a verified xpub into the group. Ignores contributions from non-members. */
export function applyXpub(group: NbmsGroup, x: CosignerXpub): NbmsGroup {
    if (!group.members.some(m => m.pubkey === x.pubkey)) return group;
    if (group.xpubs?.[x.pubkey]?.xpub === x.xpub) return group; // no change
    return { ...group, xpubs: { ...(group.xpubs ?? {}), [x.pubkey]: x } };
}

/** True once every member has contributed a verified xpub. */
export function allXpubsCollected(group: NbmsGroup): boolean {
    const xpubs = group.xpubs ?? {};
    return group.members.every(m => !!xpubs[m.pubkey]);
}

/** Members still missing an xpub. */
export function missingXpubs(group: NbmsGroup): NbmsMember[] {
    const xpubs = group.xpubs ?? {};
    return group.members.filter(m => !xpubs[m.pubkey]);
}

/** Collected cosigner xpubs in a stable order (by member pubkey) for descriptor building. */
export function cosignerList(group: NbmsGroup): CosignerXpub[] {
    return Object.values(group.xpubs ?? {}).sort((a, b) => a.pubkey.localeCompare(b.pubkey));
}

// ──────────────────────────────────────────────────────────────────────────
//  PSBT proposals (propose-once / sign-many over the channel)
// ──────────────────────────────────────────────────────────────────────────

export interface PsbtSummary {
    recipient: string;
    amountSats: number;
    feeSats: number;
    wallet: string; // "M-of-N"
}

async function publishPsbtMsg(
    group: NbmsGroup, selfSkHex: string, uuid: string, approved: boolean,
    content: Record<string, unknown>, relays: string[],
): Promise<number> {
    const gk = deriveGroupKeypair(hexToBytes(group.hHex));
    const wrap = wrapGroupMessage(
        { type: 'nbms-psbt', content, tags: [[TAG_PSBT, uuid], [TAG_APPROVED, approved ? 'yes' : 'no']] },
        selfSkHex, gk,
    );
    mirrorToBackup(wrap, selfSkHex, group.hHex, relays);
    return publishToRelays(wrap, relays);
}

/** Propose a spend: the frozen PSBT (already signed by the proposer) + a human summary. */
export function sendPsbtProposal(group: NbmsGroup, selfSkHex: string, uuid: string, psbtBase64: string, summary: PsbtSummary, relays: string[] = NBMS_DEFAULT_RELAYS) {
    return publishPsbtMsg(group, selfSkHex, uuid, true, { psbt: psbtBase64, summary }, relays);
}
/** Add this member's partial signature to a proposal. */
export function sendPsbtSignature(group: NbmsGroup, selfSkHex: string, uuid: string, psbtBase64: string, relays: string[] = NBMS_DEFAULT_RELAYS) {
    return publishPsbtMsg(group, selfSkHex, uuid, true, { psbt: psbtBase64 }, relays);
}
/** Decline a proposal. */
export function sendPsbtDecline(group: NbmsGroup, selfSkHex: string, uuid: string, relays: string[] = NBMS_DEFAULT_RELAYS) {
    return publishPsbtMsg(group, selfSkHex, uuid, false, {}, relays);
}
/** Announce that the finalized transaction was broadcast. */
export function sendPsbtBroadcast(group: NbmsGroup, selfSkHex: string, uuid: string, txid: string, relays: string[] = NBMS_DEFAULT_RELAYS) {
    return publishPsbtMsg(group, selfSkHex, uuid, true, { txid }, relays);
}

// Advisory group-published xpub cache (msx). Discovery only — wallets are built from the
// verified per-member nbms-xpub messages above, never from this blob.
export async function publishXpubsCache(group: NbmsGroup, relays: string[] = NBMS_DEFAULT_RELAYS): Promise<number> {
    const gk = deriveGroupKeypair(hexToBytes(group.hHex));
    const keys = Object.values(group.xpubs ?? {});
    const content = encryptToSelf(gk.skHex, { keys });
    const ev = finalizeEvent(
        { kind: KIND_APP_DATA, created_at: Math.floor(Date.now() / 1000), tags: [['d', DTAG_XPUBS]], content },
        gk.sk,
    );
    cacheBackupEvent('msx-' + group.groupNpub, ev); // recovery anchor — cache for rebroadcast
    return publishToRelays(ev, relays);
}

// ──────────────────────────────────────────────────────────────────────────
//  Membership record (group kind:0) — published once the group is ready
// ──────────────────────────────────────────────────────────────────────────

export function buildMembershipEvent(group: GroupKeypair, members: string[], initiator: string, profile: GroupProfile = {}, thresholdDefault = 2): Event {
    const nbms = encryptToSelf(group.skHex, {
        name: profile.name ?? '',
        picture: profile.picture ?? '',
        about: profile.about ?? '',
        members: members.map(hexToNpub),
        initiator: hexToNpub(initiator),
        threshold_default: thresholdDefault,
    });
    return finalizeEvent(
        { kind: KIND_GROUP_META, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify({ nbms }) },
        group.sk,
    );
}

/** Publish the group kind:0 (membership + encrypted profile). Re-used for profile edits. */
export async function publishMembershipRecord(group: NbmsGroup, relays: string[] = NBMS_DEFAULT_RELAYS): Promise<number> {
    const gk = deriveGroupKeypair(hexToBytes(group.hHex));
    const memberHexes = group.members.map(m => m.pubkey);
    const ev = buildMembershipEvent(gk, memberHexes, group.initiator, group.profile ?? {});
    return publishToRelays(ev, relays);
}

/** One-shot fetch of the group's newest kind:0 (membership + encrypted profile). Members only. */
function fetchGroupKind0(group: NbmsGroup, relays: string[] = NBMS_DEFAULT_RELAYS): Promise<Event | null> {
    return new Promise(resolve => {
        const sockets: WebSocket[] = [];
        const subId = 'nbmsp_' + Math.random().toString(36).slice(2, 8);
        let best: Event | null = null;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            sockets.forEach(ws => { try { ws.close(); } catch { } });
            resolve(best);
        };
        const timer = setTimeout(finish, 6000);
        for (const url of relays) {
            try {
                const ws = new WebSocket(url);
                sockets.push(ws);
                ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, { kinds: [KIND_GROUP_META], authors: [group.groupPubkey], limit: 1 }]));
                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'EVENT' && data[2]) { const ev = data[2] as Event; if (!best || ev.created_at > best.created_at) best = ev; }
                        if (data[0] === 'EOSE') finish();
                    } catch { }
                };
                ws.onerror = () => { };
            } catch { }
        }
    });
}

/** Decrypt a group kind:0 into its raw membership record (members/initiator/profile fields). */
function decryptGroupRecord(group: NbmsGroup, ev: Event): { name?: string; picture?: string; about?: string; members?: string[]; initiator?: string } | null {
    try {
        const parsed = JSON.parse(ev.content);
        if (!parsed.nbms) return null;
        const gk = deriveGroupKeypair(hexToBytes(group.hHex));
        return decryptToSelf(gk.skHex, parsed.nbms);
    } catch { return null; }
}

/** Fetch + decrypt the group's kind:0 profile (name/picture/about). Members only. */
export async function fetchGroupProfile(group: NbmsGroup, relays: string[] = NBMS_DEFAULT_RELAYS): Promise<GroupProfile | null> {
    const ev = await fetchGroupKind0(group, relays);
    const dec = ev && decryptGroupRecord(group, ev);
    if (!dec) return null;
    return { name: dec.name || undefined, picture: dec.picture || undefined, about: dec.about || undefined };
}

export interface GroupMembership {
    members: string[];  // hex pubkeys
    initiator: string;  // hex pubkey ('' if absent)
    profile: GroupProfile;
}

/** Fetch + decrypt the group's full membership record (members + initiator + profile). Members only. */
export async function fetchGroupMembership(group: NbmsGroup, relays: string[] = NBMS_DEFAULT_RELAYS): Promise<GroupMembership | null> {
    const ev = await fetchGroupKind0(group, relays);
    const dec = ev && decryptGroupRecord(group, ev);
    if (!dec) return null;
    const toHex = (npub: string) => { try { return npubToHex(npub); } catch { return ''; } };
    return {
        members: (dec.members ?? []).map(toHex).filter(Boolean),
        initiator: dec.initiator ? toHex(dec.initiator) : '',
        profile: { name: dec.name || undefined, picture: dec.picture || undefined, about: dec.about || undefined },
    };
}

// ──────────────────────────────────────────────────────────────────────────
//  Local cache (fast UI) — keyed by the owning personal pubkey
// ──────────────────────────────────────────────────────────────────────────

const localKey = (ownerHex: string) => `denos-nbms-groups-${ownerHex}`;

export function getLocalGroups(ownerHex: string): NbmsGroup[] {
    try {
        const raw = localStorage.getItem(localKey(ownerHex));
        return raw ? (JSON.parse(raw) as NbmsGroup[]) : [];
    } catch {
        return [];
    }
}

export function saveLocalGroup(ownerHex: string, group: NbmsGroup): void {
    const groups = getLocalGroups(ownerHex).filter(g => g.groupNpub !== group.groupNpub);
    groups.push(group);
    localStorage.setItem(localKey(ownerHex), JSON.stringify(groups));
}

export function deleteLocalGroup(ownerHex: string, groupNpub: string): void {
    const groups = getLocalGroups(ownerHex).filter(g => g.groupNpub !== groupNpub);
    localStorage.setItem(localKey(ownerHex), JSON.stringify(groups));
}

// ──────────────────────────────────────────────────────────────────────────
//  Personal recovery backup — NIP-78 `nbmsgc`
// ──────────────────────────────────────────────────────────────────────────

interface NbmsgcEntry {
    group_npub: string;
    h: string;
    role: GroupRole;
    label?: string;
    joined_at: number;
}

export function serializeGroupIndex(groups: NbmsGroup[]): NbmsgcEntry[] {
    return groups.map(g => ({
        group_npub: g.groupNpub,
        h: g.hHex,
        role: g.role,
        label: g.label,
        joined_at: g.createdAt,
    }));
}

/** Build the personal NIP-78 (`d=nbmsgc`) backup event, encrypted to self. */
export function buildGroupIndexEvent(personalSkHex: string, groups: NbmsGroup[]): Event {
    const content = encryptToSelf(personalSkHex, { groups: serializeGroupIndex(groups) });
    return finalizeEvent(
        {
            kind: KIND_APP_DATA,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['d', DTAG_GROUP_INDEX]],
            content,
        },
        hexToBytes(personalSkHex),
    );
}

export async function publishGroupIndex(
    personalSkHex: string,
    groups: NbmsGroup[],
    relays: string[] = NBMS_DEFAULT_RELAYS,
): Promise<number> {
    return publishToRelays(buildGroupIndexEvent(personalSkHex, groups), relays);
}

// ──────────────────────────────────────────────────────────────────────────
//  Backup durability — cache signed nbmsgc/msx events; rebroadcast if relays drop them.
//  These are recovery anchors, NOT chat — never pruned. Stored in localStorage.
// ──────────────────────────────────────────────────────────────────────────

function cacheBackupEvent(key: string, ev: Event): void {
    try { localStorage.setItem('denos-nbms-backup-' + key, JSON.stringify(ev)); } catch { /* ignore */ }
}
function getBackupEvent(key: string): Event | null {
    try { const raw = localStorage.getItem('denos-nbms-backup-' + key); return raw ? JSON.parse(raw) as Event : null; } catch { return null; }
}

/** Build, cache, and publish the personal nbmsgc backup from the current local groups. */
export async function syncGroupIndex(personalSkHex: string, personalPubHex: string, groups: NbmsGroup[], relays: string[] = NBMS_DEFAULT_RELAYS): Promise<void> {
    const ev = buildGroupIndexEvent(personalSkHex, groups);
    cacheBackupEvent('nbmsgc-' + personalPubHex, ev);
    await publishToRelays(ev, relays);
}

/**
 * Ensure a cached replaceable backup still exists on relays. Queries up to the given
 * relays; if a newer version is found it adopts that into the cache, otherwise (missing or
 * older on relays) it rebroadcasts the cached copy. Funds-independent, best-effort.
 */
export async function ensureBackupAlive(cacheKey: string, relays: string[] = NBMS_DEFAULT_RELAYS): Promise<void> {
    const ev = getBackupEvent(cacheKey);
    if (!ev) return;
    const dtag = ev.tags.find(t => t[0] === 'd')?.[1] ?? '';
    const latest = await fetchReplaceable(ev.pubkey, ev.kind, dtag, relays.slice(0, 3));
    if (latest && latest.created_at > ev.created_at) {
        cacheBackupEvent(cacheKey, latest); // relays have a newer version — adopt it
        return;
    }
    if (!latest || latest.created_at < ev.created_at) {
        await publishToRelays(ev, relays); // missing or stale on relays — rebroadcast our copy
    }
}

/** Rebroadcast all of this member's backups (nbmsgc + each group's msx) if relays dropped them. */
export async function ensureBackupsAlive(personalPubHex: string, groupNpubs: string[], relays: string[] = NBMS_DEFAULT_RELAYS): Promise<void> {
    await ensureBackupAlive('nbmsgc-' + personalPubHex, relays);
    for (const npub of groupNpubs) await ensureBackupAlive('msx-' + npub, relays);
}

/** Fetch + decrypt the personal `nbmsgc` backup into minimal group records (for recovery). */
export async function fetchGroupIndex(
    personalSkHex: string,
    personalPubHex: string,
    relays: string[] = NBMS_DEFAULT_RELAYS,
): Promise<NbmsGroup[]> {
    const ev = await fetchReplaceable(personalPubHex, KIND_APP_DATA, DTAG_GROUP_INDEX, relays);
    if (!ev) return [];
    const payload = decryptToSelf<{ groups: NbmsgcEntry[] }>(personalSkHex, ev.content);
    return (payload.groups ?? []).map(e => {
        const gk = deriveGroupKeypair(hexToBytes(e.h));
        return {
            groupNpub: e.group_npub,
            groupPubkey: gk.pubkey,
            hHex: e.h,
            initiator: '', // membership re-hydrated from the group kind:0 / channel later
            members: [],
            role: e.role,
            label: e.label,
            createdAt: e.joined_at,
        };
    });
}

/**
 * Phase 7 — cross-device / reinstall recovery. Rebuild NBMS groups from the personal `nbmsgc`
 * backup (group npub + secret H) that lives on relays, then re-hydrate each group's membership
 * from its kind:0. Only groups NOT already present locally are added (existing ones are left
 * untouched). Cosigner xpubs — and therefore the spendable wallets — re-collect from the channel
 * when the recovered group's chat is opened, so a recovered group starts as its identity +
 * roster and fills in its wallets on first open.
 *
 * Returns the newly-recovered groups and the total count found in the backup.
 */
export async function recoverGroups(
    personalSkHex: string,
    personalPubHex: string,
    relays: string[] = NBMS_DEFAULT_RELAYS,
): Promise<{ recovered: NbmsGroup[]; total: number }> {
    const index = await fetchGroupIndex(personalSkHex, personalPubHex, relays);
    const have = new Set(getLocalGroups(personalPubHex).map(g => g.groupNpub));
    const recovered: NbmsGroup[] = [];
    for (const entry of index) {
        if (have.has(entry.groupNpub)) continue;
        const gk = deriveGroupKeypair(hexToBytes(entry.hHex));
        const mem = await fetchGroupMembership(entry, relays).catch(() => null);
        const members: NbmsMember[] = (mem?.members ?? []).map(hex => ({
            pubkey: hex,
            npub: hexToNpub(hex),
            // The kind:0 is published only once the group is ready, so everyone in it has joined.
            status: hex === mem?.initiator ? 'initiator' : 'accepted',
        }));
        const group: NbmsGroup = {
            groupNpub: entry.groupNpub,
            groupPubkey: gk.pubkey,
            hHex: entry.hHex,
            initiator: mem?.initiator ?? '',
            members,
            role: entry.role,
            label: entry.label,
            profile: mem?.profile,
            createdAt: entry.createdAt,
        };
        saveLocalGroup(personalPubHex, group);
        recovered.push(group);
    }
    return { recovered, total: index.length };
}

// ── one-shot fetch of the newest replaceable event for (author, kind, d) ──
function fetchReplaceable(
    authorHex: string,
    kind: number,
    dTag: string,
    relays: string[],
): Promise<Event | null> {
    return new Promise(resolve => {
        const sockets: WebSocket[] = [];
        const subId = 'nbmsf_' + Math.random().toString(36).slice(2, 8);
        let best: Event | null = null;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            sockets.forEach(ws => { try { ws.close(); } catch { } });
            resolve(best);
        };
        const timer = setTimeout(finish, 6000);
        for (const url of relays) {
            try {
                const ws = new WebSocket(url);
                sockets.push(ws);
                ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, { kinds: [kind], authors: [authorHex], '#d': [dTag], limit: 1 }]));
                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'EVENT' && data[2]) {
                            const ev = data[2] as Event;
                            if (!best || ev.created_at > best.created_at) best = ev;
                        }
                        if (data[0] === 'EOSE') { clearTimeout(timer); finish(); }
                    } catch { }
                };
                ws.onerror = () => { };
            } catch { }
        }
    });
}
