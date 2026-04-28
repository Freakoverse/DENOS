import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
    privateKeyToBitcoinAddress,
    privateKeyToTaprootAddress,
    npubToTaprootAddress,
    fetchUTXOs,
    fetchTxHistory,
    getFeeRates,
    createBitcoinTransaction,
    createTaprootTransaction,
    broadcastTransaction,
    satsToBTC,
    btcToSats,
    type UTXO,
    type TxHistory,
    type FeeRates,
    type AddressType as BtcAddressType,
} from '@/services/bitcoin';
import {
    deriveEvmAddress,
    deriveStandardEvmAddress,
    npubToEvmAddress,
    EVM_CHAINS,
    fetchEvmBalance,
    fetchTokenBalance,
    fetchEvmTxHistory,
    fetchTokenTxHistory,
    getGasEstimate,
    sendEvmTransaction,
    sendTokenTransaction,
    formatUnits,
    formatUnitsFull,
    parseUnits,
    etherscanApiKey,
    goldrushApiKey,
    type EvmChain,
    type EvmToken,
    type EvmTx,
    type GasEstimate,
} from '@/services/evm';
import {
    deriveZcashAddress,
    deriveStandardZcashAddress,
    npubToZcashAddress,
    fetchZcashBalance,
    fetchZcashTxHistory,
    satsToZec,
    type ZcashTx,
    fetchZcashUTXOs,
    createZcashTransaction,
    broadcastZcashTransaction,
    zecToSats,
} from '@/services/zcash';
import {
    ArrowUpRight, ArrowDownLeft, RefreshCw, Copy, Check, ExternalLink,
    X, ArrowUpDown, Send, QrCode, Loader2, AlertTriangle, WalletMinimal, EyeOff, Shield,
    Search, KeyRound, ArrowLeft,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useFeedback } from '@/components/ui/feedback';
import { SatoshiIcon } from '@/components/SatoshiIcon';
import { EcashWallet } from '@/components/EcashWallet';
import { FollowsSelector } from '@/components/FollowsSelector';
import { chainIcons, tokenIcons } from '@/assets/icons/blockchain';
import { Users } from 'lucide-react';

type ChainId = 'bitcoin' | 'ethereum' | 'bnb' | 'polygon' | 'avalanche' | 'base' | 'zcash';

type WalletTab = 'native' | 'ecash' | 'silent' | 'multi';

interface WalletProps {
    activePubkey: string | null;
    sendPrefill?: { recipient: string; amount: number; feeRate?: number } | null;
    onPrefillConsumed?: () => void;
    ecashRecipient?: string;
    ecashAutoSend?: boolean;
    onEcashPrefillConsumed?: () => void;
}

