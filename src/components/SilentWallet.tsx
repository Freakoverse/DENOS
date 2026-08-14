/**
 * SilentWallet — Nostr Silent Payments tab (HD-wallet-like).
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { QRCodeSVG } from 'qrcode.react';
import {
    EyeOff, Copy, Check, ChevronDown, Search, X, QrCode,
    Bell, ArrowDownLeft, ArrowUpRight, RefreshCw, Loader2, AlertTriangle,
    Send as SendIcon, ExternalLink, Wallet, Fuel, Users, Trash2, Inbox,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

import { useFeedback } from '@/components/ui/feedback';
import { chainIcons, tokenIcons } from '@/assets/icons/blockchain';
import { EVM_CHAINS } from '@/services/evm';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SatoshiIcon } from '@/components/SatoshiIcon';
import { satsToBTC, fetchTxHistory } from '@/services/bitcoin';
import {
    createMultiKeyTaprootTransaction,
    createMultiKeySegwitTransaction,
    broadcastTransaction, fetchUTXOs, type UTXO,
} from '@/services/bitcoin';
import {
    sendEvmTransaction, sendTokenTransaction,
    fetchEvmBalance, fetchTokenBalance,
    getGasEstimate, formatUnits,
    fetchEvmTxHistory,
} from '@/services/evm';
import {
    createZcashTransaction, broadcastZcashTransaction,
    fetchZcashUTXOs, fetchZcashBalance,
} from '@/services/zcash';
import { getFeeRates } from '@/services/bitcoin';
import { FollowsSelector } from '@/components/FollowsSelector';
import { nip19 } from 'nostr-tools';
import {
    tweakPrivateKey,
    getSigningKey,
    buildPaymentURI,
    subscribeToNspNotifications,
    parseNspNotification,
    createNspNotification,
    createDeterministicNspNotification,
    selectNspIndex,
    deriveNspSend,
    nspAddressHasHistory,
    markNspAddressPending,
    recoverNspPayments,
    publishNspNotification,
    fetchExistingNotification,
    loadNspIndex,
    saveNspIndex,
    loadAllNspPages,
    addConfirmedPayments,
    removePaymentsFromPages,
    catchUpScan,
    loadSentList,
    saveSentList,
    verifyNspPayloadOwnership,
    nspTweakFromSender,
    setNspUserRelays,
    fetchRelayList,
    type NspChain,
    type NspPayload,
    type NspConfirmedPayment,
    type NspSentEntry,
    type NspIndex,
    type RelayPublishResult,
} from '@/services/nsp';
import { nspCacheGet, nspCacheSet } from '@/services/nspCache';

// ── Chain / Asset Definitions ──

interface ChainOption {
    id: NspChain;
    name: string;
    icon: string;
}

const CHAINS: ChainOption[] = [
    { id: 'bitcoin', name: 'Bitcoin', icon: chainIcons.bitcoin },
    { id: 'ethereum', name: 'Ethereum', icon: chainIcons.ethereum },
    { id: 'bnb', name: 'BNB Chain', icon: chainIcons.bnb },
    { id: 'polygon', name: 'Polygon', icon: chainIcons.polygon },
    { id: 'avalanche', name: 'Avalanche', icon: chainIcons.avalanche },
    { id: 'base', name: 'Base', icon: chainIcons.base },
    { id: 'zcash', name: 'Zcash', icon: chainIcons.zcash },
];

interface AssetOption {
    id: string;
    label: string;
    token: string | null;
    icon?: string;
}

function getAssetsForChain(chain: NspChain): AssetOption[] {
    if (chain === 'bitcoin') return [
        { id: 'taproot', label: 'Taproot (P2TR)', token: null, icon: chainIcons.bitcoin },
        { id: 'native', label: 'Native SegWit', token: null, icon: chainIcons.bitcoin },
    ];
    if (chain === 'zcash') return [
        { id: 'transparent', label: 'Transparent', token: null, icon: chainIcons.zcash },
    ];
    const evmChain = EVM_CHAINS[chain];
    if (!evmChain) return [];
    return evmChain.tokens.map(t => ({
        id: t.symbol.toLowerCase(),
        label: t.name,
        token: t.contractAddress,
        icon: t.icon,
    }));
}

// ── Props ──

interface SilentWalletProps {
    activePubkey: string | null;
}

// ── TEMP: Demo censoring — replace addresses/txids with stars ──
const CENSOR_ENABLED = true;
const censor = (s: string, prefixLen = 6, suffixLen = 4) => {
    if (!CENSOR_ENABLED || !s || s.length < prefixLen + suffixLen + 4) return s;
    return s.slice(0, prefixLen) + '****' + s.slice(-suffixLen);
};

// ── Component ──

/**
 * Build a confirmed payment record from a notification payload. The spending tweak is taken
 * from the payload (legacy) or recomputed from (sender, n) for deterministic payments; the
 * deterministic provenance (sender, n) is preserved so the entry is re-derivable from the
 * nsec alone. Addresses are the stable per-payment identity (unique per n).
 */
function buildConfirmedFromPayload(payload: NspPayload, privHex: string): NspConfirmedPayment {
    const tweak = payload.tweak ?? nspTweakFromSender(privHex, payload.sender!, payload.n!);
    return {
        chain: payload.chain,
        address: payload.address,
        tweak,
        asset: payload.asset,
        token: payload.token,
        txid: payload.txid,
        amount: payload.amount,
        confirmedAt: Math.floor(Date.now() / 1000),
        sender: payload.sender,
        n: payload.n,
    };
}

