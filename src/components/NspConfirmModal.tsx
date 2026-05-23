/**
 * NspConfirmModal — "Payment Sent?" confirmation + Nostr notification publisher.
 * Auto-fetches transaction IDs for the generated address so the user can pick one.
 */
import { useState, useEffect } from 'react';
import {
    AlertTriangle, Send, Loader2, X, RefreshCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { useFeedback } from '@/components/ui/feedback';
import { fetchTxHistory } from '@/services/bitcoin';
import { fetchEvmTxHistory } from '@/services/evm';
import { fetchZcashTxHistory } from '@/services/zcash';
import {
    createNspNotification,
    publishNspNotification,
    type NspChain,
    type NspPayload,
    type RelayPublishResult,
} from '@/services/nsp';

interface NspConfirmModalProps {
    recipientPubkey: string;
    address: string;
    chain: NspChain;
    asset: string;
    token: string | null;
    tweak: string;
    amount: string;
    onClose: () => void;
}

interface DetectedTx {
    txid: string;
    label: string;
}

export function NspConfirmModal({
    recipientPubkey, address, chain, asset, token, tweak, amount, onClose,
}: NspConfirmModalProps) {
    const { toast } = useFeedback();
    const [txid, setTxid] = useState('');
    const [sending, setSending] = useState(false);
    const [results, setResults] = useState<RelayPublishResult[]>([]);
    const [done, setDone] = useState(false);

    // Auto-detected txids
    const [detectedTxs, setDetectedTxs] = useState<DetectedTx[]>([]);
    const [loadingTxs, setLoadingTxs] = useState(false);

    const isBitcoin = chain === 'bitcoin';
    const isEvm = ['ethereum', 'bnb', 'polygon', 'avalanche', 'base'].includes(chain);
    const isZcash = chain === 'zcash';

    // Fetch txids for the address on mount
    const fetchTxids = async () => {
        setLoadingTxs(true);
        setDetectedTxs([]);
        try {
            if (isBitcoin) {
                const txs = await fetchTxHistory(address);
                setDetectedTxs(txs.map(tx => ({
                    txid: tx.txid,
                    label: `${tx.status.confirmed ? '✓' : '⏳'} ${tx.txid.slice(0, 12)}...${tx.txid.slice(-6)}`,
                })));
            } else if (isEvm) {
                const txs = await fetchEvmTxHistory(chain, address);
                setDetectedTxs(txs.map(tx => ({
                    txid: tx.hash,
                    label: `${tx.hash.slice(0, 12)}...${tx.hash.slice(-6)}`,
                })));
            } else if (isZcash) {
                const txs = await fetchZcashTxHistory(address);
                setDetectedTxs(txs.map(tx => ({
                    txid: tx.txid,
                    label: `${tx.confirmations > 0 ? '✓' : '⏳'} ${tx.txid.slice(0, 12)}...${tx.txid.slice(-6)}`,
                })));
            }
        } catch (e) {
            console.error('[NSP] Failed to fetch txids:', e);
        } finally {
            setLoadingTxs(false);
        }
    };

    useEffect(() => { fetchTxids(); }, [address, chain]);

    const handleSend = async () => {
        if (!txid.trim()) {
            toast('Please enter the transaction ID', 'error');
            return;
        }

        setSending(true);
        setResults([]);

        const payload: NspPayload = {
            address,
            chain,
            asset,
            token,
            tweak,
            txid: txid.trim(),
            amount: amount || '0',
            timestamp: Math.floor(Date.now() / 1000),
        };

        const { event } = createNspNotification(recipientPubkey, payload);

        const allResults = await publishNspNotification(
            event,
            recipientPubkey,
            (result) => setResults(prev => [...prev, result]),
        );

        const successCount = allResults.filter(r => r.success).length;
        if (successCount > 0) {
            toast(`Notification sent to ${successCount} relay${successCount > 1 ? 's' : ''}`, 'success');
        } else {
            toast('Failed to publish to any relay', 'error');
        }

        setDone(true);
        setSending(false);
    };

    const truncateAddr = (a: string) => a.length > 20 ? `${a.slice(0, 10)}...${a.slice(-8)}` : a;

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="flex min-h-full items-center justify-center px-4 py-20">
                <Card className="w-[380px] shadow-2xl">
                    <CardHeader className="flex-row items-center justify-between">
                        <CardTitle className="text-base flex items-center gap-2">
                            <Send className="w-4 h-4" /> Payment Notification
                        </CardTitle>
                        <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                            <X className="w-4 h-4" />
                        </button>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {/* Warning */}
                        <div className="flex items-start gap-2.5 p-3 rounded-xl bg-destructive/10 border border-destructive/20">
                            <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                            <p className="text-xs text-destructive leading-relaxed">
                                If you have sent payment to this address and <strong>do not notify the recipient</strong>,
                                the funds may be <strong>permanently lost</strong>. The recipient cannot discover the
                                address without this notification.
                            </p>
                        </div>

                        {/* Summary */}
                        <div className="space-y-2 text-xs">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Chain</span>
                                <span className="font-medium capitalize">{chain}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Address</span>
                                <span className="font-mono text-[11px]">{truncateAddr(address)}</span>
                            </div>
                            {amount && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Amount</span>
                                    <span className="font-medium">{amount}</span>
                                </div>
                            )}
                        </div>

                        {/* Transaction ID */}
                        <div className="space-y-1.5">
                            <label className="text-xs text-muted-foreground font-medium">Transaction ID</label>
                            <Input
                                value={txid}
                                onChange={e => setTxid(e.target.value)}
                                placeholder="Paste the blockchain tx hash..."
                                className="text-xs font-mono"
                                disabled={sending || done}
                            />
                        </div>

                        {/* Detected transactions */}
                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                                <label className="text-xs text-muted-foreground font-medium">Detected Transactions</label>
                                <button
                                    onClick={fetchTxids}
                                    disabled={loadingTxs}
                                    className="p-1 rounded-md hover:bg-accent transition-colors cursor-pointer"
                                >
                                    {loadingTxs
                                        ? <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                                        : <RefreshCw className="w-3 h-3 text-muted-foreground" />
                                    }
                                </button>
                            </div>
                            {loadingTxs ? (
                                <div className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground">
                                    <Loader2 className="w-3 h-3 animate-spin" /> Scanning address...
                                </div>
                            ) : detectedTxs.length === 0 ? (
                                <p className="text-[11px] text-muted-foreground py-1">No transactions found for this address yet.</p>
                            ) : (
                                <div className="max-h-28 overflow-y-auto space-y-1 rounded-lg border border-border p-1">
                                    {detectedTxs.map(tx => (
                                        <button
                                            key={tx.txid}
                                            onClick={() => setTxid(tx.txid)}
                                            disabled={sending || done}
                                            className={cn(
                                                "w-full text-left px-2.5 py-1.5 rounded-md text-[11px] font-mono transition-colors cursor-pointer",
                                                txid === tx.txid
                                                    ? "bg-primary/15 text-primary"
                                                    : "text-muted-foreground hover:bg-secondary"
                                            )}
                                        >
                                            {tx.label}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Relay publish progress */}
                        {results.length > 0 && (
                            <div className="space-y-1">
                                <label className="text-xs text-muted-foreground font-medium">Relay Status</label>
                                <div className="max-h-32 overflow-y-auto space-y-1">
                                    {results.map((r, i) => (
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
                            </div>
                        )}

                        {/* Buttons */}
                        <div className="flex gap-2">
                            <Button variant="outline" className="flex-1" onClick={onClose} disabled={sending}>
                                {done ? 'Close' : 'Cancel'}
                            </Button>
                            {!done && (
                                <Button className="flex-1 gap-1.5" onClick={handleSend} disabled={sending || !txid.trim()}>
                                    {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                                    Send Notification
                                </Button>
                            )}
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
