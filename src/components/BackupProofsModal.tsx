/**
 * BackupProofsModal — JSON export/import of eCash state.
 * Port of PWANS BackupProofsModal.tsx adapted for DENOS.
 */
import React, { useState } from 'react';
import { X, Download, Upload, AlertTriangle, Check, Loader2 } from 'lucide-react';
import { useEcashStore } from '@/services/ecashStore';
import { cn } from '@/lib/utils';

interface BackupProofsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export const BackupProofsModal: React.FC<BackupProofsModalProps> = ({ isOpen, onClose }) => {
    const { proofs, mints, history, activePubkey } = useEcashStore();
    const [tab, setTab] = useState<'export' | 'import'>('export');
    const [importJson, setImportJson] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const handleExport = () => {
        const backup = {
            version: 1,
            publicKey: activePubkey,
            timestamp: Date.now(),
            proofs,
            mints: Object.fromEntries(
                Object.entries(mints).map(([url, mint]) => [url, { url, active: mint.active }])
            ),
            history: history.slice(0, 500),
        };

        const json = JSON.stringify(backup, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `ecash-backup-${(activePubkey || 'unknown').slice(0, 8)}-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        setSuccess('Backup downloaded!');
        setTimeout(() => setSuccess(null), 3000);
    };

    const handleImport = async () => {
        if (!importJson.trim()) return;
        setLoading(true);
        setError(null);
        setSuccess(null);

        try {
            const parsed = JSON.parse(importJson.trim());

            if (!parsed.proofs || !Array.isArray(parsed.proofs)) {
                throw new Error('Invalid backup: missing proofs array');
            }

            // Merge proofs
            const existingSecrets = new Set(useEcashStore.getState().proofs.map(p => p.secret));
            const newProofs = parsed.proofs.filter((p: any) => !existingSecrets.has(p.secret));

            if (newProofs.length > 0) {
                useEcashStore.getState().addProofs(newProofs);
            }

            // Merge history
            if (parsed.history && Array.isArray(parsed.history)) {
                const existingIds = new Set(useEcashStore.getState().history.map(h => h.id));
                parsed.history.forEach((item: any) => {
                    if (!existingIds.has(item.id)) {
                        useEcashStore.getState().addHistoryItem(item);
                    }
                });
            }

            setSuccess(`Imported ${newProofs.length} new proofs`);
            setImportJson('');
        } catch (e: any) {
            setError(e.message || 'Failed to import backup');
        } finally {
            setLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="flex min-h-full items-center justify-center px-4 py-20">
                <div className="bg-card border border-border rounded-2xl w-[400px] shadow-2xl">
                    {/* Header */}
                    <div className="flex items-center justify-between p-4 border-b border-border">
                        <h3 className="text-lg font-bold text-foreground">Backup eCash</h3>
                        <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Tabs */}
                    <div className="flex p-2 mx-4 mt-3 bg-secondary/50 rounded-xl">
                        <button
                            onClick={() => setTab('export')}
                            className={cn(
                                "flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors cursor-pointer",
                                tab === 'export' ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <Download className="w-3.5 h-3.5 inline mr-1" />
                            Export
                        </button>
                        <button
                            onClick={() => setTab('import')}
                            className={cn(
                                "flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors cursor-pointer",
                                tab === 'import' ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <Upload className="w-3.5 h-3.5 inline mr-1" />
                            Import
                        </button>
                    </div>

                    <div className="p-4 space-y-4">
                        {tab === 'export' ? (
                            <>
                                <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-xs text-yellow-200/80 flex items-start gap-2">
                                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-yellow-500" />
                                    <span>
                                        The backup file contains <strong>spendable eCash tokens</strong>.
                                        Keep it secure — anyone with this file can spend your tokens.
                                    </span>
                                </div>

                                <div className="text-sm text-muted-foreground space-y-1">
                                    <div className="flex justify-between">
                                        <span>Proofs</span>
                                        <span className="font-medium text-foreground">{proofs.length}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span>Balance</span>
                                        <span className="font-medium text-foreground">
                                            {proofs.reduce((s, p) => s + p.amount, 0).toLocaleString()} sats
                                        </span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span>Mints</span>
                                        <span className="font-medium text-foreground">{Object.keys(mints).length}</span>
                                    </div>
                                    <div className="flex justify-between">
                                        <span>History</span>
                                        <span className="font-medium text-foreground">{history.length} items</span>
                                    </div>
                                </div>

                                <button
                                    onClick={handleExport}
                                    className="w-full py-3 bg-primary hover:bg-primary/80 text-primary-foreground font-bold rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer"
                                >
                                    <Download className="w-4 h-4" />
                                    Download Backup
                                </button>
                            </>
                        ) : (
                            <>
                                <textarea
                                    value={importJson}
                                    onChange={(e) => setImportJson(e.target.value)}
                                    placeholder="Paste backup JSON here..."
                                    className="w-full h-32 bg-background border border-border rounded-xl p-3 text-foreground text-xs font-mono resize-none focus:ring-2 focus:ring-primary outline-none"
                                />

                                <button
                                    onClick={handleImport}
                                    disabled={loading || !importJson.trim()}
                                    className="w-full py-3 bg-primary hover:bg-primary/80 disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground font-bold rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer"
                                >
                                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                                    {loading ? 'Importing...' : 'Import Backup'}
                                </button>
                            </>
                        )}

                        {error && (
                            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
                                {error}
                            </div>
                        )}
                        {success && (
                            <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-sm text-green-500 flex items-center gap-2">
                                <Check className="w-4 h-4" />
                                {success}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
