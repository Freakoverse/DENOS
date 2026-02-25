/**
 * CrossMintTransferModal — Transfer balance between mints via Lightning.
 * Port of PWANS CrossMintTransferModal.tsx adapted for DENOS.
 */
import React, { useState, useMemo } from 'react';
import { X, ArrowRight, Loader2, Check, Zap } from 'lucide-react';
import { useEcashStore } from '@/services/ecashStore';
import { CashuService } from '@/services/cashu';

interface CrossMintTransferModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export const CrossMintTransferModal: React.FC<CrossMintTransferModalProps> = ({ isOpen, onClose }) => {
    const { mints, proofs } = useEcashStore();
    const [sourceMint, setSourceMint] = useState('');
    const [destMint, setDestMint] = useState('');
    const [amount, setAmount] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    const mintUrls = Object.keys(mints);

    // Get balance per mint
    const mintBalances = useMemo(() => {
        const balances = new Map<string, number>();
        proofs.forEach(proof => {
            const mintUrl = Object.keys(mints).find(m => {
                const mintKeys = (mints[m].keys as any);
                return (mintKeys.keysets && Array.isArray(mintKeys.keysets) &&
                    mintKeys.keysets.some((k: any) => k.id === proof.id)) ||
                    mintKeys[proof.id];
            });
            if (mintUrl) balances.set(mintUrl, (balances.get(mintUrl) || 0) + proof.amount);
        });
        return balances;
    }, [proofs, mints]);

    const sourceBalance = sourceMint ? (mintBalances.get(sourceMint) || 0) : 0;

    const handleTransfer = async () => {
        const sats = parseInt(amount);
        if (isNaN(sats) || sats <= 0) { setError('Invalid amount'); return; }
        if (sats > sourceBalance) { setError('Insufficient balance at source mint'); return; }
        if (!sourceMint || !destMint) { setError('Select both mints'); return; }
        if (sourceMint === destMint) { setError('Source and destination must be different'); return; }

        setLoading(true);
        setError(null);
        try {
            await CashuService.transferBetweenMints(sourceMint, destMint, sats);
            setSuccess(true);

            useEcashStore.getState().addHistoryItem({
                id: `xmint-${Date.now()}`,
                type: 'send',
                amount: sats,
                mint: sourceMint,
                timestamp: Math.floor(Date.now() / 1000),
                isNutzap: false,
                memo: `Cross-mint transfer to ${destMint.replace('https://', '').split('/')[0]}`
            });

            setTimeout(() => { setSuccess(false); onClose(); }, 2000);
        } catch (e: any) {
            setError(e.message || 'Transfer failed');
        } finally {
            setLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[55] overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="flex min-h-full items-center justify-center px-4 py-20">
                <div className="bg-card border border-border rounded-2xl w-[400px] shadow-2xl">
                    {/* Header */}
                    <div className="flex items-center justify-between p-4 border-b border-border">
                        <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                            <Zap className="w-5 h-5 text-yellow-500" />
                            Cross-Mint Transfer
                        </h3>
                        <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    <div className="p-4 space-y-4">
                        {success ? (
                            <div className="text-center py-8">
                                <div className="w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                                    <Check className="w-8 h-8 text-green-500" />
                                </div>
                                <h4 className="text-lg font-bold text-foreground">Transfer Complete!</h4>
                                <p className="text-muted-foreground text-sm mt-1">{amount} sats transferred</p>
                            </div>
                        ) : (
                            <>
                                <p className="text-sm text-muted-foreground">
                                    Transfer eCash between mints via Lightning. A small fee may apply.
                                </p>

                                {/* Source mint */}
                                <div>
                                    <label className="text-xs text-muted-foreground font-medium mb-1 block">From Mint</label>
                                    <select
                                        value={sourceMint}
                                        onChange={(e) => setSourceMint(e.target.value)}
                                        className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-sm focus:ring-2 focus:ring-primary outline-none"
                                    >
                                        <option value="">Select source mint</option>
                                        {mintUrls.map(url => (
                                            <option key={url} value={url}>
                                                {url.replace('https://', '').replace(/\/$/, '')} ({mintBalances.get(url) || 0} sats)
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                {/* Arrow */}
                                <div className="flex justify-center">
                                    <ArrowRight className="w-5 h-5 text-muted-foreground rotate-90" />
                                </div>

                                {/* Destination mint */}
                                <div>
                                    <label className="text-xs text-muted-foreground font-medium mb-1 block">To Mint</label>
                                    <select
                                        value={destMint}
                                        onChange={(e) => setDestMint(e.target.value)}
                                        className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-sm focus:ring-2 focus:ring-primary outline-none"
                                    >
                                        <option value="">Select destination mint</option>
                                        {mintUrls.filter(u => u !== sourceMint).map(url => (
                                            <option key={url} value={url}>
                                                {url.replace('https://', '').replace(/\/$/, '')}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                {/* Amount */}
                                <div>
                                    <label className="text-xs text-muted-foreground font-medium mb-1 block">
                                        Amount (max: {sourceBalance.toLocaleString()} sats)
                                    </label>
                                    <input
                                        type="number"
                                        value={amount}
                                        onChange={(e) => setAmount(e.target.value)}
                                        placeholder="Enter amount in sats"
                                        className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-sm focus:ring-2 focus:ring-primary outline-none"
                                    />
                                </div>

                                <button
                                    onClick={handleTransfer}
                                    disabled={loading || !sourceMint || !destMint || !amount}
                                    className="w-full py-3 bg-primary hover:bg-primary/80 disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground font-bold rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer"
                                >
                                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                                    {loading ? 'Transferring...' : 'Transfer'}
                                </button>

                                {error && (
                                    <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
                                        {error}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
