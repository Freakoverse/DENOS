/**
 * PendingSendsModal — Manage and recover stuck NutZap sends.
 * Port of PWANS PendingSendsModal.tsx adapted for DENOS.
 */
import React, { useState } from 'react';
import { X, AlertTriangle, RefreshCw, Copy, Trash2, Loader2, Check } from 'lucide-react';
import { useEcashStore } from '@/services/ecashStore';
import { invoke } from '@tauri-apps/api/core';

interface PendingSendsModalProps {
    isOpen: boolean;
    onClose: () => void;
    activePubkey: string | null;
}

export const PendingSendsModal: React.FC<PendingSendsModalProps> = ({ isOpen, onClose, activePubkey }) => {
    const { pendingSends } = useEcashStore();
    const [retrying, setRetrying] = useState<string | null>(null);
    const [copiedId, setCopiedId] = useState<string | null>(null);

    const handleRetry = async (send: typeof pendingSends[0]) => {
        if (!activePubkey) return;
        setRetrying(send.id);

        try {
            const privateKeyHex: string = await invoke('export_private_key_hex', {
                pubkey: activePubkey
            });

            const { publishNutZapWithRetry } = await import('@/services/nutZapPublisher');

            const result = await publishNutZapWithRetry(
                send.token,
                send.mint,
                send.amount,
                send.recipient,
                privateKeyHex
            );

            if (result.success) {
                useEcashStore.getState().removePendingSend(send.id);
                useEcashStore.getState().addHistoryItem({
                    id: Math.random().toString(36).substring(7) + '-retry',
                    type: 'send',
                    amount: send.amount,
                    mint: send.mint,
                    timestamp: Math.floor(Date.now() / 1000),
                    isNutzap: true,
                    recipient: send.recipient
                });
                await useEcashStore.getState().publishProofsToNostr(true);
            } else {
                useEcashStore.getState().updatePendingSendAttempt(send.id, result.error);
            }
        } catch (e: any) {
            useEcashStore.getState().updatePendingSendAttempt(send.id, e.message);
        } finally {
            setRetrying(null);
        }
    };

    const handleCopyToken = (id: string, token: string) => {
        navigator.clipboard.writeText(token);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    const handleRemove = (id: string) => {
        if (confirm('Remove this pending send? The token proofs will NOT be recoverable unless you saved the token.')) {
            useEcashStore.getState().removePendingSend(id);
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
                            <AlertTriangle className="w-5 h-5 text-destructive" />
                            Pending Sends ({pendingSends.length})
                        </h3>
                        <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    <div className="p-4 space-y-3 overflow-y-auto flex-1">
                        {pendingSends.length === 0 ? (
                            <div className="p-6 text-center text-muted-foreground text-sm">
                                No pending sends. All NutZaps have been published successfully.
                            </div>
                        ) : (
                            <>
                                <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-xs text-yellow-200/80">
                                    These sends failed to publish. The tokens are locked to recipients.
                                    You can retry publishing, copy the token to send manually, or remove them.
                                </div>

                                {pendingSends.map(send => (
                                    <div key={send.id} className="bg-secondary/30 border border-destructive/20 rounded-xl p-3 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <span className="text-sm font-bold text-foreground">{send.amount} sats</span>
                                            <span className="text-xs text-muted-foreground">
                                                {new Date(send.timestamp * 1000).toLocaleDateString()}
                                            </span>
                                        </div>

                                        <div className="text-xs text-muted-foreground">
                                            to: {send.recipient.slice(0, 12)}...{send.recipient.slice(-8)}
                                        </div>
                                        <div className="text-xs text-muted-foreground truncate">
                                            mint: {send.mint.replace('https://', '')}
                                        </div>

                                        {send.lastError && (
                                            <div className="text-xs text-destructive bg-destructive/5 rounded-lg p-2">
                                                {send.lastError}
                                            </div>
                                        )}

                                        <div className="text-xs text-muted-foreground">
                                            Attempts: {send.attempts}
                                        </div>

                                        {/* Actions */}
                                        <div className="flex gap-2 pt-1">
                                            <button
                                                onClick={() => handleRetry(send)}
                                                disabled={retrying === send.id}
                                                className="flex-1 py-2 text-xs bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-lg transition-colors flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {retrying === send.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                                                Retry
                                            </button>
                                            <button
                                                onClick={() => handleCopyToken(send.id, send.token)}
                                                className="flex-1 py-2 text-xs bg-secondary/50 hover:bg-secondary text-muted-foreground hover:text-foreground border border-border/30 rounded-lg transition-colors flex items-center justify-center gap-1 cursor-pointer"
                                            >
                                                {copiedId === send.id ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
                                                {copiedId === send.id ? 'Copied!' : 'Copy Token'}
                                            </button>
                                            <button
                                                onClick={() => handleRemove(send.id)}
                                                className="py-2 px-3 text-xs text-destructive hover:bg-destructive/10 border border-destructive/20 rounded-lg transition-colors cursor-pointer"
                                            >
                                                <Trash2 className="w-3 h-3" />
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
