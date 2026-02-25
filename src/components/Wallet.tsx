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
    ArrowUpRight, ArrowDownLeft, RefreshCw, Copy, Check, ExternalLink,
    X, ArrowUpDown, Send, QrCode, Loader2, AlertTriangle, WalletMinimal, EyeOff, Shield,
    Search, ChevronDown,
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
import { Users } from 'lucide-react';

type WalletTab = 'bitcoin' | 'ecash' | 'silent' | 'multi';

interface WalletProps {
    activePubkey: string | null;
    sendPrefill?: { recipient: string; amount: number; feeRate?: number } | null;
    onPrefillConsumed?: () => void;
    ecashRecipient?: string;
    ecashAutoSend?: boolean;
    onEcashPrefillConsumed?: () => void;
}

export function Wallet({ activePubkey, sendPrefill, onPrefillConsumed, ecashRecipient, ecashAutoSend, onEcashPrefillConsumed }: WalletProps) {
    const [walletTab, setWalletTab] = useState<WalletTab>('bitcoin');
    const [addressType, setAddressType] = useState<BtcAddressType>('native');
    const [address, setAddress] = useState('');
    const [balance, setBalance] = useState(0);
    const [utxos, setUtxos] = useState<UTXO[]>([]);
    const [history, setHistory] = useState<TxHistory[]>([]);
    const [loading, setLoading] = useState(false);
    const [showBTCFirst, setShowBTCFirst] = useState(false);
    const [privateKeyHex, setPrivateKeyHex] = useState('');
    const [copiedId, setCopiedId] = useState<string | null>(null);

    // Modal states
    const [showReceive, setShowReceive] = useState(false);
    const [showSend, setShowSend] = useState(false);
    const [selectedTx, setSelectedTx] = useState<TxHistory | null>(null);
    const [showFollowsSelector, setShowFollowsSelector] = useState(false);
    const [showChainSelector, setShowChainSelector] = useState(false);
    const [chainSearch, setChainSearch] = useState('');

    // Send form
    const [sendTo, setSendTo] = useState('');
    const [resolvedAddress, setResolvedAddress] = useState('');
    const [sendAmount, setSendAmount] = useState('');
    const [unit, setUnit] = useState<'sats' | 'btc'>('sats');
    const [feeRates, setFeeRates] = useState<FeeRates | null>(null);
    const [selectedFeeRate, setSelectedFeeRate] = useState(0);
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState('');
    const [sendSuccess, setSendSuccess] = useState('');
    const [sendStep, setSendStep] = useState<'form' | 'review'>('form');

    // Resolve npub → taproot address
    useEffect(() => {
        const trimmed = sendTo.trim();
        if (trimmed.startsWith('npub')) {
            try {
                setResolvedAddress(npubToTaprootAddress(trimmed));
            } catch { setResolvedAddress(''); }
        } else if (trimmed.startsWith('bc1') || trimmed.startsWith('1') || trimmed.startsWith('3')) {
            setResolvedAddress(trimmed);
        } else {
            setResolvedAddress('');
        }
    }, [sendTo]);

    const { toast } = useFeedback();

    const copyText = (text: string, id: string) => {
        navigator.clipboard.writeText(text);
        setCopiedId(id);
        toast('Copied!', 'success');
        setTimeout(() => setCopiedId(null), 2000);
    };

    // Fetch private key and derive address
    useEffect(() => {
        if (!activePubkey) {
            setAddress('');
            setPrivateKeyHex('');
            return;
        }
        (async () => {
            try {
                const hex = await invoke<string>('export_private_key_hex', { pubkey: activePubkey });
                setPrivateKeyHex(hex);
                const addr = addressType === 'taproot'
                    ? privateKeyToTaprootAddress(hex)
                    : privateKeyToBitcoinAddress(hex);
                setAddress(addr);
            } catch (e) {
                console.error('Failed to derive Bitcoin address:', e);
            }
        })();
    }, [activePubkey, addressType]);

    // Fetch blockchain data when address changes
    const fetchData = useCallback(async () => {
        if (!address) return;
        setLoading(true);
        try {
            const [fetchedUtxos, fetchedHistory] = await Promise.all([
                fetchUTXOs(address),
                fetchTxHistory(address),
            ]);
            setUtxos(fetchedUtxos);
            setHistory(fetchedHistory);
            const total = fetchedUtxos.reduce((s, u) => s + u.value, 0);
            setBalance(total);
            if (total >= 1_000_000) setShowBTCFirst(true);
        } catch (e) {
            console.error('Error fetching Bitcoin data:', e);
        } finally {
            setLoading(false);
        }
    }, [address]);

    useEffect(() => { fetchData(); }, [fetchData]);

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
            const amountSats = unit === 'btc' ? btcToSats(parseFloat(sendAmount)) : parseInt(sendAmount);
            if (isNaN(amountSats) || amountSats <= 0) throw new Error('Invalid amount');
            const target = resolvedAddress;
            if (!target) throw new Error('Enter a valid recipient address or npub');
            if (!selectedFeeRate) throw new Error('Select a fee rate');

            const { txHex, fee } = addressType === 'taproot'
                ? await createTaprootTransaction(privateKeyHex, target, amountSats, utxos, selectedFeeRate)
                : await createBitcoinTransaction(privateKeyHex, target, amountSats, utxos, selectedFeeRate);

            const txid = await broadcastTransaction(txHex);
            setSendSuccess(txid);
            toast(`Sent! Fee: ${fee} sats`, 'success');
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
            const rates = await getFeeRates();
            setFeeRates(rates);
            setSelectedFeeRate(rates.hourFee);
        } catch {
            setFeeRates(null);
        }
    };

    // Handle prefill from IDs page
    useEffect(() => {
        if (sendPrefill && privateKeyHex && walletTab === 'bitcoin') {
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
            {(['bitcoin', 'ecash', 'silent', 'multi'] as WalletTab[]).map(id => {
                const label = id === 'bitcoin' ? 'Native' : id === 'ecash' ? 'eCash' : id === 'silent' ? 'Silent' : 'Multisig';
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

    // ── BITCOIN TAB ──
    return (
        <div className="flex flex-col gap-4 h-full overflow-hidden">
            {/* Tab toggle */}
            {renderTabs()}

            {/* Balance card */}
            <div className="wallet-balance-card bg-gradient-to-br from-primary/15 to-primary/5 border border-primary/20 rounded-2xl p-5 relative overflow-hidden shrink-0">
                <div className="relative z-10">
                    <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                            <span className="text-muted-foreground text-sm font-medium">Total Balance</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <button
                                onClick={() => { setChainSearch(''); setShowChainSelector(true); }}
                                className="wallet-badge-btn flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded-md border bg-muted border-border transition-colors cursor-pointer hover:bg-accent"
                            >
                                <svg viewBox="0 0 32 32" className="w-3 h-3"><circle cx="16" cy="16" r="16" fill="#F7931A" /><path d="M22.1 14.6c.3-2-1.2-3.1-3.3-3.8l.7-2.7-1.6-.4-.6 2.6c-.4-.1-.9-.2-1.3-.3l.7-2.6-1.7-.4-.7 2.7c-.4-.1-.7-.2-1-.2v-.1l-2.3-.6-.4 1.8s1.2.3 1.2.3c.7.2.8.6.8 1l-.8 3.2c0 .1.1.1.1.1l-.1 0-1.1 4.5c-.1.2-.3.5-.7.4 0 0-1.2-.3-1.2-.3l-.8 1.9 2.2.5c.4.1.8.2 1.2.3l-.7 2.8 1.6.4.7-2.7c.5.1.9.2 1.3.3l-.7 2.7 1.7.4.7-2.8c2.8.5 5 .3 5.9-2.2.7-2 0-3.2-1.5-3.9 1.1-.3 1.9-1 2.1-2.5zm-3.7 5.2c-.5 2-4 .9-5.1.7l.9-3.7c1.1.3 4.7.8 4.2 3zm.5-5.3c-.5 1.8-3.3.9-4.3.7l.8-3.3c1 .2 4 .7 3.5 2.6z" fill="#fff" /></svg>
                                Bitcoin
                                <ChevronDown className="w-2.5 h-2.5" />
                            </button>
                            <button
                                onClick={() => setAddressType(t => t === 'native' ? 'taproot' : 'native')}
                                className={cn(
                                    "wallet-badge-btn px-2 py-0.5 text-[10px] font-medium rounded-md border transition-colors cursor-pointer",
                                    addressType === 'native'
                                        ? "bg-muted border-border"
                                        : "bg-muted border-border"
                                )}
                            >
                                {addressType === 'native' ? 'Native' : 'Taproot'}
                            </button>
                            <button onClick={() => setShowBTCFirst(!showBTCFirst)} className="p-1 hover:bg-white/10 rounded-md transition-colors cursor-pointer">
                                <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />
                            </button>
                            <button onClick={fetchData} disabled={loading} className="p-1 hover:bg-white/10 rounded-md transition-colors cursor-pointer">
                                <RefreshCw className={cn("w-3.5 h-3.5 text-muted-foreground", loading && "animate-spin")} />
                            </button>
                        </div>
                    </div>

                    {showBTCFirst ? (
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

            {/* Transaction history */}
            <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-foreground">History</h3>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pb-[100px]">
                    {loading && history.length === 0 ? (
                        <div className="flex items-center justify-center py-8 text-muted-foreground">
                            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
                        </div>
                    ) : history.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground text-sm">
                            No transactions yet
                        </div>
                    ) : (
                        history.slice(0, 20).map((tx) => {
                            const { isReceive, absAmount } = getTxDetails(tx);
                            return (
                                <button
                                    key={tx.txid}
                                    onClick={() => setSelectedTx(tx)}
                                    className="tx-item w-full text-left bg-secondary/50 hover:bg-secondary rounded-xl p-3.5 transition-colors cursor-pointer"
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2.5">
                                            <div className={cn(
                                                "p-1.5 rounded-full",
                                                isReceive ? "bg-green-500/10 text-green-500" : "bg-primary/10 text-primary"
                                            )}>
                                                {isReceive ? <ArrowDownLeft className="w-3.5 h-3.5" /> : <ArrowUpRight className="w-3.5 h-3.5" />}
                                            </div>
                                            <div>
                                                <div className="text-sm font-medium text-foreground">
                                                    {isReceive ? 'Received' : 'Sent'}
                                                </div>
                                                <div className="text-[10px] text-muted-foreground">
                                                    {new Date((tx.status.block_time || Date.now() / 1000) * 1000).toLocaleDateString()}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <div className={cn("text-sm font-bold", isReceive ? "text-green-500" : "text-foreground")}>
                                                {isReceive ? '+' : '-'}{absAmount.toLocaleString()} sats
                                            </div>
                                            <div className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                                                <div className={cn("w-1.5 h-1.5 rounded-full", tx.status.confirmed ? "bg-green-500" : "bg-yellow-500")} />
                                                {tx.status.confirmed ? 'Confirmed' : 'Pending'}
                                            </div>
                                        </div>
                                    </div>
                                </button>
                            );
                        })
                    )}
                </div>
            </div>

            {/* ── RECEIVE MODAL ── */}
            {showReceive && (
                <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                    <div className="flex min-h-full items-center justify-center px-4 py-20">
                        <Card className="w-[360px] shadow-2xl">
                            <CardHeader className="flex-row items-center justify-between">
                                <CardTitle className="text-base flex items-center gap-2">
                                    <QrCode className="w-4 h-4" /> Receive Bitcoin
                                </CardTitle>
                                <button onClick={() => setShowReceive(false)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                    <X className="w-4 h-4" />
                                </button>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="flex items-center justify-center">
                                    <div className="bg-white p-3 rounded-xl">
                                        <img
                                            src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=bitcoin:${address}`}
                                            alt="QR Code"
                                            className="w-48 h-48"
                                        />
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-xs text-muted-foreground font-medium">
                                        {addressType === 'native' ? 'Native SegWit (P2WPKH)' : 'Taproot (P2TR)'}
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
                                    <Send className="w-4 h-4" /> Send Bitcoin
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
                                            <label className="text-xs text-muted-foreground font-medium">Transaction ID</label>
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
                                                placeholder="Bitcoin address or npub..."
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
                                                <button
                                                    onClick={() => {
                                                        const myAddr = privateKeyToBitcoinAddress(privateKeyHex);
                                                        setSendTo(myAddr);
                                                        setResolvedAddress(myAddr);
                                                    }}
                                                    className="px-2.5 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary text-[11px] font-medium rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                                                >
                                                    <ArrowUpRight className="w-3 h-3" />
                                                    Send to Myself
                                                </button>
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
                                                    Available: {balance.toLocaleString()} sats
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2 bg-secondary/50 border border-border rounded-lg px-3 py-2 focus-within:ring-1 focus-within:ring-primary/50 transition-all">
                                                {unit === 'sats' ? (
                                                    <SatoshiIcon className="text-lg text-primary shrink-0" />
                                                ) : (
                                                    <span className="text-lg text-primary shrink-0">₿</span>
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
                                                        const totalSats = balance;
                                                        if (unit === 'sats') {
                                                            setSendAmount(totalSats.toString());
                                                        } else {
                                                            setSendAmount(satsToBTC(totalSats));
                                                        }
                                                    }}
                                                    className="px-1.5 py-0.5 bg-primary/10 hover:bg-primary/20 text-primary text-[10px] font-bold rounded transition-colors cursor-pointer shrink-0"
                                                >
                                                    MAX
                                                </button>
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
                                            </div>
                                        </div>

                                        {/* Fee Rate */}
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
                                                    {unit === 'sats'
                                                        ? `${parseInt(sendAmount).toLocaleString()} sats`
                                                        : `${sendAmount} BTC`}
                                                </span>
                                            </div>
                                            <div className="border-t border-border" />
                                            <div className="flex justify-between items-center">
                                                <span className="text-xs text-muted-foreground">Fee Rate</span>
                                                <span className="text-xs font-medium text-foreground">{selectedFeeRate} sat/vB</span>
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
            {/* Follows Selector for Bitcoin send */}
            {activePubkey && (
                <FollowsSelector
                    isOpen={showFollowsSelector}
                    onClose={() => setShowFollowsSelector(false)}
                    onSelect={(npub) => {
                        setSendTo(npub);
                        try {
                            setResolvedAddress(npubToTaprootAddress(npub));
                        } catch { /* skip */ }
                    }}
                    activePubkey={activePubkey}
                    showTaprootAddress={true}
                />
            )}

            {/* ── BLOCKCHAIN SELECTOR MODAL ── */}
            {showChainSelector && (() => {
                const chains = [
                    {
                        id: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', active: true, color: '#F7931A',
                        logo: <svg viewBox="0 0 32 32" className="w-8 h-8"><circle cx="16" cy="16" r="16" fill="#F7931A" /><path d="M22.1 14.6c.3-2-1.2-3.1-3.3-3.8l.7-2.7-1.6-.4-.6 2.6c-.4-.1-.9-.2-1.3-.3l.7-2.6-1.7-.4-.7 2.7c-.4-.1-.7-.2-1-.2v-.1l-2.3-.6-.4 1.8s1.2.3 1.2.3c.7.2.8.6.8 1l-.8 3.2c0 .1.1.1.1.1l-.1 0-1.1 4.5c-.1.2-.3.5-.7.4 0 0-1.2-.3-1.2-.3l-.8 1.9 2.2.5c.4.1.8.2 1.2.3l-.7 2.8 1.6.4.7-2.7c.5.1.9.2 1.3.3l-.7 2.7 1.7.4.7-2.8c2.8.5 5 .3 5.9-2.2.7-2 0-3.2-1.5-3.9 1.1-.3 1.9-1 2.1-2.5zm-3.7 5.2c-.5 2-4 .9-5.1.7l.9-3.7c1.1.3 4.7.8 4.2 3zm.5-5.3c-.5 1.8-3.3.9-4.3.7l.8-3.3c1 .2 4 .7 3.5 2.6z" fill="#fff" /></svg>
                    },
                    {
                        id: 'ethereum', name: 'Ethereum', symbol: 'ETH', active: false, color: '#627EEA',
                        logo: <svg viewBox="0 0 32 32" className="w-8 h-8"><circle cx="16" cy="16" r="16" fill="#627EEA" /><path d="M16 4v8.87l7.5 3.35L16 4z" fill="#fff" fillOpacity=".6" /><path d="M16 4L8.5 16.22 16 12.87V4z" fill="#fff" /><path d="M16 21.97v6.03l7.5-10.38L16 21.97z" fill="#fff" fillOpacity=".6" /><path d="M16 28v-6.03L8.5 17.62 16 28z" fill="#fff" /><path d="M16 20.57l7.5-4.35L16 12.87v7.7z" fill="#fff" fillOpacity=".2" /><path d="M8.5 16.22l7.5 4.35v-7.7l-7.5 3.35z" fill="#fff" fillOpacity=".6" /></svg>
                    },
                    {
                        id: 'dogecoin', name: 'Dogecoin', symbol: 'DOGE', active: false, color: '#C2A633',
                        logo: <svg viewBox="0 0 32 32" className="w-8 h-8"><circle cx="16" cy="16" r="16" fill="#C2A633" /><path d="M13 8.5h4.5c3.6 0 6.5 2.9 6.5 6.5v2c0 3.6-2.9 6.5-6.5 6.5H13V8.5zm3 3v9h1.5c2 0 3.5-1.5 3.5-3.5v-2c0-2-1.5-3.5-3.5-3.5H16z" fill="#fff" /><path d="M11 15.5h8v3h-8z" fill="#fff" /></svg>
                    },
                    {
                        id: 'litecoin', name: 'Litecoin', symbol: 'LTC', active: false, color: '#345D9D',
                        logo: <svg viewBox="0 0 32 32" className="w-8 h-8"><circle cx="16" cy="16" r="16" fill="#345D9D" /><path d="M10.5 23.5h11l-.5-2.5h-5.5l1.5-6 3-1-0.5-2-3 1 1.5-5h-3l-1.5 5.5-2.5 1 .5 2 2.5-1-1.5 5.5h-2l-.5 2.5z" fill="#fff" /></svg>
                    },
                    {
                        id: 'tron', name: 'Tron', symbol: 'TRX', active: false, color: '#EF0027',
                        logo: <svg viewBox="0 0 32 32" className="w-8 h-8"><circle cx="16" cy="16" r="16" fill="#EF0027" /><path d="M8 9l14 2-8 14L8 9zm2.5 2.5l1.5 8.5 5.5-9.5-7-1.5v2.5z" fill="#fff" /></svg>
                    },
                    {
                        id: 'zcash', name: 'Zcash', symbol: 'ZEC', active: false, color: '#ECB244',
                        logo: <svg viewBox="0 0 32 32" className="w-8 h-8"><circle cx="16" cy="16" r="16" fill="#ECB244" /><path d="M16 6a10 10 0 100 20 10 10 0 000-20zm0 2v3h3l-6 6h3v3h-3l6-6h-3V8z" fill="#fff" /></svg>
                    },
                    {
                        id: 'polygon', name: 'Polygon', symbol: 'POL', active: false, color: '#8247E5',
                        logo: <svg viewBox="0 0 32 32" className="w-8 h-8"><circle cx="16" cy="16" r="16" fill="#8247E5" /><path d="M21 12.5l-3.5-2c-.3-.2-.7-.2-1 0l-3.5 2c-.3.2-.5.5-.5.9v4c0 .4.2.7.5.9l3.5 2c.3.2.7.2 1 0l3.5-2c.3-.2.5-.5.5-.9v-4c0-.4-.2-.7-.5-.9z" fill="#fff" /></svg>
                    },
                    {
                        id: 'avalanche', name: 'Avalanche', symbol: 'AVAX', active: false, color: '#E84142',
                        logo: <svg viewBox="0 0 32 32" className="w-8 h-8"><circle cx="16" cy="16" r="16" fill="#E84142" /><path d="M11.5 21h-2.5c-.4 0-.6-.3-.4-.6l7-12c.2-.3.6-.3.8 0l1.5 2.6c.2.3 0 .6-.4.6h-2.5L11.5 21zm5 0h5c.4 0 .6-.3.4-.6l-2.5-4.4c-.2-.3-.6-.3-.8 0l-2.5 4.4c-.2.3 0 .6.4.6z" fill="#fff" /></svg>
                    },
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
                                    <button onClick={() => setShowChainSelector(false)} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                        <X className="w-4 h-4" />
                                    </button>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    {/* Search */}
                                    <div className="relative">
                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                        <Input
                                            placeholder="Search blockchains..."
                                            value={chainSearch}
                                            onChange={e => setChainSearch(e.target.value)}
                                            className="pl-9 text-sm"
                                        />
                                    </div>

                                    {/* Chain list */}
                                    <div className="space-y-1 max-h-[360px] overflow-y-auto">
                                        {filtered.map(chain => (
                                            <button
                                                key={chain.id}
                                                disabled={!chain.active}
                                                onClick={() => { if (chain.active) setShowChainSelector(false); }}
                                                className={cn(
                                                    "w-full flex items-center gap-3 p-3 rounded-xl transition-colors text-left",
                                                    chain.active
                                                        ? "bg-primary/10 border border-primary/30 cursor-pointer"
                                                        : "opacity-40 cursor-not-allowed"
                                                )}
                                            >
                                                <div className="shrink-0">{chain.logo}</div>
                                                <div className="flex-1">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-sm font-semibold text-foreground">{chain.name}</span>
                                                        <span className="text-xs text-muted-foreground">{chain.symbol}</span>
                                                    </div>
                                                    {!chain.active && (
                                                        <span className="text-[10px] text-muted-foreground">Coming Soon</span>
                                                    )}
                                                </div>
                                                {chain.active && (
                                                    <Check className="w-4 h-4 text-green-400 shrink-0" />
                                                )}
                                            </button>
                                        ))}
                                        {filtered.length === 0 && (
                                            <div className="text-center py-6 text-muted-foreground text-sm">
                                                No blockchains found
                                            </div>
                                        )}
                                    </div>
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
}
