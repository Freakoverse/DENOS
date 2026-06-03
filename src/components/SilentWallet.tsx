/**
 * SilentWallet — Nostr Silent Payments tab (HD-wallet-like).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
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
import { NspConfirmModal } from '@/components/NspConfirmModal';
import { FollowsSelector } from '@/components/FollowsSelector';
import { nip19 } from 'nostr-tools';
import {
    generateTweak,
    deriveTweakedAddress,
    deriveTweakedAddressFromPubkey,
    tweakPrivateKey,
    getSigningKey,
    buildPaymentURI,
    subscribeToNspNotifications,
    parseNspNotification,
    createNspNotification,
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
    verifyPaymentOwnership,
    type NspChain,
    type NspPayload,
    type NspConfirmedPayment,
    type NspSentEntry,
    type NspIndex,
    type RelayPublishResult,
} from '@/services/nsp';
import {
    deriveScanKeys,
    deriveScanPubKeys,
    encodeSp1Address,
    decodeSp1Address,
    deriveOutputForSp1,
    verifyTxOwnership,
    type Sp1VerifyResult,
} from '@/services/sp1';

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
        { id: 'sp1', label: 'Silent Payment (sp1)', token: null, icon: chainIcons.bitcoin },
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
    const [showConfirm, setShowConfirm] = useState(false);
    const [showRegenConfirm, setShowRegenConfirm] = useState(false);

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

    // ── sp1 (BIP-352) state ──
    const [sp1Address, setSp1Address] = useState('');
    const [sp1VerifyTxid, setSp1VerifyTxid] = useState('');
    const [sp1Verifying, setSp1Verifying] = useState(false);
    const [sp1VerifyResult, setSp1VerifyResult] = useState<Sp1VerifyResult | null>(null);
    const [, setSp1NotifSending] = useState(false);
    const [sp1NotifDone, setSp1NotifDone] = useState(false);

    // Notifications state
    const [notifView, setNotifView] = useState<'unconfirmed' | 'confirmed'>('unconfirmed');
    const [unconfirmed, setUnconfirmed] = useState<{ event: any; payload: NspPayload; checking: boolean; verified: boolean }[]>([]);
    const [confirmed, setConfirmed] = useState<(NspConfirmedPayment & { liveBalance?: string })[]>([]);
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
    const [sentListLoaded, setSentListLoaded] = useState(false);

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

    // ── Generate Address ──
    const handleGenerate = () => {
        if (!privateKeyHex) return;
        const tweak = generateTweak();
        const addr = deriveTweakedAddress(chain, privateKeyHex, tweak, asset);
        setCurrentTweak(tweak);
        setGeneratedAddress(addr);
        const uri = buildPaymentURI(chain, addr, amount || undefined, currentAsset?.token);
        setQrUri(uri);
    };

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
    const isSp1 = asset === 'sp1';

    // ── Derive sp1 address from nsec/npub ──
    useEffect(() => {
        if (!privateKeyHex || !activePubkey) { setSp1Address(''); return; }
        try {
            const keys = deriveScanKeys(privateKeyHex, activePubkey);
            setSp1Address(encodeSp1Address(keys.scanPub, keys.spendPub));
        } catch (e) {
            console.error('[SP1] Failed to derive sp1 address:', e);
            setSp1Address('');
        }
    }, [privateKeyHex, activePubkey]);

    // ── sp1 txid verification + self-notification ──
    const handleSp1Verify = async () => {
        if (!privateKeyHex || !activePubkey || !sp1VerifyTxid.trim()) return;
        setSp1Verifying(true);
        setSp1VerifyResult(null);
        setSp1NotifDone(false);
        try {
            const keys = deriveScanKeys(privateKeyHex, activePubkey);
            const result = await verifyTxOwnership(keys.scanPriv, keys.spendPub, sp1VerifyTxid.trim());
            setSp1VerifyResult(result);

            if (result.owned && result.tweak && result.address) {
                // Self-notify via kind 1604
                setSp1NotifSending(true);
                const payload: NspPayload = {
                    address: result.address,
                    chain: 'bitcoin',
                    asset: 'sp1',
                    token: null,
                    tweak: result.tweak,
                    txid: sp1VerifyTxid.trim(),
                    amount: result.amount?.toString() || '0',
                    timestamp: Math.floor(Date.now() / 1000),
                };
                const { event } = createNspNotification(activePubkey, payload);
                await publishNspNotification(event, activePubkey);
                setSp1NotifDone(true);
                setSp1NotifSending(false);
                toast('Payment verified & notification sent!', 'success');
            } else {
                toast('No matching output found for this transaction', 'info');
            }
        } catch (e) {
            console.error('[SP1] Verification error:', e);
            toast('Verification failed: ' + String(e), 'error');
        }
        setSp1Verifying(false);
    };

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
        setLoadingNotifs(true);
        let subRef: { stop: () => void } | null = null;

        (async () => {
            // 1. Load index + all pages
            const index = await loadNspIndex(privateKeyHex, activePubkey);
            setNspIndex(index);

            const payments = await loadAllNspPages(privateKeyHex, activePubkey, index.last_page);
            const unique = payments.filter((p, i, arr) => arr.findIndex(x => x.tweak === p.tweak) === i);
            setConfirmed(unique);
            setLoadingNotifs(false);

            // Purge any unconfirmed items that are already confirmed
            const confirmedTweaks = new Set(unique.map(p => p.tweak));
            setUnconfirmed(prev => prev.filter(u => !confirmedTweaks.has(u.payload.tweak)));

            // 2. Catch-up scan: fetch notifications since last_scanned
            const newCursor = await catchUpScan(activePubkey, index.last_scanned, (batch) => {
                for (const event of batch) {
                    const payload = parseNspNotification(event, privateKeyHex);
                    if (!payload) continue;
                    setUnconfirmed(prev => {
                        if (prev.some(u => u.payload.tweak === payload.tweak)) return prev;
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
                    if (prev.some(u => u.payload.tweak === payload.tweak)) return prev;
                    return [...prev, { event, payload, checking: false, verified: false }];
                });
                setConfirmed(prevConfirmed => {
                    if (prevConfirmed.some(p => p.tweak === payload.tweak)) {
                        setUnconfirmed(prev => prev.filter(u => u.payload.tweak !== payload.tweak));
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

        // Load sent list from NIP-78
        if (!sentListLoaded) {
            loadSentList(privateKeyHex, activePubkey).then(({ entries }) => {
                setSentList(entries);
                setSentListLoaded(true);
            });
        }

        return () => { if (subRef) subRef.stop(); };
    }, [activePubkey, privateKeyHex]);

    // ── Auto-scan unconfirmed: verify ownership → confirm permanently ──
    useEffect(() => {
        if (!privateKeyHex || unconfirmed.length === 0) return;

        const newlyConfirmed: NspConfirmedPayment[] = [];
        const removedTweaks: string[] = [];

        for (const item of unconfirmed) {
            if (item.checking || item.verified) continue;

            // Verify ownership (tweaked key derives the expected address)
            const owned = verifyPaymentOwnership(privateKeyHex, item.payload.tweak, item.payload.address, item.payload.chain, item.payload.asset);
            if (!owned) {
                console.warn(`[NSP] ✗ Ownership verification FAILED — removing notification:`,
                    `chain=${item.payload.chain} asset=${item.payload.asset} address=${item.payload.address} tweak=${item.payload.tweak.slice(0, 16)}...`);
                removedTweaks.push(item.payload.tweak);
                continue;
            }

            // Ownership verified → confirm permanently (regardless of current balance)
            newlyConfirmed.push({
                chain: item.payload.chain,
                address: item.payload.address,
                tweak: item.payload.tweak,
                asset: item.payload.asset,
                token: item.payload.token,
                txid: item.payload.txid,
                amount: item.payload.amount,
                confirmedAt: Math.floor(Date.now() / 1000),
            });
            removedTweaks.push(item.payload.tweak);
        }

        if (newlyConfirmed.length === 0 && removedTweaks.length === 0) return;

        // Remove processed items from unconfirmed
        if (removedTweaks.length > 0) {
            setUnconfirmed(prev => prev.filter(u => !removedTweaks.includes(u.payload.tweak)));
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

    // ── Manual rescan ──
    const rescanItem = async (tweak: string) => {
        const item = unconfirmed.find(u => u.payload.tweak === tweak);
        if (!item) return;
        setUnconfirmed(prev => prev.map(u =>
            u.payload.tweak === tweak ? { ...u, checking: true } : u
        ));
        const owned = verifyPaymentOwnership(privateKeyHex, item.payload.tweak, item.payload.address, item.payload.chain, item.payload.asset);
        if (owned) {
            const payment: NspConfirmedPayment = {
                chain: item.payload.chain, address: item.payload.address,
                tweak: item.payload.tweak, asset: item.payload.asset,
                token: item.payload.token, txid: item.payload.txid,
                amount: item.payload.amount, confirmedAt: Math.floor(Date.now() / 1000),
            };
            setConfirmed(prev => {
                if (prev.some(p => p.tweak === payment.tweak)) return prev;
                const merged = [...prev, payment];
                if (activePubkey && nspIndex) {
                    addConfirmedPayments(privateKeyHex, activePubkey, nspIndex, [payment], prev).then(updatedIdx => {
                        setNspIndex(updatedIdx);
                    });
                }
                return merged;
            });
            setUnconfirmed(prev => prev.filter(u => u.payload.tweak !== tweak));
            toast('Payment verified & confirmed!', 'success');
        } else {
            setUnconfirmed(prev => prev.map(u =>
                u.payload.tweak === tweak ? { ...u, checking: false } : u
            ));
            toast('Could not verify ownership', 'info');
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
    const [taggedUtxos, setTaggedUtxos] = useState<{ utxo: UTXO; privateKeyHex: string; rawTaproot?: boolean }[]>([]);
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
    const [nspDerivedAddress, setNspDerivedAddress] = useState('');
    // Bitcoin send mode toggle (Taproot, SegWit, SP) — only when Bitcoin + npub recipient
    const [btcSendMode, setBtcSendMode] = useState<'taproot' | 'segwit' | 'sp'>('taproot');
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
                const allTagged: { utxo: UTXO; privateKeyHex: string; rawTaproot?: boolean }[] = [];
                let total = 0;
                for (const p of sources) {
                    const tweakedKey = getSigningKey(chain, privateKeyHex, p.tweak, p.address, asset);
                    const utxos = await fetchUTXOs(p.address);
                    const isSp1Input = asset === 'sp1';
                    for (const u of utxos) {
                        allTagged.push({ utxo: u, privateKeyHex: tweakedKey, rawTaproot: isSp1Input });
                        total += u.value;
                    }
                }
                setTaggedUtxos(allTagged);
                setAggregatedBalance(total);
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
        // sp1 address — BIP-352 silent payment
        if (addr.startsWith('sp1')) {
            try { decodeSp1Address(addr); return null; } catch { return 'Invalid sp1 address'; }
        }
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
    const isSp1Recipient = sendTo.startsWith('sp1');
    const recipientError = validateRecipientAddress(sendTo);
    const isValidRecipient = sendTo.trim().length > 0 && !recipientError;

    // Keep the handleSendFromConfirmed for detail modal
    const handleSendFromConfirmed = (payment: NspConfirmedPayment) => {
        openSendModal(payment);
    };

    // Handle follows selection — derive NSP address from recipient's pubkey
    const handleFollowsSelect = (npub: string) => {
        try {
            const decoded = nip19.decode(npub);
            if (decoded.type !== 'npub') throw new Error('Invalid npub');
            const pubkeyHex = decoded.data as string;
            if (isBitcoin && btcSendMode === 'sp') {
                // SP mode: derive the recipient's static sp1 address
                const { scanPub, spendPub } = deriveScanPubKeys(pubkeyHex);
                const sp1Addr = encodeSp1Address(scanPub, spendPub);
                setNspRecipientPubkey(pubkeyHex);
                setNspRecipientTweak('');  // tweak is computed at send time from outpoints
                setNspDerivedAddress(sp1Addr);
                setSendTo(npub);
            } else {
                const effectiveAsset = isBitcoin ? (btcSendMode === 'segwit' ? 'native' : 'taproot') : asset;
                const tweak = generateTweak();
                const derivedAddr = deriveTweakedAddressFromPubkey(chain, pubkeyHex, tweak, effectiveAsset);
                setNspRecipientPubkey(pubkeyHex);
                setNspRecipientTweak(tweak);
                setNspDerivedAddress(derivedAddr);
                setSendTo(npub);
            }
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
            // Don't re-derive if it's the same recipient
            if (pubkeyHex === nspRecipientPubkey) return;
            if (isBitcoin && btcSendMode === 'sp') {
                const { scanPub, spendPub } = deriveScanPubKeys(pubkeyHex);
                const sp1Addr = encodeSp1Address(scanPub, spendPub);
                setNspRecipientPubkey(pubkeyHex);
                setNspRecipientName('');
                setNspRecipientTweak('');
                setNspDerivedAddress(sp1Addr);
            } else {
                const effectiveAsset = isBitcoin ? (btcSendMode === 'segwit' ? 'native' : 'taproot') : asset;
                const tweak = generateTweak();
                const derivedAddr = deriveTweakedAddressFromPubkey(chain, pubkeyHex, tweak, effectiveAsset);
                setNspRecipientPubkey(pubkeyHex);
                setNspRecipientName('');
                setNspRecipientTweak(tweak);
                setNspDerivedAddress(derivedAddr);
            }
        } catch { /* not a valid npub yet, ignore */ }
    };

    // Regenerate a fresh NSP address for the same recipient
    const regenerateNspAddress = () => {
        if (!nspRecipientPubkey) return;
        if (isBitcoin && btcSendMode === 'sp') {
            // SP mode: static address, no regeneration needed
            return;
        }
        const effectiveAsset = isBitcoin ? (btcSendMode === 'segwit' ? 'native' : 'taproot') : asset;
        const tweak = generateTweak();
        const derivedAddr = deriveTweakedAddressFromPubkey(chain, nspRecipientPubkey, tweak, effectiveAsset);
        setNspRecipientTweak(tweak);
        setNspDerivedAddress(derivedAddr);
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
        // When sending to an NSP recipient (npub), use the derived address
        let effectiveRecipient = nspDerivedAddress || sendTo.trim();
        let sp1TweakHex = '';
        if (!privateKeyHex || !effectiveRecipient) return;
        setSending(true);
        setSendError('');

        try {
            // sp1 destination: derive BIP-352 ECDH output address
            if ((isSp1Recipient || (isBitcoin && btcSendMode === 'sp' && nspRecipientPubkey)) && isBitcoin) {
                let scanPub: Buffer, spendPub: Buffer;
                if (isSp1Recipient) {
                    ({ scanPub, spendPub } = decodeSp1Address(sendTo.trim()));
                } else {
                    ({ scanPub, spendPub } = deriveScanPubKeys(nspRecipientPubkey!));
                }
                // We need the outpoints from selected UTXOs to compute the ECDH
                if (taggedUtxos.length === 0) throw new Error('No UTXOs available for sp1 derivation');
                // Use the first key's private key as the signing key (Taproot key-path spend)
                const signingKey = taggedUtxos[0].privateKeyHex;
                const outpoints = taggedUtxos.map(t => ({
                    txid: t.utxo.txid, vout: t.utxo.vout,
                }));
                const sp1Out = deriveOutputForSp1(signingKey, scanPub, spendPub, outpoints);
                effectiveRecipient = sp1Out.outputAddress;
                sp1TweakHex = sp1Out.tweak;
            }

            let resultTxid = '';


            if (isBitcoin) {
                const amountSats = parseInt(sendAmount);
                if (isNaN(amountSats) || amountSats <= 0) throw new Error('Invalid amount');
                if (amountSats < 546) throw new Error(`Amount too small — Bitcoin dust limit is 546 sats (tried ${amountSats})`);
                const { txHex, fee } = await createMultiKeyTaprootTransaction(
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
            const isSp1NpubSend = isBitcoin && btcSendMode === 'sp' && nspRecipientPubkey && sp1TweakHex;
            const isNspSend = nspRecipientPubkey && nspDerivedAddress && nspRecipientTweak;
            if ((isNspSend || isSp1NpubSend) && resultTxid) {
                const notifAddress = isSp1NpubSend ? effectiveRecipient : nspDerivedAddress;
                const notifTweak = isSp1NpubSend ? sp1TweakHex : nspRecipientTweak;
                const notifAsset = isSp1NpubSend ? 'sp1' : asset;
                setNspNotifying(true);
                setNspNotifyResults([]);
                setNspNotifyDone(false);
                try {
                    const payload: NspPayload = {
                        address: notifAddress,
                        chain: chain as NspChain,
                        asset: notifAsset,
                        token: currentAsset?.token || null,
                        tweak: notifTweak,
                        txid: resultTxid,
                        amount: sendAmount || '0',
                        timestamp: Math.floor(Date.now() / 1000),
                    };
                    const { event, ephemeralSkHex } = createNspNotification(nspRecipientPubkey!, payload);
                    await publishNspNotification(
                        event,
                        nspRecipientPubkey!,
                        (result) => setNspNotifyResults(prev => [...prev, result]),
                    );
                    setNspNotifyDone(true);

                    // Save to sent list (background, non-blocking)
                    const newEntry: NspSentEntry = {
                        txid: resultTxid,
                        chain: chain as NspChain,
                        asset: notifAsset,
                        token: currentAsset?.token || null,
                        amount: sendAmount || '0',
                        address: notifAddress,
                        tweak: notifTweak,
                        recipientPubkey: nspRecipientPubkey!,
                        senderNsec: ephemeralSkHex,
                        timestamp: Math.floor(Date.now() / 1000),
                    };
                    const updatedList = [...sentList, newEntry];
                    setSentList(updatedList);
                    if (privateKeyHex && activePubkey) {
                        saveSentList(privateKeyHex, activePubkey, updatedList).catch(e =>
                            console.error('[NSP] Failed to save sent list:', e)
                        );
                    }
                } catch (e) {
                    console.error('[NSP] Notification failed:', e);
                    toast('Transaction sent but notification failed — you can retry manually', 'info');
                } finally {
                    setNspNotifying(false);
                }
            }

            // ── sp1 destination: save to sent list (no notification) ──
            if (isSp1Recipient && sp1TweakHex && resultTxid) {
                const newEntry: NspSentEntry = {
                    txid: resultTxid,
                    chain: chain as NspChain,
                    asset: 'sp1',
                    token: null,
                    amount: sendAmount || '0',
                    address: effectiveRecipient,
                    tweak: sp1TweakHex,
                    recipientPubkey: '', // unknown from sp1 address
                    senderNsec: '',      // no ephemeral key needed
                    timestamp: Math.floor(Date.now() / 1000),
                };
                const updatedList = [...sentList, newEntry];
                setSentList(updatedList);
                if (privateKeyHex && activePubkey) {
                    saveSentList(privateKeyHex, activePubkey, updatedList).catch(e =>
                        console.error('[SP1] Failed to save sent list:', e)
                    );
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
                            <button onClick={() => { fetchAllNspBalances(); fetchNspTxHistory(); }} disabled={balanceLoading}
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
                                    <ArrowDownLeft className="w-4 h-4" /> {isSp1 ? 'Receive via Silent Payment' : 'Receive Silent Payment'}
                                </CardTitle>
                                <button onClick={() => { setShowReceiveModal(false); setSp1VerifyTxid(''); setSp1VerifyResult(null); setSp1NotifDone(false); }} className="text-muted-foreground hover:text-foreground cursor-pointer">
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

                                {isSp1 ? (
                                    /* ── sp1 Receive: static address + txid verification ── */
                                    <>
                                        {/* Static QR */}
                                        <div className="flex flex-col items-center gap-3">
                                            {sp1Address ? (
                                                <div className="bg-white p-3 rounded-xl">
                                                    <QRCodeSVG value={sp1Address} size={180} />
                                                </div>
                                            ) : (
                                                <div className="w-[204px] h-[204px] rounded-xl border-2 border-dashed border-border flex items-center justify-center">
                                                    <Loader2 className="w-6 h-6 text-muted-foreground/30 animate-spin" />
                                                </div>
                                            )}
                                        </div>

                                        {/* sp1 Address */}
                                        <div className="space-y-1.5">
                                            <label className="text-xs text-muted-foreground font-medium">Your Silent Payment Address</label>
                                            <div className="flex items-center gap-1.5">
                                                <Input value={censor(sp1Address, 8, 6)} readOnly className="text-xs font-mono" />
                                                {sp1Address && (
                                                    <Button size="sm" variant="outline" onClick={() => copyText(sp1Address, 'sp1-addr')}>
                                                        {copiedId === 'sp1-addr' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                                    </Button>
                                                )}
                                            </div>
                                        </div>

                                        {/* Divider */}
                                        <div className="flex items-center gap-2 py-1">
                                            <div className="flex-1 border-t border-border" />
                                            <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Received a payment?</span>
                                            <div className="flex-1 border-t border-border" />
                                        </div>

                                        {/* ⚠ Notification warning */}
                                        <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
                                            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                                            <p className="text-[11px] leading-relaxed text-amber-200/90">
                                                <span className="font-bold text-amber-400">Important:</span> The sender must send a Nostr notification with the payment details. Without it, your funds will be <span className="font-semibold">extremely difficult to recover</span> — there is no automatic way to scan the blockchain for your transaction.
                                            </p>
                                        </div>

                                        {/* txid verification */}
                                        <div className="space-y-1.5">
                                            <label className="text-xs text-muted-foreground font-medium">Transaction ID</label>
                                            <Input
                                                value={sp1VerifyTxid}
                                                onChange={e => { setSp1VerifyTxid(e.target.value); setSp1VerifyResult(null); setSp1NotifDone(false); }}
                                                placeholder="Paste txid here..."
                                                className="text-xs font-mono"
                                            />
                                        </div>

                                        <Button
                                            onClick={handleSp1Verify}
                                            className="w-full gap-2"
                                            disabled={!sp1VerifyTxid.trim() || sp1Verifying || sp1NotifDone}
                                        >
                                            {sp1Verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                                            {sp1Verifying ? 'Verifying...' : sp1NotifDone ? 'Verified ✓' : 'Verify & Send Notification'}
                                        </Button>

                                        {/* Verification result */}
                                        {sp1VerifyResult && (
                                            <div className={cn(
                                                "rounded-lg px-3 py-2.5 text-xs space-y-1",
                                                sp1VerifyResult.owned
                                                    ? "bg-green-500/10 border border-green-500/20"
                                                    : "bg-orange-500/10 border border-orange-500/20"
                                            )}>
                                                {sp1VerifyResult.owned ? (
                                                    <>
                                                        <div className="font-medium text-green-500 flex items-center gap-1.5">
                                                            <Check className="w-3.5 h-3.5" /> Payment verified!
                                                        </div>
                                                        <div className="text-muted-foreground">
                                                            <span className="font-mono text-[10px]">{censor(sp1VerifyResult.address || '', 8, 4)}</span>
                                                            {sp1VerifyResult.amount && (
                                                                <span className="ml-2">{sp1VerifyResult.amount.toLocaleString()} sats</span>
                                                            )}
                                                        </div>
                                                        {sp1NotifDone && (
                                                            <div className="text-green-500/80 text-[10px]">Notification published to relays</div>
                                                        )}
                                                    </>
                                                ) : (
                                                    <div className="font-medium text-orange-500 flex items-center gap-1.5">
                                                        <AlertTriangle className="w-3.5 h-3.5" /> No matching output found
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </>
                                ) : (
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
                                                <Input value={censor(generatedAddress)} readOnly placeholder="Click 'Generate' below" className="text-xs font-mono" />
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

                                        <Button onClick={() => {
                                            if (generatedAddress) {
                                                setShowRegenConfirm(true);
                                            } else {
                                                handleGenerate();
                                            }
                                        }} className="w-full gap-2" disabled={!privateKeyHex}>
                                            <EyeOff className="w-4 h-4" />
                                            {generatedAddress ? 'Regenerate Address' : 'Generate Address'}
                                        </Button>

                                        {generatedAddress && (
                                            <Button variant="outline" onClick={() => setShowConfirm(true)}
                                                className="w-full gap-2 border-primary/30 text-primary hover:bg-primary/10">
                                                <SendIcon className="w-4 h-4" /> Payment Sent?
                                            </Button>
                                        )}
                                    </>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                </div>
            )}

            {/* ═══ REGENERATE CONFIRMATION MODAL ═══ */}
            {showRegenConfirm && (
                <div className="fixed inset-0 z-[55] bg-black/60 backdrop-blur-sm animate-fade-in flex items-center justify-center px-4">
                    <Card className="w-[340px] shadow-2xl">
                        <CardHeader>
                            <CardTitle className="text-base flex items-center gap-2">
                                <AlertTriangle className="w-4 h-4 text-yellow-500" /> Replace Address?
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                You already have a generated address. Generating a new one will <span className="text-destructive font-semibold">permanently discard</span> the current address.
                            </p>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                If a sender has already been given this address but hasn't sent the payment notification yet, you will <span className="text-destructive font-semibold">lose access to any funds</span> sent to it.
                            </p>
                            <div className="p-2.5 rounded-lg bg-secondary/50 border border-border">
                                <p className="text-[10px] text-muted-foreground font-mono truncate">{censor(generatedAddress)}</p>
                            </div>
                            <div className="flex gap-2 pt-1">
                                <Button variant="outline" className="flex-1 text-xs" onClick={() => setShowRegenConfirm(false)}>
                                    Cancel
                                </Button>
                                <Button className="flex-1 text-xs gap-1.5 bg-destructive text-destructive-foreground hover:bg-destructive/90 border-0" onClick={() => {
                                    setShowRegenConfirm(false);
                                    handleGenerate();
                                }}>
                                    <RefreshCw className="w-3.5 h-3.5 shrink-0" /> Replace
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
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
                                                    <div key={item.payload.tweak} className="flex items-center gap-3 p-3 rounded-xl bg-secondary/50 border border-border">
                                                        <img src={ch?.icon || ''} alt="" className="w-7 h-7 rounded-full shrink-0" />
                                                        <div className="flex-1 min-w-0">
                                                            <div className="text-sm font-medium truncate">{item.payload.amount} on {ch?.name}</div>
                                                            <div className="text-[10px] text-muted-foreground font-mono truncate">{censor(item.payload.address)}</div>
                                                        </div>
                                                        <button onClick={() => rescanItem(item.payload.tweak)} disabled={item.checking}
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
                                    onClick={() => { setAsset(a.id); setGeneratedAddress(''); setCurrentTweak(''); setQrUri(''); setShowAssetModal(false); }}
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
            {showConfirm && activePubkey && (
                <NspConfirmModal
                    recipientPubkey={activePubkey}
                    address={generatedAddress}
                    chain={chain}
                    asset={asset}
                    token={currentAsset?.token || null}
                    tweak={currentTweak}
                    amount={amount}
                    onClose={() => setShowConfirm(false)}
                />
            )}

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
                                                {/* Bitcoin send mode toggle: Taproot / SegWit / SP */}
                                                {isBitcoin && nspRecipientPubkey && (
                                                    <div className="flex bg-secondary border border-border rounded-lg p-0.5 gap-0.5">
                                                        {([
                                                            { id: 'taproot' as const, label: 'Taproot' },
                                                            { id: 'segwit' as const, label: 'SegWit' },
                                                            { id: 'sp' as const, label: 'SP' },
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
                                                                    if (mode.id === 'sp') {
                                                                        const { scanPub, spendPub } = deriveScanPubKeys(nspRecipientPubkey);
                                                                        const sp1Addr = encodeSp1Address(scanPub, spendPub);
                                                                        setNspRecipientTweak('');
                                                                        setNspDerivedAddress(sp1Addr);
                                                                    } else {
                                                                        const effectiveAsset = mode.id === 'segwit' ? 'native' : 'taproot';
                                                                        const tweak = generateTweak();
                                                                        const derivedAddr = deriveTweakedAddressFromPubkey(chain, nspRecipientPubkey, tweak, effectiveAsset);
                                                                        setNspRecipientTweak(tweak);
                                                                        setNspDerivedAddress(derivedAddr);
                                                                    }
                                                                }}
                                                            >
                                                                {mode.label}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                                {/* NSP / SP derived address info */}
                                                {nspRecipientPubkey && nspDerivedAddress && (
                                                    <div className="flex items-center gap-2 p-2.5 rounded-xl bg-primary/5 border border-primary/20 animate-fade-in">
                                                        <div className="flex-1 min-w-0">
                                                            {nspRecipientName && (
                                                                <p className="text-[11px] text-primary font-medium truncate mb-0.5">
                                                                    Sending to {nspRecipientName}
                                                                </p>
                                                            )}
                                                            <p className="text-[10px] text-muted-foreground font-mono truncate">
                                                                {isBitcoin && btcSendMode === 'sp' ? 'SP' : 'NSP'}: {censor(nspDerivedAddress)}
                                                            </p>
                                                        </div>
                                                        {/* Only show regenerate button for non-SP modes */}
                                                        {!(isBitcoin && btcSendMode === 'sp') && (
                                                            <button
                                                                onClick={regenerateNspAddress}
                                                                className="p-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 transition-colors cursor-pointer shrink-0"
                                                                title="Generate new random address"
                                                            >
                                                                <RefreshCw className="w-3.5 h-3.5 text-primary" />
                                                            </button>
                                                        )}
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
                                                            <span className="text-xs text-muted-foreground">{isBitcoin && btcSendMode === 'sp' ? 'SP Address' : 'NSP Address'}</span>
                                                            <span className="text-[10px] font-mono text-muted-foreground max-w-[200px] truncate block">
                                                                {censor(nspDerivedAddress, 8, 4)}
                                                            </span>
                                                        </div>
                                                        <div className="border-t border-border" />
                                                        <div className="flex justify-between items-center">
                                                            <span className="text-xs text-muted-foreground">Type</span>
                                                            <span className="text-[11px] font-medium text-primary flex items-center gap-1">
                                                                <Bell className="w-3 h-3" /> {isBitcoin && btcSendMode === 'sp' ? 'BIP-352 Silent Payment + Notify' : 'Will notify via Nostr'}
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
                    setFetchingNotif(true);
                    setExistingNotifEvent(null);
                    setRenotifyResults([]);
                    setRenotifyDone(false);
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
                        const payload: NspPayload = {
                            address: sentEntry.address,
                            chain: sentEntry.chain,
                            asset: sentEntry.asset,
                            token: sentEntry.token,
                            tweak: sentEntry.tweak,
                            txid: sentEntry.txid,
                            amount: sentEntry.amount,
                            timestamp: sentEntry.timestamp,
                        };
                        const { event } = createNspNotification(sentEntry.recipientPubkey, payload, sentEntry.senderNsec);
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
