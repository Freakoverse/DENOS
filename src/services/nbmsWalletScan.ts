/**
 * NIP-NBMS — Phase 5: balance / address scanning + history for multisig wallets.
 *
 * Uses the Esplora `/address/{addr}` (chain_stats) and `/address/{addr}/txs` endpoints,
 * reusing the user's configured Bitcoin nodes from bitcoin.ts.
 */
import { bitcoinNodes } from './bitcoin';
import { deriveMultisigAddress } from './nbmsWallet';

export interface AddrStats {
    funded: number;
    spent: number;
    txCount: number;
    /** True when every node failed to answer for this address — the stats are UNKNOWN, not zero. */
    failed?: boolean;
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Public Esplora instances rate-limit
 * (HTTP 429) a large parallel burst, so scanning must be throttled rather than firing every
 * address lookup at once.
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

/**
 * Fetch a path from the first responsive node. On total failure (every node erroring or
 * rate-limiting) the whole node set is retried a couple of times with a short backoff, since
 * a burst of parallel address lookups can trip public Esplora rate limits transiently. Throws
 * only if every attempt fails — callers rely on that to distinguish "node down" from "empty".
 */
async function fetchNode(path: string): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
        for (const base of bitcoinNodes.getNodes()) {
            try {
                const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10000) });
                if (res.ok) return res;
                lastErr = new Error(`${base}: HTTP ${res.status}`);
            } catch (e) {
                lastErr = e;
            }
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
    throw lastErr ?? new Error('all Bitcoin nodes failed');
}

export async function fetchAddressStats(address: string): Promise<AddrStats> {
    const d = await (await fetchNode(`/address/${address}`)).json();
    const c = d.chain_stats ?? {};
    const mp = d.mempool_stats ?? {};
    // Count mempool alongside confirmed, so a still-pending deposit or spend already marks the
    // address used (advances the receive index) and shows up in the balance.
    return {
        funded: (c.funded_txo_sum ?? 0) + (mp.funded_txo_sum ?? 0),
        spent: (c.spent_txo_sum ?? 0) + (mp.spent_txo_sum ?? 0),
        txCount: (c.tx_count ?? 0) + (mp.tx_count ?? 0),
    };
}

/**
 * Resilient per-address stats: on hard failure (all nodes down after retries) returns a
 * `failed` sentinel instead of throwing, so one flaky lookup can't sink the whole scan. A
 * failed read is treated as UNKNOWN (never as an unused/zero address), so it can't wrongly
 * reset the receive index or blank the balance.
 */
async function statOf(address: string): Promise<AddrStats> {
    try {
        return await fetchAddressStats(address);
    } catch {
        return { funded: 0, spent: 0, txCount: 0, failed: true };
    }
}

async function fetchAddressTxs(address: string): Promise<any[]> {
    return (await fetchNode(`/address/${address}/txs`)).json();
}

export interface ScannedAddress {
    address: string;
    index: number;
    chain: 0 | 1;
    used: boolean;
    balance: number; // sats
}

export interface WalletScan {
    balance: number;            // sats (receive + change)
    nextReceiveIndex: number;
    nextReceiveAddress: string;
    usedReceive: number;
    /** Every address (receive + change) that has on-chain history — used for history lookup. */
    usedAddresses: string[];
    /** All addresses the walk derived (used + unused), per chain. */
    receive: ScannedAddress[];
    change: ScannedAddress[];
}

/**
 * Scan a wallet by walking the receive and change chains in batches of `batch`. Keeps
 * scanning the next batch until a full batch has zero history, then stops (gap-limit walk).
 * `maxBatches` caps the walk as a safety bound for pathological cases.
 */
