/**
 * NIP-NBMS — Nostr Bitcoin Multi-Sig Groups.
 *
 * Phase 1: channel primitives.
 *   - Group secret (H) derivation from pairwise NIP-44 conversation keys.
 *   - Group keypair derivation from H.
 *   - Self-addressed, inner-signed NIP-17/59 envelope (the "npub messages itself" channel).
 *   - Relay publish / subscribe scoped to a single group npub.
 *
 * Crypto is all nostr-tools (nip44 + finalize/verify). The only NBMS-specific parts are
 * (1) using the group keypair instead of an ephemeral key for the gift wrap, and
 * (2) signing the inner rumor with the author's personal key so members are attributable
 *     inside a shared channel. See docs/NIP-NBMS.md.
 */
import { nip44, nip19, finalizeEvent, getPublicKey, verifyEvent, type Event } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

// ── Event kinds ──
export const KIND_SEAL = 13;
export const KIND_GIFT_WRAP = 1059;
export const KIND_GROUP_META = 0;
export const KIND_APP_DATA = 30078; // NIP-78, used for both nbmsgc (personal) and msx (group)

// ── NIP-78 d-tags ──
export const DTAG_GROUP_INDEX = 'nbmsgc'; // personal: groups + H backup
export const DTAG_XPUBS = 'msx';         // group: cosigner xpub cache (advisory)

// ── Channel message types (live in inner-rumor JSON content) ──
export type NbmsMessageType =
    | 'nbms-invite'
    | 'nbms-accept'
    | 'nbms-decline'
    | 'nbms-text'
    | 'nbms-xpub'
    | 'nbms-psbt'
    | 'nbms-backup';

// ── Inner-rumor tags ──
export const TAG_XPUB = 'ns-xpub';   // [xpub, derivation_path]
export const TAG_PSBT = 'psbt';      // [proposal uuid]
export const TAG_APPROVED = 'approved'; // ["yes" | "no"]

const TWO_DAYS = 2 * 24 * 60 * 60;
const nowSec = () => Math.floor(Date.now() / 1000);
/** Jittered past timestamp for seal/wrap, mirroring nostr-tools nip59 timing-resistance. */
const randomPastSec = () => Math.floor(nowSec() - Math.random() * TWO_DAYS);

// ──────────────────────────────────────────────────────────────────────────
//  Group secret (H)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Pairwise secret between two parties = NIP-44 v2 conversation key (HKDF over the
 * ECDH x-coordinate). Symmetric: pairwise(a, B) === pairwise(b, A).
 */
function pairwiseSecret(skHex: string, otherPubHex: string): Uint8Array {
    return nip44.v2.utils.getConversationKey(hexToBytes(skHex), otherPubHex);
}

/** Domain-separation tag: keeps the NBMS group key distinct from any other protocol that
 *  might derive a key the same way from the same people. Bump the version if the
 *  derivation ever changes. */
const NBMS_DOMAIN_TAG = new TextEncoder().encode('nbms-v1');

/**
 * Compute the 32-byte group secret H. **Initiator only** — only the initiator is a
 * party to every pairwise secret. Order-independent (secrets are byte-sorted first).
 *
 * Preimage: "nbms-v1" || sorted(pairwise secrets) || uint32be(groupIndex)
 * The `groupIndex` (default 0) is reserved so the same member-set can derive multiple
 * distinct groups in the future without changing this format; today it is always 0,
 * keeping H deterministically recomputable from membership alone.
 *
 * @param initiatorSkHex  initiator's private key (hex)
 * @param memberPubHexes  the OTHER members' pubkeys (hex), excluding the initiator
 * @param groupIndex      reserved ordinal for future multi-group support (default 0)
 */
export function computeGroupSecret(initiatorSkHex: string, memberPubHexes: string[], groupIndex = 0): Uint8Array {
    if (memberPubHexes.length === 0) throw new Error('NBMS: a group needs at least one other member');
    const secrets = memberPubHexes.map(pub => pairwiseSecret(initiatorSkHex, pub));
    // Lexicographic byte sort so H is independent of member-selection order.
    secrets.sort(compareBytes);

    const idx = new Uint8Array(4);
    new DataView(idx.buffer).setUint32(0, groupIndex >>> 0, false); // big-endian
    const preimage = new Uint8Array(NBMS_DOMAIN_TAG.length + secrets.length * 32 + 4);
    preimage.set(NBMS_DOMAIN_TAG, 0);
    secrets.forEach((s, i) => preimage.set(s, NBMS_DOMAIN_TAG.length + i * 32));
    preimage.set(idx, NBMS_DOMAIN_TAG.length + secrets.length * 32);
    return sha256(preimage);
}