export function Wallet({ activePubkey, sendPrefill, onPrefillConsumed, ecashRecipient, ecashAutoSend, onEcashPrefillConsumed }: WalletProps) {
    const [walletTab, setWalletTab] = useState<WalletTab>('native');
    const [selectedChain, setSelectedChain] = useState<ChainId>('bitcoin');
    const [selectedAsset, setSelectedAsset] = useState<string>('native'); // 'native' | 'taproot' | 'usdt' | 'usdc' | etc.
    const [showStandardAddress, setShowStandardAddress] = useState(false);
    const [address, setAddress] = useState('');
    const [nostrAddress, setNostrAddress] = useState('');
    const [standardAddress, setStandardAddress] = useState('');
    const [balance, setBalance] = useState(0);
    const [balanceBigInt, setBalanceBigInt] = useState(0n);
    const [utxos, setUtxos] = useState<UTXO[]>([]);
    const [history, setHistory] = useState<TxHistory[]>([]);
    const [evmHistory, setEvmHistory] = useState<EvmTx[]>([]);
    const [zcashHistory, setZcashHistory] = useState<ZcashTx[]>([]);
    const [loading, setLoading] = useState(false);
    const [showBTCFirst, setShowBTCFirst] = useState(false);
    const [privateKeyHex, setPrivateKeyHex] = useState('');
    const [nativeGasBalance, setNativeGasBalance] = useState<bigint>(0n);
    const [copiedId, setCopiedId] = useState<string | null>(null);

    // Modal states
    const [showReceive, setShowReceive] = useState(false);
    const [showSend, setShowSend] = useState(false);
    const [selectedTx, setSelectedTx] = useState<TxHistory | null>(null);
    const [selectedEvmTx, setSelectedEvmTx] = useState<EvmTx | null>(null);
    const [selectedZcashTx, setSelectedZcashTx] = useState<ZcashTx | null>(null);
    const [zcashTxAddresses, setZcashTxAddresses] = useState<{ from: string[]; to: string[] }>({ from: [], to: [] });
    const [showFollowsSelector, setShowFollowsSelector] = useState(false);
    const [showChainSelector, setShowChainSelector] = useState(false);
    const [showAssetSelector, setShowAssetSelector] = useState(false);
    const [showApiKeyModal, setShowApiKeyModal] = useState(false);
    const [showSubscriptions, setShowSubscriptions] = useState(false);
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [goldrushKeyInput, setGoldrushKeyInput] = useState('');
    const [chainSearch, setChainSearch] = useState('');

    // Send form
    const [sendTo, setSendTo] = useState('');
    const [resolvedAddress, setResolvedAddress] = useState('');
    const [sendAmount, setSendAmount] = useState('');
    const [unit, setUnit] = useState<'sats' | 'btc'>('sats');
    const [feeRates, setFeeRates] = useState<FeeRates | null>(null);
    const [selectedFeeRate, setSelectedFeeRate] = useState(0);
    const [gasEstimate, setGasEstimate] = useState<GasEstimate | null>(null);
    const [selectedGasPrice, setSelectedGasPrice] = useState(0n);
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState('');
    const [sendSuccess, setSendSuccess] = useState('');
    const [sendStep, setSendStep] = useState<'form' | 'review'>('form');

    // Chain helpers
    const isBitcoin = selectedChain === 'bitcoin';
    const isEvm = ['ethereum', 'bnb', 'polygon', 'avalanche', 'base'].includes(selectedChain);
    const isZcash = selectedChain === 'zcash';
    const evmChain = isEvm ? EVM_CHAINS[selectedChain] : null;
    const currentToken = isEvm && evmChain ? evmChain.tokens.find(t => t.symbol.toLowerCase() === selectedAsset) || evmChain.tokens[0] : null;
    const isTokenTransfer = isEvm && currentToken && currentToken.contractAddress !== null;
    const currentDecimals = currentToken?.decimals ?? (isZcash ? 8 : 8);
    const currentSymbol = isBitcoin ? 'BTC' : isZcash ? 'ZEC' : currentToken?.symbol ?? evmChain?.symbol ?? '';

    // Resolve npub → address based on selected chain
    useEffect(() => {
        const trimmed = sendTo.trim();
        if (trimmed.startsWith('npub')) {
            try {
                if (isBitcoin) {
                    setResolvedAddress(npubToTaprootAddress(trimmed));
                } else if (isEvm) {
                    setResolvedAddress(npubToEvmAddress(trimmed));
                } else if (isZcash) {
                    setResolvedAddress(npubToZcashAddress(trimmed));
                }
            } catch { setResolvedAddress(''); }
        } else if (isBitcoin && (trimmed.startsWith('bc1') || trimmed.startsWith('1') || trimmed.startsWith('3'))) {
            setResolvedAddress(trimmed);
        } else if (isEvm && trimmed.startsWith('0x') && trimmed.length === 42) {
            setResolvedAddress(trimmed);
        } else if (isZcash && trimmed.startsWith('t1')) {
            setResolvedAddress(trimmed);
        } else {
            setResolvedAddress('');
        }
    }, [sendTo, selectedChain]);

    const { toast } = useFeedback();

    const copyText = (text: string, id: string) => {
        navigator.clipboard.writeText(text);
        setCopiedId(id);
        toast('Copied!', 'success');
        setTimeout(() => setCopiedId(null), 2000);
    };

    // Fetch private key and derive address for selected chain
    useEffect(() => {
        if (!activePubkey) {
            setAddress('');
            setStandardAddress('');
            setPrivateKeyHex('');
            return;
        }
        (async () => {
            try {
                const hex = await invoke<string>('export_private_key_hex', { pubkey: activePubkey });
                setPrivateKeyHex(hex);

                if (isBitcoin) {
                    const addr = selectedAsset === 'taproot'
                        ? privateKeyToTaprootAddress(hex)
                        : privateKeyToBitcoinAddress(hex);
                    setAddress(addr);
                    setNostrAddress(addr);
                    setStandardAddress(addr);
                } else if (isEvm) {
                    const nostrAddr = deriveEvmAddress(hex);
                    const stdAddr = deriveStandardEvmAddress(hex);
                    setNostrAddress(nostrAddr);
                    setStandardAddress(stdAddr);
                    setAddress(showStandardAddress ? stdAddr : nostrAddr);
                } else if (isZcash) {
                    const nostrAddr = deriveZcashAddress(hex);
                    const stdAddr = deriveStandardZcashAddress(hex);
                    setNostrAddress(nostrAddr);
                    setStandardAddress(stdAddr);
                    setAddress(showStandardAddress ? stdAddr : nostrAddr);
                }
            } catch (e) {
                console.error('Failed to derive address:', e);
            }
        })();
    }, [activePubkey, selectedChain, selectedAsset, showStandardAddress]);

    // Fetch blockchain data when address changes
    const fetchData = useCallback(async () => {
        if (!address) return;
        // Guard: ensure address format matches selected chain (address update is async)
        if (isBitcoin && !address.startsWith('bc1') && !address.startsWith('1') && !address.startsWith('3')) return;
        if (isZcash && !address.startsWith('t1')) return;
        if (isEvm && !address.startsWith('0x')) return;
        setLoading(true);
        // Clear stale history immediately so old data doesn't show with wrong address
        setEvmHistory([]);
        setHistory([]);
        setZcashHistory([]);
        try {
            if (isBitcoin) {
                const [fetchedUtxos, fetchedHistory] = await Promise.all([
                    fetchUTXOs(address),
                    fetchTxHistory(address),
                ]);
                setUtxos(fetchedUtxos);
                setHistory(fetchedHistory);
                setEvmHistory([]);
                setZcashHistory([]);
                const total = fetchedUtxos.reduce((s, u) => s + u.value, 0);
                setBalance(total);
                setBalanceBigInt(BigInt(total));
                if (total >= 1_000_000) setShowBTCFirst(true);
            } else if (isEvm) {
                const isToken = currentToken && currentToken.contractAddress !== null;

                // Fetch balance and history independently so one failure doesn't block the other
                const balPromise = (isToken
                    ? fetchTokenBalance(selectedChain, currentToken!.contractAddress!, address)
                    : fetchEvmBalance(selectedChain, address)
                ).catch(e => { console.error('Balance fetch failed:', e); return null; });

                const histPromise = (isToken
                    ? fetchTokenTxHistory(selectedChain, address, currentToken!.contractAddress!)
                    : fetchEvmTxHistory(selectedChain, address)
                ).catch(e => { console.error('History fetch failed:', e); return [] as EvmTx[]; });

                const [bal, txs] = await Promise.all([balPromise, histPromise]);

                if (bal !== null) {
                    setBalanceBigInt(bal);
                    setBalance(Number(bal));
                }
                setEvmHistory(txs);
                setHistory([]);
                setUtxos([]);
                setZcashHistory([]);

                // When viewing a token, also fetch native balance for gas indicator
                if (isToken) {
                    fetchEvmBalance(selectedChain, address)
                        .then(nb => setNativeGasBalance(nb))
                        .catch(() => setNativeGasBalance(0n));
                } else {
                    setNativeGasBalance(bal ?? 0n);
                }
            } else if (isZcash) {
                const [bal, txs] = await Promise.all([
                    fetchZcashBalance(address),
                    fetchZcashTxHistory(address),
                ]);
                setBalance(bal);
                setBalanceBigInt(BigInt(bal));
                setZcashHistory(txs);
                setHistory([]);
                setEvmHistory([]);
                setUtxos([]);
            }
        } catch (e) {
            console.error('Error fetching chain data:', e);
        } finally {
            setLoading(false);
        }
    }, [address, selectedChain, selectedAsset, currentToken]);

    useEffect(() => { fetchData(); }, [fetchData]);

    // Reset asset, history & balance when chain changes — show loading until address syncs
    useEffect(() => {
        setEvmHistory([]);
        setHistory([]);
        setZcashHistory([]);
        setBalance(0);
        setBalanceBigInt(BigInt(0));
        setLoading(true);
        if (isBitcoin) setSelectedAsset('native');
        else if (isEvm && evmChain) setSelectedAsset(evmChain.tokens[0].symbol.toLowerCase());
        else if (isZcash) setSelectedAsset('transparent');
    }, [selectedChain]);

    // Asset/token change within same chain — fetchData will update balance
    useEffect(() => {
        // no-op: fetchData dependency on selectedAsset handles the refresh
    }, [selectedAsset]);

    const getTxDetails = (tx: TxHistory) => {
        let netChange = 0;
        tx.vin.forEach((input: any) => {
            if (input.prevout?.scriptpubkey_address === address) netChange -= input.prevout.value;
        });
        tx.vout.forEach((output: any) => {
            if (output.scriptpubkey_address === address) netChange += output.value;
        });
        return { netChange, isReceive: netChange > 0, absAmount: Math.abs(netChange) };
    };

    // Send transaction
    const handleSend = async () => {
        setSending(true);
        setSendError('');
        setSendSuccess('');
        try {
            const target = resolvedAddress;
            if (!target) throw new Error('Enter a valid recipient address or npub');

            if (isBitcoin) {
                const amountSats = unit === 'btc' ? btcToSats(parseFloat(sendAmount)) : parseInt(sendAmount);
                if (isNaN(amountSats) || amountSats <= 0) throw new Error('Invalid amount');
                if (!selectedFeeRate) throw new Error('Select a fee rate');

                const { txHex, fee } = selectedAsset === 'taproot'
                    ? await createTaprootTransaction(privateKeyHex, target, amountSats, utxos, selectedFeeRate)
                    : await createBitcoinTransaction(privateKeyHex, target, amountSats, utxos, selectedFeeRate);

                const txid = await broadcastTransaction(txHex);
                setSendSuccess(txid);
                toast(`Sent! Fee: ${fee} sats`, 'success');
            } else if (isEvm) {
                if (!selectedGasPrice) throw new Error('Gas price not set');
                if (isTokenTransfer && currentToken?.contractAddress) {
                    const amount = parseUnits(sendAmount, currentToken.decimals);
                    const txHash = await sendTokenTransaction(
                        selectedChain, privateKeyHex, currentToken.contractAddress,
                        target, amount, selectedGasPrice, undefined, showStandardAddress
                    );
                    setSendSuccess(txHash);
                    toast('Token transfer sent!', 'success');
                } else {
                    const amount = parseUnits(sendAmount, currentDecimals);
                    const txHash = await sendEvmTransaction(
                        selectedChain, privateKeyHex, target, amount, selectedGasPrice, 21000n, showStandardAddress
                    );
                    setSendSuccess(txHash);
                    toast('Transaction sent!', 'success');
                }
            } else if (isZcash) {
                const amountZatoshi = zecToSats(parseFloat(sendAmount));
                if (isNaN(amountZatoshi) || amountZatoshi <= 0) throw new Error('Invalid amount');
                const zcashUtxos = await fetchZcashUTXOs(address);
                if (zcashUtxos.length === 0) throw new Error('No UTXOs found for this address');
                const { txHex, fee } = await createZcashTransaction(
                    privateKeyHex, target, amountZatoshi, zcashUtxos, undefined, showStandardAddress
                );
                const txid = await broadcastZcashTransaction(txHex);
                setSendSuccess(txid);
                toast(`Sent! Fee: ${fee} zatoshi`, 'success');
            }
            fetchData();
        } catch (e) {
            setSendError(String(e));
        } finally {
            setSending(false);
        }
    };

    const openSendModal = async () => {
        setSendTo('');
        setResolvedAddress('');
        setSendAmount('');
        setUnit('sats');
        setSendError('');
        setSendSuccess('');
        setSendStep('form');
        setShowSend(true);
        try {
            if (isBitcoin) {
                const rates = await getFeeRates();
                setFeeRates(rates);
                setSelectedFeeRate(rates.hourFee);
            } else if (isEvm) {
                const gas = await getGasEstimate(selectedChain);
                setGasEstimate(gas);
                setSelectedGasPrice(gas.standard);
            }
        } catch {
            setFeeRates(null);
            setGasEstimate(null);
        }
    };

    // Handle prefill from IDs page
    useEffect(() => {
        if (sendPrefill && privateKeyHex && walletTab === 'native') {
            setSendTo(sendPrefill.recipient);
            setResolvedAddress(sendPrefill.recipient);
            setSendAmount(sendPrefill.amount.toString());
            setUnit('sats');
            setSendError('');
            setSendSuccess('');
            setSendStep('form');
            setShowSend(true);
            (async () => {
                try {
                    const rates = await getFeeRates();
                    setFeeRates(rates);
                    setSelectedFeeRate(sendPrefill.feeRate || rates.economyFee);
                } catch {
                    setFeeRates(null);
                    if (sendPrefill.feeRate) setSelectedFeeRate(sendPrefill.feeRate);
                }
            })();
            onPrefillConsumed?.();
        }
    }, [sendPrefill, privateKeyHex, walletTab]);

    // Handle ecash prefill
    useEffect(() => {
        if (ecashRecipient && ecashAutoSend) {
            setWalletTab('ecash');
        }
    }, [ecashRecipient, ecashAutoSend]);

    // Fetch Zcash tx counterparty addresses when detail modal opens
    useEffect(() => {
        if (!selectedZcashTx) { setZcashTxAddresses({ from: [], to: [] }); return; }
        const tx = selectedZcashTx;
        (async () => {
            try {
                const res = await fetch(`https://sandbox-api.3xpl.com/zcash/transaction/${tx.txid}?data=transaction,events`, { signal: AbortSignal.timeout(8000) });
                if (!res.ok) return;
                const json = await res.json();
                const events: any[] = json.data?.events?.['zcash-main'] || [];
                const senders: string[] = [];
                const receivers: string[] = [];
                for (const ev of events) {
                    const effect = parseInt(ev.effect || '0', 10);
                    const addr = ev.address;
                    if (!addr || addr === 'the-void') continue;
                    if (effect < 0 && !senders.includes(addr)) senders.push(addr);
                    if (effect > 0 && !receivers.includes(addr)) receivers.push(addr);
                }
                // For sends: filter own address from "to" (that's just change)
                // For receives: filter own address from "from" (shouldn't happen but be safe)
                const isReceive = tx.type === 'receive';
                const filteredTo = isReceive ? receivers : receivers.filter(a => a !== address);
                const filteredFrom = isReceive ? senders.filter(a => a !== address) : senders;
                setZcashTxAddresses({ from: filteredFrom, to: filteredTo });
            } catch { /* silent */ }
        })();
    }, [selectedZcashTx]);

    if (!activePubkey) {
        return (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
                <WalletMinimal className="w-12 h-12 opacity-30" />
                <p className="text-sm">Create or select a keypair to use the wallet.</p>
            </div>
        );
    }

    // Helper to render the tab bar
    const renderTabs = () => (
        <div className="flex bg-secondary border border-border rounded-xl p-1 gap-1 flex-wrap">
            {(['native', 'ecash', 'silent', 'multi'] as WalletTab[]).map(id => {
                const label = id === 'native' ? 'Native' : id === 'ecash' ? 'eCash' : id === 'silent' ? 'Silent' : 'Multisig';
                const isActive = walletTab === id;
                return (
                    <button
                        key={id}
                        className={cn(
                            "flex-1 flex items-center justify-center py-2.5 px-2.5 rounded-lg text-sm transition-colors cursor-pointer",
                            isActive
                                ? "bg-primary text-primary-foreground font-semibold"
                                : "font-medium text-muted-foreground"
                        )}
                        onClick={() => setWalletTab(id)}
                    >
                        {label}
                    </button>
                );
            })}
        </div>
    );

    // ── ECASH TAB ──
    if (walletTab === 'ecash') {
        return (
            <div className="flex flex-col gap-4 h-full overflow-hidden">
                {renderTabs()}
                <EcashWallet
                    activePubkey={activePubkey}
                    initialRecipient={ecashRecipient || ''}
                    autoOpenSend={ecashAutoSend || false}
                    onSendComplete={() => { onEcashPrefillConsumed?.(); }}
                />
            </div>
        );
    }

    // ── SILENT TAB (placeholder) ──
    if (walletTab === 'silent') {
        return (
            <div className="space-y-4">
                {renderTabs()}
                <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
                    <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                        <EyeOff className="w-8 h-8 text-primary" />
                    </div>
                    <h3 className="text-lg font-bold text-foreground">Silent</h3>
                    <p className="text-sm text-center max-w-xs">Nostr Silent Payments Wallet coming soon.</p>
                    <Badge variant="secondary" className="text-xs">Coming Soon</Badge>
                </div>
            </div>
        );
    }

    // ── MULTI TAB (placeholder) ──
    if (walletTab === 'multi') {
        return (
            <div className="space-y-4">
                {renderTabs()}
                <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
                    <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                        <Shield className="w-8 h-8 text-primary" />
                    </div>
                    <h3 className="text-lg font-bold text-foreground">Multisig</h3>
                    <p className="text-sm text-center max-w-xs">Bitcoin Multisig Wallet coming soon.</p>
                    <Badge variant="secondary" className="text-xs">Coming Soon</Badge>
                </div>
            </div>
        );
    }

    // ── SUBSCRIPTIONS PAGE ──
    if (showSubscriptions) {
        return (
            <div className="flex flex-col h-[calc(100vh-115px)] animate-fade-in">
                <div className="flex items-center gap-3 shrink-0 pb-3">
                    <button
                        onClick={() => setShowSubscriptions(false)}
                        className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors"
                    >
                        <ArrowLeft className="w-4.5 h-4.5 text-muted-foreground" />
                    </button>
                    <h2 className="text-base font-semibold">Subscriptions</h2>
                </div>
                <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center gap-3 text-muted-foreground pb-[100px]">
                    <WalletMinimal className="w-12 h-12 text-primary/30" />
                    <p className="text-base font-semibold text-foreground">Coming Soon</p>
                    <p className="text-xs text-center max-w-[260px]">Recurring payments and subscription management will be available here.</p>
                </div>
            </div>
        );
    }

    // ── BITCOIN TAB ──
    return (
        <div className="flex flex-col gap-4 h-full overflow-hidden">
            {/* Tab toggle */}
            {renderTabs()}

            {/* Balance card */}
            <div className="wallet-balance-card bg-gradient-to-br from-primary/15 to-primary/5 border border-primary/20 rounded-2xl p-5 relative overflow-hidden shrink-0">
                <div className="relative z-10">
                    <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                            <span className="text-muted-foreground text-sm font-medium">Total Balance</span>
                            {!isBitcoin && nostrAddress !== standardAddress && (
                                <button
                                    onClick={() => setShowStandardAddress(!showStandardAddress)}
                                    className="px-1.5 py-0.5 text-[9px] font-medium rounded border bg-muted/50 border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
                                >
                                    {showStandardAddress ? 'Standard' : 'Nostr'}
                                </button>
                            )}
                        </div>
                        <div className="flex items-center gap-1.5">
                            <button
                                onClick={() => { setChainSearch(''); setShowChainSelector(true); }}
                                className="wallet-badge-btn flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded-md border bg-muted border-border transition-colors cursor-pointer hover:bg-accent"
                            >
                                <img
                                    src={isBitcoin ? chainIcons.bitcoin : isZcash ? chainIcons.zcash : evmChain?.icon || ''}
                                    alt=""
                                    className="rounded-full object-cover shrink-0"
                                    style={{ width: 12, height: 12 }}
                                />
                                {isBitcoin ? 'Bitcoin' : isZcash ? 'Zcash' : evmChain?.name || 'Chain'}
                            </button>
                            <button
                                onClick={() => setShowAssetSelector(true)}
                                className="wallet-badge-btn flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-md border bg-muted border-border transition-colors cursor-pointer hover:bg-accent"
                            >
                                {isEvm && currentToken && (
                                    <img
                                        src={currentToken.icon || ''}
                                        alt=""
                                        className="rounded-full object-cover shrink-0"
                                        style={{ width: 12, height: 12 }}
                                    />
                                )}
                                {isBitcoin ? (selectedAsset === 'taproot' ? 'Taproot' : 'Native Segwit')
                                    : isZcash ? 'Transparent'
                                        : currentToken?.symbol || 'Asset'}
                            </button>
                            {isBitcoin && (
                                <button onClick={() => setShowBTCFirst(!showBTCFirst)} className="p-1 hover:bg-white/10 rounded-md transition-colors cursor-pointer">
                                    <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />
                                </button>
                            )}
                            <button onClick={fetchData} disabled={loading} className="p-1 hover:bg-white/10 rounded-md transition-colors cursor-pointer">
                                <RefreshCw className={cn("w-3.5 h-3.5 text-muted-foreground", loading && "animate-spin")} />
                            </button>
                        </div>
                    </div>

                    {/* Balance display */}
                    {isBitcoin ? (
                        showBTCFirst ? (
                            <>
                                <div className="flex items-baseline gap-2">
                                    <span className="text-3xl text-primary">₿</span>
                                    <span className="text-4xl font-bold text-foreground">{satsToBTC(balance)}</span>
                                    <span className="text-primary font-bold text-sm">BTC</span>
                                </div>
                                <div className="flex items-center gap-1.5 text-muted-foreground text-xs mt-1">
                                    <SatoshiIcon className="w-3.5 h-3.5" />
                                    <span>{balance.toLocaleString()} sats</span>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="flex items-baseline gap-2">
                                    <SatoshiIcon className="text-3xl text-primary" />
                                    <span className="text-4xl font-bold text-foreground">{balance.toLocaleString()}</span>
                                    <span className="text-primary font-bold text-sm">sats</span>
                                </div>
                                <div className="flex items-center gap-1.5 text-muted-foreground text-xs mt-1">
                                    <span>₿</span>
                                    <span>≈ {satsToBTC(balance)} BTC</span>
                                </div>
                            </>
                        )
                    ) : isEvm ? (
                        <>
                            <div className="flex items-baseline gap-2">
                                <span className="text-4xl font-bold text-foreground">{formatUnits(balanceBigInt, currentDecimals)}</span>
                                <span className="text-primary font-bold text-sm">{currentSymbol}</span>
                            </div>
                            <div className="text-[14px] text-muted-foreground/50 font-mono mt-0.5 truncate">
                                {formatUnitsFull(balanceBigInt, currentDecimals)} {currentSymbol}
                            </div>
                        </>
                    ) : isZcash ? (
                        <>
                            <div className="flex items-baseline gap-2">
                                <span className="text-4xl font-bold text-foreground">{satsToZec(balance)}</span>
                                <span className="text-primary font-bold text-sm">ZEC</span>
                            </div>
                            {balance > 0 && (
                                <div className="text-[10px] text-muted-foreground/50 font-mono mt-0.5">
                                    {balance.toLocaleString()} zatoshi
                                </div>
                            )}
                        </>
                    ) : null}


                    {/* Zcash privacy note */}
                    {isZcash && (
                        <div className="flex items-center gap-1.5 mt-1.5">
                            <AlertTriangle className="w-3 h-3 text-yellow-500" />
                            <span className="text-[10px] text-yellow-500">Transparent address — transactions are not private</span>
                        </div>
                    )}

                    <div className="mt-4 flex gap-2 flex-wrap">
                        <Button variant="outline" className="flex-1 gap-1.5" onClick={() => setShowReceive(true)}>
                            <ArrowDownLeft className="w-4 h-4 text-green-500" /> Receive
                        </Button>
                        <Button className="flex-1 gap-1.5" onClick={openSendModal}>
                            <ArrowUpRight className="w-4 h-4" /> Send
                        </Button>
                    </div>
                </div>
            </div>

            {/* Subscriptions button */}
            <button
                onClick={() => setShowSubscriptions(true)}
                className="w-full flex items-center justify-between px-4 py-3 bg-secondary/50 hover:bg-secondary rounded-xl transition-colors cursor-pointer shrink-0"
            >
                <span className="text-sm font-medium text-foreground">Subscriptions</span>
                <span className="text-xs font-bold text-muted-foreground bg-muted px-2 py-0.5 rounded-md">0</span>
            </button>

            {/* Transaction history */}
            <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-foreground">History</h3>
                    {isEvm && (
                        <button
                            onClick={() => { setApiKeyInput(localStorage.getItem('denos-etherscan-apikey') || ''); setGoldrushKeyInput(localStorage.getItem('denos-goldrush-apikey') || ''); setShowApiKeyModal(true); }}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground bg-secondary/50 hover:bg-secondary rounded-lg transition-colors cursor-pointer"
                            title="Configure Etherscan API Key"
                        >
                            <KeyRound className="w-3 h-3" />
                            API Key
                        </button>
                    )}
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pb-[100px]">
                    {loading && history.length === 0 && evmHistory.length === 0 && zcashHistory.length === 0 ? (
                        <div className="flex items-center justify-center py-8 text-muted-foreground">
                            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
                        </div>
                    ) : isBitcoin ? (
                        history.length === 0 ? (
                            <div className="text-center py-8 text-muted-foreground text-sm">No transactions yet</div>
                        ) : (
                            history.slice(0, 20).map((tx) => {
                                const { isReceive, absAmount } = getTxDetails(tx);
                                return (
                                    <button key={tx.txid} onClick={() => setSelectedTx(tx)} className="tx-item w-full text-left bg-secondary/50 hover:bg-secondary rounded-xl p-3.5 transition-colors cursor-pointer">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2.5">
                                                <div className={cn("p-1.5 rounded-full", isReceive ? "bg-green-500/10 text-green-500" : "bg-primary/10 text-primary")}>
                                                    {isReceive ? <ArrowDownLeft className="w-3.5 h-3.5" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
                                                </div>
                                                <div>
                                                    <div className="text-sm font-medium text-foreground">{isReceive ? 'Received' : 'Sent'}</div>
                                                    <div className="text-[10px] text-muted-foreground">{new Date((tx.status.block_time || Date.now() / 1000) * 1000).toLocaleDateString()}</div>
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <div className={cn("text-sm font-bold", isReceive ? "text-green-500" : "text-foreground")}>{isReceive ? '+' : '-'}{absAmount.toLocaleString()} sats</div>
                                                <div className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                                                    <div className={cn("w-1.5 h-1.5 rounded-full", tx.status.confirmed ? "bg-green-500" : "bg-yellow-500")} />
                                                    {tx.status.confirmed ? 'Confirmed' : 'Pending'}
                                                </div>
                                            </div>
                                        </div>
                                    </button>
                                );
                            })
                        )
                    ) : isEvm ? (
                        evmHistory.length === 0 ? (
                            <div className="text-center py-8 text-muted-foreground text-sm">No transactions yet</div>
                        ) : (
                            evmHistory.filter(tx => tx.isError !== '1').slice(0, 20).map((tx) => {
                                const isReceive = tx.to.toLowerCase() === address.toLowerCase();
                                const rawValue = tx.tokenDecimal ? formatUnits(BigInt(tx.value || '0'), parseInt(tx.tokenDecimal)) : formatUnits(BigInt(tx.value || '0'), currentDecimals);
                                const txSymbol = tx.tokenSymbol || currentSymbol;
                                const isZeroValue = BigInt(tx.value || '0') === 0n;
                                const gasFee = BigInt(tx.gasUsed || '0') * BigInt(tx.gasPrice || '0');
                                const isGasOnly = isZeroValue && !isReceive && gasFee > 0n;
                                const displayValue = isGasOnly
                                    ? parseFloat(formatUnits(gasFee, 18)).toFixed(8).replace(/\.?0+$/, '')
                                    : parseFloat(rawValue).toFixed(8).replace(/\.?0+$/, '');
                                const displaySymbol = isGasOnly ? (evmChain?.symbol || 'ETH') : txSymbol;
                                return (
                                    <button key={tx.hash} onClick={() => setSelectedEvmTx(tx)} className="tx-item w-full text-left bg-secondary/50 hover:bg-secondary rounded-xl p-3.5 transition-colors cursor-pointer">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2.5">
                                                <div className={cn("p-1.5 rounded-full", isReceive ? "bg-green-500/10 text-green-500" : "bg-primary/10 text-primary")}>
                                                    {isReceive ? <ArrowDownLeft className="w-3.5 h-3.5" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
                                                </div>
                                                <div>
                                                    <div className="text-sm font-medium text-foreground">{isGasOnly ? 'Token Tx (Gas)' : isReceive ? 'Received' : 'Sent'}</div>
                                                    <div className="text-[10px] text-muted-foreground">{new Date(parseInt(tx.timeStamp) * 1000).toLocaleDateString()}</div>
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <div className={cn("text-sm font-bold", isReceive ? "text-green-500" : "text-foreground")}>-{displayValue} {displaySymbol}</div>
                                                <div className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                                                    <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                                                    Confirmed
                                                </div>
                                            </div>
                                        </div>
                                    </button>
                                );
                            })
                        )
                    ) : isZcash ? (
                        zcashHistory.length === 0 ? (
                            <div className="text-center py-8 text-muted-foreground text-sm">No transactions yet</div>
                        ) : (
                            zcashHistory.slice(0, 20).map((tx) => {
                                const isReceive = tx.type === 'receive';
                                return (
                                    <button key={tx.txid} onClick={() => setSelectedZcashTx(tx)} className="tx-item w-full text-left bg-secondary/50 hover:bg-secondary rounded-xl p-3.5 transition-colors cursor-pointer">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2.5">
                                                <div className={cn("p-1.5 rounded-full", isReceive ? "bg-green-500/10 text-green-500" : "bg-primary/10 text-primary")}>
                                                    {isReceive ? <ArrowDownLeft className="w-3.5 h-3.5" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
                                                </div>
                                                <div>
                                                    <div className="text-sm font-medium text-foreground">{isReceive ? 'Received' : 'Sent'}</div>
                                                    <div className="text-[10px] text-muted-foreground">{new Date(tx.timestamp * 1000).toLocaleDateString()}</div>
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <div className={cn("text-sm font-bold", isReceive ? "text-green-500" : "text-foreground")}>{isReceive ? '+' : '-'}{satsToZec(tx.value)} ZEC</div>
                                                <div className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                                                    <div className={cn("w-1.5 h-1.5 rounded-full", tx.confirmations > 0 ? "bg-green-500" : "bg-yellow-500")} />
                                                    {tx.confirmations > 0 ? 'Confirmed' : 'Pending'}
                                                </div>
                                            </div>
                                        </div>
                                    </button>
                                );
                            })
                        )
                    ) : null}
                </div>
            </div>

            {/* ── RECEIVE MODAL ── */}
            {showReceive && (
                <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                    <div className="flex min-h-full items-center justify-center px-4 py-20">
                        <Card className="w-[360px] shadow-2xl">
                            <CardHeader className="flex-row items-center justify-between">
                                <CardTitle className="text-base flex items-center gap-2">
                                    <QrCode className="w-4 h-4" /> Receive {isBitcoin ? (selectedAsset === 'taproot' ? 'Bitcoin (Taproot)' : 'Bitcoin') : isZcash ? 'Zcash' : currentToken?.symbol || evmChain?.name || 'Crypto'}
                                </CardTitle>
                                <button onClick={() => setShowReceive(false)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                    <X className="w-4 h-4" />
                                </button>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="flex items-center justify-center">
                                    <div className="bg-white p-3 rounded-xl">
                                        <img
                                            src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${isBitcoin ? `bitcoin:${address}` : isZcash ? `zcash:${address}` : address}`}
                                            alt="QR Code"
                                            className="w-48 h-48"
                                        />
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-xs text-muted-foreground font-medium">
                                        {isBitcoin
                                            ? (selectedAsset === 'native' ? 'Native SegWit (P2WPKH)' : 'Taproot (P2TR)')
                                            : isZcash
                                                ? 'Transparent (t-addr)'
                                                : evmChain?.name || 'Address'}
                                    </label>
                                    <div className="flex items-center gap-1.5">
                                        <Input value={address} readOnly className="text-xs font-mono" />
                                        <Button size="sm" variant="outline" onClick={() => copyText(address, 'recv-addr')}>
                                            {copiedId === 'recv-addr' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                        </Button>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </div>
            )}

            {/* ── SEND MODAL ── */}
            {showSend && (
                <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                    <div className="flex min-h-full items-center justify-center px-4 py-20">
                        <Card className="w-[380px] shadow-2xl">
                            <CardHeader className="flex-row items-center justify-between">
                                <CardTitle className="text-base flex items-center gap-2">
                                    <Send className="w-4 h-4" /> Send {isBitcoin ? (selectedAsset === 'taproot' ? 'Bitcoin (Taproot)' : 'Bitcoin') : isZcash ? 'Zcash' : currentToken?.symbol || evmChain?.name || 'Crypto'}
                                </CardTitle>
                                <button onClick={() => setShowSend(false)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                    <X className="w-4 h-4" />
                                </button>
                            </CardHeader>
                            <CardContent className="space-y-3">
                                {sendSuccess ? (
                                    <div className="space-y-3 animate-fade-in">
                                        <Alert>
                                            <AlertDescription className="text-xs">
                                                Transaction broadcast successfully!
                                            </AlertDescription>
                                        </Alert>
                                        <div className="space-y-1">
                                            <label className="text-xs text-muted-foreground font-medium">Transaction {isBitcoin ? 'ID' : 'Hash'}</label>
                                            <div className="flex items-center gap-1.5">
                                                <Input value={sendSuccess} readOnly className="text-[10px] font-mono" />
                                                <Button size="sm" variant="outline" onClick={() => copyText(sendSuccess, 'txid')}>
                                                    {copiedId === 'txid' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                                                </Button>
                                            </div>
                                        </div>
                                        <Button className="w-full" onClick={() => { setShowSend(false); setSendSuccess(''); }}>
                                            Done
                                        </Button>
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

                                        {/* Recipient */}
                                        <div className="space-y-1.5">
                                            <label className="text-xs text-muted-foreground font-medium">Recipient</label>
                                            <Input
                                                placeholder={isBitcoin ? 'Bitcoin address or npub...' : isEvm ? `${evmChain?.name || 'EVM'} address or npub...` : 'Zcash address or npub...'}
                                                value={sendTo}
                                                onChange={e => setSendTo(e.target.value)}
                                                className="text-xs font-mono"
                                            />
                                            {sendTo.trim().startsWith('npub') && resolvedAddress && (
                                                <p className="text-[10px] text-green-500 break-all">
                                                    Resolved: {resolvedAddress}
                                                </p>
                                            )}
                                            {/* Quick actions */}
                                            <div className="flex flex-wrap gap-1.5">
                                                {isBitcoin && (
                                                    <button
                                                        onClick={() => {
                                                            setSendTo(address);
                                                            setResolvedAddress(address);
                                                        }}
                                                        className="px-2.5 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary text-[11px] font-medium rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                                                    >
                                                        <ArrowUpRight className="w-3 h-3" />
                                                        Send to Myself
                                                    </button>
                                                )}
                                                {activePubkey && (
                                                    <button
                                                        onClick={() => setShowFollowsSelector(true)}
                                                        className="px-2.5 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary text-[11px] font-medium rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                                                    >
                                                        <Users className="w-3 h-3" />
                                                        To Following
                                                    </button>
                                                )}
                                            </div>
                                        </div>

                                        {/* Amount */}
                                        <div className="space-y-1.5">
                                            <div className="flex justify-between items-center">
                                                <label className="text-xs text-muted-foreground font-medium">Amount</label>
                                                <span className="text-[10px] text-muted-foreground">
                                                    Available: {isBitcoin
                                                        ? `${balance.toLocaleString()} sats`
                                                        : isEvm
                                                            ? `${formatUnits(balanceBigInt, currentDecimals)} ${currentSymbol}`
                                                            : isZcash
                                                                ? `${satsToZec(balance)} ZEC`
                                                                : ''}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2 bg-secondary/50 border border-border rounded-lg px-3 py-2 focus-within:ring-1 focus-within:ring-primary/50 transition-all">
                                                {isBitcoin ? (
                                                    unit === 'sats' ? (
                                                        <SatoshiIcon className="text-lg text-primary shrink-0" />
                                                    ) : (
                                                        <span className="text-lg text-primary shrink-0">₿</span>
                                                    )
                                                ) : (
                                                    <span className="text-xs text-primary font-bold shrink-0">{currentSymbol}</span>
                                                )}
                                                <input
                                                    type="number"
                                                    placeholder="0.00"
                                                    value={sendAmount}
                                                    onChange={e => setSendAmount(e.target.value)}
                                                    className="flex-1 bg-transparent text-foreground outline-none font-mono text-sm min-w-0"
                                                />
                                                <button
                                                    onClick={() => {
                                                        if (isBitcoin) {
                                                            setSendAmount(unit === 'sats' ? balance.toString() : satsToBTC(balance));
                                                        } else if (isEvm) {
                                                            setSendAmount(formatUnits(balanceBigInt, currentDecimals));
                                                        } else if (isZcash) {
                                                            setSendAmount(satsToZec(balance));
                                                        }
                                                    }}
                                                    className="px-1.5 py-0.5 bg-primary/10 hover:bg-primary/20 text-primary text-[10px] font-bold rounded transition-colors cursor-pointer shrink-0"
                                                >
                                                    MAX
                                                </button>
                                                {isBitcoin && (
                                                    <>
                                                        <button
                                                            onClick={() => {
                                                                const current = parseFloat(sendAmount) || 0;
                                                                if (unit === 'sats') {
                                                                    setSendAmount(current > 0 ? satsToBTC(current) : '');
                                                                    setUnit('btc');
                                                                } else {
                                                                    setSendAmount(current > 0 ? btcToSats(current).toString() : '');
                                                                    setUnit('sats');
                                                                }
                                                            }}
                                                            className="p-1 hover:bg-white/10 rounded transition-colors cursor-pointer shrink-0"
                                                            title="Toggle unit"
                                                        >
                                                            <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />
                                                        </button>
                                                        <span className="text-xs text-muted-foreground font-medium shrink-0">{unit === 'sats' ? 'sats' : 'BTC'}</span>
                                                    </>
                                                )}
                                                {isZcash && (
                                                    <span className="text-xs text-muted-foreground font-medium shrink-0">ZEC</span>
                                                )}
                                            </div>
                                            {/* Native gas balance hint for token transfers */}
                                            {isTokenTransfer && evmChain && (
                                                <p className="text-[10px] text-muted-foreground">
                                                    Gas balance: {formatUnits(nativeGasBalance, 18)} {evmChain.symbol}
                                                    {nativeGasBalance === 0n && (
                                                        <span className="text-destructive ml-1">— insufficient for gas</span>
                                                    )}
                                                </p>
                                            )}
                                        </div>

                                        {/* Fee / Gas */}
                                        {isBitcoin ? (
                                            <div className="space-y-1.5">
                                                <label className="text-xs text-muted-foreground font-medium">Fee Rate (sat/vB)</label>
                                                {feeRates ? (
                                                    <div className="grid grid-cols-3 gap-1.5">
                                                        {[
                                                            { label: 'Economy', rate: feeRates.economyFee },
                                                            { label: 'Normal', rate: feeRates.hourFee },
                                                            { label: 'Fast', rate: feeRates.fastestFee },
                                                        ].map(({ label, rate }) => (
                                                            <button
                                                                key={label}
                                                                onClick={() => setSelectedFeeRate(rate)}
                                                                className={cn(
                                                                    "py-2 px-2 rounded-lg text-center transition-colors cursor-pointer border",
                                                                    selectedFeeRate === rate
                                                                        ? "bg-primary/10 border-primary/30 text-primary"
                                                                        : "bg-secondary border-transparent text-muted-foreground hover:text-foreground"
                                                                )}
                                                            >
                                                                <div className="text-[10px] font-medium">{label}</div>
                                                                <div className="text-xs font-bold">{rate}</div>
                                                            </button>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <Input
                                                        type="number"
                                                        placeholder="1"
                                                        value={selectedFeeRate || ''}
                                                        onChange={e => setSelectedFeeRate(Number(e.target.value))}
                                                        className="text-xs"
                                                    />
                                                )}
                                            </div>
                                        ) : isEvm && gasEstimate ? (
                                            <div className="space-y-1.5">
                                                <label className="text-xs text-muted-foreground font-medium">Gas Price</label>
                                                <div className="grid grid-cols-3 gap-1.5">
                                                    {[
                                                        { label: 'Low', price: gasEstimate.slow },
                                                        { label: 'Standard', price: gasEstimate.standard },
                                                        { label: 'Fast', price: gasEstimate.fast },
                                                    ].map(({ label, price }) => (
                                                        <button
                                                            key={label}
                                                            onClick={() => setSelectedGasPrice(price)}
                                                            className={cn(
                                                                "py-2 px-2 rounded-lg text-center transition-colors cursor-pointer border",
                                                                selectedGasPrice === price
                                                                    ? "bg-primary/10 border-primary/30 text-primary"
                                                                    : "bg-secondary border-transparent text-muted-foreground hover:text-foreground"
                                                            )}
                                                        >
                                                            <div className="text-[10px] font-medium">{label}</div>
                                                            <div className="text-xs font-bold">{Math.round(Number(price || 0) / 1e9)} Gwei</div>
                                                            <div className="text-[9px] text-muted-foreground">≈ {formatUnits(BigInt(price || 0) * BigInt(currentToken && currentToken.contractAddress ? 65000 : 21000), 18)} {evmChain?.symbol || 'ETH'}</div>
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        ) : null}

                                        <Button
                                            className="w-full gap-1.5 font-bold"
                                            onClick={() => setSendStep('review')}
                                            disabled={!resolvedAddress || !sendAmount}
                                        >
                                            <Send className="w-4 h-4" />
                                            Review Transaction
                                        </Button>
                                    </>
                                ) : null}

                                {/* Review Step */}
                                {sendStep === 'review' && !sendSuccess && (
                                    <div className="space-y-3 animate-fade-in">
                                        <div className="bg-secondary/50 rounded-xl p-4 space-y-3">
                                            <div className="flex justify-between items-center">
                                                <span className="text-xs text-muted-foreground">Recipient</span>
                                                <span className="text-xs font-mono text-foreground max-w-[200px] truncate">{resolvedAddress}</span>
                                            </div>
                                            <div className="border-t border-border" />
                                            <div className="flex justify-between items-center">
                                                <span className="text-xs text-muted-foreground">Amount</span>
                                                <span className="text-sm font-bold text-foreground">
                                                    {isBitcoin
                                                        ? (unit === 'sats'
                                                            ? `${parseInt(sendAmount).toLocaleString()} sats`
                                                            : `${sendAmount} BTC`)
                                                        : `${sendAmount} ${currentSymbol}`}
                                                </span>
                                            </div>
                                            <div className="border-t border-border" />
                                            <div className="flex justify-between items-center">
                                                <span className="text-xs text-muted-foreground">{isBitcoin ? 'Fee Rate' : isZcash ? 'Network Fee' : 'Est. Gas Fee'}</span>
                                                <span className="text-xs font-medium text-foreground">
                                                    {isBitcoin
                                                        ? `${selectedFeeRate} sat/vB`
                                                        : isEvm
                                                            ? `${Math.round(Number(selectedGasPrice) / 1e9)} Gwei ≈ ${formatUnits(BigInt(selectedGasPrice || 0) * BigInt(currentToken && currentToken.contractAddress ? 65000 : 21000), 18)} ${evmChain?.symbol || 'ETH'}`
                                                            : isZcash
                                                                ? '0.0001 ZEC (10,000 zatoshi)'
                                                                : '—'}
                                                </span>
                                            </div>
                                            {resolvedAddress === address && (
                                                <>
                                                    <div className="border-t border-border" />
                                                    <div className="flex items-center gap-2 text-xs text-primary">
                                                        <ArrowUpRight className="w-3.5 h-3.5" />
                                                        Self-transfer (to your own address)
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
                                            <Button variant="outline" className="flex-1" onClick={() => setSendStep('form')}>
                                                Back
                                            </Button>
                                            <Button
                                                className="flex-1 gap-1.5 font-bold"
                                                onClick={handleSend}
                                                disabled={sending}
                                            >
                                                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                                                {sending ? 'Sending...' : 'Confirm Send'}
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                </div>
            )}

            {/* ── TRANSACTION DETAIL MODAL ── */}
            {selectedTx && (() => {
                const { isReceive, absAmount } = getTxDetails(selectedTx);
                const txDate = new Date((selectedTx.status.block_time || Date.now() / 1000) * 1000);
                const fromAddresses = [...new Set(selectedTx.vin.map((v: any) => v.prevout?.scriptpubkey_address).filter(Boolean))] as string[];
                const toAddresses = [...new Set(selectedTx.vout.map((v: any) => v.scriptpubkey_address).filter(Boolean))] as string[];
                const explorers = [
                    { name: 'Mempool.space', url: `https://mempool.space/tx/${selectedTx.txid}` },
                    { name: 'Blockstream', url: `https://blockstream.info/tx/${selectedTx.txid}` },
                    { name: 'Blockchain.com', url: `https://www.blockchain.com/btc/tx/${selectedTx.txid}` },
                ];

                return (
                    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                        <div className="flex min-h-full items-center justify-center px-4 py-20">
                            <Card className="w-full max-w-[400px] shadow-2xl">
                                <CardHeader className="flex-row items-center justify-between">
                                    <CardTitle className="text-base flex items-center gap-2">
                                        <div className={cn(
                                            "p-1.5 rounded-full",
                                            isReceive ? "bg-green-500/10 text-green-500" : "bg-primary/10 text-primary"
                                        )}>
                                            {isReceive ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                                        </div>
                                        {isReceive ? 'Received' : 'Sent'} {absAmount.toLocaleString()} sats
                                    </CardTitle>
                                    <button onClick={() => setSelectedTx(null)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                        <X className="w-4 h-4" />
                                    </button>
                                </CardHeader>
                                <CardContent className="flex flex-col gap-4">
                                    {/* Date & Time */}
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Date & Time</label>
                                        <div className="text-sm text-foreground">
                                            {txDate.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
                                            {' · '}
                                            {txDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                                        </div>
                                    </div>

                                    {/* Status & Fee */}
                                    <div className="flex gap-3">
                                        <div className="flex-1 flex flex-col gap-1">
                                            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Status</label>
                                            <div className="flex items-center gap-1.5">
                                                <div className={cn("w-2 h-2 rounded-full", selectedTx.status.confirmed ? "bg-green-500" : "bg-yellow-500")} />
                                                <span className="text-sm text-foreground">{selectedTx.status.confirmed ? 'Confirmed' : 'Pending'}</span>
                                            </div>
                                        </div>
                                        <div className="flex-1 flex flex-col gap-1">
                                            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Network Fee</label>
                                            <div className="text-sm text-foreground">{selectedTx.fee?.toLocaleString() ?? '—'} sats</div>
                                        </div>
                                    </div>

                                    {/* From Addresses */}
                                    <div className="flex flex-col gap-1.5">
                                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">From</label>
                                        {fromAddresses.map((addr, i) => (
                                            <div key={i} className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2.5 py-1.5">
                                                <span className={cn("text-[11px] font-mono truncate flex-1", addr === address && "text-primary font-semibold")}>
                                                    {addr}
                                                </span>
                                                <button onClick={() => copyText(addr, `from-${i}`)} className="shrink-0 p-1 hover:bg-white/10 rounded transition-colors cursor-pointer">
                                                    {copiedId === `from-${i}` ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                                                </button>
                                            </div>
                                        ))}
                                    </div>

                                    {/* To Addresses */}
                                    <div className="flex flex-col gap-1.5">
                                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">To</label>
                                        {toAddresses.map((addr, i) => (
                                            <div key={i} className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2.5 py-1.5">
                                                <span className={cn("text-[11px] font-mono truncate flex-1", addr === address && "text-primary font-semibold")}>
                                                    {addr}
                                                </span>
                                                <button onClick={() => copyText(addr, `to-${i}`)} className="shrink-0 p-1 hover:bg-white/10 rounded transition-colors cursor-pointer">
                                                    {copiedId === `to-${i}` ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                                                </button>
                                            </div>
                                        ))}
                                    </div>

                                    {/* Transaction ID */}
                                    <div className="flex flex-col gap-1.5">
                                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Transaction ID</label>
                                        <div className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2.5 py-1.5">
                                            <span className="text-[11px] font-mono truncate flex-1">{selectedTx.txid}</span>
                                            <button onClick={() => copyText(selectedTx.txid, 'detail-txid')} className="shrink-0 p-1 hover:bg-white/10 rounded transition-colors cursor-pointer">
                                                {copiedId === 'detail-txid' ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                                            </button>
                                        </div>
                                    </div>

                                    {/* View on Explorer */}
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
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                );
            })()}

            {/* ── ZCASH TX DETAIL MODAL ── */}
            {selectedZcashTx && (() => {
                const tx = selectedZcashTx;
                const isReceive = tx.type === 'receive';
                const txDate = new Date(tx.timestamp * 1000);
                const explorers = [
                    { name: '3xpl', url: `https://3xpl.com/zcash/transaction/${tx.txid}` },
                    { name: 'Blockchair', url: `https://blockchair.com/zcash/transaction/${tx.txid}` },
                ];

                return (
                    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                        <div className="flex min-h-full items-center justify-center px-4 py-20">
                            <Card className="w-full max-w-[400px] shadow-2xl">
                                <CardHeader className="flex-row items-center justify-between">
                                    <CardTitle className="text-base flex items-center gap-2">
                                        <div className={cn(
                                            "p-1.5 rounded-full",
                                            isReceive ? "bg-green-500/10 text-green-500" : "bg-primary/10 text-primary"
                                        )}>
                                            {isReceive ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                                        </div>
                                        {isReceive ? 'Received' : 'Sent'} {satsToZec(tx.value)} ZEC
                                    </CardTitle>
                                    <button onClick={() => setSelectedZcashTx(null)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                        <X className="w-4 h-4" />
                                    </button>
                                </CardHeader>
                                <CardContent className="flex flex-col gap-4">
                                    {/* Date & Time */}
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Date & Time</label>
                                        <div className="text-sm text-foreground">
                                            {txDate.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
                                            {' · '}
                                            {txDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                                        </div>
                                    </div>

                                    {/* Status */}
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Status</label>
                                        <div className="flex items-center gap-1.5">
                                            <div className={cn("w-2 h-2 rounded-full", tx.confirmations > 0 ? "bg-green-500" : "bg-yellow-500")} />
                                            <span className="text-sm text-foreground">{tx.confirmations > 0 ? 'Confirmed' : 'Pending'}</span>
                                        </div>
                                    </div>

                                    {/* From */}
                                    <div className="flex flex-col gap-1.5">
                                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">From</label>
                                        {zcashTxAddresses.from.length > 0 ? (
                                            zcashTxAddresses.from.map((addr, i) => (
                                                <div key={i} className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2.5 py-1.5">
                                                    <span className={cn("text-[11px] font-mono truncate flex-1", addr === address && "text-primary font-semibold")}>{addr}</span>
                                                    <button onClick={() => copyText(addr, `zcash-from-${i}`)} className="shrink-0 p-1 hover:bg-white/10 rounded transition-colors cursor-pointer">
                                                        {copiedId === `zcash-from-${i}` ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                                                    </button>
                                                </div>
                                            ))
                                        ) : (
                                            <div className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2.5 py-1.5">
                                                <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                                                <span className="text-[11px] text-muted-foreground">Loading...</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* To */}
                                    <div className="flex flex-col gap-1.5">
                                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">To</label>
                                        {zcashTxAddresses.to.length > 0 ? (
                                            zcashTxAddresses.to.map((addr, i) => (
                                                <div key={i} className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2.5 py-1.5">
                                                    <span className={cn("text-[11px] font-mono truncate flex-1", addr === address && "text-primary font-semibold")}>{addr}</span>
                                                    <button onClick={() => copyText(addr, `zcash-to-${i}`)} className="shrink-0 p-1 hover:bg-white/10 rounded transition-colors cursor-pointer">
                                                        {copiedId === `zcash-to-${i}` ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                                                    </button>
                                                </div>
                                            ))
                                        ) : (
                                            <div className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2.5 py-1.5">
                                                <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                                                <span className="text-[11px] text-muted-foreground">Loading...</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Transaction ID */}
                                    <div className="flex flex-col gap-1.5">
                                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Transaction ID</label>
                                        <div className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2.5 py-1.5">
                                            <span className="text-[11px] font-mono truncate flex-1">{tx.txid}</span>
                                            <button onClick={() => copyText(tx.txid, 'zcash-detail-txid')} className="shrink-0 p-1 hover:bg-white/10 rounded transition-colors cursor-pointer">
                                                {copiedId === 'zcash-detail-txid' ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                                            </button>
                                        </div>
                                    </div>

                                    {/* View on Explorer */}
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
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                );
            })()}

            {/* ── EVM TRANSACTION DETAIL MODAL ── */}
            {selectedEvmTx && (() => {
                const tx = selectedEvmTx;
                const isReceive = tx.to.toLowerCase() === address.toLowerCase();
                const txValue = tx.tokenDecimal ? formatUnitsFull(BigInt(tx.value || '0'), parseInt(tx.tokenDecimal)) : formatUnitsFull(BigInt(tx.value || '0'), currentDecimals);
                const txSymbol = tx.tokenSymbol || currentSymbol;
                const txDate = new Date(parseInt(tx.timeStamp) * 1000);
                const explorerUrl = evmChain ? `${evmChain.explorerUrl}/tx/${tx.hash}` : '';
                const gasFee = BigInt(tx.gasUsed || '0') * BigInt(tx.gasPrice || '0');
                const isZeroValue = BigInt(tx.value || '0') === 0n;
                const isGasOnly = isZeroValue && !isReceive && gasFee > 0n;

                return (
                    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                        <div className="flex min-h-full items-center justify-center px-4 py-20">
                            <Card className="w-full max-w-[400px] shadow-2xl">
                                <CardHeader className="flex-row items-center justify-between">
                                    <CardTitle className="text-base flex items-center gap-2">
                                        <div className={cn("p-1.5 rounded-full", isReceive ? "bg-green-500/10 text-green-500" : "bg-primary/10 text-primary")}>
                                            {isReceive ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                                        </div>
                                        {isGasOnly ? `Token Transaction (Gas)` : isReceive ? 'Received' : 'Sent'} {txSymbol}
                                    </CardTitle>
                                    <button onClick={() => setSelectedEvmTx(null)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                        <X className="w-4 h-4" />
                                    </button>
                                </CardHeader>
                                <CardContent className="flex flex-col gap-4">
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Date & Time</label>
                                        <div className="text-sm text-foreground">
                                            {txDate.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
                                            {' · '}
                                            {txDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                                        </div>
                                    </div>
                                    <div className="flex gap-3">
                                        <div className="flex-1 flex flex-col gap-1">
                                            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Status</label>
                                            <div className="flex items-center gap-1.5">
                                                <div className={cn("w-2 h-2 rounded-full", tx.isError !== '1' ? "bg-green-500" : "bg-red-500")} />
                                                <span className="text-sm text-foreground">{tx.isError !== '1' ? 'Confirmed' : 'Failed'}</span>
                                            </div>
                                        </div>
                                        <div className="flex-1 flex flex-col gap-1">
                                            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Gas Fee</label>
                                            <div className="text-sm text-foreground">
                                                {formatUnitsFull(gasFee, 18)} {evmChain?.symbol || 'ETH'}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                                            {isGasOnly ? 'Gas Fee (Token Transaction)' : 'Amount'}
                                        </label>
                                        {isGasOnly ? (
                                            <div className="text-sm font-bold text-foreground">-{formatUnitsFull(gasFee, 18)} {evmChain?.symbol || 'ETH'}</div>
                                        ) : (
                                            <div className={cn("text-sm font-bold", isReceive ? "text-green-500" : "text-foreground")}>{isReceive ? '+' : '-'}{txValue} {txSymbol}</div>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">From</label>
                                        <div className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2.5 py-1.5">
                                            <span className={cn("text-[11px] font-mono truncate flex-1", tx.from.toLowerCase() === address.toLowerCase() && "text-primary font-semibold")}>{tx.from}</span>
                                            <button onClick={() => copyText(tx.from, 'evm-from')} className="shrink-0 p-1 hover:bg-white/10 rounded transition-colors cursor-pointer">
                                                {copiedId === 'evm-from' ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                                            </button>
                                        </div>
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">To</label>
                                        <div className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2.5 py-1.5">
                                            <span className={cn("text-[11px] font-mono truncate flex-1", tx.to.toLowerCase() === address.toLowerCase() && "text-primary font-semibold")}>{tx.to}</span>
                                            <button onClick={() => copyText(tx.to, 'evm-to')} className="shrink-0 p-1 hover:bg-white/10 rounded transition-colors cursor-pointer">
                                                {copiedId === 'evm-to' ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                                            </button>
                                        </div>
                                    </div>
                                    <div className="flex flex-col gap-1.5">
                                        <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Transaction Hash</label>
                                        <div className="flex items-center gap-1.5 bg-secondary/50 rounded-lg px-2.5 py-1.5">
                                            <span className="text-[11px] font-mono truncate flex-1">{tx.hash}</span>
                                            <button onClick={() => copyText(tx.hash, 'evm-txhash')} className="shrink-0 p-1 hover:bg-white/10 rounded transition-colors cursor-pointer">
                                                {copiedId === 'evm-txhash' ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-muted-foreground" />}
                                            </button>
                                        </div>
                                    </div>
                                    {explorerUrl && (
                                        <div className="flex flex-col gap-1.5">
                                            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">View on Explorer</label>
                                            <button onClick={() => openUrl(explorerUrl)} className="flex items-center justify-between w-full px-3 py-2 bg-secondary/50 hover:bg-secondary rounded-lg transition-colors cursor-pointer">
                                                <span className="text-xs font-medium text-foreground">{evmChain?.name || 'Explorer'}</span>
                                                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                                            </button>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                );
            })()}

            {showApiKeyModal && (
                <div className="fixed inset-0 z-[55] overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                    <div className="flex min-h-full items-center justify-center px-4 py-20">
                        <Card className="w-[380px] shadow-2xl">
                            <CardHeader className="flex-row items-center justify-between">
                                <CardTitle className="text-base flex items-center gap-2">
                                    <KeyRound className="w-4 h-4" /> API Keys
                                </CardTitle>
                                <button onClick={() => setShowApiKeyModal(false)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                    <X className="w-4 h-4" />
                                </button>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                    Transaction history uses multiple indexer APIs with automatic fallback. Configure your own keys for better reliability.
                                </p>

                                {/* Etherscan V2 */}
                                <div className="space-y-1.5">
                                    <div className="flex items-center justify-between">
                                        <label className="text-xs text-muted-foreground font-medium">Etherscan V2</label>
                                        <button
                                            onClick={() => openUrl('https://etherscan.io/myapikey')}
                                            className="text-[10px] text-primary hover:underline cursor-pointer"
                                        >
                                            Get free key →
                                        </button>
                                    </div>
                                    <Input
                                        value={apiKeyInput}
                                        onChange={e => setApiKeyInput(e.target.value)}
                                        placeholder="Etherscan API key (ETH, Polygon free)..."
                                        className="text-xs font-mono"
                                    />
                                    <p className="text-[10px] text-muted-foreground/60">Free tier covers Ethereum & Polygon. Paid plan covers all chains.</p>
                                </div>

                                {/* GoldRush (Covalent) */}
                                <div className="space-y-1.5">
                                    <div className="flex items-center justify-between">
                                        <label className="text-xs text-muted-foreground font-medium">GoldRush (Covalent)</label>
                                        <button
                                            onClick={() => openUrl('https://goldrush.dev/platform/apikey/')}
                                            className="text-[10px] text-primary hover:underline cursor-pointer"
                                        >
                                            Get free key →
                                        </button>
                                    </div>
                                    <Input
                                        value={goldrushKeyInput}
                                        onChange={e => setGoldrushKeyInput(e.target.value)}
                                        placeholder="GoldRush API key (all chains)..."
                                        className="text-xs font-mono"
                                    />
                                    <p className="text-[10px] text-muted-foreground/60">Free tier covers all chains including BNB & Base. Used as fallback.</p>
                                </div>

                                <div className="flex gap-2">
                                    <Button
                                        variant="outline"
                                        className="flex-1"
                                        onClick={() => setShowApiKeyModal(false)}
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        className="flex-1 font-bold"
                                        onClick={() => {
                                            etherscanApiKey.set(apiKeyInput);
                                            goldrushApiKey.set(goldrushKeyInput);
                                            setShowApiKeyModal(false);
                                            fetchData();
                                            toast('API keys saved', 'success');
                                        }}
                                    >
                                        Save
                                    </Button>
                                </div>
                                <button
                                    onClick={() => {
                                        setApiKeyInput('');
                                        setGoldrushKeyInput('');
                                        etherscanApiKey.set('');
                                        goldrushApiKey.set('');
                                        setShowApiKeyModal(false);
                                        fetchData();
                                        toast('Reset to defaults', 'success');
                                    }}
                                    className="w-full text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer py-1"
                                >
                                    Reset All to Defaults
                                </button>
                            </CardContent>
                        </Card>
                    </div>
                </div>
            )}

            {/* Follows Selector for send */}
            {activePubkey && (
                <FollowsSelector
                    isOpen={showFollowsSelector}
                    onClose={() => setShowFollowsSelector(false)}
                    onSelect={(npub) => {
                        setSendTo(npub);
                        try {
                            if (isBitcoin) setResolvedAddress(npubToTaprootAddress(npub));
                            else if (isEvm) setResolvedAddress(npubToEvmAddress(npub));
                            else if (isZcash) setResolvedAddress(npubToZcashAddress(npub));
                        } catch { /* skip */ }
                    }}
                    activePubkey={activePubkey}
                    chainType={isBitcoin ? 'bitcoin' : isEvm ? 'evm' : isZcash ? 'zcash' : 'none'}
                />
            )}

            {/* ── BLOCKCHAIN SELECTOR MODAL ── */}
            {showChainSelector && (() => {
                const chains: { id: ChainId; name: string; symbol: string; color: string; icon?: string }[] = [
                    { id: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', color: '#F7931A', icon: chainIcons.bitcoin },
                    { id: 'ethereum', name: 'Ethereum', symbol: 'ETH', color: '#627EEA', icon: EVM_CHAINS['ethereum']?.icon },
                    { id: 'bnb', name: 'BNB Chain', symbol: 'BNB', color: '#F0B90B', icon: EVM_CHAINS['bnb']?.icon },
                    { id: 'polygon', name: 'Polygon', symbol: 'POL', color: '#8247E5', icon: EVM_CHAINS['polygon']?.icon },
                    { id: 'avalanche', name: 'Avalanche', symbol: 'AVAX', color: '#E84142', icon: EVM_CHAINS['avalanche']?.icon },
                    { id: 'base', name: 'Base', symbol: 'ETH', color: '#0052FF', icon: EVM_CHAINS['base']?.icon },
                    { id: 'zcash', name: 'Zcash', symbol: 'ZEC', color: '#ECB244', icon: chainIcons.zcash },
                ];
                const filtered = chains.filter(c =>
                    c.name.toLowerCase().includes(chainSearch.toLowerCase()) ||
                    c.symbol.toLowerCase().includes(chainSearch.toLowerCase())
                );
                return (
                    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                        <div className="flex min-h-full items-center justify-center px-4 py-20">
                            <Card className="w-[380px] shadow-2xl">
                                <CardHeader className="flex-row items-center justify-between">
                                    <CardTitle className="text-base">Select Blockchain</CardTitle>
                                    <button onClick={() => setShowChainSelector(false)} className="text-muted-foreground hover:text-foreground cursor-pointer"><X className="w-4 h-4" /></button>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <div className="relative">
                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                        <Input placeholder="Search blockchains..." value={chainSearch} onChange={e => setChainSearch(e.target.value)} className="pl-9 text-sm" />
                                    </div>
                                    <div className="space-y-1 max-h-[360px] overflow-y-auto">
                                        {filtered.map(chain => (
                                            <button
                                                key={chain.id}
                                                onClick={() => { setSelectedChain(chain.id); setShowChainSelector(false); }}
                                                className={cn(
                                                    "w-full flex items-center gap-3 p-3 rounded-xl transition-colors text-left cursor-pointer",
                                                    selectedChain === chain.id ? "bg-primary/10 border border-primary/30" : "hover:bg-muted"
                                                )}
                                            >
                                                <img src={chain.icon || ''} alt={chain.name} className="rounded-full object-cover shrink-0" style={{ width: 32, height: 32 }} />
                                                <div className="flex-1">
                                                    <span className="text-sm font-semibold text-foreground">{chain.name}</span>
                                                    <span className="text-xs text-muted-foreground ml-2">{chain.symbol}</span>
                                                </div>
                                                {selectedChain === chain.id && <Check className="w-4 h-4 text-green-400 shrink-0" />}
                                            </button>
                                        ))}
                                        {filtered.length === 0 && <div className="text-center py-6 text-muted-foreground text-sm">No blockchains found</div>}
                                    </div>
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                );
            })()}

            {/* ── ASSET SELECTOR MODAL ── */}
            {showAssetSelector && (() => {
                let assets: { id: string; name: string; detail?: string; contractAddress?: string | null }[] = [];
                if (isBitcoin) {
                    assets = [
                        { id: 'native', name: 'Native SegWit', detail: 'bc1q...' },
                        { id: 'taproot', name: 'Taproot', detail: 'bc1p...' },
                    ];
                } else if (isEvm && evmChain) {
                    assets = evmChain.tokens.map(t => ({
                        id: t.symbol.toLowerCase(),
                        name: t.name,
                        detail: t.contractAddress ? `${t.symbol} · ERC-20` : `${t.symbol} · Native`,
                        contractAddress: t.contractAddress || null,
                    }));
                } else if (isZcash) {
                    assets = [{ id: 'transparent', name: 'Transparent', detail: 't1...', contractAddress: null }];
                }
                return (
                    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                        <div className="flex min-h-full items-center justify-center px-4 py-20">
                            <Card className="w-[340px] shadow-2xl">
                                <CardHeader className="flex-row items-center justify-between">
                                    <CardTitle className="text-base">Select Asset</CardTitle>
                                    <button onClick={() => setShowAssetSelector(false)} className="text-muted-foreground hover:text-foreground cursor-pointer"><X className="w-4 h-4" /></button>
                                </CardHeader>
                                <CardContent className="space-y-1">
                                    {assets.map(a => (
                                        <button
                                            key={a.id}
                                            onClick={() => { setSelectedAsset(a.id); setShowAssetSelector(false); }}
                                            className={cn(
                                                "w-full flex items-center justify-between p-3 rounded-xl transition-colors text-left cursor-pointer",
                                                selectedAsset === a.id ? "bg-primary/10 border border-primary/30" : "hover:bg-muted"
                                            )}
                                        >
                                            <div className="flex items-center gap-2.5">
                                                {isEvm && evmChain && (() => {
                                                    const token = evmChain.tokens.find(t => t.symbol.toLowerCase() === a.id);
                                                    return <img src={token?.icon || ''} alt={a.name} className="rounded-full object-cover shrink-0" style={{ width: 24, height: 24 }} />;
                                                })()}
                                                <div>
                                                <span className="text-sm font-semibold text-foreground">{a.name}</span>
                                                {a.detail && <span className="text-xs text-muted-foreground ml-2">{a.detail}</span>}
                                                {a.contractAddress && (
                                                    <div className="text-[10px] font-mono text-muted-foreground/60 mt-0.5">
                                                        {a.contractAddress.slice(0, 7)}...{a.contractAddress.slice(-5)}
                                                    </div>
                                                )}
                                                </div>
                                            </div>
                                            {selectedAsset === a.id && <Check className="w-4 h-4 text-green-400 shrink-0" />}
                                        </button>
                                    ))}
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
}