export async function scanWallet(
    keys: { xpub: string }[],
    m: number,
    batch = 10,
    maxBatches = 20,
): Promise<WalletScan> {
    // Throttled, resilient walk. Individual address failures become `failed` sentinels (never
    // treated as empty), so a transient rate-limit can't reset the receive index or blank the
    // balance. Only a whole batch failing (nodes truly unreachable) stops the walk.
    const scanChain = async (chain: 0 | 1) => {
        const stats: AddrStats[] = [];
        const addrs: string[] = [];
        for (let b = 0; b < maxBatches; b++) {
            const batchAddrs = Array.from({ length: batch }, (_, i) => deriveMultisigAddress(keys, m, chain, b * batch + i));
            const batchStats = await mapLimit(batchAddrs, 4, statOf);
            stats.push(...batchStats);
            addrs.push(...batchAddrs);
            if (batchStats.every(s => s.failed)) break;                       // nodes unreachable — stop walking
            if (batchStats.every(s => !s.failed && s.txCount === 0)) break;   // genuinely empty batch — end of walk
        }
        return { stats, addrs };
    };

    const recv = await scanChain(0);
    const chg = await scanChain(1);

    // If literally nothing could be read, this is a node outage — surface it so the caller keeps
    // the last-known-good scan (and shows an error) rather than displaying a bogus empty wallet.
    const all = [...recv.stats, ...chg.stats];
    if (all.length > 0 && all.every(s => s.failed)) throw new Error('Bitcoin nodes unreachable');

    let balance = 0;
    recv.stats.forEach(s => { if (!s.failed) balance += s.funded - s.spent; });
    chg.stats.forEach(s => { if (!s.failed) balance += s.funded - s.spent; });

    // Next receive index = highest KNOWN-used index + 1. This never hands out an already-used
    // address, and never resets to 0 while address 0's usage is readable (the earlier
    // findIndex-of-first-gap could reset to 0 if a used address read back as failed/empty).
    let lastUsed = -1;
    recv.stats.forEach((s, i) => { if (!s.failed && s.txCount > 0) lastUsed = i; });
    const nextReceiveIndex = lastUsed + 1;
    const nextReceiveAddress = recv.addrs[nextReceiveIndex] ?? deriveMultisigAddress(keys, m, 0, nextReceiveIndex);

    const toScanned = (chain: 0 | 1, addrs: string[], stats: AddrStats[]): ScannedAddress[] =>
        addrs.map((address, i) => ({ address, index: i, chain, used: !stats[i].failed && stats[i].txCount > 0, balance: stats[i].failed ? 0 : stats[i].funded - stats[i].spent }));

    const receive = toScanned(0, recv.addrs, recv.stats);
    const change = toScanned(1, chg.addrs, chg.stats);

    return {
        balance,
        nextReceiveIndex,
        nextReceiveAddress,
        usedReceive: recv.stats.filter(s => !s.failed && s.txCount > 0).length,
        usedAddresses: [...receive, ...change].filter(a => a.used).map(a => a.address),
        receive,
        change,
    };
}

export interface NbmsTx {
    txid: string;
    confirmed: boolean;
    blockTime?: number;
    delta: number; // net sats to the wallet (positive = received, negative = sent)
    fee: number;
}

/**
 * Build the wallet's transaction history from its used addresses. Net delta per tx is
 * computed from outputs to / inputs from the wallet's own address set.
 */
export async function fetchWalletHistory(addresses: string[]): Promise<NbmsTx[]> {
    if (addresses.length === 0) return [];
    const set = new Set(addresses);
    const byTxid = new Map<string, any>();

    let anyOk = false;
    await mapLimit(addresses, 4, async addr => {
        try {
            const txs = await fetchAddressTxs(addr);
            anyOk = true;
            for (const t of txs) byTxid.set(t.txid, t);
        } catch { /* skip this address */ }
    });
    // If not a single address could be fetched, this is a node failure — surface it rather than
    // returning an empty list that the UI would render as "no transactions".
    if (!anyOk) throw new Error('Could not load transaction history — Bitcoin nodes unreachable');

    const out: NbmsTx[] = [];
    for (const tx of byTxid.values()) {
        let received = 0, sent = 0;
        for (const v of tx.vout ?? []) {
            if (v.scriptpubkey_address && set.has(v.scriptpubkey_address)) received += v.value;
        }
        for (const v of tx.vin ?? []) {
            if (v.prevout?.scriptpubkey_address && set.has(v.prevout.scriptpubkey_address)) sent += v.prevout.value;
        }
        out.push({
            txid: tx.txid,
            confirmed: !!tx.status?.confirmed,
            blockTime: tx.status?.block_time,
            delta: received - sent,
            fee: tx.fee ?? 0,
        });
    }
    // Newest first; unconfirmed (no block time) on top.
    out.sort((a, b) => (b.blockTime ?? Number.MAX_SAFE_INTEGER) - (a.blockTime ?? Number.MAX_SAFE_INTEGER));
    return out;
}