/** Compare two equal-length byte arrays lexicographically (byte 0 first, then onward). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
}

// ──────────────────────────────────────────────────────────────────────────
//  Group keypair
// ──────────────────────────────────────────────────────────────────────────

export interface GroupKeypair {
    sk: Uint8Array;
    skHex: string;
    pubkey: string; // hex x-only
    npub: string;
}

/**
 * Derive the group keypair from H. H is a SHA-256 digest, which is a valid secp256k1
 * scalar with overwhelming probability; getPublicKey throws on the negligible chance
 * it is out of range, which we surface as a clear error.
 */
export function deriveGroupKeypair(H: Uint8Array): GroupKeypair {
    if (H.length !== 32) throw new Error('NBMS: group secret must be 32 bytes');
    let pubkey: string;
    try {
        pubkey = getPublicKey(H);
    } catch {
        throw new Error('NBMS: group secret is not a valid key (re-create the group)');
    }
    return { sk: H, skHex: bytesToHex(H), pubkey, npub: nip19.npubEncode(pubkey) };
}

/** Versioned KDF context for the per-member, per-group backup key (see {@link deriveBackupKeypair}). */
const BACKUP_KDF_INFO = new TextEncoder().encode('nbms-backup-v1');

/**
 * Derive a member's private backup keypair for a group — a "group of one" used as a
 * self-addressed channel where the member mirrors their own sent messages, so a relay-side
 * deletion by another member never costs them the original event.
 *
 *   backupSk = HKDF-SHA256(ikm = personal private key, salt = H, info = "nbms-backup-v1")
 *
 * Only the member can derive it (it needs their private key), and it is re-derivable on any
 * device from their nsec + H (already in their `nbmsgc` backup). No other member can produce
 * or delete events under it. Inherits the channel's invisibility and authors-filterability.
 */
export function deriveBackupKeypair(personalSkHex: string, H: Uint8Array): GroupKeypair {
    const sk = hkdf(sha256, hexToBytes(personalSkHex), H, BACKUP_KDF_INFO, 32);
    return deriveGroupKeypair(sk);
}

// ──────────────────────────────────────────────────────────────────────────
//  Self-addressed, inner-signed envelope
// ──────────────────────────────────────────────────────────────────────────

/** The inner message a member wants to put on the channel. */
export interface NbmsInner {
    type: NbmsMessageType;
    content: Record<string, unknown>;
    tags?: string[][];
    /** Inner-rumor kind. Defaults to 14 (NIP-17 chat). */
    kind?: number;
}

function selfConversationKey(skHex: string): Uint8Array {
    const pub = getPublicKey(hexToBytes(skHex));
    return nip44.v2.utils.getConversationKey(hexToBytes(skHex), pub);
}

/**
 * Wrap a message for the group channel.
 *
 * Layering (NBMS variant of NIP-17/59):
 *   rumor  — SIGNED by the author's personal key (attribution + verifiability)
 *   seal   — kind 13, signed by the GROUP key, NIP-44 self-encrypted (group→group)
 *   wrap   — kind 1059, signed by the GROUP key (not ephemeral), self-encrypted, p=group
 *
 * The author signs the rumor (a deviation from stock NIP-17, where the rumor is unsigned)
 * because the seal/wrap are signed by the shared group key, so the rumor signature is the
 * only thing that proves which member authored a funds-affecting message.
 *
 * @param authorSkHex  the publishing member's personal private key (hex)
 * @param group        the group keypair (held by all members)
 */
export function wrapGroupMessage(inner: NbmsInner, authorSkHex: string, group: GroupKeypair): Event {
    const rumor = finalizeEvent(
        {
            kind: inner.kind ?? 14,
            created_at: nowSec(),
            tags: inner.tags ?? [],
            content: JSON.stringify({ type: inner.type, ...inner.content }),
        },
        hexToBytes(authorSkHex),
    );
    return sealAndWrap(rumor, group);
}

/**
 * Seal + wrap an already-signed inner rumor for the group channel. Shared by the normal send
 * path and by {@link rewrapRumor}. The seal and wrap are self-encrypted to the group key and
 * signed by it; their timestamps are jittered into the past (NIP-59 timing resistance).
 */
function sealAndWrap(rumor: Event, group: GroupKeypair): Event {
    const groupKey = selfConversationKey(group.skHex);

    const seal = finalizeEvent(
        {
            kind: KIND_SEAL,
            created_at: randomPastSec(),
            tags: [],
            content: nip44.v2.encrypt(JSON.stringify(rumor), groupKey),
        },
        group.sk,
    );

    const wrap = finalizeEvent(
        {
            kind: KIND_GIFT_WRAP,
            created_at: randomPastSec(),
            tags: [['p', group.pubkey]],
            content: nip44.v2.encrypt(JSON.stringify(seal), groupKey),
        },
        group.sk,
    );

    return wrap;
}

