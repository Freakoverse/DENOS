/**
 * EcashReceiveModal — Receive eCash via NutZap (npub QR) or Lightning invoice.
 * Port of PWANS EcashReceiveModal.tsx adapted for DENOS.
 */
import React, { useState, useEffect } from 'react';
import { X, ArrowDownLeft, Zap, Copy, Check, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useEcashStore } from '@/services/ecashStore';
import { CashuService } from '@/services/cashu';
import { cn } from '@/lib/utils';
import { CustomSelect } from '@/components/ui/custom-select';
import { nip19 } from 'nostr-tools';

interface EcashReceiveModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type ReceiveTab = 'token' | 'lightning';

export const EcashReceiveModal: React.FC<EcashReceiveModalProps> = ({ isOpen, onClose }) => {
    const [tab, setTab] = useState<ReceiveTab>('token');
    const [tokenInput, setTokenInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [showManualImport, setShowManualImport] = useState(false);
    const [npubCopied, setNpubCopied] = useState(false);

    // Lightning receive state
    const [selectedMint, setSelectedMint] = useState<string>('');
    const [lnAmount, setLnAmount] = useState('');
    const [invoice, setInvoice] = useState<string | null>(null);
    const [polling, setPolling] = useState(false);
    const [paymentSuccess, setPaymentSuccess] = useState(false);
    const [copied, setCopied] = useState(false);

    const { mints, activePubkey } = useEcashStore();
    const mintUrls = Object.keys(mints).filter(m => mints[m].active);

    // Derive npub from activePubkey
    const npub = activePubkey ? nip19.npubEncode(activePubkey) : '';
    const truncatedNpub = npub ? `${npub.slice(0, 12)}...${npub.slice(-6)}` : '';

    // Set default mint
    useEffect(() => {
        if (mintUrls.length > 0 && !selectedMint) {
            setSelectedMint(mintUrls[0]);
        }
    }, [mintUrls]);

    // Reset on close
    useEffect(() => {
        if (!isOpen) {
            setTokenInput('');
            setError(null);
            setSuccess(null);
            setInvoice(null);
            setPolling(false);
            setPaymentSuccess(false);
            setLnAmount('');
            setCopied(false);
            setShowManualImport(false);
            setNpubCopied(false);
        }
    }, [isOpen]);

    // Standalone poll function — captures values at call time (matches PWANS pattern)
    const pollForPayment = (mint: string, quoteId: string, amount: number) => {
        console.log(`⚡ Starting poll for payment: mint=${mint}, quoteId=${quoteId}, amount=${amount}`);
        const interval = setInterval(async () => {
            try {
                console.log(`⚡ Polling claimMintQuote...`);
                const proofs = await CashuService.claimMintQuote(mint, amount, quoteId);
                console.log(`⚡ claimMintQuote returned:`, proofs);
                if (proofs && proofs.length > 0) {
                    clearInterval(interval);
                    setPolling(false);
                    setPaymentSuccess(true);
                    setSuccess(`Received ${proofs.reduce((s: number, p: any) => s + p.amount, 0)} sats via Lightning!`);

                    useEcashStore.getState().addHistoryItem({
                        id: `ln-receive-${Date.now()}`,
                        type: 'receive',
                        amount,
                        mint,
                        timestamp: Math.floor(Date.now() / 1000),
                        isNutzap: false,
                        memo: 'Lightning receive'
                    });

                    setTimeout(onClose, 2000);
                }
            } catch (e: any) {
                // Log the actual error so we can debug
                console.warn(`⚡ Poll error (will retry):`, e?.message || e);
            }
        }, 3000);

        // Stop polling after 5 minutes
        setTimeout(() => {
            clearInterval(interval);
            setPolling(false);
        }, 300000);
    };

    const handleClaimToken = async () => {
        if (!tokenInput.trim()) return;
        setLoading(true);
        setError(null);
        setSuccess(null);

        try {
            const result = await CashuService.receiveToken(tokenInput.trim());
            setSuccess(`Received ${result.amount} sats from ${result.mint.replace('https://', '').split('/')[0]}`);

            useEcashStore.getState().addHistoryItem({
                id: `token-receive-${Date.now()}`,
                type: 'receive',
                amount: result.amount,
                mint: result.mint,
                timestamp: Math.floor(Date.now() / 1000),
                isNutzap: false,
                memo: 'Token claim'
            });

            setTokenInput('');
            setTimeout(onClose, 2000);
        } catch (e: any) {
            setError(e.message || 'Failed to claim token');
        } finally {
            setLoading(false);
        }
    };

    const copyNpub = () => {
        if (npub) {
            navigator.clipboard.writeText(npub);
            setNpubCopied(true);
            setTimeout(() => setNpubCopied(false), 2000);
        }
    };

    const handleCreateInvoice = async () => {
        const amount = parseInt(lnAmount);
        if (isNaN(amount) || amount <= 0 || !selectedMint) return;

        setLoading(true);
        setError(null);
        setPaymentSuccess(false);

        try {
            const quote = await CashuService.getMintQuote(selectedMint, amount);
            setInvoice(quote.request);
            setPolling(true);
            // Start polling with captured values
            pollForPayment(selectedMint, quote.quote, amount);
        } catch (e: any) {
            setError(e.message || 'Failed to create invoice');
        } finally {
            setLoading(false);
        }
    };

    const copyInvoice = () => {
        if (invoice) {
            navigator.clipboard.writeText(invoice);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="flex min-h-full items-center justify-center px-4 py-20">
                <div className="bg-card border border-border rounded-2xl w-[400px] shadow-2xl">
                    {/* Header */}
                    <div className="flex items-center justify-between p-4 border-b border-border">
                        <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                            <ArrowDownLeft className="w-5 h-5 text-green-500" />
                            Receive eCash
                        </h3>
                        <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Tabs */}
                    <div className="flex p-2 mx-4 mt-4 bg-secondary/50 rounded-xl">
                        <button
                            onClick={() => setTab('token')}
                            className={cn(
                                "flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors cursor-pointer",
                                tab === 'token' ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            NutZap
                        </button>
                        <button
                            onClick={() => setTab('lightning')}
                            className={cn(
                                "flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors cursor-pointer",
                                tab === 'lightning' ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <Zap className="w-3.5 h-3.5 inline mr-1" />
                            Lightning
                        </button>
                    </div>

                    <div className="p-4 space-y-4">
                        {tab === 'token' ? (
                            <>
                                {/* npub QR Code */}
                                {npub ? (
                                    <div className="flex flex-col items-center gap-3">
                                        <p className="text-xs text-muted-foreground text-center">
                                            Share your npub to receive NutZaps
                                        </p>
                                        <div className="bg-white p-4 rounded-2xl">
                                            <QRCodeSVG value={npub} size={180} />
                                        </div>
                                        <div className="flex items-center gap-2 bg-background border border-border rounded-xl px-3 py-2 w-full">
                                            <span className="text-sm font-mono text-muted-foreground truncate flex-1">
                                                {truncatedNpub}
                                            </span>
                                            <button
                                                onClick={copyNpub}
                                                className="p-1.5 hover:bg-secondary rounded-lg transition-colors cursor-pointer flex-shrink-0"
                                            >
                                                {npubCopied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4 text-muted-foreground" />}
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-sm text-yellow-500 text-center">
                                        No active identity. Select a keypair to receive NutZaps.
                                    </div>
                                )}

                                {/* Manual Import toggle */}
                                <button
                                    onClick={() => setShowManualImport(!showManualImport)}
                                    className="w-full flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                >
                                    {showManualImport ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                    Manual Import
                                </button>

                                {/* Collapsible token paste */}
                                {showManualImport && (
                                    <div className="space-y-3 animate-fade-in">
                                        <textarea
                                            value={tokenInput}
                                            onChange={(e) => setTokenInput(e.target.value)}
                                            placeholder="Paste cashuA... or cashuB... token"
                                            className="w-full h-28 bg-background border border-border rounded-xl p-3 text-foreground text-sm font-mono focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-all resize-none"
                                        />
                                        <button
                                            onClick={handleClaimToken}
                                            disabled={loading || !tokenInput.trim()}
                                            className="w-full py-3 bg-primary hover:bg-primary/80 disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground font-bold rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer"
                                        >
                                            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowDownLeft className="w-4 h-4" />}
                                            {loading ? 'Claiming...' : 'Claim Token'}
                                        </button>
                                    </div>
                                )}
                            </>
                        ) : (
                            <>
                                {!invoice ? (
                                    <>
                                        {/* Mint selector */}
                                        {mintUrls.length > 0 ? (
                                            <div>
                                                <label className="text-xs text-muted-foreground font-medium mb-1 block">Mint</label>
                                                <CustomSelect
                                                    value={selectedMint}
                                                    onChange={setSelectedMint}
                                                    options={mintUrls.map(url => ({
                                                        value: url,
                                                        label: url.replace('https://', '').replace(/\/$/, '')
                                                    }))}
                                                    placeholder="Select a mint"
                                                />
                                            </div>
                                        ) : (
                                            <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-xl text-sm text-yellow-500">
                                                No mints added yet. Add a mint first to receive via Lightning.
                                            </div>
                                        )}

                                        {/* Amount input */}
                                        <div>
                                            <label className="text-xs text-muted-foreground font-medium mb-1 block">Amount (sats)</label>
                                            <input
                                                type="number"
                                                value={lnAmount}
                                                onChange={(e) => setLnAmount(e.target.value)}
                                                placeholder="Enter amount in sats"
                                                className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-sm focus:ring-2 focus:ring-primary outline-none"
                                            />
                                        </div>

                                        <button
                                            onClick={handleCreateInvoice}
                                            disabled={loading || !lnAmount || !selectedMint}
                                            className="w-full py-3 bg-primary hover:bg-primary/80 disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground font-bold rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer"
                                        >
                                            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                                            {loading ? 'Creating...' : 'Create Invoice'}
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        {paymentSuccess ? (
                                            /* Payment success view */
                                            <div className="flex flex-col items-center gap-3 py-6">
                                                <div className="w-14 h-14 bg-green-500/10 rounded-full flex items-center justify-center ring-4 ring-green-500/20">
                                                    <Check className="w-7 h-7 text-green-500" />
                                                </div>
                                                <h4 className="text-lg font-bold text-foreground">Payment Received!</h4>
                                                <p className="text-sm text-muted-foreground">Successfully minted {lnAmount} sats.</p>
                                            </div>
                                        ) : (
                                            <>
                                                {/* QR + Invoice display */}
                                                <div className="flex flex-col items-center gap-4">
                                                    <div className="bg-white p-4 rounded-2xl">
                                                        <QRCodeSVG value={invoice} size={200} />
                                                    </div>

                                                    <div className="w-full">
                                                        <div className="flex items-center gap-2 bg-background border border-border rounded-xl p-3">
                                                            <span className="text-xs font-mono text-muted-foreground truncate flex-1">
                                                                {invoice.slice(0, 40)}...
                                                            </span>
                                                            <button
                                                                onClick={copyInvoice}
                                                                className="p-1.5 hover:bg-secondary rounded-lg transition-colors cursor-pointer"
                                                            >
                                                                {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4 text-muted-foreground" />}
                                                            </button>
                                                        </div>
                                                    </div>

                                                    {polling && (
                                                        <div className="flex items-center gap-2 text-sm text-muted-foreground animate-pulse">
                                                            <Loader2 className="w-4 h-4 animate-spin" />
                                                            Waiting for payment...
                                                        </div>
                                                    )}
                                                </div>
                                            </>
                                        )}
                                    </>
                                )}
                            </>
                        )}

                        {/* Status messages */}
                        {error && (
                            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
                                {error}
                            </div>
                        )}
                        {success && (
                            <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-sm text-green-500">
                                {success}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
