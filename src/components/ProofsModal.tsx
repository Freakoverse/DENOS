/**
 * ProofsModal — View proof breakdown per mint with consolidation and cross-mint transfer.
 * Port of PWANS ProofsModal.tsx adapted for DENOS.
 */
import React, { useState, useMemo } from 'react';
import { X, ArrowUpDown, Coins, Loader2 } from 'lucide-react';
import { useEcashStore } from '@/services/ecashStore';
import { CashuService } from '@/services/cashu';
import { CrossMintTransferModal } from './CrossMintTransferModal';

interface ProofsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export const ProofsModal: React.FC<ProofsModalProps> = ({ isOpen, onClose }) => {
    const { mints, proofs } = useEcashStore();
    const [consolidatingMint, setConsolidatingMint] = useState<string | null>(null);
    const [showTransfer, setShowTransfer] = useState(false);

    // Group proofs by mint
    const proofsByMint = useMemo(() => {
        const grouped: Record<string, typeof proofs> = {};
        proofs.forEach(proof => {
            // Try tagged mintUrl first
            if ((proof as any).mintUrl && mints[(proof as any).mintUrl]) {
                const key = (proof as any).mintUrl;
                if (!grouped[key]) grouped[key] = [];
                grouped[key].push(proof);
                return;
            }

            // Fallback: keyset ID matching
            const mintUrl = Object.keys(mints).find(m => {
                const mintKeys = (mints[m].keys as any);
                return (mintKeys.keysets && Array.isArray(mintKeys.keysets) &&
                    mintKeys.keysets.some((k: any) => k.id === proof.id)) ||
                    mintKeys[proof.id];
            });
            const key = mintUrl || 'unknown';
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(proof);
        });
        return grouped;
    }, [proofs, mints]);

    const handleConsolidate = async (mintUrl: string) => {
        const mintProofs = proofsByMint[mintUrl];
        if (!mintProofs || mintProofs.length <= 1) return;

        setConsolidatingMint(mintUrl);
        try {
            const consolidated = await CashuService.consolidateProofs(mintUrl, mintProofs);
            useEcashStore.getState().removeProofs(mintProofs, true);
            useEcashStore.getState().addProofs(consolidated, true, mintUrl);
            await useEcashStore.getState().publishProofsToNostr(true);
        } catch (e) {
            console.error('Consolidation failed:', e);
        } finally {
            setConsolidatingMint(null);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="flex min-h-full items-center justify-center px-4 py-20">
                <div className="bg-card border border-border rounded-2xl w-[420px] shadow-2xl max-h-[80vh] flex flex-col">
                    {/* Header */}
                    <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
                        <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                            <Coins className="w-5 h-5 text-primary" />
                            Proofs ({proofs.length})
                        </h3>
                        <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    <div className="p-4 space-y-3 overflow-y-auto flex-1">
                        {/* Summary */}
                        <div className="flex items-center justify-between text-sm mb-2">
                            <span className="text-muted-foreground">Total Balance</span>
                            <span className="text-foreground font-bold">
                                {proofs.reduce((s, p) => s + p.amount, 0).toLocaleString()} sats
                            </span>
                        </div>

                        {/* Cross-mint transfer button */}
                        {Object.keys(proofsByMint).length > 1 && (
                            <button
                                onClick={() => setShowTransfer(true)}
                                className="w-full py-2 bg-secondary/50 hover:bg-secondary border border-border/30 rounded-xl text-sm text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center gap-2 cursor-pointer"
                            >
                                <ArrowUpDown className="w-4 h-4" />
                                Cross-Mint Transfer
                            </button>
                        )}

                        {/* Per-mint breakdown */}
                        {Object.entries(proofsByMint).map(([mintUrl, mintProofs]) => {
                            const balance = mintProofs.reduce((s, p) => s + p.amount, 0);
                            const isConsolidating = consolidatingMint === mintUrl;

                            return (
                                <div key={mintUrl} className="bg-secondary/30 border border-border rounded-xl p-3 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium text-foreground truncate">
                                                {mintUrl === 'unknown'
                                                    ? 'Unknown Mint'
                                                    : mintUrl.replace('https://', '').replace(/\/$/, '')}
                                            </div>
                                            <div className="text-xs text-muted-foreground">
                                                {mintProofs.length} proofs · {balance.toLocaleString()} sats
                                            </div>
                                        </div>
                                        {mintProofs.length > 3 && mintUrl !== 'unknown' && (
                                            <button
                                                onClick={() => handleConsolidate(mintUrl)}
                                                disabled={isConsolidating}
                                                className="px-3 py-1.5 text-xs bg-primary/10 hover:bg-primary/20 border border-primary/20 text-primary rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                {isConsolidating ? (
                                                    <Loader2 className="w-3 h-3 animate-spin" />
                                                ) : (
                                                    'Consolidate'
                                                )}
                                            </button>
                                        )}
                                    </div>

                                    {/* Proof denomination breakdown */}
                                    <div className="flex flex-wrap gap-1.5">
                                        {Object.entries(
                                            mintProofs.reduce((acc, p) => {
                                                acc[p.amount] = (acc[p.amount] || 0) + 1;
                                                return acc;
                                            }, {} as Record<number, number>)
                                        )
                                            .sort(([a], [b]) => parseInt(b) - parseInt(a))
                                            .map(([denom, count]) => (
                                                <span key={denom} className="text-xs px-2 py-1 bg-background/50 rounded-md text-muted-foreground">
                                                    {denom} × {count}
                                                </span>
                                            ))}
                                    </div>
                                </div>
                            );
                        })}

                        {proofs.length === 0 && (
                            <div className="p-6 text-center text-muted-foreground text-sm">
                                No proofs in wallet.
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <CrossMintTransferModal
                isOpen={showTransfer}
                onClose={() => setShowTransfer(false)}
            />
        </div>
    );
};
