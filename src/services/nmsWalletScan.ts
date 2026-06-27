/**
 * NIP-NMS — Phase 5: balance / address scanning + history for multisig wallets.
 *
 * Uses the Esplora `/address/{addr}` (chain_stats) and `/address/{addr}/txs` endpoints,
 * reusing the user's configured Bitcoin nodes from bitcoin.ts.
 */
import { bitcoinNodes } from './bitcoin';
import { deriveMultisigAddress } from './nmsWallet';

export interface AddrStats {
    funded: number;
    spent: number;
    txCount: number;
}

export async function fetchAddressStats(address: string): Promise<AddrStats> {
    let lastErr: unknown;
    for (const base of bitcoinNodes.getNodes()) {
        try {
            const res = await fetch(`${base}/address/${address}`, { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const d = await res.json();
                const c = d.chain_stats ?? {};
                return { funded: c.funded_txo_sum ?? 0, spent: c.spent_txo_sum ?? 0, txCount: c.tx_count ?? 0 };
            }
            lastErr = new Error(`${base}: HTTP ${res.status}`);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr ?? new Error('address stats failed');
}

async function fetchAddressTxs(address: string): Promise<any[]> {
    let lastErr: unknown;
    for (const base of bitcoinNodes.getNodes()) {
        try {
            const res = await fetch(`${base}/address/${address}/txs`, { signal: AbortSignal.timeout(8000) });
            if (res.ok) return await res.json();
            lastErr = new Error(`${base}: HTTP ${res.status}`);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr ?? new Error('address txs failed');
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
    const safe = (a: string) => fetchAddressStats(a).catch(() => ({ funded: 0, spent: 0, txCount: 0 } as AddrStats));

    const scanChain = async (chain: 0 | 1) => {
        const stats: AddrStats[] = [];
        const addrs: string[] = [];
        for (let b = 0; b < maxBatches; b++) {
            const batchAddrs = Array.from({ length: batch }, (_, i) => deriveMultisigAddress(keys, m, chain, b * batch + i));
            const batchStats = await Promise.all(batchAddrs.map(safe));
            stats.push(...batchStats);
            addrs.push(...batchAddrs);
            if (batchStats.every(s => s.txCount === 0)) break; // a fully-empty batch ends the walk
        }
        return { stats, addrs };
    };

    const recv = await scanChain(0);
    const chg = await scanChain(1);

    let balance = 0;
    recv.stats.forEach(s => { balance += s.funded - s.spent; });
    chg.stats.forEach(s => { balance += s.funded - s.spent; });

    let nextReceiveIndex = recv.stats.findIndex(s => s.txCount === 0);
    if (nextReceiveIndex < 0) nextReceiveIndex = recv.stats.length;
    const nextReceiveAddress = recv.addrs[nextReceiveIndex] ?? deriveMultisigAddress(keys, m, 0, nextReceiveIndex);

    const toScanned = (chain: 0 | 1, addrs: string[], stats: AddrStats[]): ScannedAddress[] =>
        addrs.map((address, i) => ({ address, index: i, chain, used: stats[i].txCount > 0, balance: stats[i].funded - stats[i].spent }));

    const receive = toScanned(0, recv.addrs, recv.stats);
    const change = toScanned(1, chg.addrs, chg.stats);

    return {
        balance,
        nextReceiveIndex,
        nextReceiveAddress,
        usedReceive: recv.stats.filter(s => s.txCount > 0).length,
        usedAddresses: [...receive, ...change].filter(a => a.used).map(a => a.address),
        receive,
        change,
    };
}

export interface NmsTx {
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
export async function fetchWalletHistory(addresses: string[]): Promise<NmsTx[]> {
    if (addresses.length === 0) return [];
    const set = new Set(addresses);
    const byTxid = new Map<string, any>();

    await Promise.all(addresses.map(async addr => {
        try {
            const txs = await fetchAddressTxs(addr);
            for (const t of txs) byTxid.set(t.txid, t);
        } catch { /* skip this address */ }
    }));

    const out: NmsTx[] = [];
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