/**
 * Re-envelope an EXISTING, author-signed inner rumor into a fresh gift wrap. Used to restore a
 * message a member deleted on relays: the new wrap has a different event id (fresh NIP-44 nonce
 * + jittered timestamp), so the old NIP-09 deletion — which names the prior wrap id — does not
 * apply. The rumor (content + the author's signature) is carried over verbatim, so authorship
 * and the message's logical timestamp are unchanged and the inner rumor id stays stable for
 * de-duplication against any surviving copies.
 */
export function rewrapRumor(rumor: Event, group: GroupKeypair): Event {
    return sealAndWrap(rumor, group);
}

// ── Personal backup channel (mirror your own messages to your derived "group of one") ──

/**
 * Publish a personal backup of one of your own channel wraps to your derived backup channel,
 * so a deletion by another member never costs you the original event. The payload is the whole
 * original group wrap (both encryption layers intact), recovered verbatim on restore.
 * Best-effort; returns the number of relays that accepted it.
 */
export async function backupOwnWrap(originalWrap: Event, backup: GroupKeypair, relays?: string[]): Promise<number> {
    const wrap = wrapGroupMessage({ type: 'nbms-backup', content: { wrap: originalWrap } }, backup.skHex, backup);
    return publishToRelays(wrap, relays);
}

/**
 * Fetch + decrypt this member's backup channel and return the ORIGINAL group wraps they
 * mirrored. The caller (which holds the group key) unwraps each to index it by inner rumor id.
 */
export async function fetchOwnBackups(backup: GroupKeypair, opts: { limit?: number } = {}, relays?: string[]): Promise<Event[]> {
    const items = await fetchChannelMessages(backup, { limit: opts.limit ?? 500 }, relays);
    const out: Event[] = [];
    for (const { msg } of items) {
        const w = msg.type === 'nbms-backup' ? (msg.content as { wrap?: Event }).wrap : undefined;
        if (w && w.id) out.push(w);
    }
    return out;
}

export interface NbmsUnwrapped {
    /** The real author's pubkey (hex), cryptographically verified. */
    author: string;
    type: NbmsMessageType;
    content: Record<string, unknown>;
    tags: string[][];
    created_at: number;
    /** The fully-verified inner rumor, for callers that need raw access. */
    rumor: Event;
}

/**
 * Unwrap and verify a channel gift wrap. Returns null if anything fails to decrypt or
 * verify — callers MUST treat null as "ignore this message". The author signature on the
 * inner rumor is verified here; never trust an unwrapped message that returns null.
 */
export function unwrapGroupMessage(wrap: Event, group: GroupKeypair): NbmsUnwrapped | null {
    try {
        // The wrap and seal are signed by the group key; decrypt with the group self-key.
        if (wrap.kind !== KIND_GIFT_WRAP || wrap.pubkey !== group.pubkey) return null;
        const groupKey = selfConversationKey(group.skHex);

        const seal = JSON.parse(nip44.v2.decrypt(wrap.content, groupKey)) as Event;
        if (seal.kind !== KIND_SEAL || seal.pubkey !== group.pubkey || !verifyEvent(seal)) return null;

        const rumor = JSON.parse(nip44.v2.decrypt(seal.content, groupKey)) as Event;
        // The crux: the rumor must be a valid, signed event by its claimed author.
        if (!rumor.pubkey || !rumor.sig || !verifyEvent(rumor)) return null;

        const parsed = JSON.parse(rumor.content) as { type: NbmsMessageType } & Record<string, unknown>;
        const { type, ...content } = parsed;
        return {
            author: rumor.pubkey,
            type,
            content,
            tags: rumor.tags,
            created_at: rumor.created_at,
            rumor,
        };
    } catch {
        return null;
    }
}

// ──────────────────────────────────────────────────────────────────────────
//  Encrypt-to-self helpers (kind:0 about, nbmsgc, msx content)
// ──────────────────────────────────────────────────────────────────────────

/** NIP-44 self-encrypt arbitrary JSON under a key (group key for msx/kind:0, personal key for nbmsgc). */
export function encryptToSelf(skHex: string, payload: unknown): string {
    return nip44.v2.encrypt(JSON.stringify(payload), selfConversationKey(skHex));
}

export function decryptToSelf<T = unknown>(skHex: string, ciphertext: string): T {
    return JSON.parse(nip44.v2.decrypt(ciphertext, selfConversationKey(skHex))) as T;
}