export function SilentWallet({ activePubkey }: SilentWalletProps) {
    const { toast } = useFeedback();

    // ── Chain/Asset state (mirrors native tab) ──
    const [chain, setChain] = useState<NspChain>('bitcoin');
    const [asset, setAsset] = useState('taproot');
    const skipAssetResetRef = useRef(false);
    const [privateKeyHex, setPrivateKeyHex] = useState('');
    const [copiedId, setCopiedId] = useState<string | null>(null);

    // Modals
    const [showChainModal, setShowChainModal] = useState(false);
    const [showAssetModal, setShowAssetModal] = useState(false);
    const [chainSearch, setChainSearch] = useState('');
    const [showReceiveModal, setShowReceiveModal] = useState(false);
    const [showNotifications, setShowNotifications] = useState(false);
    const [showAllNotifications, setShowAllNotifications] = useState(false);
    const [showSelfAddrs, setShowSelfAddrs] = useState(false);
    const [generatedIndex, setGeneratedIndex] = useState<number | null>(null);

    // Cleanup / pruning state
    const [showCleanup, setShowCleanup] = useState(false);
    const [cleanupLoading, setCleanupLoading] = useState(false);
    const [cleanupEntries, setCleanupEntries] = useState<{ payment: NspConfirmedPayment; balance: number }[]>([]);
    const [cleanupSelected, setCleanupSelected] = useState<Set<string>>(new Set());
    const [cleanupRemoving, setCleanupRemoving] = useState(false);

    // Receive state
    const [amount, setAmount] = useState('');
    const [generatedAddress, setGeneratedAddress] = useState('');
    const [currentTweak, setCurrentTweak] = useState('');
    const [qrUri, setQrUri] = useState('');


    // Notifications state
    const [notifView, setNotifView] = useState<'unconfirmed' | 'confirmed'>('unconfirmed');
    const [unconfirmed, setUnconfirmed] = useState<{ event: any; payload: NspPayload; checking: boolean; verified: boolean }[]>([]);
    const [confirmed, setConfirmed] = useState<(NspConfirmedPayment & { liveBalance?: string })[]>([]);
    // Which account the in-memory confirmed/sent lists belong to. Guards the cache-mirror effects
    // so a mid-account-switch render (new activePubkey, still-stale lists) can't write one account's
    // payments into another account's cache — the source of the cross-account contamination.
    const nspOwnerRef = useRef<string | null>(null);
    const [nspIndex, setNspIndex] = useState<NspIndex | null>(null);
    const [loadingNotifs, setLoadingNotifs] = useState(false);
    const [showSilentWarning, setShowSilentWarning] = useState(() => {
        const dismissed = localStorage.getItem('silent_warning_dismissed');
        if (!dismissed) return true;
        return Date.now() > parseInt(dismissed, 10);
    });
    const dismissSilentWarning = () => {
        const threeDays = 3 * 24 * 60 * 60 * 1000;
        localStorage.setItem('silent_warning_dismissed', String(Date.now() + threeDays));
        setShowSilentWarning(false);
    };

    // ── Aggregated balance state ──
    const [nspBalances, setNspBalances] = useState<Map<string, number>>(new Map());
    const [balanceLoading, setBalanceLoading] = useState(false);

    // ── List tabs & tx history ──
    const [listTab, setListTab] = useState<'transactions' | 'addresses'>('transactions');
    const [txHistory, setTxHistory] = useState<{ txid: string; time: number; amount: string; isReceive: boolean; address: string; confirmed: boolean; addresses?: string[] }[]>([]);
    const [txLoading, setTxLoading] = useState(false);
    const [selectedNspTx, setSelectedNspTx] = useState<{ txid: string; time: number; amount: string; isReceive: boolean; address: string; confirmed: boolean; addresses?: string[] } | null>(null);

    // ── Sent list (NIP-78 d = nostr-silent-payment-sent-list) ──
    const [sentList, setSentList] = useState<NspSentEntry[]>([]);

    // ── Detail modal renotify flow ──
    const [detailPage, setDetailPage] = useState<'info' | 'renotify'>('info');
    const [fetchingNotif, setFetchingNotif] = useState(false);
    const [existingNotifEvent, setExistingNotifEvent] = useState<any | null>(null);
    const [renotifyLoading, setRenotifyLoading] = useState(false);
    const [renotifyResults, setRenotifyResults] = useState<RelayPublishResult[]>([]);
    const [renotifyDone, setRenotifyDone] = useState(false);

    // ── Address detail modal ──
    const [detailPayment, setDetailPayment] = useState<NspConfirmedPayment | null>(null);

    // ── Gas Station (EVM only) ──
    type GasStationStep = 'select' | 'fund' | 'distributing' | 'done';
    interface GasAddrInfo {
        payment: NspConfirmedPayment;
        gasBalance: bigint;
        tokenBalance: bigint;
        needsGas: boolean;
    }
    const [showGasStation, setShowGasStation] = useState(false);
    const [gasStep, setGasStep] = useState<GasStationStep>('select');
    const [gasAddresses, setGasAddresses] = useState<GasAddrInfo[]>([]);
    const [gasSelected, setGasSelected] = useState<Set<string>>(new Set());
    const [gasHandler, setGasHandler] = useState<NspConfirmedPayment | null>(null);
    const [gasPrice, setGasPrice] = useState(0n);
    const [gasHandlerBalance, setGasHandlerBalance] = useState(0n);
    const [gasDistProgress, setGasDistProgress] = useState(0);
    const [gasDistTotal, setGasDistTotal] = useState(0);
    const [gasDistError, setGasDistError] = useState('');
    const [gasLoading, setGasLoading] = useState(false);
    const [gasPolling, setGasPolling] = useState(false);

    // Get private key
    useEffect(() => {
        if (!activePubkey) return;
        invoke<string>('export_private_key_hex', { pubkey: activePubkey })
            .then(setPrivateKeyHex)
            .catch(e => console.error('Failed to get private key:', e));
    }, [activePubkey]);

    // Feed the user's own relays (configured + published NIP-65) into the NSP relay set,
    // so the user's payment list / sent list / scan don't depend solely on hardcoded relays.
    useEffect(() => {
        if (!activePubkey) return;
        const urls: string[] = [];
        invoke<{ user_relays?: { url: string }[] }>('get_signer_state')
            .then(s => { for (const r of s.user_relays ?? []) urls.push(r.url); })
            .catch(() => { })
            .finally(() => {
                fetchRelayList(activePubkey)
                    .then(nip65 => setNspUserRelays([...urls, ...nip65]))
                    .catch(() => setNspUserRelays(urls));
            });
    }, [activePubkey]);

    // Reset asset when chain changes (skip if explicitly set via All Notifications nav)
    useEffect(() => {
        if (skipAssetResetRef.current) {
            skipAssetResetRef.current = false;
        } else {
            const assets = getAssetsForChain(chain);
            if (assets.length > 0) setAsset(assets[0].id);
        }
        setGeneratedAddress('');
        setCurrentTweak('');
        setGeneratedIndex(null);
        setQrUri('');
    }, [chain]);

    const currentChain = CHAINS.find(c => c.id === chain)!;
    const assets = getAssetsForChain(chain);
    const currentAsset = assets.find(a => a.id === asset) || assets[0];

    // Copy helper
    const copyText = (text: string, id: string) => {
        navigator.clipboard.writeText(text);
        setCopiedId(id);
        toast('Copied!', 'success');
        setTimeout(() => setCopiedId(null), 2000);
    };

    // ── Generate Address (in-person / self receive) ──
    // Self-ECDH (sender = own npub) at the lowest unused index. Deterministic and
    // recoverable from the nsec alone — no notification needed for these.
    const handleGenerate = async () => {
        if (!privateKeyHex || !activePubkey) return;
        setGenerating(true);
        try {
            const { address, tweak, n } = await selectNspIndex(
                chain as NspChain, activePubkey, privateKeyHex, asset,
                { evmDefaultIndex: nspIndex?.evm_default_index },
            );
            setCurrentTweak(tweak);
            setGeneratedIndex(n);
            setGeneratedAddress(address);
            setQrUri(buildPaymentURI(chain, address, amount || undefined, currentAsset?.token));
        } catch (e) {
            console.error('[NSP] generate failed:', e);
            toast('Could not generate a fresh address (network?). Try again.', 'error');
        } finally {
            setGenerating(false);
        }
    };

    // The receive address is deterministic (self-ECDH at the lowest unused index), so there is
    // nothing to "roll" — derive and show it as soon as the key is available.
    useEffect(() => {
        if (!privateKeyHex || !activePubkey || generatedAddress || generating) return;
        void handleGenerate();
    }, [privateKeyHex, activePubkey, chain, asset, generatedAddress]); // eslint-disable-line react-hooks/exhaustive-deps

    // Watch the generated address so an incoming payment surfaces on its own. Nothing is ever lost
    // without this — the address is re-derivable and Recover walks the indices — it just removes
    // the need for a notification or a manual scan in the in-person flow.
    const autoRecordedRef = useRef<string>('');
    useEffect(() => {
        if (!generatedAddress || !privateKeyHex || !activePubkey || generatedIndex === null) return;
        if (autoRecordedRef.current === generatedAddress) return;
        let cancelled = false;
        const check = async () => {
            if (cancelled || autoRecordedRef.current === generatedAddress) return;
            try {
                const funded = ['ethereum', 'bnb', 'polygon', 'avalanche', 'base'].includes(chain)
                    ? (await fetchEvmBalance(chain, generatedAddress)) > 0n
                    : await nspAddressHasHistory(chain as NspChain, generatedAddress);
                if (!funded || cancelled) return;
                autoRecordedRef.current = generatedAddress;
                const entry: NspConfirmedPayment = {
                    chain: chain as NspChain, address: generatedAddress, tweak: currentTweak,
                    asset, token: currentAsset?.token ?? null, txid: '', amount: '0',
                    confirmedAt: Math.floor(Date.now() / 1000),
                    sender: nip19.npubEncode(activePubkey), n: generatedIndex,
                };
                const prev = confirmed;
                setConfirmed(c => c.some(p => p.address === entry.address) ? c : [...c, entry]);
                if (nspIndex) {
                    const idx = await addConfirmedPayments(privateKeyHex, activePubkey, nspIndex, [entry], prev);
                    setNspIndex(idx);
                }
                toast('Payment received — added to your balance', 'success');
            } catch { /* transient (network) — retried on the next tick */ }
        };
        void check();
        const timer = setInterval(check, 20_000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [generatedAddress, generatedIndex, chain, asset, privateKeyHex, activePubkey, nspIndex, confirmed]); // eslint-disable-line react-hooks/exhaustive-deps

    // Discover payments to PREVIOUS self-addresses — e.g. paid while the app was closed. The
    // gap-walk silently skips used indices when deriving a fresh address, so without this such a
    // payment would never be recorded. Quiet: only speaks up when it actually finds something.
    const scanSelfForMissed = useCallback(async () => {
        if (!privateKeyHex || !activePubkey) return;
        try {
            const results = await recoverNspPayments(
                chain as NspChain, asset, activePubkey, privateKeyHex,
                { token: currentAsset?.token ?? null },
            );
            const known = new Set(confirmed.map(p => p.address));
            const found: NspConfirmedPayment[] = results
                .filter(r => !known.has(r.address))
                .map(r => ({
                    chain: r.chain, address: r.address, tweak: r.tweak, asset: r.asset,
                    token: currentAsset?.token ?? null, txid: '', amount: String(r.balance),
                    confirmedAt: Math.floor(Date.now() / 1000), sender: r.sender, n: r.n,
                }));
            if (found.length === 0) return;
            const prev = confirmed;
            setConfirmed(c => [...c, ...found.filter(f => !c.some(p => p.address === f.address))]);
            if (nspIndex) {
                const idx = await addConfirmedPayments(privateKeyHex, activePubkey, nspIndex, found, prev);
                setNspIndex(idx);
            }
            toast(`Found ${found.length} payment${found.length !== 1 ? 's' : ''} to your addresses`, 'success');
        } catch { /* quiet — refresh should never nag */ }
    }, [privateKeyHex, activePubkey, chain, asset, confirmed, nspIndex, currentAsset]); // eslint-disable-line react-hooks/exhaustive-deps

    // Every self-address up to the current index, derived locally (pure crypto, no network) so the
    // user can see which indices have been used and confirm nothing was missed.
    const selfAddresses = useMemo(() => {
        if (!privateKeyHex || !activePubkey) return [];
        const mine = confirmed.filter(p => p.chain === chain && p.asset === asset);
        const byAddr = new Map(mine.map(p => [p.address, p]));
        const maxN = Math.max(
            generatedIndex ?? 0,
            ...mine.map(p => (typeof p.n === 'number' ? p.n : 0)),
            0,
        );
        const rows: { n: number; address: string; received: boolean; balance?: number; current: boolean }[] = [];
        for (let n = 0; n <= maxN; n++) {
            try {
                const { address } = deriveNspSend(chain as NspChain, activePubkey, privateKeyHex, n, asset);
                const rec = byAddr.get(address);
                rows.push({
                    n, address,
                    received: !!rec,
                    balance: rec ? nspBalances.get(rec.tweak) : undefined,
                    current: address === generatedAddress,
                });
            } catch { /* skip an underivable index */ }
        }
        return rows;
    }, [privateKeyHex, activePubkey, chain, asset, confirmed, generatedIndex, generatedAddress, nspBalances]);

    // ── Helper: resolve token decimals from EVM_CHAINS registry ──
    const getTokenDecimals = (chainId: string, token: string | null): number => {
        const evmChain = EVM_CHAINS[chainId];
        if (!evmChain) return 18;
        if (!token) {
            // Native token — find the entry with null contractAddress
            const native = evmChain.tokens.find(t => t.contractAddress === null);
            return native?.decimals ?? 18;
        }
        const match = evmChain.tokens.find(
            t => t.contractAddress?.toLowerCase() === token.toLowerCase()
        );
        return match?.decimals ?? 18;
    };

    // ── Aggregated balance fetching ──
    const filteredConfirmed = confirmed.filter(p => p.chain === chain && p.asset.toLowerCase() === asset.toLowerCase());

    const fetchAllNspBalances = useCallback(async () => {
        if (filteredConfirmed.length === 0) { setNspBalances(new Map()); return; }
        setBalanceLoading(true);
        const results = await Promise.allSettled(
            filteredConfirmed.map(async (p) => {
                if (p.chain === 'bitcoin') {
                    const utxos = await fetchUTXOs(p.address);
                    return { tweak: p.tweak, balance: utxos.reduce((s, u) => s + u.value, 0) };
                } else if (['ethereum', 'bnb', 'polygon', 'avalanche', 'base'].includes(p.chain)) {
                    const decimals = getTokenDecimals(p.chain, p.token);
                    const bal = p.token
                        ? await fetchTokenBalance(p.chain, p.token, p.address)
                        : await fetchEvmBalance(p.chain, p.address);
                    return { tweak: p.tweak, balance: parseFloat(formatUnits(bal, decimals)) };
                } else if (p.chain === 'zcash') {
                    const bal = await fetchZcashBalance(p.address);
                    return { tweak: p.tweak, balance: bal };
                }
                return { tweak: p.tweak, balance: 0 };
            })
        );
        const map = new Map<string, number>();
        for (const r of results) {
            if (r.status === 'fulfilled') map.set(r.value.tweak, r.value.balance);
        }
        setNspBalances(map);
        setBalanceLoading(false);
    }, [filteredConfirmed.length, chain, asset]);

    // Auto-fetch balances when confirmed list or chain changes
    useEffect(() => {
        if (confirmed.length > 0 && privateKeyHex) fetchAllNspBalances();
    }, [confirmed.length, chain, asset, privateKeyHex]);

    const totalBalance = Array.from(nspBalances.values()).reduce((s, v) => s + v, 0);
    const isBitcoin = chain === 'bitcoin';
    const isEvm = ['ethereum', 'bnb', 'polygon', 'avalanche', 'base'].includes(chain);
    const isZcash = chain === 'zcash';

    // ── Fetch aggregated tx history for all confirmed addresses ──
    const fetchNspTxHistory = useCallback(async () => {
        if (filteredConfirmed.length === 0) { setTxHistory([]); return; }
        setTxLoading(true);
        try {
            const allTxs: { txid: string; time: number; amount: string; isReceive: boolean; address: string; confirmed: boolean }[] = [];
            const results = await Promise.allSettled(
                filteredConfirmed.map(async (p) => {
                    if (p.chain === 'bitcoin') {
                        const txs = await fetchTxHistory(p.address);
                        return txs.map(tx => {
                            let net = 0;
                            tx.vin.forEach((i: any) => { if (i.prevout?.scriptpubkey_address === p.address) net -= i.prevout.value; });
                            tx.vout.forEach((o: any) => { if (o.scriptpubkey_address === p.address) net += o.value; });
                            return { txid: tx.txid, time: tx.status?.block_time || 0, confirmed: !!tx.status?.confirmed, amount: `${Math.abs(net).toLocaleString()} sats`, isReceive: net > 0, address: p.address };
                        });
                    } else if (isEvm) {
                        const txs = await fetchEvmTxHistory(p.chain, p.address);
                        const decimals = getTokenDecimals(p.chain, p.token);
                        return txs.map(tx => {
                            const val = parseFloat(formatUnits(BigInt(tx.value || '0'), tx.tokenDecimal ? parseInt(tx.tokenDecimal) : decimals));
                            const symbol = tx.tokenSymbol || currentChain.name;
                            return {
                                txid: tx.hash, time: Number(tx.timeStamp || 0),
                                amount: `${val.toFixed(6).replace(/\.?0+$/, '')} ${symbol}`,
                                isReceive: tx.to?.toLowerCase() === p.address.toLowerCase(), address: p.address, confirmed: true,
                            };
                        });
                    }
                    return [];
                })
            );
            for (const r of results) if (r.status === 'fulfilled') allTxs.push(...r.value);

            // Merge entries with the same txid (e.g. multi-address sends that aggregate UTXOs)
            const txMap = new Map<string, typeof allTxs[0] & { addresses: string[] }>();
            for (const tx of allTxs) {
                const key = tx.txid + (tx.isReceive ? '_in' : '_out');
                const existing = txMap.get(key);
                if (existing) {
                    // Same txid + same direction → combine amounts
                    const existingVal = parseInt(existing.amount.replace(/[^0-9]/g, '')) || 0;
                    const newVal = parseInt(tx.amount.replace(/[^0-9]/g, '')) || 0;
                    if (isBitcoin) {
                        existing.amount = `${(existingVal + newVal).toLocaleString()} sats`;
                    } else {
                        existing.amount = tx.amount; // EVM/Zcash: keep as-is (same tx = same value)
                    }
                    if (!existing.addresses.includes(tx.address)) {
                        existing.addresses.push(tx.address);
                    }
                    // Prefer confirmed status
                    if (tx.confirmed) existing.confirmed = true;
                    if (tx.time && (!existing.time || tx.time > existing.time)) existing.time = tx.time;
                } else {
                    txMap.set(key, { ...tx, addresses: [tx.address] });
                }
            }
            const mergedTxs = Array.from(txMap.values()).map(({ addresses, ...rest }) => ({
                ...rest,
                address: addresses.length > 1 ? addresses[0] : rest.address,
                addresses: addresses.length > 1 ? addresses : undefined,
            }));
            mergedTxs.sort((a, b) => (b.time || Infinity) - (a.time || Infinity));
            setTxHistory(mergedTxs);
        } catch (e) { console.error('TX history fetch error:', e); }
        setTxLoading(false);
    }, [filteredConfirmed.length, chain, asset]);

    useEffect(() => {
        if (confirmed.length > 0 && privateKeyHex) fetchNspTxHistory();
    }, [confirmed.length, chain, asset, privateKeyHex]);

    // ── Load Notifications ──
    useEffect(() => {
        if (!activePubkey || !privateKeyHex) return;
        const owner = activePubkey;
        // Entering a new account context: clear the previous account's lists and mark ownership as
        // "loading" (null) so the cache-mirror effects can't persist stale data under this key.
        nspOwnerRef.current = null;
        setConfirmed([]);
        setUnconfirmed([]);
        setNspBalances(new Map());
        setLoadingNotifs(true);
        let cancelled = false;
        let subRef: { stop: () => void } | null = null;

        // A payment belongs to this account only if this key can derive its spending key (the tweak
        // must resolve to the stored address). Drops cross-account contamination and orphaned records.
        const canDerive = (p: NspConfirmedPayment) => {
            try { getSigningKey(p.chain, privateKeyHex, p.tweak, p.address, p.asset); return true; }
            catch { return false; }
        };

        (async () => {
            // 0. Seed from local cache instantly — survives relay pruning, loads with no network.
            const cachedConfirmed = ((await nspCacheGet<NspConfirmedPayment[]>(owner, 'confirmed')) ?? []).filter(canDerive);
            if (cancelled) return;
            if (cachedConfirmed.length) setConfirmed(cachedConfirmed);

            // 1. Load index + all pages from relays
            const index = await loadNspIndex(privateKeyHex, owner);
            if (cancelled) return;
            setNspIndex(index);
            const payments = await loadAllNspPages(privateKeyHex, owner, index.last_page);
            if (cancelled) return;
            const relayConfirmed = payments.filter((p, i, arr) => arr.findIndex(x => x.address === p.address) === i);

            // Merge cache + relay (cache fills gaps the relays pruned); keep only derivable entries,
            // then claim ownership so the cache-mirror effects may persist this account's data.
            const mergedMap = new Map<string, NspConfirmedPayment>();
            for (const p of [...cachedConfirmed, ...relayConfirmed]) mergedMap.set(p.address, p);
            const merged = [...mergedMap.values()].filter(canDerive);
            nspOwnerRef.current = owner;
            setConfirmed(merged);
            nspCacheSet(owner, 'confirmed', merged);
            setLoadingNotifs(false);

            // Rebroadcast any confirmed entries the relays dropped but the cache retained.
            const relayAddrs = new Set(relayConfirmed.map(p => p.address));
            const cacheOnly = cachedConfirmed.filter(c => !relayAddrs.has(c.address));
            if (cacheOnly.length > 0) {
                addConfirmedPayments(privateKeyHex, activePubkey, index, cacheOnly, relayConfirmed)
                    .then(setNspIndex).catch(() => { });
            }

            // Purge any unconfirmed items that are already confirmed (keyed by address)
            const confirmedAddrs = new Set(merged.map(p => p.address));
            setUnconfirmed(prev => prev.filter(u => !confirmedAddrs.has(u.payload.address)));

            // 2. Catch-up scan: fetch notifications since last_scanned
            const newCursor = await catchUpScan(activePubkey, index.last_scanned, (batch) => {
                for (const event of batch) {
                    const payload = parseNspNotification(event, privateKeyHex);
                    if (!payload) continue;
                    setUnconfirmed(prev => {
                        if (prev.some(u => u.payload.address === payload.address)) return prev;
                        return [...prev, { event, payload, checking: false, verified: false }];
                    });
                }
            });

            // Update last_scanned cursor
            if (newCursor > index.last_scanned) {
                const updatedIndex = { ...index, last_scanned: newCursor };
                setNspIndex(updatedIndex);
                await saveNspIndex(privateKeyHex, activePubkey, updatedIndex);
            }

            // 3. Real-time subscription for live notifications
            const now = Math.floor(Date.now() / 1000);
            subRef = subscribeToNspNotifications(activePubkey, (event) => {
                const payload = parseNspNotification(event, privateKeyHex);
                if (!payload) return;
                setUnconfirmed(prev => {
                    if (prev.some(u => u.payload.address === payload.address)) return prev;
                    return [...prev, { event, payload, checking: false, verified: false }];
                });
                setConfirmed(prevConfirmed => {
                    if (prevConfirmed.some(p => p.address === payload.address)) {
                        setUnconfirmed(prev => prev.filter(u => u.payload.address !== payload.address));
                    }
                    return prevConfirmed;
                });
                // Update last_scanned for live events
                if (event.created_at) {
                    setNspIndex(prev => {
                        if (!prev || event.created_at <= prev.last_scanned) return prev;
                        return { ...prev, last_scanned: event.created_at };
                    });
                }
            }, now);
        })();

        // Load sent list per account: cache first, then merge with relay; rebroadcast anything lost.
        setSentList([]);
        (async () => {
            const cachedSent = (await nspCacheGet<NspSentEntry[]>(owner, 'sent')) ?? [];
            if (cancelled) return;
            if (cachedSent.length) setSentList(cachedSent);
            const { entries: relaySent } = await loadSentList(privateKeyHex, owner);
            if (cancelled) return;
            const m = new Map<string, NspSentEntry>();
            for (const e of [...cachedSent, ...relaySent]) m.set(e.txid, e);
            const mergedSent = [...m.values()];
            setSentList(mergedSent);
            nspCacheSet(owner, 'sent', mergedSent);
            const relayTxids = new Set(relaySent.map(e => e.txid));
            if (cachedSent.some(e => !relayTxids.has(e.txid))) {
                saveSentList(privateKeyHex, owner, mergedSent).catch(() => { });
            }
        })();

        return () => { cancelled = true; if (subRef) subRef.stop(); };
    }, [activePubkey, privateKeyHex]);

    // Mirror confirmed/sent state to the local cache on every change (recovery anchors). The owner
    // guard prevents a mid-switch render from writing one account's data under another's key.
    useEffect(() => { if (activePubkey && confirmed.length && nspOwnerRef.current === activePubkey) nspCacheSet(activePubkey, 'confirmed', confirmed); }, [confirmed, activePubkey]);
    useEffect(() => { if (activePubkey && sentList.length && nspOwnerRef.current === activePubkey) nspCacheSet(activePubkey, 'sent', sentList); }, [sentList, activePubkey]);

    // ── Auto-scan unconfirmed: verify ownership → confirm permanently ──
    useEffect(() => {
        if (!privateKeyHex || unconfirmed.length === 0) return;

        const newlyConfirmed: NspConfirmedPayment[] = [];
        const removedAddrs: string[] = [];

        for (const item of unconfirmed) {
            if (item.checking || item.verified) continue;

            // Verify ownership — handles deterministic (sender+n) and legacy (tweak) payloads.
            const owned = verifyNspPayloadOwnership(privateKeyHex, item.payload);
            if (!owned) {
                console.warn(`[NSP] ✗ Ownership verification FAILED — removing notification: chain=${item.payload.chain} asset=${item.payload.asset} address=${item.payload.address}`);
                removedAddrs.push(item.payload.address);
                continue;
            }

            // Ownership verified → confirm permanently (regardless of current balance)
            newlyConfirmed.push(buildConfirmedFromPayload(item.payload, privateKeyHex));
            removedAddrs.push(item.payload.address);
        }

        if (newlyConfirmed.length === 0 && removedAddrs.length === 0) return;

        // Remove processed items from unconfirmed
        if (removedAddrs.length > 0) {
            setUnconfirmed(prev => prev.filter(u => !removedAddrs.includes(u.payload.address)));
        }

        // Batch-add all newly confirmed (using functional update to avoid stale closure)
        if (newlyConfirmed.length > 0) {
            setConfirmed(prev => {
                const merged = [...prev];
                for (const p of newlyConfirmed) {
                    if (!merged.some(x => x.tweak === p.tweak)) merged.push(p);
                }
                // Save to paginated NIP-78 storage
                if (activePubkey && nspIndex) {
                    addConfirmedPayments(privateKeyHex, activePubkey, nspIndex, newlyConfirmed, prev).then(updatedIdx => {
                        setNspIndex(updatedIdx);
                    });
                }
                return merged;
            });
        }
    }, [unconfirmed, privateKeyHex]);

    // ── Manual rescan (keyed by address) ──
    const rescanItem = async (address: string) => {
        const item = unconfirmed.find(u => u.payload.address === address);
        if (!item) return;
        setUnconfirmed(prev => prev.map(u =>
            u.payload.address === address ? { ...u, checking: true } : u
        ));
        const owned = verifyNspPayloadOwnership(privateKeyHex, item.payload);
        if (owned) {
            const payment = buildConfirmedFromPayload(item.payload, privateKeyHex);
            setConfirmed(prev => {
                if (prev.some(p => p.address === payment.address)) return prev;
                const merged = [...prev, payment];
                if (activePubkey && nspIndex) {
                    addConfirmedPayments(privateKeyHex, activePubkey, nspIndex, [payment], prev).then(updatedIdx => {
                        setNspIndex(updatedIdx);
                    });
                }
                return merged;
            });
            setUnconfirmed(prev => prev.filter(u => u.payload.address !== address));
            toast('Payment verified & confirmed!', 'success');
        } else {
            setUnconfirmed(prev => prev.map(u =>
                u.payload.address === address ? { ...u, checking: false } : u
            ));
            toast('Could not verify ownership', 'info');
        }
    };

    // ── Deep recovery: walk self + known senders on the current chain to find payments
    //    whose notification/NIP-78 record was lost. Funded addresses are merged into storage. ──
    const handleRecover = async () => {
        if (!privateKeyHex || !activePubkey || recovering) return;
        setRecovering(true);
        try {
            const effectiveAsset = isBitcoin ? (btcSendMode === 'segwit' ? 'native' : 'taproot') : asset;
            // Senders to walk: self (in-person) + everyone who has paid us before.
            const senders = new Set<string>([activePubkey]);
            for (const p of confirmed) {
                if (!p.sender) continue;
                try { senders.add(nip19.decode(p.sender).data as string); } catch { /* skip */ }
            }
            const found: NspConfirmedPayment[] = [];
            const existingAddrs = new Set(confirmed.map(p => p.address));
            for (const senderHex of senders) {
                const results = await recoverNspPayments(chain as NspChain, effectiveAsset, senderHex, privateKeyHex, { token: currentAsset?.token ?? null });
                for (const r of results) {
                    if (existingAddrs.has(r.address)) continue;
                    existingAddrs.add(r.address);
                    found.push({
                        chain: r.chain, address: r.address, tweak: r.tweak, asset: r.asset,
                        token: currentAsset?.token ?? null, txid: '', amount: String(r.balance),
                        confirmedAt: Math.floor(Date.now() / 1000), sender: r.sender, n: r.n,
                    });
                }
            }
            if (found.length > 0 && nspIndex) {
                const prev = confirmed;
                setConfirmed(c => [...c, ...found]);
                const idx = await addConfirmedPayments(privateKeyHex, activePubkey, nspIndex, found, prev);
                setNspIndex(idx);
                toast(`Recovered ${found.length} payment${found.length !== 1 ? 's' : ''}`, 'success');
            } else {
                toast('No additional payments found', 'info');
            }
        } catch (e) {
            console.error('[NSP] recovery failed:', e);
            toast('Recovery failed — try again', 'error');
        } finally {
            setRecovering(false);
        }
    };

    // ── Gas Station (EVM) ──

    const GAS_LIMIT_ETH = 21000n;
    const GAS_BUDGET_TXS = 2n; // budget each address for 2 future transactions

    const openGasStation = async () => {
        if (!privateKeyHex) return;
        setShowGasStation(true);
        setGasStep('select');
        setGasSelected(new Set());
        setGasHandler(null);
        setGasDistProgress(0);
        setGasDistTotal(0);
        setGasDistError('');
        setGasLoading(true);
        setGasPolling(false);

        try {
            // Fetch gas price
            const gas = await getGasEstimate(chain);
            setGasPrice(gas.standard);

            // Scan all filtered confirmed addresses for gas and token balances
            const infos: GasAddrInfo[] = [];
            for (const p of filteredConfirmed) {
                const gasBalance = await fetchEvmBalance(p.chain, p.address);
                const tokenBalance = p.token
                    ? await fetchTokenBalance(p.chain, p.token, p.address)
                    : 0n;
                const perAddrGas = gas.standard * GAS_LIMIT_ETH * GAS_BUDGET_TXS;
                const needsGas = gasBalance < perAddrGas && (tokenBalance > 0n || (nspBalances.get(p.tweak) ?? 0) > 0);
                infos.push({ payment: p, gasBalance, tokenBalance, needsGas });
            }
            setGasAddresses(infos);

            // Pre-select addresses that need gas
            const needGasSet = new Set(infos.filter(i => i.needsGas).map(i => i.payment.tweak));
            setGasSelected(needGasSet);

            // Auto-select handler: address with the most gas
            const bestHandler = infos
                .filter(i => (nspBalances.get(i.payment.tweak) ?? 0) > 0 || i.gasBalance > 0n)
                .sort((a, b) => Number(b.gasBalance - a.gasBalance))[0];
            if (bestHandler) setGasHandler(bestHandler.payment);
        } catch (e) {
            console.error('[Gas Station] scan error:', e);
        }
        setGasLoading(false);
    };

    // Compute gas math
    const computeGasMath = () => {
        const selectedAddrs = gasAddresses.filter(a => gasSelected.has(a.payment.tweak));
        const targets = selectedAddrs.filter(a => a.payment.tweak !== gasHandler?.tweak);
        const N = targets.length;
        const perAddrBudget = gasPrice * GAS_LIMIT_ETH * GAS_BUDGET_TXS; // gas for 2 future txs
        const distributionCost = BigInt(N) * gasPrice * GAS_LIMIT_ETH; // handler → each target
        const handlerBudget = gasPrice * GAS_LIMIT_ETH * GAS_BUDGET_TXS; // handler's own gas
        const totalNeeded = distributionCost + BigInt(N) * perAddrBudget + handlerBudget;
        return { N, perAddrBudget, distributionCost, handlerBudget, totalNeeded };
    };

    // Poll handler balance
    useEffect(() => {
        if (!gasPolling || !gasHandler || gasStep !== 'fund') return;
        const interval = setInterval(async () => {
            try {
                const bal = await fetchEvmBalance(chain, gasHandler.address);
                setGasHandlerBalance(bal);
            } catch { }
        }, 5000);
        // Fetch immediately
        fetchEvmBalance(chain, gasHandler.address).then(setGasHandlerBalance).catch(() => { });
        return () => clearInterval(interval);
    }, [gasPolling, gasHandler, gasStep, chain]);

    // Distribute gas from handler to selected addresses
    const distributeGas = async () => {
        if (!privateKeyHex || !gasHandler) return;
        setGasStep('distributing');
        setGasDistError('');

        const targets = gasAddresses.filter(
            a => gasSelected.has(a.payment.tweak) && a.payment.tweak !== gasHandler.tweak
        );
        setGasDistTotal(targets.length);
        setGasDistProgress(0);

        const handlerKey = tweakPrivateKey(privateKeyHex, gasHandler.tweak);
        const perAddrBudget = gasPrice * GAS_LIMIT_ETH * GAS_BUDGET_TXS;

        try {
            for (let i = 0; i < targets.length; i++) {
                const target = targets[i];
                await sendEvmTransaction(
                    chain,
                    handlerKey,
                    target.payment.address,
                    perAddrBudget,
                    gasPrice,
                    GAS_LIMIT_ETH,
                    true, // useStandard — NSP uses natural-parity keys
                );
                setGasDistProgress(i + 1);
            }
            setGasStep('done');
            toast(`Gas distributed to ${targets.length} address${targets.length !== 1 ? 'es' : ''}!`, 'success');
        } catch (e) {
            setGasDistError(String(e));
        }
    };

    // ── Send modal state ──
    const [showSendModal, setShowSendModal] = useState(false);
    const [sendTo, setSendTo] = useState('');
    const [sendAmount, setSendAmount] = useState('');
    const [sendError, setSendError] = useState('');
    const [sendSuccess, setSendSuccess] = useState('');
    const [sendStep, setSendStep] = useState<'form' | 'review'>('form');
    const [sending, setSending] = useState(false);
    const [nspSendLoading, setNspSendLoading] = useState(false);

    // Bitcoin/Zcash: aggregated UTXOs with tagged keys
    const [taggedUtxos, setTaggedUtxos] = useState<{ utxo: UTXO; privateKeyHex: string; address: string }[]>([]);
    const [aggregatedBalance, setAggregatedBalance] = useState(0);
    const [selectedFeeRate, setSelectedFeeRate] = useState(2);
    const [feeRates, setFeeRates] = useState<{ fastestFee: number; hourFee: number; economyFee: number } | null>(null);

    // EVM: address selector
    const [evmAddressOptions, setEvmAddressOptions] = useState<{ payment: NspConfirmedPayment; balance: bigint }[]>([]);
    const [selectedEvmAddress, setSelectedEvmAddress] = useState<NspConfirmedPayment | null>(null);
    const [selectedEvmBalance, setSelectedEvmBalance] = useState<bigint>(0n);
    const [showEvmAddrDropdown, setShowEvmAddrDropdown] = useState(false);

    // For detail modal → send (single address, EVM behavior)
    const [sendPayment, setSendPayment] = useState<NspConfirmedPayment | null>(null);

    // ── "To Following" NSP flow ──
    const [showFollowsSelector, setShowFollowsSelector] = useState(false);
    const [nspRecipientPubkey, setNspRecipientPubkey] = useState<string | null>(null);
    const [nspRecipientName, setNspRecipientName] = useState('');
    const [nspRecipientTweak, setNspRecipientTweak] = useState('');
    const [nspRecipientN, setNspRecipientN] = useState<number | null>(null);
    const [nspDeriving, setNspDeriving] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [recovering, setRecovering] = useState(false);
    const [nspDerivedAddress, setNspDerivedAddress] = useState('');
    // Bitcoin send mode toggle (Taproot, SegWit, SP) — only when Bitcoin + npub recipient
    const [btcSendMode, setBtcSendMode] = useState<'taproot' | 'segwit'>('taproot');
    // Notification relay progress (post-send)
    const [nspNotifying, setNspNotifying] = useState(false);
    const [nspNotifyResults, setNspNotifyResults] = useState<RelayPublishResult[]>([]);
    const [nspNotifyDone, setNspNotifyDone] = useState(false);

    // Open send modal from main button
    const openSendModal = async (preselectedPayment?: NspConfirmedPayment) => {
        if (!privateKeyHex) return;
        setSendTo('');
        setSendAmount('');
        setSendError('');
        setSendSuccess('');
        setSendStep('form');
        setShowSendModal(true);
        setNspSendLoading(true);
        setSendPayment(preselectedPayment || null);
        // Reset "To Following" state
        setNspRecipientPubkey(null);
        setNspRecipientName('');
        setNspRecipientTweak('');
        setNspRecipientN(null);
        setNspDerivedAddress('');
        setBtcSendMode('taproot');
        setNspNotifying(false);
        setNspNotifyResults([]);
        setNspNotifyDone(false);

        try {
            if (isBitcoin) {
                // Single address or aggregate all
                const sources = preselectedPayment
                    ? [preselectedPayment]
                    : filteredConfirmed.filter(p => (nspBalances.get(p.tweak) ?? 0) > 0);
                const allTagged: { utxo: UTXO; privateKeyHex: string; address: string }[] = [];
                let total = 0;
                const skipped: string[] = [];
                for (const p of sources) {
                    // Isolate each address: a UTXO-fetch failure or an un-derivable stored tweak
                    // (e.g. an orphaned record from an older format) must NOT abort the whole send.
                    let utxos: UTXO[];
                    try {
                        utxos = await fetchUTXOs(p.address);
                    } catch (e) {
                        console.warn('[NSP Send] UTXO fetch failed for', p.address, e);
                        skipped.push(p.address);
                        continue;
                    }
                    if (utxos.length === 0) continue;
                    let tweakedKey: string;
                    try {
                        tweakedKey = getSigningKey(chain, privateKeyHex, p.tweak, p.address, asset);
                    } catch (e) {
                        console.warn('[NSP Send] cannot derive signing key for', p.address, '— skipping:', e);
                        skipped.push(p.address);
                        continue;
                    }
                    for (const u of utxos) {
                        allTagged.push({ utxo: u, privateKeyHex: tweakedKey, address: p.address });
                        total += u.value;
                    }
                }
                setTaggedUtxos(allTagged);
                setAggregatedBalance(total);
                if (skipped.length > 0) {
                    toast(
                        allTagged.length === 0
                            ? `Couldn't prepare your funded address(es) for spending — see console. They may be from an older format.`
                            : `${skipped.length} address(es) couldn't be prepared and were skipped; spending the rest.`,
                        allTagged.length === 0 ? 'error' : 'info',
                    );
                }
                const rates = await getFeeRates();
                setFeeRates(rates);
                setSelectedFeeRate(rates.hourFee);
            } else if (isEvm) {
                // Load balance for each address
                const options: { payment: NspConfirmedPayment; balance: bigint }[] = [];
                for (const p of filteredConfirmed) {
                    const bal = p.token
                        ? await fetchTokenBalance(p.chain, p.token, p.address)
                        : await fetchEvmBalance(p.chain, p.address);
                    if (bal > 0n) options.push({ payment: p, balance: bal });
                }
                options.sort((a, b) => Number(b.balance - a.balance));
                setEvmAddressOptions(options);
                if (preselectedPayment) {
                    const match = options.find(o => o.payment.tweak === preselectedPayment.tweak);
                    setSelectedEvmAddress(match?.payment || options[0]?.payment || null);
                    setSelectedEvmBalance(match?.balance || options[0]?.balance || 0n);
                } else if (options.length > 0) {
                    setSelectedEvmAddress(options[0].payment);
                    setSelectedEvmBalance(options[0].balance);
                }
            } else if (isZcash) {
                // Single address or aggregate
                const sources = preselectedPayment
                    ? [preselectedPayment]
                    : filteredConfirmed.filter(p => (nspBalances.get(p.tweak) ?? 0) > 0);
                let total = 0;
                for (const p of sources) {
                    const bal = await fetchZcashBalance(p.address);
                    total += bal;
                }
                setAggregatedBalance(total);
            }
        } catch (e) {
            console.error('[NSP Send] Failed to load context:', e);
        } finally {
            setNspSendLoading(false);
        }
    };

    // EVM: auto-switch address when amount changes
    const handleSendAmountChange = (val: string) => {
        setSendAmount(val);
        if (isEvm && evmAddressOptions.length > 0 && val) {
            const needed = BigInt(Math.floor(parseFloat(val) * 1e18));
            const best = evmAddressOptions.find(o => o.balance >= needed);
            if (best) {
                setSelectedEvmAddress(best.payment);
                setSelectedEvmBalance(best.balance);
            }
        }
    };

    const evmInsufficientBalance = isEvm && sendAmount && selectedEvmBalance > 0n
        ? BigInt(Math.floor(parseFloat(sendAmount || '0') * 1e18)) > selectedEvmBalance
        : false;

    // ── Recipient address validation ──
    const validateRecipientAddress = (addr: string): string | null => {
        if (!addr.trim()) return null; // empty = no error yet
        // npub is valid — triggers NSP derivation
        if (addr.startsWith('npub1')) return null;
        if (isBitcoin) {
            // Bech32 (bc1q / bc1p), legacy (1...), P2SH (3...)
            if (/^bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{25,87}$/i.test(addr)) return null;
            if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(addr)) return null;
            return 'Invalid Bitcoin address';
        }
        if (isEvm) {
            if (/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
            return 'Invalid address — must be 0x followed by 40 hex characters';
        }
        if (isZcash) {
            if (/^t[13][a-km-zA-HJ-NP-Z1-9]{33}$/.test(addr)) return null;
            return 'Invalid Zcash transparent address';
        }
        return null;
    };
    const recipientError = validateRecipientAddress(sendTo);
    const isValidRecipient = sendTo.trim().length > 0 && !recipientError;

    // Keep the handleSendFromConfirmed for detail modal
    const handleSendFromConfirmed = (payment: NspConfirmedPayment) => {
        openSendModal(payment);
    };

    // Deterministically derive the NSP one-time address for a recipient: the shared-secret
    // tweak at the lowest unused index n (gap-walk for UTXO, fixed for EVM). Async (network).
    const deriveNspForRecipient = useCallback(async (pubkeyHex: string, effectiveAsset: string) => {
        if (!privateKeyHex) return;
        setNspRecipientPubkey(pubkeyHex);
        setNspDeriving(true);
        setNspDerivedAddress('');
        try {
            const { n, address, tweak } = await selectNspIndex(
                chain as NspChain, pubkeyHex, privateKeyHex, effectiveAsset,
                { evmDefaultIndex: nspIndex?.evm_default_index },
            );
            setNspRecipientN(n);
            setNspRecipientTweak(tweak);
            setNspDerivedAddress(address);
        } catch (e) {
            console.error('[NSP] address derivation failed:', e);
            setNspRecipientN(null);
            setNspDerivedAddress('');
            toast('Could not derive a fresh address (network?). Try again.', 'error');
        } finally {
            setNspDeriving(false);
        }
    }, [privateKeyHex, chain, asset, nspIndex]);

    // Handle follows selection — derive NSP address from recipient's pubkey
    const handleFollowsSelect = (npub: string) => {
        try {
            const decoded = nip19.decode(npub);
            if (decoded.type !== 'npub') throw new Error('Invalid npub');
            const pubkeyHex = decoded.data as string;
            setSendTo(npub);
            const effectiveAsset = isBitcoin ? (btcSendMode === 'segwit' ? 'native' : 'taproot') : asset;
            void deriveNspForRecipient(pubkeyHex, effectiveAsset);
        } catch (e) {
            console.error('[NSP] Failed to derive address from npub:', e);
            toast('Failed to derive NSP address for this contact', 'error');
        }
    };

    // Derive NSP address from manually typed npub
    const deriveFromNpub = (npub: string) => {
        try {
            const decoded = nip19.decode(npub);
            if (decoded.type !== 'npub') return;
            const pubkeyHex = decoded.data as string;
            if (pubkeyHex === nspRecipientPubkey) return; // don't re-derive same recipient
            setNspRecipientName('');
            const effectiveAsset = isBitcoin ? (btcSendMode === 'segwit' ? 'native' : 'taproot') : asset;
            void deriveNspForRecipient(pubkeyHex, effectiveAsset);
        } catch { /* not a valid npub yet, ignore */ }
    };

    // Re-derive the NSP address for the same recipient (re-runs the gap-walk).
    const regenerateNspAddress = () => {
        if (!nspRecipientPubkey) return;
        const effectiveAsset = isBitcoin ? (btcSendMode === 'segwit' ? 'native' : 'taproot') : asset;
        void deriveNspForRecipient(nspRecipientPubkey, effectiveAsset);
    };

    // ── Cleanup / Pruning ──
    const openCleanup = async () => {
        setShowCleanup(true);
        setCleanupLoading(true);
        setCleanupSelected(new Set());
        setCleanupEntries([]);

        try {
            // Scan ALL confirmed entries (across all chains) for zero balances
            const entries: { payment: NspConfirmedPayment; balance: number }[] = [];
            for (const p of confirmed) {
                let balance = 0;
                try {
                    if (p.chain === 'bitcoin') {
                        const utxos = await fetchUTXOs(p.address);
                        balance = utxos.reduce((s, u) => s + u.value, 0);
                    } else if (['ethereum', 'bnb', 'polygon', 'avalanche', 'base'].includes(p.chain)) {
                        const bal = p.token
                            ? await fetchTokenBalance(p.chain, p.token, p.address)
                            : await fetchEvmBalance(p.chain, p.address);
                        balance = Number(bal);
                    } else if (p.chain === 'zcash') {
                        balance = await fetchZcashBalance(p.address);
                    }
                } catch { /* treat errors as non-zero to be safe */ balance = -1; }
                if (balance === 0) {
                    // Only offer entries confirmed > 24h ago
                    const age = Date.now() / 1000 - (p.confirmedAt || 0);
                    if (age > 86400) entries.push({ payment: p, balance: 0 });
                }
            }
            setCleanupEntries(entries);
        } catch (e) {
            console.error('[Cleanup] scan error:', e);
        }
        setCleanupLoading(false);
    };

    const removeCleanupEntries = async () => {
        if (cleanupSelected.size === 0) return;
        setCleanupRemoving(true);
        try {
            if (activePubkey && nspIndex) {
                const updatedIdx = await removePaymentsFromPages(
                    privateKeyHex, activePubkey, nspIndex, cleanupSelected, confirmed,
                );
                setNspIndex(updatedIdx);
            }
            setConfirmed(prev => prev.filter(p => !cleanupSelected.has(p.tweak)));
            setShowCleanup(false);
            toast(`Removed ${cleanupSelected.size} zero-balance address(es)`, 'success');
        } catch (e) {
            console.error('[Cleanup] remove error:', e);
            toast('Failed to remove entries', 'error');
        }
        setCleanupRemoving(false);
    };

    const handleNspSend = async () => {
        // Safety: if an NSP recipient is selected, the one-time address must have finished
        // deriving — never fall back to broadcasting to the raw npub string.
        if (nspRecipientPubkey && !nspDerivedAddress) {
            toast(nspDeriving ? 'Still deriving the address — try again in a moment' : 'No address derived for this recipient', 'error');
            return;
        }
        // When sending to an NSP recipient (npub), use the derived address
        const effectiveRecipient = nspDerivedAddress || sendTo.trim();
        if (!privateKeyHex || !effectiveRecipient) return;
        setSending(true);
        setSendError('');

        try {
            let resultTxid = '';


            if (isBitcoin) {
                const amountSats = parseInt(sendAmount);
                if (isNaN(amountSats) || amountSats <= 0) throw new Error('Invalid amount');
                if (amountSats < 546) throw new Error(`Amount too small — Bitcoin dust limit is 546 sats (tried ${amountSats})`);
                // Native-SegWit payments sit on P2WPKH scripts — the Taproot builder would frame
                // them as P2TR inputs and produce an invalid transaction.
                const { txHex, fee } = asset === 'native'
                    ? await createMultiKeySegwitTransaction(
                        taggedUtxos.map(t => ({ utxo: t.utxo, privateKeyHex: t.privateKeyHex, address: t.address })),
                        effectiveRecipient, amountSats, selectedFeeRate
                    )
                    : await createMultiKeyTaprootTransaction(
                        taggedUtxos, effectiveRecipient, amountSats, selectedFeeRate
                    );
                resultTxid = await broadcastTransaction(txHex);
                setSendSuccess(resultTxid);
                toast(`Sent! Fee: ${fee} sats`, 'success');
            } else if (isEvm && selectedEvmAddress) {
                const tweakedKey = getSigningKey(chain, privateKeyHex, selectedEvmAddress.tweak, selectedEvmAddress.address, asset);
                if (selectedEvmAddress.token) {
                    const amount = BigInt(Math.floor(parseFloat(sendAmount) * 1e6));
                    const gas = await getGasEstimate(selectedEvmAddress.chain);
                    resultTxid = await sendTokenTransaction(
                        selectedEvmAddress.chain, tweakedKey, selectedEvmAddress.token,
                        effectiveRecipient, amount, gas.standard, undefined, true // useStandard — NSP natural-parity
                    );
                    setSendSuccess(resultTxid);
                    toast('Token transfer sent!', 'success');
                } else {
                    const amount = BigInt(Math.floor(parseFloat(sendAmount) * 1e18));
                    const gas = await getGasEstimate(selectedEvmAddress.chain);
                    resultTxid = await sendEvmTransaction(
                        selectedEvmAddress.chain, tweakedKey, effectiveRecipient, amount, gas.standard, 21000n, true // useStandard — NSP natural-parity
                    );
                    setSendSuccess(resultTxid);
                    toast('Transaction sent!', 'success');
                }
            } else if (isZcash) {
                // For Zcash, use the first funded address (single input for now)
                const funded = filteredConfirmed.find(p => (nspBalances.get(p.tweak) ?? 0) > 0);
                if (!funded) throw new Error('No funded Zcash address');
                const tweakedKey = getSigningKey(chain, privateKeyHex, funded.tweak, funded.address, asset);
                const amountZatoshi = Math.floor(parseFloat(sendAmount) * 1e8);
                if (isNaN(amountZatoshi) || amountZatoshi <= 0) throw new Error('Invalid amount');
                const zcashUtxos = await fetchZcashUTXOs(funded.address);
                const { txHex, fee } = await createZcashTransaction(
                    tweakedKey, effectiveRecipient, amountZatoshi, zcashUtxos
                );
                resultTxid = await broadcastZcashTransaction(txHex);
                setSendSuccess(resultTxid);
                toast(`Sent! Fee: ${fee} zatoshi`, 'success');
            }

            // ── Auto-notify if sent via "To Following" ──
            const isNspSend = nspRecipientPubkey && nspDerivedAddress && nspRecipientN !== null;
            if (isNspSend && resultTxid && privateKeyHex) {
                const notifAddress = nspDerivedAddress;
                // Must describe the address we ACTUALLY derived (driven by btcSendMode), not the
                // selected tab — otherwise the recipient re-derives the wrong script type, the
                // ownership check fails, and the notification is discarded as not-theirs.
                const notifAsset = isBitcoin ? (btcSendMode === 'segwit' ? 'native' : 'taproot') : asset;
                const ts = Math.floor(Date.now() / 1000);
                setNspNotifying(true);
                setNspNotifyResults([]);
                setNspNotifyDone(false);
                try {
                    const common = {
                        txid: resultTxid, chain: chain as NspChain, asset: notifAsset,
                        token: currentAsset?.token || null, amount: sendAmount || '0',
                        address: notifAddress, recipientPubkey: nspRecipientPubkey!, timestamp: ts,
                    };

                    // Deterministic NSP: notification key + sender/n payload; sender is stateless
                    const res = createDeterministicNspNotification(privateKeyHex, nspRecipientPubkey!, nspRecipientN!, {
                        address: notifAddress, chain: chain as NspChain, asset: notifAsset, token: currentAsset?.token || null, txid: resultTxid, amount: sendAmount || '0',
                    });
                    markNspAddressPending(notifAddress); // reserve this index until it hits the mempool
                    const sentEntry: NspSentEntry = { ...common, tweak: nspRecipientTweak, n: nspRecipientN! };

                    // Persist the sent record LOCALLY first — before the (failable) network
                    // notify — so an app crash right after broadcast can't strand the funds.
                    const updatedList = [...sentList, sentEntry];
                    setSentList(updatedList);
                    if (activePubkey) await nspCacheSet(activePubkey, 'sent', updatedList);

                    await publishNspNotification(res.event, nspRecipientPubkey!, (result) => setNspNotifyResults(prev => [...prev, result]));
                    setNspNotifyDone(true);

                    if (activePubkey) {
                        saveSentList(privateKeyHex, activePubkey, updatedList).catch(e => console.error('[NSP] Failed to save sent list:', e));
                    }
                } catch (e) {
                    console.error('[NSP] Notification failed:', e);
                    toast('Transaction sent but notification failed — you can retry manually', 'info');
                } finally {
                    setNspNotifying(false);
                }
            }
        } catch (e) {
            setSendError(String(e));
        } finally {
            setSending(false);
        }
    };

    if (!activePubkey) {
        return (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
                <EyeOff className="w-10 h-10 opacity-30" />
                <p className="text-sm">Select a keypair to use Silent Payments.</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4 h-full overflow-hidden">
            {/* Experimental Warning */}
            {showSilentWarning && (
                <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl shrink-0" style={{ backgroundColor: '#F04444' }}>
                    <p className="text-xs leading-relaxed text-white flex-1">
                        <span className="font-bold">Experimental.</span> Funds you receive are fully under your control, but some addresses or transactions may be lost.
                    </p>
                    <button onClick={dismissSilentWarning} className="text-white/80 hover:text-white shrink-0 cursor-pointer p-0.5 pl-2.5 h-full border-l border-white/25">
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {/* ═══ ALL NOTIFICATIONS BUTTON ═══ */}
            {confirmed.length > 0 && (
                <button
                    onClick={() => setShowAllNotifications(true)}
                    className="flex items-center justify-center gap-2 w-full py-2 px-3 rounded-xl bg-secondary/60 border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer shrink-0"
                >
                    <Inbox className="w-3.5 h-3.5" />
                    All Notifications
                    <span className="ml-auto px-1.5 py-0.5 rounded-md bg-primary/15 text-primary text-[10px] font-bold">
                        {confirmed.length}
                    </span>
                </button>
            )}

            {/* ═══ DEEP RECOVERY ═══ */}
            <button
                onClick={handleRecover}
                disabled={recovering || !privateKeyHex}
                title="Scan the chain for received payments whose notification was lost (self + known senders)"
                className="flex items-center justify-center gap-2 w-full py-2 px-3 rounded-xl bg-secondary/40 border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50 shrink-0"
            >
                {recovering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                {recovering ? 'Recovering…' : 'Recover lost payments'}
            </button>

            {/* ═══ BALANCE CARD ═══ */}
            <Card className="relative overflow-hidden bg-gradient-to-br from-card via-card to-secondary/20 shrink-0">
                <CardContent className="pt-5 pb-4 px-5 space-y-4">
                    {/* Chain/Asset switchers */}
                    <div className="flex items-center gap-2 flex-wrap">
                        <button onClick={() => { setChainSearch(''); setShowChainModal(true); }}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary border border-border text-xs font-medium cursor-pointer hover:bg-accent transition-colors">
                            <img src={currentChain.icon} alt="" className="w-4 h-4 rounded-full" />
                            {currentChain.name}
                            <ChevronDown className="w-3 h-3 text-muted-foreground" />
                        </button>
                        <button onClick={() => setShowAssetModal(true)}
                            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary border border-border text-xs font-medium cursor-pointer hover:bg-accent transition-colors">
                            {currentAsset?.icon && <img src={currentAsset.icon} alt="" className="w-3.5 h-3.5 rounded-full" />}
                            {currentAsset?.label || 'Type'}
                            <ChevronDown className="w-3 h-3 text-muted-foreground" />
                        </button>
                        <div className="ml-auto flex items-center gap-1">
                            <button onClick={openCleanup} title="Clean up zero-balance addresses"
                                className="p-1.5 rounded-lg hover:bg-accent transition-colors cursor-pointer text-muted-foreground hover:text-foreground">
                                <Trash2 className="w-4 h-4" />
                            </button>
                            <button onClick={() => setShowNotifications(true)}
                                className="p-1.5 rounded-lg hover:bg-accent transition-colors cursor-pointer text-muted-foreground hover:text-foreground relative">
                                <Bell className="w-4 h-4" />
                                {unconfirmed.some(u => u.payload.chain === chain && u.payload.asset === asset) && (
                                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-primary" />
                                )}
                            </button>
                            <button onClick={() => { fetchAllNspBalances(); fetchNspTxHistory(); void scanSelfForMissed(); }} disabled={balanceLoading}
                                className="p-1.5 rounded-lg hover:bg-accent transition-colors cursor-pointer text-muted-foreground hover:text-foreground">
                                <RefreshCw className={cn("w-4 h-4", balanceLoading && "animate-spin")} />
                            </button>
                        </div>
                    </div>

                    {/* Total Balance */}
                    <div className="space-y-1">
                        <p className="text-xs text-muted-foreground font-medium">Total Balance</p>
                        <div className="flex items-baseline gap-2">
                            {isBitcoin && <SatoshiIcon className="text-3xl text-primary" />}
                            <span className="text-4xl font-bold tracking-tight">
                                {loadingNotifs ? (
                                    <span className="flex items-center gap-2 text-muted-foreground">
                                        <Loader2 className="w-6 h-6 animate-spin" />
                                    </span>
                                ) : balanceLoading ? '...' : isBitcoin
                                    ? totalBalance.toLocaleString()
                                    : isZcash ? (totalBalance / 1e8).toFixed(8).replace(/\.?0+$/, '')
                                        : totalBalance.toFixed(6).replace(/\.?0+$/, '')}
                            </span>
                            {!loadingNotifs && (
                                <span className="text-sm text-muted-foreground font-medium">
                                    {isBitcoin ? 'sats' : isZcash ? 'ZEC' : currentChain.name}
                                </span>
                            )}
                        </div>
                        {loadingNotifs ? (
                            <p className="text-[10px] text-muted-foreground animate-pulse">Syncing payment data...</p>
                        ) : (
                            <>
                                {isBitcoin && totalBalance > 0 && (
                                    <p className="text-xs text-muted-foreground">≈ {satsToBTC(totalBalance)} BTC</p>
                                )}
                                <p className="text-[10px] text-muted-foreground">
                                    {filteredConfirmed.length} address{filteredConfirmed.length !== 1 ? 'es' : ''} on {currentChain.name}
                                </p>
                            </>
                        )}
                    </div>

                    {/* Receive / Gas Station / Send buttons */}
                    <div className="flex gap-2">
                        <Button variant="outline" className="flex-1 gap-1.5" onClick={() => setShowReceiveModal(true)}>
                            <ArrowDownLeft className="w-4 h-4" /> Receive
                        </Button>
                        {isEvm && (
                            <Button variant="outline" className="gap-1.5 px-3"
                                onClick={openGasStation}
                                title="Gas Station — fund NSP addresses with gas">
                                <Fuel className="w-4 h-4" />
                            </Button>
                        )}
                        <Button className="flex-1 gap-1.5 font-bold" onClick={() => {
                            if (filteredConfirmed.length === 0) { toast('No NSP addresses with funds on this chain', 'info'); return; }
                            openSendModal();
                        }} disabled={filteredConfirmed.length === 0}>
                            <ArrowUpRight className="w-4 h-4" /> Send
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* ═══ TABS: Transactions | NSP Addresses ═══ */}
            <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex bg-secondary border border-border rounded-xl p-1 gap-1 shrink-0">
                    {(['transactions', 'addresses'] as const).map(t => (
                        <button key={t}
                            className={cn("flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-sm transition-colors cursor-pointer",
                                listTab === t ? "bg-primary text-primary-foreground font-semibold" : "text-muted-foreground font-medium")}
                            onClick={() => setListTab(t)}>
                            {t === 'transactions' ? <ExternalLink className="w-3.5 h-3.5" /> : <Wallet className="w-3.5 h-3.5" />}
                            {t === 'transactions' ? 'Transactions' : 'Addresses'}
                        </button>
                    ))}
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto mt-4 pb-[100px]">

                    {/* ── Transactions tab ── */}
                    {listTab === 'transactions' && (
                        loadingNotifs ? (
                            <div className="flex items-center justify-center py-8 text-muted-foreground">
                                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Syncing payment data...
                            </div>
                        ) : txLoading ? (
                            <div className="flex items-center justify-center py-8 text-muted-foreground">
                                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading history...
                            </div>
                        ) : txHistory.length === 0 ? (
                            <div className="text-center py-8 text-muted-foreground text-sm">No transactions yet</div>
                        ) : (
                            <div className="space-y-1.5">
                                {txHistory.map((tx, i) => {
                                    const sentEntry = sentList.find(s => s.txid === tx.txid);
                                    const recipientNpub = sentEntry ? nip19.npubEncode(sentEntry.recipientPubkey) : null;
                                    return (
                                        <button key={`${tx.txid}-${i}`}
                                            onClick={() => { setDetailPage('info'); setSelectedNspTx(tx); }}
                                            className="w-full flex items-center gap-3 p-3 rounded-xl bg-secondary/50 border border-border hover:bg-secondary transition-colors cursor-pointer text-left"
                                        >
                                            <div className={cn("w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                                                tx.isReceive ? "bg-green-500/15 text-green-500" : "bg-orange-500/15 text-orange-500")}>
                                                {tx.isReceive ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-medium">{tx.isReceive ? '+' : '-'}{tx.amount}</div>
                                                {recipientNpub ? (
                                                    <div className="text-[10px] text-primary font-medium truncate flex items-center gap-1">
                                                        <Users className="w-3 h-3 shrink-0" />
                                                        {censor(recipientNpub, 10, 4)}
                                                    </div>
                                                ) : (
                                                    <div className="text-[10px] text-muted-foreground font-mono truncate">{censor(tx.txid, 8, 4)}</div>
                                                )}
                                            </div>
                                            <div className="text-right shrink-0">
                                                <div className="text-[10px] text-muted-foreground">
                                                    {tx.confirmed ? new Date(tx.time * 1000).toLocaleDateString() : 'Pending'}
                                                </div>
                                                <div className="text-[9px] text-muted-foreground font-mono truncate max-w-[80px]">
                                                    {tx.addresses && tx.addresses.length > 1
                                                        ? `${tx.addresses.length} addresses`
                                                        : censor(tx.address, 6, 4)}
                                                </div>
                                            </div>
                                            <ChevronDown className="w-4 h-4 text-muted-foreground -rotate-90 shrink-0" />
                                        </button>
                                    );
                                })}
                            </div>
                        )
                    )}

                    {/* ── Addresses tab ── */}
                    {listTab === 'addresses' && (
                        filteredConfirmed.length > 0 ? (
                            <div className="space-y-1.5">
                                {[...filteredConfirmed].sort((a, b) => (nspBalances.get(b.tweak) ?? 0) - (nspBalances.get(a.tweak) ?? 0)).map(payment => {
                                    const bal = nspBalances.get(payment.tweak) ?? 0;
                                    const balStr = isBitcoin ? `${bal.toLocaleString()} sats`
                                        : isZcash ? `${(bal / 1e8).toFixed(8)} ZEC`
                                            : `${bal.toFixed(6).replace(/\.?0+$/, '')} ${currentChain.name}`;
                                    return (
                                        <button
                                            key={payment.tweak}
                                            onClick={() => setDetailPayment(payment)}
                                            className={cn(
                                                "w-full flex items-center gap-3 p-3 rounded-xl border transition-colors cursor-pointer text-left",
                                                bal > 0 ? "bg-secondary/50 hover:bg-secondary border-border" : "bg-secondary/20 hover:bg-secondary/40 border-border/50 opacity-70"
                                            )}
                                        >
                                            <img src={currentChain.icon} alt="" className="w-8 h-8 rounded-full shrink-0" />
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-bold">{balStr}</div>
                                                <div className="text-[10px] text-muted-foreground font-mono truncate">{censor(payment.address)}</div>
                                            </div>
                                            <ChevronDown className="w-4 h-4 text-muted-foreground -rotate-90 shrink-0" />
                                        </button>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="text-center py-8 text-muted-foreground text-sm">
                                No NSP addresses on {currentChain.name}. Use <span className="font-semibold">Receive</span> to generate one.
                            </div>
                        )
                    )}
                </div>{/* end scrollable */}
            </div>{/* end flex-1 tab container */}

            {/* ═══ ADDRESS DETAIL MODAL ═══ */}
            {detailPayment && (() => {
                const bal = nspBalances.get(detailPayment.tweak) ?? 0;
                const balStr = isBitcoin ? `${bal.toLocaleString()} sats`
                    : isZcash ? `${(bal / 1e8).toFixed(8)} ZEC`
                        : `${bal.toFixed(6).replace(/\.?0+$/, '')} ${currentChain.name}`;
                return (
                    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                        <div className="flex min-h-full items-center justify-center px-4 py-20">
                            <Card className="w-[380px] shadow-2xl">
                                <CardHeader className="flex-row items-center justify-between">
                                    <CardTitle className="text-base flex items-center gap-2">
                                        <Wallet className="w-4 h-4" /> Address Details
                                    </CardTitle>
                                    <button onClick={() => setDetailPayment(null)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                        <X className="w-4 h-4" />
                                    </button>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    {/* Balance */}
                                    <div className="text-center py-3">
                                        <div className="flex items-center justify-center gap-2">
                                            {isBitcoin && <SatoshiIcon className="text-2xl text-primary" />}
                                            <span className="text-3xl font-bold">{bal > 0 ? (isBitcoin ? bal.toLocaleString() : balStr) : '0'}</span>
                                            {isBitcoin && <span className="text-sm text-muted-foreground">sats</span>}
                                        </div>
                                        {bal === 0 && <p className="text-xs text-muted-foreground mt-1">Spent</p>}
                                    </div>

                                    {/* Address */}
                                    <div className="space-y-1.5">
                                        <label className="text-xs text-muted-foreground font-medium">Address</label>
                                        <div className="flex items-center gap-1.5">
                                            <Input value={censor(detailPayment.address)} readOnly className="text-[10px] font-mono" />
                                            <Button size="sm" variant="outline" onClick={() => copyText(detailPayment.address, 'detail-addr')}>
                                                {copiedId === 'detail-addr' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                            </Button>
                                        </div>
                                    </div>

                                    {/* Info */}
                                    <div className="bg-secondary/50 rounded-xl p-3 space-y-2 text-xs">
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Chain</span>
                                            <span className="font-medium flex items-center gap-1.5">
                                                <img src={currentChain.icon} alt="" className="w-3.5 h-3.5 rounded-full" /> {currentChain.name}
                                            </span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-muted-foreground">Type</span>
                                            <span className="font-medium">{detailPayment.asset}</span>
                                        </div>
                                        {detailPayment.txid && (
                                            <div className="flex justify-between">
                                                <span className="text-muted-foreground">First TX</span>
                                                <span className="font-mono text-[10px]">{censor(detailPayment.txid, 8, 4)}</span>
                                            </div>
                                        )}
                                        {detailPayment.confirmedAt && (
                                            <div className="flex justify-between">
                                                <span className="text-muted-foreground">Confirmed</span>
                                                <span>{new Date(detailPayment.confirmedAt * 1000).toLocaleDateString()}</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Send button */}
                                    {bal > 0 && (
                                        <Button className="w-full gap-1.5 font-bold" onClick={() => {
                                            setDetailPayment(null);
                                            handleSendFromConfirmed(detailPayment);
                                        }}>
                                            <SendIcon className="w-4 h-4" /> Send from this address
                                        </Button>
                                    )}
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                );
            })()}

            {/* ═══ RECEIVE MODAL ═══ */}
            {showReceiveModal && (
                <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                    <div className="flex min-h-full items-center justify-center px-4 py-20">
                        <Card className="w-[380px] shadow-2xl">
                            <CardHeader className="flex-row items-center justify-between">
                                <CardTitle className="text-base flex items-center gap-2">
                                    <ArrowDownLeft className="w-4 h-4" /> Receive Silent Payment
                                </CardTitle>
                                <button onClick={() => {
                                    setShowReceiveModal(false);
                                }} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                    <X className="w-4 h-4" />
                                </button>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {/* Show selected chain/asset */}
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <img src={currentChain.icon} alt="" className="w-4 h-4 rounded-full" />
                                    <span className="font-medium text-foreground">{currentChain.name}</span>
                                    <span>·</span>
                                    <span>{currentAsset?.label}</span>
                                </div>

                                {(
                                    /* ── Standard NSP Receive: generate one-time address ── */
                                    <>
                                        {/* QR Area */}
                                        <div className="flex flex-col items-center gap-3">
                                            {generatedAddress ? (
                                                <div className="bg-white p-3 rounded-xl">
                                                    <QRCodeSVG value={qrUri || generatedAddress} size={180} />
                                                </div>
                                            ) : (
                                                <div className="w-[204px] h-[204px] rounded-xl border-2 border-dashed border-border flex items-center justify-center">
                                                    <QrCode className="w-10 h-10 text-muted-foreground/30" />
                                                </div>
                                            )}
                                        </div>

                                        {/* Address */}
                                        <div className="space-y-1.5">
                                            <label className="text-xs text-muted-foreground font-medium">Recipient Address</label>
                                            <div className="flex items-center gap-1.5">
                                                <Input value={censor(generatedAddress)} readOnly placeholder={generating ? 'Deriving your address…' : 'Unavailable — unlock your key'} className="text-xs font-mono" />
                                                {generatedAddress && (
                                                    <Button size="sm" variant="outline" onClick={() => copyText(generatedAddress, 'nsp-addr')}>
                                                        {copiedId === 'nsp-addr' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                                    </Button>
                                                )}
                                            </div>
                                        </div>

                                        {/* Amount */}
                                        <div className="space-y-1.5">
                                            <label className="text-xs text-muted-foreground font-medium">Amount (optional)</label>
                                            <Input type="number" value={amount}
                                                onChange={e => { setAmount(e.target.value); if (generatedAddress) setQrUri(buildPaymentURI(chain, generatedAddress, e.target.value || undefined, currentAsset?.token)); }}
                                                placeholder="0.00" className="text-sm" />
                                        </div>

                                        {generatedAddress && (
                                            <>
                                                <p className="text-[11px] leading-relaxed text-muted-foreground px-1">
                                                    This address is derived from your key, so payments to it are always
                                                    recoverable. It's being watched — an incoming payment appears on its own.
                                                </p>

                                                {selfAddresses.length > 0 && (
                                                    <div className="pt-1">
                                                        <button onClick={() => setShowSelfAddrs(v => !v)}
                                                            className="w-full flex items-center justify-between px-1 py-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                                                            <span>Your receive addresses ({selfAddresses.length})</span>
                                                            <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showSelfAddrs && "rotate-180")} />
                                                        </button>
                                                        {showSelfAddrs && (
                                                            <div className="space-y-1 mt-1 max-h-56 overflow-y-auto">
                                                                {selfAddresses.map(r => (
                                                                    <div key={r.address}
                                                                        className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-secondary/40 border border-white/5">
                                                                        <span className="text-[10px] font-mono text-muted-foreground w-7 shrink-0">#{r.n}</span>
                                                                        <span className="text-[10px] font-mono text-foreground truncate flex-1">{censor(r.address)}</span>
                                                                        {r.current ? (
                                                                            <span className="text-[10px] font-semibold text-primary shrink-0">current</span>
                                                                        ) : r.received ? (
                                                                            <span className="text-[10px] font-semibold text-green-500 shrink-0">
                                                                                {r.balance ? r.balance.toLocaleString() : 'received'}
                                                                            </span>
                                                                        ) : (
                                                                            <span className="text-[10px] text-muted-foreground shrink-0">unused</span>
                                                                        )}
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                </div>
            )}

            {/* ═══ GAS STATION MODAL (EVM only) ═══ */}
            {showGasStation && (() => {
                const math = computeGasMath();
                const hasSufficientFunds = gasHandlerBalance >= math.totalNeeded;
                return (
                    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                        <div className="flex min-h-full items-center justify-center px-4 py-20">
                            <Card className="w-[400px] shadow-2xl max-h-[80vh] flex flex-col">
                                <CardHeader className="flex-row items-center justify-between shrink-0">
                                    <CardTitle className="text-base flex items-center gap-2">
                                        <Fuel className="w-4 h-4" /> Gas Station
                                    </CardTitle>
                                    <button onClick={() => { setShowGasStation(false); setGasPolling(false); }}
                                        className="text-muted-foreground hover:text-foreground cursor-pointer">
                                        <X className="w-4 h-4" />
                                    </button>
                                </CardHeader>
                                <CardContent className="space-y-3 overflow-y-auto">
                                    {/* Chain badge */}
                                    <div className="flex items-center gap-2">
                                        <img src={currentChain.icon} alt="" className="w-5 h-5 rounded-full" />
                                        <span className="text-sm font-medium">{currentChain.name}</span>
                                        <span className="text-xs text-muted-foreground">• Native gas: {EVM_CHAINS[chain]?.symbol}</span>
                                    </div>

                                    {gasLoading ? (
                                        <div className="flex items-center justify-center py-8 text-muted-foreground">
                                            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Scanning addresses...
                                        </div>
                                    ) : gasStep === 'select' ? (
                                        <>
                                            {/* Address list with gas status */}
                                            <p className="text-xs text-muted-foreground">Select addresses to fund with gas:</p>
                                            <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                                                {gasAddresses.map(info => {
                                                    const selected = gasSelected.has(info.payment.tweak);
                                                    const gasStatus = info.gasBalance >= gasPrice * GAS_LIMIT_ETH * GAS_BUDGET_TXS
                                                        ? 'green' : info.gasBalance > 0n ? 'yellow' : 'red';
                                                    return (
                                                        <button key={info.payment.tweak}
                                                            onClick={() => {
                                                                const next = new Set(gasSelected);
                                                                selected ? next.delete(info.payment.tweak) : next.add(info.payment.tweak);
                                                                setGasSelected(next);
                                                            }}
                                                            className={cn(
                                                                "w-full flex items-center gap-2.5 p-2.5 rounded-xl border transition-colors cursor-pointer text-left",
                                                                selected ? "bg-primary/10 border-primary/30" : "bg-secondary/30 border-border hover:bg-secondary/50"
                                                            )}>
                                                            {/* Gas status dot */}
                                                            <div className={cn("w-2.5 h-2.5 rounded-full shrink-0",
                                                                gasStatus === 'green' ? "bg-green-500" :
                                                                    gasStatus === 'yellow' ? "bg-yellow-500" : "bg-red-500"
                                                            )} />
                                                            <div className="flex-1 min-w-0">
                                                                <div className="text-[10px] text-muted-foreground font-mono truncate">{censor(info.payment.address)}</div>
                                                                <div className="flex gap-3 text-[10px] mt-0.5">
                                                                    <span className="text-muted-foreground">
                                                                        Gas: {formatUnits(info.gasBalance, 18)} {EVM_CHAINS[chain]?.symbol}
                                                                    </span>
                                                                    {info.tokenBalance > 0n && (
                                                                        <span className="text-foreground font-medium">
                                                                            Tokens: {formatUnits(info.tokenBalance, getTokenDecimals(info.payment.chain, info.payment.token))}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            {/* Checkbox */}
                                                            <div className={cn("w-4 h-4 rounded border flex items-center justify-center shrink-0",
                                                                selected ? "bg-primary border-primary" : "border-border"
                                                            )}>
                                                                {selected && <Check className="w-3 h-3 text-primary-foreground" />}
                                                            </div>
                                                        </button>
                                                    );
                                                })}
                                            </div>

                                            {/* Select All */}
                                            <button onClick={() => {
                                                if (gasSelected.size === gasAddresses.length) {
                                                    setGasSelected(new Set());
                                                } else {
                                                    setGasSelected(new Set(gasAddresses.map(a => a.payment.tweak)));
                                                }
                                            }} className="text-xs text-primary font-medium cursor-pointer hover:underline">
                                                {gasSelected.size === gasAddresses.length ? 'Deselect All' : 'Select All'}
                                            </button>

                                            {/* Handler selector */}
                                            {gasSelected.size > 0 && (
                                                <div className="space-y-1.5 pt-1 border-t border-border">
                                                    <label className="text-xs text-muted-foreground font-medium">Gas distributor (handler):</label>
                                                    <div className="space-y-1">
                                                        {gasAddresses.filter(a => gasSelected.has(a.payment.tweak)).map(info => (
                                                            <button key={info.payment.tweak}
                                                                onClick={() => setGasHandler(info.payment)}
                                                                className={cn(
                                                                    "w-full flex items-center gap-2 p-2 rounded-lg text-left text-[10px] font-mono cursor-pointer transition-colors",
                                                                    gasHandler?.tweak === info.payment.tweak
                                                                        ? "bg-primary/15 border border-primary/30"
                                                                        : "bg-secondary/30 border border-transparent hover:bg-secondary/50"
                                                                )}>
                                                                <div className="flex-1 truncate">{censor(info.payment.address)}</div>
                                                                {gasHandler?.tweak === info.payment.tweak && (
                                                                    <span className="text-[9px] text-primary font-semibold shrink-0">HANDLER</span>
                                                                )}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            <Button className="w-full" disabled={gasSelected.size === 0 || !gasHandler}
                                                onClick={() => { setGasStep('fund'); setGasPolling(true); }}>
                                                Continue ({gasSelected.size} address{gasSelected.size !== 1 ? 'es' : ''})
                                            </Button>
                                        </>
                                    ) : gasStep === 'fund' ? (
                                        <>
                                            {/* Gas math breakdown */}
                                            <div className="bg-secondary/50 rounded-xl p-3 space-y-2 text-xs">
                                                <div className="flex justify-between">
                                                    <span className="text-muted-foreground">Target addresses</span>
                                                    <span>{math.N}</span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-muted-foreground">Per-address budget (2 txs)</span>
                                                    <span>{formatUnits(math.perAddrBudget, 18)} {EVM_CHAINS[chain]?.symbol}</span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-muted-foreground">Distribution cost ({math.N} sends)</span>
                                                    <span>{formatUnits(math.distributionCost, 18)} {EVM_CHAINS[chain]?.symbol}</span>
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-muted-foreground">Handler's own budget</span>
                                                    <span>{formatUnits(math.handlerBudget, 18)} {EVM_CHAINS[chain]?.symbol}</span>
                                                </div>
                                                <div className="border-t border-border pt-2 flex justify-between font-bold">
                                                    <span>Total needed</span>
                                                    <span className="text-primary">{formatUnits(math.totalNeeded, 18)} {EVM_CHAINS[chain]?.symbol}</span>
                                                </div>
                                            </div>

                                            <p className="text-xs text-muted-foreground">
                                                Send the total to the handler address below:
                                            </p>

                                            {/* QR + handler address */}
                                            {gasHandler && (
                                                <div className="flex flex-col items-center gap-3">
                                                    <div className="bg-white rounded-2xl p-3">
                                                        <QRCodeSVG value={gasHandler.address} size={150} />
                                                    </div>
                                                    <div className="flex items-center gap-2 w-full">
                                                        <div className="flex-1 bg-secondary/60 rounded-lg px-3 py-2 text-[10px] font-mono text-muted-foreground truncate">
                                                            {censor(gasHandler.address)}
                                                        </div>
                                                        <Button size="sm" variant="outline" onClick={() => {
                                                            navigator.clipboard.writeText(gasHandler.address);
                                                            toast('Handler address copied', 'success');
                                                        }}>
                                                            <Copy className="w-3.5 h-3.5" />
                                                        </Button>
                                                    </div>
                                                </div>
                                            )}

                                            {/* Live balance watcher */}
                                            <div className={cn(
                                                "flex items-center gap-2 p-3 rounded-xl border",
                                                hasSufficientFunds
                                                    ? "bg-green-500/10 border-green-500/30"
                                                    : "bg-secondary/50 border-border"
                                            )}>
                                                {hasSufficientFunds ? (
                                                    <Check className="w-4 h-4 text-green-500 shrink-0" />
                                                ) : (
                                                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />
                                                )}
                                                <div className="flex-1 text-xs">
                                                    <span className={hasSufficientFunds ? "text-green-500 font-semibold" : "text-muted-foreground"}>
                                                        {hasSufficientFunds ? 'Funds received!' : 'Waiting for funds...'}
                                                    </span>
                                                    <span className="text-muted-foreground ml-2">
                                                        {formatUnits(gasHandlerBalance, 18)} / {formatUnits(math.totalNeeded, 18)} {EVM_CHAINS[chain]?.symbol}
                                                    </span>
                                                </div>
                                            </div>

                                            <div className="flex gap-2">
                                                <Button variant="outline" className="flex-1"
                                                    onClick={() => { setGasStep('select'); setGasPolling(false); }}>
                                                    Back
                                                </Button>
                                                <Button className="flex-1 gap-1.5" disabled={!hasSufficientFunds}
                                                    onClick={distributeGas}>
                                                    <Fuel className="w-3.5 h-3.5" /> Distribute Gas
                                                </Button>
                                            </div>
                                        </>
                                    ) : gasStep === 'distributing' ? (
                                        <div className="space-y-4 py-4">
                                            <div className="flex flex-col items-center gap-3">
                                                <Loader2 className="w-8 h-8 animate-spin text-primary" />
                                                <p className="text-sm font-medium">Distributing gas...</p>
                                                <p className="text-xs text-muted-foreground">
                                                    {gasDistProgress} / {gasDistTotal} addresses funded
                                                </p>
                                            </div>
                                            {/* Progress bar */}
                                            <div className="w-full h-2 rounded-full bg-secondary overflow-hidden">
                                                <div className="h-full bg-primary rounded-full transition-all duration-300"
                                                    style={{ width: `${gasDistTotal > 0 ? (gasDistProgress / gasDistTotal) * 100 : 0}%` }} />
                                            </div>
                                            {gasDistError && (
                                                <Alert><AlertDescription className="text-xs text-destructive">{gasDistError}</AlertDescription></Alert>
                                            )}
                                        </div>
                                    ) : gasStep === 'done' ? (
                                        <div className="space-y-4 py-4">
                                            <div className="flex flex-col items-center gap-3">
                                                <div className="w-12 h-12 rounded-full bg-green-500/15 flex items-center justify-center">
                                                    <Check className="w-6 h-6 text-green-500" />
                                                </div>
                                                <p className="text-sm font-semibold">Gas Distributed!</p>
                                                <p className="text-xs text-muted-foreground text-center">
                                                    {gasDistProgress} address{gasDistProgress !== 1 ? 'es' : ''} funded with gas for ~2 transactions each.
                                                </p>
                                            </div>
                                            <Button className="w-full" onClick={() => { setShowGasStation(false); setGasPolling(false); fetchAllNspBalances(); }}>
                                                Done
                                            </Button>
                                        </div>
                                    ) : null}
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                );
            })()}

            {/* ═══ CLEANUP MODAL ═══ */}
            {showCleanup && (
                <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                    <div className="flex min-h-full items-center justify-center px-4 py-20">
                        <Card className="w-[420px] shadow-2xl max-h-[70vh] flex flex-col">
                            <div className="flex items-center justify-between p-4 border-b border-border">
                                <h3 className="font-semibold flex items-center gap-2">
                                    <Trash2 className="w-4 h-4" /> Clean Up Addresses
                                </h3>
                                <button onClick={() => setShowCleanup(false)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                            <div className="flex-1 overflow-y-auto p-4 space-y-3">
                                {cleanupLoading ? (
                                    <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
                                        <Loader2 className="w-5 h-5 animate-spin" />
                                        <span className="text-sm">Scanning for zero-balance addresses...</span>
                                    </div>
                                ) : cleanupEntries.length === 0 ? (
                                    <div className="text-center py-10 text-muted-foreground text-sm">
                                        No zero-balance addresses to clean up.
                                        <br /><span className="text-xs opacity-70">Only entries confirmed more than 24 hours ago are eligible.</span>
                                    </div>
                                ) : (
                                    <>
                                        <p className="text-xs text-muted-foreground">
                                            Found {cleanupEntries.length} zero-balance address(es). Select entries to remove from your payment list.
                                        </p>
                                        <div className="flex items-center gap-2 mb-1">
                                            <button
                                                onClick={() => {
                                                    if (cleanupSelected.size === cleanupEntries.length) {
                                                        setCleanupSelected(new Set());
                                                    } else {
                                                        setCleanupSelected(new Set(cleanupEntries.map(e => e.payment.tweak)));
                                                    }
                                                }}
                                                className="text-xs text-primary hover:underline cursor-pointer"
                                            >
                                                {cleanupSelected.size === cleanupEntries.length ? 'Deselect All' : 'Select All'}
                                            </button>
                                            {cleanupSelected.size > 0 && (
                                                <span className="text-xs text-muted-foreground">
                                                    {cleanupSelected.size} selected
                                                </span>
                                            )}
                                        </div>
                                        {cleanupEntries.map(entry => {
                                            const p = entry.payment;
                                            const isChecked = cleanupSelected.has(p.tweak);
                                            return (
                                                <label key={p.tweak}
                                                    className={cn(
                                                        "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                                                        isChecked ? "border-primary/50 bg-primary/5" : "border-border hover:bg-accent/50"
                                                    )}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={isChecked}
                                                        onChange={() => {
                                                            setCleanupSelected(prev => {
                                                                const next = new Set(prev);
                                                                if (next.has(p.tweak)) next.delete(p.tweak);
                                                                else next.add(p.tweak);
                                                                return next;
                                                            });
                                                        }}
                                                        className="mt-1 accent-primary"
                                                    />
                                                    <div className="flex-1 min-w-0">
                                                        <div className="flex items-center gap-1.5">
                                                            <span className="text-xs font-medium uppercase text-muted-foreground">{p.chain}</span>
                                                            {p.asset !== 'taproot' && p.asset !== 'native' && (
                                                                <span className="text-xs text-muted-foreground/60">· {p.asset}</span>
                                                            )}
                                                        </div>
                                                        <p className="text-xs font-mono text-muted-foreground truncate">{p.address}</p>
                                                        {p.confirmedAt && (
                                                            <p className="text-[10px] text-muted-foreground/50 mt-0.5">
                                                                Confirmed {new Date(p.confirmedAt * 1000).toLocaleDateString()}
                                                            </p>
                                                        )}
                                                    </div>
                                                    <span className="text-xs font-medium text-muted-foreground/50 whitespace-nowrap">0 bal</span>
                                                </label>
                                            );
                                        })}
                                    </>
                                )}
                            </div>
                            {cleanupEntries.length > 0 && !cleanupLoading && (
                                <div className="p-4 border-t border-border flex gap-2">
                                    <Button variant="outline" className="flex-1 cursor-pointer" onClick={() => setShowCleanup(false)}>
                                        Cancel
                                    </Button>
                                    <Button
                                        className="flex-1 cursor-pointer"
                                        variant="destructive"
                                        disabled={cleanupSelected.size === 0 || cleanupRemoving}
                                        onClick={removeCleanupEntries}
                                    >
                                        {cleanupRemoving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Trash2 className="w-4 h-4 mr-1" />}
                                        Remove {cleanupSelected.size > 0 ? `(${cleanupSelected.size})` : ''}
                                    </Button>
                                </div>
                            )}
                        </Card>
                    </div>
                </div>
            )}

            {/* ═══ NOTIFICATIONS MODAL ═══ */}
            {showNotifications && (
                <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                    <div className="flex min-h-full items-center justify-center px-4 py-20">
                        <Card className="w-[380px] shadow-2xl max-h-[70vh] flex flex-col">
                            <CardHeader className="flex-row items-center justify-between shrink-0">
                                <CardTitle className="text-base flex items-center gap-2">
                                    <Bell className="w-4 h-4" /> Notifications
                                </CardTitle>
                                <button onClick={() => setShowNotifications(false)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                    <X className="w-4 h-4" />
                                </button>
                            </CardHeader>
                            <CardContent className="space-y-3 overflow-y-auto">
                                {/* View toggle */}
                                <div className="flex bg-secondary border border-border rounded-lg p-0.5 gap-0.5">
                                    {(['unconfirmed', 'confirmed'] as const).map(v => (
                                        <button key={v}
                                            className={cn("flex-1 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer",
                                                notifView === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}
                                            onClick={() => setNotifView(v)}>
                                            {v === 'unconfirmed'
                                                ? `Unconfirmed (${unconfirmed.filter(u => u.payload.chain === chain && u.payload.asset === asset).length})`
                                                : `Confirmed (${filteredConfirmed.length})`}
                                        </button>
                                    ))}
                                </div>

                                {loadingNotifs && (
                                    <div className="flex items-center justify-center py-8 text-muted-foreground">
                                        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
                                    </div>
                                )}

                                {/* Unconfirmed */}
                                {notifView === 'unconfirmed' && !loadingNotifs && (() => {
                                    const filtered = unconfirmed.filter(u => u.payload.chain === chain && u.payload.asset === asset);
                                    return filtered.length === 0 ? (
                                        <div className="text-center py-8 text-muted-foreground text-sm">No pending notifications</div>
                                    ) : (
                                        <div className="space-y-2">
                                            {filtered.map(item => {
                                                const ch = CHAINS.find(c => c.id === item.payload.chain);
                                                return (
                                                    <div key={item.payload.address} className="flex items-center gap-3 p-3 rounded-xl bg-secondary/50 border border-border">
                                                        <img src={ch?.icon || ''} alt="" className="w-7 h-7 rounded-full shrink-0" />
                                                        <div className="flex-1 min-w-0">
                                                            <div className="text-sm font-medium truncate">{item.payload.amount} on {ch?.name}</div>
                                                            <div className="text-[10px] text-muted-foreground font-mono truncate">{censor(item.payload.address)}</div>
                                                        </div>
                                                        <button onClick={() => rescanItem(item.payload.address)} disabled={item.checking}
                                                            className="p-1.5 rounded-lg hover:bg-accent transition-colors cursor-pointer">
                                                            {item.checking ? <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /> : <RefreshCw className="w-4 h-4 text-muted-foreground" />}
                                                        </button>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    );
                                })()}

                                {/* Confirmed */}
                                {notifView === 'confirmed' && !loadingNotifs && (
                                    filteredConfirmed.length === 0 ? (
                                        <div className="text-center py-8 text-muted-foreground text-sm">No confirmed payments</div>
                                    ) : (
                                        <div className="space-y-2">
                                            {filteredConfirmed.map(payment => {
                                                const ch = CHAINS.find(c => c.id === payment.chain);
                                                return (
                                                    <div key={payment.tweak} className="flex items-center gap-3 p-3 rounded-xl bg-secondary/50 border border-border">
                                                        <img src={ch?.icon || ''} alt="" className="w-7 h-7 rounded-full shrink-0" />
                                                        <div className="flex-1 min-w-0">
                                                            <div className="text-sm font-medium">{payment.amount} on {ch?.name}</div>
                                                            <div className="text-[10px] text-muted-foreground font-mono truncate">{censor(payment.address)}</div>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )
                                )}
                            </CardContent>
                        </Card>
                    </div>
                </div>
            )}

            {/* ═══ ALL NOTIFICATIONS MODAL ═══ */}
            {showAllNotifications && (() => {
                // Group confirmed payments by chain+asset
                type GroupKey = string;
                const groups = new Map<GroupKey, { chain: NspChain; asset: string; chainName: string; icon: string; payments: (NspConfirmedPayment & { liveBalance?: string })[] }>();
                for (const p of confirmed) {
                    const key = `${p.chain}::${p.asset.toLowerCase()}`;
                    if (!groups.has(key)) {
                        const ch = CHAINS.find(c => c.id === p.chain);
                        // Resolve icon: try asset-specific icon, fall back to chain icon
                        const assetOpts = getAssetsForChain(p.chain);
                        const matchedAsset = assetOpts.find(a => a.id === p.asset.toLowerCase());
                        const icon = matchedAsset?.icon || tokenIcons[p.asset.toUpperCase()] || ch?.icon || '';
                        groups.set(key, {
                            chain: p.chain,
                            asset: p.asset.toLowerCase(),
                            chainName: ch?.name || p.chain,
                            icon,
                            payments: [],
                        });
                    }
                    groups.get(key)!.payments.push(p);
                }
                // Sort groups: most payments first
                const sortedGroups = Array.from(groups.values()).sort((a, b) => b.payments.length - a.payments.length);

                return (
                    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                        <div className="flex min-h-full items-center justify-center px-4 py-20">
                            <Card className="w-[400px] shadow-2xl max-h-[75vh] flex flex-col">
                                <CardHeader className="flex-row items-center justify-between shrink-0">
                                    <CardTitle className="text-base flex items-center gap-2">
                                        <Inbox className="w-4 h-4" /> All Notifications
                                        <span className="text-xs font-normal text-muted-foreground ml-1">({confirmed.length})</span>
                                    </CardTitle>
                                    <button onClick={() => setShowAllNotifications(false)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                        <X className="w-4 h-4" />
                                    </button>
                                </CardHeader>
                                <CardContent className="overflow-y-auto space-y-4 pb-6">
                                    {loadingNotifs ? (
                                        <div className="flex items-center justify-center py-8 text-muted-foreground">
                                            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
                                        </div>
                                    ) : sortedGroups.length === 0 ? (
                                        <div className="text-center py-8 text-muted-foreground text-sm">No confirmed notifications</div>
                                    ) : (
                                        sortedGroups.map(group => (
                                            <div key={`${group.chain}::${group.asset}`}>
                                                {/* Group header — clickable to navigate */}
                                                <button
                                                    onClick={() => {
                                                        skipAssetResetRef.current = true;
                                                        setChain(group.chain);
                                                        setAsset(group.asset);
                                                        setShowAllNotifications(false);
                                                    }}
                                                    className="flex items-center gap-2 w-full mb-2 px-1 group cursor-pointer"
                                                >
                                                    <img src={group.icon} alt="" className="w-5 h-5 rounded-full shrink-0" />
                                                    <span className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
                                                        {group.chainName}
                                                        <span className="text-muted-foreground font-normal"> · {(() => {
                                                            const assetOpts = getAssetsForChain(group.chain);
                                                            const matched = assetOpts.find(a => a.id === group.asset);
                                                            return matched?.label || group.asset.toUpperCase();
                                                        })()}</span>
                                                    </span>
                                                    <span className="ml-auto text-[10px] font-bold text-muted-foreground bg-secondary px-1.5 py-0.5 rounded-md">
                                                        {group.payments.length}
                                                    </span>
                                                    <ChevronDown className="w-3 h-3 text-muted-foreground -rotate-90 group-hover:text-primary transition-colors" />
                                                </button>
                                                {/* Payment rows */}
                                                <div className="space-y-1">
                                                    {group.payments.slice(0, 5).map(payment => (
                                                        <button
                                                            key={payment.tweak}
                                                            onClick={() => {
                                                                skipAssetResetRef.current = true;
                                                                setChain(payment.chain);
                                                                setAsset(group.asset);
                                                                setShowAllNotifications(false);
                                                                // Open the address detail
                                                                setDetailPayment(payment);
                                                            }}
                                                            className="flex items-center gap-2.5 w-full p-2.5 rounded-lg bg-secondary/40 border border-border/50 hover:bg-secondary/80 hover:border-border transition-colors cursor-pointer text-left"
                                                        >
                                                            <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                                                                <ArrowDownLeft className="w-3.5 h-3.5 text-primary" />
                                                            </div>
                                                            <div className="flex-1 min-w-0">
                                                                <div className="text-xs font-medium truncate">
                                                                    {payment.amount || 'Received'}
                                                                </div>
                                                                <div className="text-[10px] text-muted-foreground font-mono truncate">
                                                                    {censor(payment.address)}
                                                                </div>
                                                            </div>
                                                            <div className="text-[10px] text-muted-foreground shrink-0">
                                                                {payment.confirmedAt ? new Date(payment.confirmedAt * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''}
                                                            </div>
                                                        </button>
                                                    ))}
                                                    {group.payments.length > 5 && (
                                                        <button
                                                            onClick={() => {
                                                                skipAssetResetRef.current = true;
                                                                setChain(group.chain);
                                                                setAsset(group.asset);
                                                                setShowAllNotifications(false);
                                                            }}
                                                            className="w-full text-center py-1.5 text-[11px] text-primary hover:text-primary/80 font-medium cursor-pointer transition-colors"
                                                        >
                                                            +{group.payments.length - 5} more — view all →
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                );
            })()}

            {/* ═══ CHAIN SELECTOR MODAL ═══ */}
            {showChainModal && (
                <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm animate-fade-in flex items-center justify-center px-4">
                    <Card className="w-[340px] shadow-2xl">
                        <CardHeader className="flex-row items-center justify-between">
                            <CardTitle className="text-base">Select Chain</CardTitle>
                            <button onClick={() => setShowChainModal(false)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                <X className="w-4 h-4" />
                            </button>
                        </CardHeader>
                        <CardContent className="space-y-1.5">
                            <div className="relative mb-2">
                                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                                <Input
                                    value={chainSearch}
                                    onChange={e => setChainSearch(e.target.value)}
                                    placeholder="Search..."
                                    className="pl-8 h-8 text-xs"
                                />
                            </div>
                            {CHAINS.filter(c => c.name.toLowerCase().includes(chainSearch.toLowerCase())).map(c => (
                                <button
                                    key={c.id}
                                    onClick={() => { setChain(c.id); setShowChainModal(false); }}
                                    className={cn(
                                        "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer",
                                        chain === c.id ? "bg-primary/15 text-primary" : "hover:bg-secondary"
                                    )}
                                >
                                    <img src={c.icon} alt="" className="w-5 h-5 rounded-full" />
                                    {c.name}
                                </button>
                            ))}
                        </CardContent>
                    </Card>
                </div>
            )}

            {/* ═══ ASSET SELECTOR MODAL ═══ */}
            {showAssetModal && (
                <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm animate-fade-in flex items-center justify-center px-4">
                    <Card className="w-[340px] shadow-2xl">
                        <CardHeader className="flex-row items-center justify-between">
                            <CardTitle className="text-base">Select Type / Token</CardTitle>
                            <button onClick={() => setShowAssetModal(false)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                <X className="w-4 h-4" />
                            </button>
                        </CardHeader>
                        <CardContent className="space-y-1.5">
                            {assets.map(a => (
                                <button
                                    key={a.id}
                                    onClick={() => { setAsset(a.id); setGeneratedAddress(''); setCurrentTweak(''); setGeneratedIndex(null); setQrUri(''); setShowAssetModal(false); }}
                                    className={cn(
                                        "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer",
                                        asset === a.id ? "bg-primary/15 text-primary" : "hover:bg-secondary"
                                    )}
                                >
                                    {a.icon && <img src={a.icon} alt="" className="w-5 h-5 rounded-full" />}
                                    {a.label}
                                </button>
                            ))}
                        </CardContent>
                    </Card>
                </div>
            )}

            {/* ═══ CONFIRM MODAL ═══ */}
            {/* ═══ NSP SEND MODAL ═══ */}
            {showSendModal && (() => {
                const availStr = isBitcoin ? `${aggregatedBalance.toLocaleString()} sats`
                    : isEvm ? `${(Number(selectedEvmBalance) / 1e18).toFixed(8)} ${currentChain.name}`
                        : isZcash ? `${(aggregatedBalance / 1e8).toFixed(8)} ZEC` : '';
                return (
                    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                        <div className="flex min-h-full items-center justify-center px-4 py-20">
                            <Card className="w-[380px] shadow-2xl">
                                <CardHeader className="flex-row items-center justify-between">
                                    <CardTitle className="text-base flex items-center gap-2">
                                        <SendIcon className="w-4 h-4" /> Send
                                    </CardTitle>
                                    <button onClick={() => setShowSendModal(false)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                        <X className="w-4 h-4" />
                                    </button>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    {/* EVM: Address dropdown */}
                                    {isEvm && evmAddressOptions.length > 0 && (
                                        <div className="space-y-1.5">
                                            <label className="text-xs text-muted-foreground font-medium">Send from</label>
                                            <div className="relative">
                                                <button
                                                    onClick={() => setShowEvmAddrDropdown(!showEvmAddrDropdown)}
                                                    className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl bg-secondary/60 border border-border text-sm cursor-pointer hover:bg-secondary transition-colors"
                                                >
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <img src={currentChain.icon} alt="" className="w-4 h-4 rounded-full shrink-0" />
                                                        <span className="font-mono text-xs truncate">
                                                            {censor(selectedEvmAddress?.address || '')}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-1.5">
                                                        <span className="text-xs text-muted-foreground">
                                                            {(Number(selectedEvmBalance) / 1e18).toFixed(6)}
                                                        </span>
                                                        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                                                    </div>
                                                </button>
                                                {showEvmAddrDropdown && (
                                                    <div className="absolute z-10 top-full mt-1 w-full bg-card border border-border rounded-xl shadow-lg overflow-hidden">
                                                        {evmAddressOptions.map(opt => (
                                                            <button key={opt.payment.tweak}
                                                                onClick={() => {
                                                                    setSelectedEvmAddress(opt.payment);
                                                                    setSelectedEvmBalance(opt.balance);
                                                                    setShowEvmAddrDropdown(false);
                                                                }}
                                                                className={cn(
                                                                    "w-full flex items-center justify-between px-3 py-2 text-xs cursor-pointer hover:bg-secondary transition-colors",
                                                                    opt.payment.tweak === selectedEvmAddress?.tweak && "bg-primary/10"
                                                                )}
                                                            >
                                                                <span className="font-mono truncate">
                                                                    {censor(opt.payment.address)}
                                                                </span>
                                                                <span className="text-muted-foreground shrink-0 ml-2">
                                                                    {(Number(opt.balance) / 1e18).toFixed(6)} {currentChain.name}
                                                                </span>
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Bitcoin/Zcash: context info */}
                                    {(isBitcoin || isZcash) && (
                                        <div className="flex items-start gap-2.5 p-3 rounded-xl bg-primary/10 border border-primary/20">
                                            <EyeOff className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                                            <div className="text-xs leading-relaxed">
                                                {sendPayment ? (
                                                    <>
                                                        <p className="font-semibold text-primary mb-0.5">Sending from address</p>
                                                        <p className="text-muted-foreground font-mono text-[10px]">
                                                            {censor(sendPayment.address, 8, 6)}
                                                        </p>
                                                    </>
                                                ) : (
                                                    <>
                                                        <p className="font-semibold text-primary mb-0.5">Multi-address send</p>
                                                        <p className="text-muted-foreground">
                                                            Aggregating UTXOs from {filteredConfirmed.filter(p => (nspBalances.get(p.tweak) ?? 0) > 0).length} NSP address(es).
                                                        </p>
                                                        <p className="text-amber-400/90 text-[10px] mt-1.5 leading-relaxed">
                                                            Combining multiple addresses in one transaction links them on-chain, reducing privacy. Send from individual addresses for better privacy.
                                                        </p>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {sendSuccess ? (
                                        <div className="space-y-3 animate-fade-in">
                                            <Alert>
                                                <AlertDescription className="text-xs">Transaction broadcast successfully!</AlertDescription>
                                            </Alert>
                                            <div className="space-y-1">
                                                <label className="text-xs text-muted-foreground font-medium">Transaction ID</label>
                                                <div className="flex items-center gap-1.5">
                                                    <Input value={censor(sendSuccess, 8, 4)} readOnly className="text-[10px] font-mono" />
                                                    <Button size="sm" variant="outline" onClick={() => copyText(sendSuccess, 'nsp-txid')}>
                                                        {copiedId === 'nsp-txid' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                                    </Button>
                                                </div>
                                            </div>
                                            {/* NSP notification relay progress */}
                                            {nspRecipientPubkey && (
                                                <>
                                                    {nspNotifying && (
                                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                            Sending notification to recipient...
                                                        </div>
                                                    )}
                                                    {nspNotifyResults.length > 0 && (
                                                        <div className="space-y-1">
                                                            <label className="text-xs text-muted-foreground font-medium">Notification Relay Status</label>
                                                            <div className="max-h-32 overflow-y-auto space-y-1">
                                                                {nspNotifyResults.map((r, i) => (
                                                                    <div key={i} className="flex items-center gap-2 text-[11px]">
                                                                        <div className={cn(
                                                                            "w-1.5 h-1.5 rounded-full shrink-0",
                                                                            r.success ? "bg-green-500" : "bg-red-500"
                                                                        )} />
                                                                        <span className="truncate text-muted-foreground">{r.relay.replace('wss://', '')}</span>
                                                                        <span className={cn("ml-auto shrink-0 font-medium", r.success ? "text-green-500" : "text-red-500")}>
                                                                            {r.success ? 'OK' : r.error || 'Failed'}
                                                                        </span>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                            {nspNotifyDone && (() => {
                                                                const ok = nspNotifyResults.filter(r => r.success).length;
                                                                return (
                                                                    <p className={cn("text-[11px] font-medium", ok > 0 ? "text-green-500" : "text-destructive")}>
                                                                        {ok > 0
                                                                            ? `✓ Notification delivered to ${ok}/${nspNotifyResults.length} relay${nspNotifyResults.length > 1 ? 's' : ''}`
                                                                            : '✗ Failed to deliver notification'}
                                                                    </p>
                                                                );
                                                            })()}
                                                        </div>
                                                    )}
                                                </>
                                            )}
                                            <Button className="w-full" onClick={() => { setShowSendModal(false); setSendSuccess(''); }} disabled={nspNotifying}>
                                                {nspNotifying ? 'Notifying...' : 'Done'}
                                            </Button>
                                        </div>
                                    ) : nspSendLoading ? (
                                        <div className="flex items-center justify-center py-8 text-muted-foreground">
                                            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
                                        </div>
                                    ) : sendStep === 'form' ? (
                                        <>
                                            {sendError && (
                                                <Alert variant="destructive">
                                                    <AlertDescription className="text-xs flex items-start gap-1.5">
                                                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {sendError}
                                                    </AlertDescription>
                                                </Alert>
                                            )}
                                            <div className="space-y-1.5">
                                                <label className="text-xs text-muted-foreground font-medium">Recipient</label>
                                                <Input value={sendTo} onChange={e => {
                                                    const val = e.target.value;
                                                    setSendTo(val);
                                                    if (val.startsWith('npub1') && val.length >= 62) {
                                                        deriveFromNpub(val);
                                                    } else if (!val.startsWith('npub')) {
                                                        // Clear NSP state if user switches to a raw address
                                                        if (nspRecipientPubkey) {
                                                            setNspRecipientPubkey(null);
                                                            setNspRecipientName('');
                                                            setNspDerivedAddress('');
                                                            setNspRecipientTweak('');
                                                        }
                                                    }
                                                }}
                                                    placeholder={`npub or ${currentChain.name} address...`}
                                                    className={cn("text-xs font-mono", recipientError && "border-destructive")} />
                                                {recipientError && !nspRecipientPubkey && (
                                                    <p className="text-[10px] text-destructive flex items-center gap-1">
                                                        <AlertTriangle className="w-3 h-3 shrink-0" /> {recipientError}
                                                    </p>
                                                )}
                                                {/* To Following button */}
                                                <div className="flex flex-wrap gap-1.5">
                                                    {activePubkey && (
                                                        <button
                                                            onClick={() => setShowFollowsSelector(true)}
                                                            className="px-2.5 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary text-[11px] font-medium rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                                                        >
                                                            <Users className="w-3 h-3" />
                                                            To Following
                                                        </button>
                                                    )}
                                                    {nspRecipientPubkey && (
                                                        <button
                                                            onClick={() => {
                                                                setNspRecipientPubkey(null);
                                                                setNspRecipientName('');
                                                                setNspDerivedAddress('');
                                                                setNspRecipientTweak('');
                                                                setSendTo('');
                                                            }}
                                                            className="px-2.5 py-1.5 bg-destructive/10 hover:bg-destructive/20 text-destructive text-[11px] font-medium rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                                                        >
                                                            <X className="w-3 h-3" />
                                                            Clear
                                                        </button>
                                                    )}
                                                </div>
                                                {/* Bitcoin send mode toggle: Taproot / SegWit */}
                                                {isBitcoin && nspRecipientPubkey && (
                                                    <div className="flex bg-secondary border border-border rounded-lg p-0.5 gap-0.5">
                                                        {([
                                                            { id: 'taproot' as const, label: 'Taproot' },
                                                            { id: 'segwit' as const, label: 'SegWit' },
                                                        ]).map(mode => (
                                                            <button
                                                                key={mode.id}
                                                                className={cn(
                                                                    "flex-1 py-1.5 px-2 rounded-md text-[10px] font-semibold transition-colors cursor-pointer",
                                                                    btcSendMode === mode.id
                                                                        ? "bg-primary text-primary-foreground"
                                                                        : "text-muted-foreground hover:text-foreground"
                                                                )}
                                                                onClick={() => {
                                                                    if (btcSendMode === mode.id) return;
                                                                    setBtcSendMode(mode.id);
                                                                    // Re-derive address for new mode
                                                                    void deriveNspForRecipient(nspRecipientPubkey, mode.id === 'segwit' ? 'native' : 'taproot');
                                                                }}
                                                            >
                                                                {mode.label}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                                {/* NSP / SP derived address info */}
                                                {nspRecipientPubkey && nspDeriving && !nspDerivedAddress && (
                                                    <div className="flex items-center gap-2 p-2.5 rounded-xl bg-primary/5 border border-primary/20 animate-fade-in">
                                                        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />
                                                        <p className="text-[11px] text-muted-foreground">Deriving one-time address…</p>
                                                    </div>
                                                )}
                                                {nspRecipientPubkey && nspDerivedAddress && (
                                                    <div className="flex items-center gap-2 p-2.5 rounded-xl bg-primary/5 border border-primary/20 animate-fade-in">
                                                        <div className="flex-1 min-w-0">
                                                            {nspRecipientName && (
                                                                <p className="text-[11px] text-primary font-medium truncate mb-0.5">
                                                                    Sending to {nspRecipientName}
                                                                </p>
                                                            )}
                                                            <p className="text-[10px] text-muted-foreground font-mono truncate">
                                                                NSP: {censor(nspDerivedAddress)}
                                                            </p>
                                                        </div>
                                                        <button
                                                            onClick={regenerateNspAddress}
                                                            className="p-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 transition-colors cursor-pointer shrink-0"
                                                            title="Generate new random address"
                                                        >
                                                            <RefreshCw className="w-3.5 h-3.5 text-primary" />
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                            <div className="space-y-1.5">
                                                <div className="flex justify-between items-center">
                                                    <label className="text-xs text-muted-foreground font-medium">Amount</label>
                                                    <span className="text-[10px] text-muted-foreground">Available: {availStr}</span>
                                                </div>
                                                <Input type="number" value={sendAmount}
                                                    onChange={e => handleSendAmountChange(e.target.value)}
                                                    placeholder="0.00" className="text-sm font-mono" />
                                            </div>
                                            {/* EVM insufficient warning */}
                                            {evmInsufficientBalance && (
                                                <Alert variant="destructive">
                                                    <AlertDescription className="text-xs flex items-center gap-1.5">
                                                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                                        Insufficient balance in selected address
                                                    </AlertDescription>
                                                </Alert>
                                            )}
                                            {isBitcoin && feeRates && (
                                                <div className="space-y-1.5">
                                                    <label className="text-xs text-muted-foreground font-medium">Fee Rate (sat/vB)</label>
                                                    <div className="grid grid-cols-3 gap-1.5">
                                                        {[
                                                            { label: 'Economy', rate: feeRates.economyFee },
                                                            { label: 'Normal', rate: feeRates.hourFee },
                                                            { label: 'Fast', rate: feeRates.fastestFee },
                                                        ].map(({ label, rate }) => (
                                                            <button key={label} onClick={() => setSelectedFeeRate(rate)}
                                                                className={cn("py-2 px-2 rounded-lg text-center transition-colors cursor-pointer border",
                                                                    selectedFeeRate === rate ? "bg-primary/10 border-primary/30 text-primary" : "bg-secondary border-transparent text-muted-foreground hover:text-foreground")}>
                                                                <div className="text-[10px] font-medium">{label}</div>
                                                                <div className="text-xs font-bold">{rate}</div>
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                            <Button className="w-full gap-1.5 font-bold"
                                                onClick={() => setSendStep('review')}
                                                disabled={!isValidRecipient || !sendAmount || evmInsufficientBalance}>
                                                <SendIcon className="w-4 h-4" /> Review Transaction
                                            </Button>
                                        </>
                                    ) : (
                                        <div className="space-y-3 animate-fade-in">
                                            <div className="bg-secondary/50 rounded-xl p-4 space-y-3">
                                                <div className="flex justify-between items-center">
                                                    <span className="text-xs text-muted-foreground">Recipient</span>
                                                    <div className="text-right">
                                                        {nspRecipientName && (
                                                            <span className="text-xs font-medium text-primary block">{nspRecipientName}</span>
                                                        )}
                                                        <span className="text-xs font-mono text-foreground max-w-[200px] truncate block">
                                                            {censor(sendTo, 8, 4)}
                                                        </span>
                                                    </div>
                                                </div>
                                                {nspRecipientPubkey && (
                                                    <>
                                                        <div className="border-t border-border" />
                                                        <div className="flex justify-between items-center">
                                                            <span className="text-xs text-muted-foreground">NSP Address</span>
                                                            <span className="text-[10px] font-mono text-muted-foreground max-w-[200px] truncate block">
                                                                {censor(nspDerivedAddress, 8, 4)}
                                                            </span>
                                                        </div>
                                                        <div className="border-t border-border" />
                                                        <div className="flex justify-between items-center">
                                                            <span className="text-xs text-muted-foreground">Type</span>
                                                            <span className="text-[11px] font-medium text-primary flex items-center gap-1">
                                                                <Bell className="w-3 h-3" /> Will notify via Nostr
                                                            </span>
                                                        </div>
                                                    </>
                                                )}
                                                <div className="border-t border-border" />
                                                <div className="flex justify-between items-center">
                                                    <span className="text-xs text-muted-foreground">Amount</span>
                                                    <span className="text-sm font-bold text-foreground">
                                                        {sendAmount} {isBitcoin ? 'sats' : isZcash ? 'ZEC' : currentChain.name}
                                                    </span>
                                                </div>
                                                {isEvm && selectedEvmAddress && (
                                                    <>
                                                        <div className="border-t border-border" />
                                                        <div className="flex justify-between items-center">
                                                            <span className="text-xs text-muted-foreground">From</span>
                                                            <span className="text-[10px] font-mono text-foreground">
                                                                {censor(selectedEvmAddress.address)}
                                                            </span>
                                                        </div>
                                                    </>
                                                )}
                                                {isBitcoin && (
                                                    <>
                                                        <div className="border-t border-border" />
                                                        <div className="flex justify-between items-center">
                                                            <span className="text-xs text-muted-foreground">From</span>
                                                            <span className="text-[10px] font-mono text-foreground">
                                                                {sendPayment
                                                                    ? censor(sendPayment.address)
                                                                    : `${new Set(taggedUtxos.map(t => t.privateKeyHex)).size} address(es)`
                                                                }
                                                            </span>
                                                        </div>
                                                        <div className="flex justify-between items-center">
                                                            <span className="text-xs text-muted-foreground">Fee Rate</span>
                                                            <span className="text-xs font-medium text-foreground">{selectedFeeRate} sat/vB</span>
                                                        </div>
                                                        <div className="flex justify-between items-center">
                                                            <span className="text-xs text-muted-foreground">Inputs</span>
                                                            <span className="text-xs font-medium text-foreground">{taggedUtxos.length} UTXOs</span>
                                                        </div>
                                                    </>
                                                )}
                                            </div>
                                            {sendError && (
                                                <Alert variant="destructive">
                                                    <AlertDescription className="text-xs flex items-start gap-1.5">
                                                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {sendError}
                                                    </AlertDescription>
                                                </Alert>
                                            )}
                                            <div className="flex gap-2">
                                                <Button variant="outline" className="flex-1" onClick={() => setSendStep('form')}>Back</Button>
                                                <Button className="flex-1 gap-1.5 font-bold" onClick={handleNspSend} disabled={sending}>
                                                    {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : nspRecipientPubkey ? <Bell className="w-4 h-4" /> : <SendIcon className="w-4 h-4" />}
                                                    {sending ? (nspRecipientPubkey ? 'Sending & Notifying...' : 'Sending...') : (nspRecipientPubkey ? 'Send & Notify' : 'Confirm Send')}
                                                </Button>
                                            </div>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                );
            })()}

            {/* ── NSP TRANSACTION DETAIL MODAL ── */}
            {selectedNspTx && (() => {
                const tx = selectedNspTx;
                const txDate = tx.time > 0 ? new Date(tx.time * 1000) : null;
                const sentEntry = sentList.find(s => s.txid === tx.txid);
                const recipientNpub = sentEntry ? nip19.npubEncode(sentEntry.recipientPubkey) : null;
                // Build explorer links based on the current chain
                const explorers: { name: string; url: string }[] = [];
                if (isBitcoin) {
                    explorers.push(
                        { name: 'Mempool.space', url: `https://mempool.space/tx/${tx.txid}` },
                        { name: 'Blockstream', url: `https://blockstream.info/tx/${tx.txid}` },
                        { name: 'Blockchain.com', url: `https://www.blockchain.com/btc/tx/${tx.txid}` },
                    );
                } else if (isZcash) {
                    explorers.push(
                        { name: '3xpl', url: `https://3xpl.com/zcash/transaction/${tx.txid}` },
                        { name: 'Blockchair', url: `https://blockchair.com/zcash/transaction/${tx.txid}` },
                    );
                } else if (isEvm) {
                    const evmChain = EVM_CHAINS[chain];
                    if (evmChain) {
                        explorers.push({ name: evmChain.name, url: `${evmChain.explorerUrl}/tx/${tx.txid}` });
                    }
                }

                const handleClose = () => {
                    setSelectedNspTx(null);
                    setDetailPage('info');
                    setExistingNotifEvent(null);
                    setRenotifyResults([]);
                    setRenotifyDone(false);
                };

                const handleStartRenotify = async () => {
                    if (!sentEntry) return;
                    setDetailPage('renotify');
                    setExistingNotifEvent(null);
                    setRenotifyResults([]);
                    setRenotifyDone(false);
                    // Legacy entries carry an ephemeral key whose existing notification can be
                    // looked up. Deterministic entries have no stored key — go straight to recreate.
                    if (!sentEntry.senderNsec) { setFetchingNotif(false); return; }
                    setFetchingNotif(true);
                    try {
                        const existing = await fetchExistingNotification(sentEntry.senderNsec, sentEntry.recipientPubkey);
                        setExistingNotifEvent(existing);
                    } catch (e) {
                        console.error('[NSP] Failed to fetch notification:', e);
                    } finally {
                        setFetchingNotif(false);
                    }
                };

                const handleRepublish = async () => {
                    if (!existingNotifEvent || !sentEntry) return;
                    setRenotifyLoading(true);
                    setRenotifyResults([]);
                    setRenotifyDone(false);
                    try {
                        await publishNspNotification(
                            existingNotifEvent,
                            sentEntry.recipientPubkey,
                            (result) => setRenotifyResults(prev => [...prev, result]),
                        );
                    } catch (e) {
                        console.error('[NSP] Republish failed:', e);
                    } finally {
                        setRenotifyLoading(false);
                        setRenotifyDone(true);
                    }
                };

                const handleCreateAndPublish = async () => {
                    if (!sentEntry) return;
                    setRenotifyLoading(true);
                    setRenotifyResults([]);
                    setRenotifyDone(false);
                    try {
                        // Deterministic entries (have n) recreate the notification statelessly from
                        // (sender nsec, recipient, n). Legacy entries reuse the stored ephemeral key.
                        let event: any;
                        if (sentEntry.n !== undefined && privateKeyHex) {
                            ({ event } = createDeterministicNspNotification(privateKeyHex, sentEntry.recipientPubkey, sentEntry.n, {
                                address: sentEntry.address, chain: sentEntry.chain, asset: sentEntry.asset,
                                token: sentEntry.token, txid: sentEntry.txid, amount: sentEntry.amount,
                            }));
                        } else {
                            const payload: NspPayload = {
                                address: sentEntry.address, chain: sentEntry.chain, asset: sentEntry.asset,
                                token: sentEntry.token, tweak: sentEntry.tweak, txid: sentEntry.txid,
                                amount: sentEntry.amount, timestamp: sentEntry.timestamp,
                            };
                            ({ event } = createNspNotification(sentEntry.recipientPubkey, payload, sentEntry.senderNsec));
                        }
                        await publishNspNotification(
                            event,
                            sentEntry.recipientPubkey,
                            (result) => setRenotifyResults(prev => [...prev, result]),
                        );
                    } catch (e) {
                        console.error('[NSP] Create & publish failed:', e);
                    } finally {
                        setRenotifyLoading(false);
                        setRenotifyDone(true);
                    }
                };

                return (
                    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                        <div className="flex min-h-full items-center justify-center px-4 py-20">
                            <Card className="w-full max-w-[400px] shadow-2xl">
                                <CardHeader className="flex-row items-center justify-between">
                                    <CardTitle className="text-base flex items-center gap-2">
                                        {detailPage === 'renotify' ? (
                                            <>
                                                <div className="p-1.5 rounded-full bg-primary/10 text-primary">
                                                    <Bell className="w-4 h-4" />
                                                </div>
                                                Renotify
                                            </>
                                        ) : (
                                            <>
                                                <div className={cn(
                                                    "p-1.5 rounded-full",
                                                    tx.isReceive ? "bg-green-500/10 text-green-500" : "bg-primary/10 text-primary"
                                                )}>
                                                    {tx.isReceive ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                                                </div>
                                                {tx.isReceive ? 'Received' : 'Sent'} {tx.amount}
                                            </>
                                        )}
                                    </CardTitle>
                                    <button onClick={handleClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                        <X className="w-4 h-4" />
                                    </button>
                                </CardHeader>
                                <CardContent className="flex flex-col gap-4">
                                    {detailPage === 'info' ? (
                                        <>
                                            {/* Date & Time */}
                                            <div className="flex flex-col gap-1">
                                                <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Date & Time</label>
                                                <div className="text-sm text-foreground">
                                                    {txDate
                                                        ? `${txDate.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })} · ${txDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
                                                        : 'Pending'}
                                                </div>
                                            </div>

                                            {/* Status */}
                                            <div className="flex flex-col gap-1">
                                                <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Status</label>
                                                <div className="flex items-center gap-1.5">
                                                    <div className={cn("w-2 h-2 rounded-full", tx.confirmed ? "bg-green-500" : "bg-yellow-500 animate-pulse")} />
                                                    <span className="text-sm text-foreground">{tx.confirmed ? 'Confirmed' : 'Pending confirmation'}</span>
                                                </div>
                                            </div>

                                            {/* Recipient (if sent to following) */}
                                            {sentEntry && recipientNpub && (
                                                <div className="flex flex-col gap-1.5">
                                                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Recipient</label>
                                                    <div className="flex items-center gap-2 bg-primary/5 border border-primary/20 rounded-lg px-2.5 py-2">
                                                        <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                                                            <Users className="w-3.5 h-3.5 text-primary" />
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="text-[11px] font-mono text-primary truncate">{censor(recipientNpub, 10, 4)}</div>
                                                        </div>
                                                        <button onClick={() => copyText(recipientNpub, 'nsp-recip')} className="shrink-0 p-1 hover:bg-white/10 rounded transition-colors cursor-pointer">
                                                            {copiedId === 'nsp-recip' ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                                                        </button>
                                                    </div>
                                                </div>
                                            )}

                                            {/* NSP Address(es) */}
                                            <div className="flex flex-col gap-1.5">
                                                <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                                                    {tx.addresses && tx.addresses.length > 1 ? `NSP Addresses (${tx.addresses.length})` : 'NSP Address'}
                                                </label>
                                                {(tx.addresses && tx.addresses.length > 1 ? tx.addresses : [tx.address]).map((addr, idx) => (
                                                    <div key={idx} className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2.5 py-1.5">
                                                        <span className="text-[11px] font-mono truncate flex-1 text-primary font-semibold">{censor(addr)}</span>
                                                        <button onClick={() => copyText(addr, `nsp-detail-addr-${idx}`)} className="shrink-0 p-1 hover:bg-white/10 rounded transition-colors cursor-pointer">
                                                            {copiedId === `nsp-detail-addr-${idx}` ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>

                                            {/* Transaction ID */}
                                            <div className="flex flex-col gap-1.5">
                                                <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Transaction ID</label>
                                                <div className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2.5 py-1.5">
                                                    <span className="text-[11px] font-mono truncate flex-1">{censor(tx.txid, 8, 4)}</span>
                                                    <button onClick={() => copyText(tx.txid, 'nsp-detail-txid')} className="shrink-0 p-1 hover:bg-white/10 rounded transition-colors cursor-pointer">
                                                        {copiedId === 'nsp-detail-txid' ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                                                    </button>
                                                </div>
                                            </div>

                                            {/* View on Explorer */}
                                            {explorers.length > 0 && (
                                                <div className="flex flex-col gap-1.5">
                                                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">View on Explorer</label>
                                                    <div className="grid gap-1.5">
                                                        {explorers.map(({ name, url }) => (
                                                            <button
                                                                key={name}
                                                                onClick={() => openUrl(url)}
                                                                className="flex items-center justify-between w-full px-3 py-2 bg-secondary/50 hover:bg-secondary rounded-lg transition-colors cursor-pointer"
                                                            >
                                                                <span className="text-xs font-medium text-foreground">{name}</span>
                                                                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            {/* Renotify button */}
                                            {sentEntry && (
                                                <Button
                                                    variant="outline"
                                                    className="w-full gap-1.5"
                                                    onClick={handleStartRenotify}
                                                >
                                                    <Bell className="w-4 h-4" /> Renotify Recipient
                                                </Button>
                                            )}
                                        </>
                                    ) : (
                                        /* ── RENOTIFY PAGE ── */
                                        <div className="space-y-4 animate-fade-in">
                                            {/* Recipient info */}
                                            {recipientNpub && (
                                                <div className="flex items-center gap-2 bg-primary/5 border border-primary/20 rounded-lg px-3 py-2">
                                                    <Users className="w-4 h-4 text-primary shrink-0" />
                                                    <span className="text-[11px] font-mono text-primary truncate">{recipientNpub}</span>
                                                </div>
                                            )}

                                            {/* Fetching state */}
                                            {fetchingNotif && (
                                                <div className="flex items-center justify-center gap-2 py-4 text-muted-foreground">
                                                    <Loader2 className="w-4 h-4 animate-spin" />
                                                    <span className="text-sm">Checking relays for existing notification...</span>
                                                </div>
                                            )}

                                            {/* Found / Not Found */}
                                            {!fetchingNotif && !renotifyDone && (
                                                <>
                                                    {existingNotifEvent ? (
                                                        <div className="space-y-3">
                                                            <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2">
                                                                <div className="text-xs font-medium text-green-500 flex items-center gap-1.5">
                                                                    <Check className="w-3.5 h-3.5" /> Existing notification found
                                                                </div>
                                                                <div className="text-[10px] text-muted-foreground mt-1 font-mono truncate">
                                                                    Event: {censor(existingNotifEvent.id || '', 10, 4)}
                                                                </div>
                                                            </div>
                                                            <Button className="w-full gap-1.5" onClick={handleRepublish} disabled={renotifyLoading}>
                                                                {renotifyLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                                                                Republish to Relays
                                                            </Button>
                                                        </div>
                                                    ) : (
                                                        <div className="space-y-3">
                                                            <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg px-3 py-2">
                                                                <div className="text-xs font-medium text-orange-500 flex items-center gap-1.5">
                                                                    <AlertTriangle className="w-3.5 h-3.5" /> No existing notification found on relays
                                                                </div>
                                                            </div>
                                                            <Button className="w-full gap-1.5" onClick={handleCreateAndPublish} disabled={renotifyLoading}>
                                                                {renotifyLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bell className="w-4 h-4" />}
                                                                Send New Notification
                                                            </Button>
                                                        </div>
                                                    )}
                                                </>
                                            )}

                                            {/* Relay progress */}
                                            {renotifyResults.length > 0 && (
                                                <div className="space-y-1.5">
                                                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Relay Status</label>
                                                    {renotifyResults.map((r, i) => (
                                                        <div key={i} className="flex items-center gap-2 text-xs">
                                                            <div className={cn("w-2 h-2 rounded-full shrink-0", r.success ? "bg-green-500" : "bg-red-500")} />
                                                            <span className="text-muted-foreground truncate flex-1 font-mono text-[10px]">{r.relay}</span>
                                                            <span className={cn("text-[10px] font-medium", r.success ? "text-green-500" : "text-red-500")}>
                                                                {r.success ? 'OK' : 'Failed'}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}

                                            {/* Done summary */}
                                            {renotifyDone && (
                                                <div className="bg-secondary/50 rounded-lg px-3 py-2 text-center">
                                                    <span className="text-xs text-foreground">
                                                        ✓ Delivered to {renotifyResults.filter(r => r.success).length}/{renotifyResults.length} relays
                                                    </span>
                                                </div>
                                            )}

                                            {/* Back button */}
                                            <Button variant="outline" className="w-full" onClick={() => {
                                                setDetailPage('info');
                                                setExistingNotifEvent(null);
                                                setRenotifyResults([]);
                                                setRenotifyDone(false);
                                            }}>
                                                Back to Details
                                            </Button>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                );
            })()}

            {/* FollowsSelector for NSP sends */}
            {activePubkey && (
                <FollowsSelector
                    isOpen={showFollowsSelector}
                    onClose={() => setShowFollowsSelector(false)}
                    onSelect={(npub, displayName) => {
                        handleFollowsSelect(npub);
                        if (displayName) setNspRecipientName(displayName);
                        setShowFollowsSelector(false);
                    }}
                    activePubkey={activePubkey}
                    chainType={'none'}
                />
            )}
        </div>
    );
}