// ──────────────────────────────────────────────────────────────────────────
//  Relay I/O (scoped to the group channel)
// ──────────────────────────────────────────────────────────────────────────

export const NBMS_DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
    'wss://relay.primal.net',
];

/** Publish a signed event to relays; resolves with the number of relays that accepted. */
export async function publishToRelays(signed: Event, relays: string[] = NBMS_DEFAULT_RELAYS): Promise<number> {
    let ok = 0;
    await Promise.allSettled(relays.map(url => new Promise<void>(resolve => {
        try {
            const ws = new WebSocket(url);
            const timer = setTimeout(() => { try { ws.close(); } catch { } resolve(); }, 5000);
            ws.onopen = () => ws.send(JSON.stringify(['EVENT', signed]));
            ws.onmessage = (msg) => {
                try {
                    const data = JSON.parse(msg.data);
                    if (data[0] === 'OK' && data[2] === true) ok++;
                } catch { }
                clearTimeout(timer);
                try { ws.close(); } catch { }
                resolve();
            };
            ws.onerror = () => { clearTimeout(timer); resolve(); };
        } catch { resolve(); }
    })));
    return ok;
}

/**
 * Subscribe to a group's channel: gift wraps p-tagged to the group npub. Each accepted
 * message is unwrapped, verified, and delivered via onMessage. Returns a stop() handle.
 */
export function subscribeGroupChannel(
    group: GroupKeypair,
    onMessage: (msg: NbmsUnwrapped, raw: Event) => void,
    relays: string[] = NBMS_DEFAULT_RELAYS,
    limit = 300,
): { stop: () => void } {
    const sockets: WebSocket[] = [];
    const subId = 'nbms_' + group.pubkey.slice(0, 12);
    const seen = new Set<string>(); // dedupe wraps across relays
    const filter: Record<string, unknown> = { kinds: [KIND_GIFT_WRAP], '#p': [group.pubkey], limit };

    for (const url of relays) {
        try {
            const ws = new WebSocket(url);
            ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
            ws.onmessage = (msg) => {
                try {
                    const data = JSON.parse(msg.data);
                    if (data[0] === 'EVENT' && data[2]) {
                        const raw = data[2] as Event;
                        if (seen.has(raw.id)) return;
                        seen.add(raw.id);
                        const unwrapped = unwrapGroupMessage(raw, group);
                        if (unwrapped) onMessage(unwrapped, raw);
                    }
                } catch { }
            };
            ws.onerror = () => { };
            sockets.push(ws);
        } catch { }
    }

    return {
        stop: () => sockets.forEach(ws => {
            try { ws.send(JSON.stringify(['CLOSE', subId])); ws.close(); } catch { }
        }),
    };
}

/**
 * One-shot fetch of channel messages, for backlog / scroll-up pagination. `until`/`since`
 * filter on the WRAP timestamp (which NIP-17 jitters ±2 days), so pagination is fuzzy at
 * the boundaries — callers dedupe by id and walk the `until` cursor backward.
 */
export function fetchChannelMessages(
    group: GroupKeypair,
    opts: { until?: number; since?: number; limit?: number } = {},
    relays: string[] = NBMS_DEFAULT_RELAYS,
): Promise<{ msg: NbmsUnwrapped; raw: Event }[]> {
    return new Promise(resolve => {
        const sockets: WebSocket[] = [];
        const subId = 'nbmsfc_' + Math.random().toString(36).slice(2, 8);
        const seen = new Set<string>();
        const out: { msg: NbmsUnwrapped; raw: Event }[] = [];
        let eose = 0;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            sockets.forEach(ws => { try { ws.close(); } catch { } });
            resolve(out);
        };
        const filter: Record<string, unknown> = { kinds: [KIND_GIFT_WRAP], '#p': [group.pubkey], limit: opts.limit ?? 40 };
        if (opts.until !== undefined) filter.until = opts.until;
        if (opts.since !== undefined) filter.since = opts.since;
        const timer = setTimeout(finish, 6000);
        for (const url of relays) {
            try {
                const ws = new WebSocket(url);
                sockets.push(ws);
                ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'EVENT' && data[2]) {
                            const raw = data[2] as Event;
                            if (seen.has(raw.id)) return;
                            seen.add(raw.id);
                            const u = unwrapGroupMessage(raw, group);
                            if (u) out.push({ msg: u, raw });
                        }
                        if (data[0] === 'EOSE' && ++eose >= sockets.length) finish();
                    } catch { }
                };
                ws.onerror = () => { };
            } catch { }
        }
    });
}
