/**
 * EcashSendModal — Send eCash (private token, NutZap, Lightning, multi-mint).
 * Port of PWANS EcashSendModal.tsx adapted for DENOS.
 */
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { X, ShieldCheck, Globe, Loader2, QrCode, Copy as CopyIcon, Check, Zap, Send, Users } from 'lucide-react';
import jsQR from 'jsqr';
import { useEcashStore } from '@/services/ecashStore';
import { CashuService } from '@/services/cashu';
import { LnurlService } from '@/services/lnurl';
import { nip19 } from 'nostr-tools';
import { invoke } from '@tauri-apps/api/core';
import { CustomSelect } from '@/components/ui/custom-select';
import { FollowsSelector } from '@/components/FollowsSelector';
import { decode } from '@gandlaf21/bolt11-decode';
import { cn } from '@/lib/utils';
import type { Proof } from '@cashu/cashu-ts';

interface EcashSendModalProps {
    isOpen: boolean;
    onClose: () => void;
    initialRecipient?: string;
    activePubkey?: string | null;
    hideFollowsSelector?: boolean;
    forcePublic?: boolean;
    onSendComplete?: () => void;
}

type InputType = 'npub' | 'lightning_invoice' | 'lightning_address' | 'unknown';

type MintSendItem = {
    mintUrl: string;
    amount: number;
    status: 'pending' | 'sending' | 'success' | 'failed';
};

export const EcashSendModal: React.FC<EcashSendModalProps> = ({
    isOpen,
    onClose,
    initialRecipient = '',
    activePubkey,
    hideFollowsSelector = false,
    forcePublic = false,
    onSendComplete
}) => {
    const [amount, setAmount] = useState('');
    const [recipient, setRecipient] = useState(initialRecipient);
    const [isPrivate, setIsPrivate] = useState(forcePublic ? false : false);
    const [loading, setLoading] = useState(false);
    const [generatedToken, setGeneratedToken] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [showScanner, setShowScanner] = useState(false);
    const [copied, setCopied] = useState(false);
    const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
    const [selectedCameraId, setSelectedCameraId] = useState<string>('');
    const videoRef = useRef<HTMLVideoElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [showFollowsSelector, setShowFollowsSelector] = useState(false);

    // Multi-mint state
    const [multiMintPlan, setMultiMintPlan] = useState<MintSendItem[] | null>(null);
    const [sendingProgress, setSendingProgress] = useState({ total: 0, sent: 0, failed: 0 });

    // Input type detection
    const [inputType, setInputType] = useState<InputType>('unknown');

    const { mints, proofs } = useEcashStore();

    const detectInputType = (input: string): InputType => {
        const trimmed = input.trim();
        if (trimmed.startsWith('npub')) return 'npub';
        const lower = trimmed.toLowerCase();
        if (lower.startsWith('lnbc') || lower.startsWith('lntb')) return 'lightning_invoice';
        if (LnurlService.isLightningAddress(trimmed)) return 'lightning_address';
        return 'unknown';
    };

    // Sync recipient with initialRecipient
    useEffect(() => {
        if (initialRecipient) setRecipient(initialRecipient);
    }, [initialRecipient]);

    // Update input type when recipient changes
    useEffect(() => {
        const type = detectInputType(recipient);
        setInputType(type);

        // Auto-fill amount from Lightning invoice
        if (type === 'lightning_invoice') {
            try {
                const decoded = decode(recipient.trim());
                if (decoded.sections) {
                    const amountSection = decoded.sections.find((s: any) => s.name === 'amount');
                    if (amountSection && amountSection.value) {
                        const sats = Math.floor(parseInt(amountSection.value) / 1000);
                        setAmount(sats.toString());
                    }
                }
            } catch (e) {
                console.error('Failed to decode invoice:', e);
            }
        }
    }, [recipient]);

    // Total balance
    const totalBalance = useMemo(() => proofs.reduce((s, p) => s + p.amount, 0), [proofs]);

    // Balance per mint
    const mintBalances = useMemo(() => {
        const balances = new Map<string, number>();
        proofs.forEach(proof => {
            const mintUrl = Object.keys(mints).find(m => {
                const mintKeys = (mints[m].keys as any);
                return (mintKeys.keysets && Array.isArray(mintKeys.keysets) &&
                    mintKeys.keysets.some((k: any) => k.id === proof.id)) ||
                    mintKeys[proof.id];
            });
            if (mintUrl) {
                balances.set(mintUrl, (balances.get(mintUrl) || 0) + proof.amount);
            }
        });
        return balances;
    }, [proofs, mints]);

    // Smart mint selection
    const availableMintUrl = useMemo(() => {
        const mintUrls = Object.keys(mints);
        if (mintUrls.length === 0) return undefined;

        const amountNum = parseInt(amount);
        if (!amount || isNaN(amountNum) || amountNum <= 0) {
            let maxMint = mintUrls[0];
            let maxBalance = mintBalances.get(maxMint) || 0;
            mintUrls.forEach(url => {
                const balance = mintBalances.get(url) || 0;
                if (balance > maxBalance) { maxBalance = balance; maxMint = url; }
            });
            return maxMint;
        }

        if (inputType === 'npub') {
            for (const url of mintUrls) {
                const balance = mintBalances.get(url) || 0;
                if (balance >= amountNum) return url;
            }
        }

        // For Lightning: pick mint with most balance
        let maxMint = mintUrls[0];
        let maxBalance = mintBalances.get(maxMint) || 0;
        mintUrls.forEach(url => {
            const balance = mintBalances.get(url) || 0;
            if (balance > maxBalance) { maxBalance = balance; maxMint = url; }
        });
        return maxMint;
    }, [mints, amount, inputType, mintBalances]);

    // Reset on close
    const wasOpenRef = useRef(false);
    useEffect(() => {
        if (wasOpenRef.current && !isOpen) {
            setGeneratedToken(null);
            setError(null);
            setAmount('');
            setRecipient('');
            setLoading(false);
            setMultiMintPlan(null);
        }
        wasOpenRef.current = isOpen;
    }, [isOpen]);

    // Multi-mint split calculator
    const calculateMultiMintSplit = (totalAmount: number): MintSendItem[] | null => {
        const splits: MintSendItem[] = [];
        let remaining = totalAmount;
        const sortedMints = Array.from(mintBalances.entries()).sort((a, b) => b[1] - a[1]);

        for (const [mintUrl, balance] of sortedMints) {
            if (remaining <= 0) break;
            const amountFromThisMint = Math.min(balance, remaining);
            if (amountFromThisMint > 0) {
                splits.push({ mintUrl, amount: amountFromThisMint, status: 'pending' });
                remaining -= amountFromThisMint;
            }
        }

        if (remaining > 0) return null;
        return splits.length > 1 ? splits : null;
    };

    const handlePayLightning = async () => {
        if (!availableMintUrl) { setError('No mints available'); return; }
        setLoading(true);
        setError(null);
        try {
            const result = await CashuService.meltTokens(availableMintUrl, recipient);
            useEcashStore.getState().addHistoryItem({
                id: Math.random().toString(36).substring(7),
                type: 'send', amount: result.quote.amount, mint: availableMintUrl,
                timestamp: Math.floor(Date.now() / 1000), isNutzap: false, memo: 'Lightning payment'
            });
            setGeneratedToken('paid');
            onSendComplete?.();
            setTimeout(onClose, 2000);
        } catch (e: any) {
            setError(e.message || 'Payment failed');
        } finally { setLoading(false); }
    };

    const handlePayLightningAddress = async () => {
        if (!availableMintUrl) { setError('No mints available'); return; }
        setLoading(true);
        setError(null);
        try {
            const sats = parseInt(amount);
            if (isNaN(sats) || sats <= 0) throw new Error('Invalid amount');
            const invoice = await LnurlService.resolveToInvoice(recipient, sats);
            const result = await CashuService.meltTokens(availableMintUrl, invoice);
            useEcashStore.getState().addHistoryItem({
                id: Math.random().toString(36).substring(7),
                type: 'send', amount: result.quote.amount, mint: availableMintUrl,
                timestamp: Math.floor(Date.now() / 1000), isNutzap: false,
                memo: `Lightning payment to ${recipient}`
            });
            setGeneratedToken('paid');
            onSendComplete?.();
            setTimeout(onClose, 2000);
        } catch (e: any) {
            setError(e.message || 'Payment failed');
        } finally { setLoading(false); }
    };

    // QR Scanner - File Upload
    const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            const result = e.target?.result as string;
            const image = new Image();
            image.src = result;
            image.onload = () => {
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                if (!context) return;
                canvas.width = image.width;
                canvas.height = image.height;
                context.drawImage(image, 0, 0);
                const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
                const code = jsQR(imageData.data, canvas.width, canvas.height);
                if (code) {
                    setRecipient(code.data);
                    setShowScanner(false);
                } else {
                    setError('No QR code found in image');
                }
            };
        };
        reader.readAsDataURL(file);
    };

    // QR Scanner - Camera
    useEffect(() => {
        if (!showScanner) return;
        let isActive = true;
        let activeStream: MediaStream | null = null;

        const initCamera = async () => {
            try {
                // Enumerate cameras
                const devices = await navigator.mediaDevices.enumerateDevices();
                const videoDevices = devices.filter(d => d.kind === 'videoinput');
                setCameras(videoDevices);

                // Pick camera: selected, or first environment-facing, or first available
                const constraints: MediaStreamConstraints = {
                    video: selectedCameraId
                        ? { deviceId: { exact: selectedCameraId } }
                        : { facingMode: 'environment' }
                };

                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                if (!isActive) { stream.getTracks().forEach(t => t.stop()); return; }
                activeStream = stream;

                // Set selectedCameraId to the actual device being used (for dropdown sync)
                const activeTrack = stream.getVideoTracks()[0];
                if (activeTrack && !selectedCameraId) {
                    const settings = activeTrack.getSettings();
                    if (settings.deviceId) setSelectedCameraId(settings.deviceId);
                }

                const video = videoRef.current;
                if (video) {
                    video.srcObject = stream;
                    video.setAttribute('playsinline', 'true');
                    video.onloadedmetadata = () => {
                        video.play().catch(() => { });
                        const scan = () => {
                            if (!showScanner || !isActive) {
                                stream.getTracks().forEach(t => t.stop());
                                return;
                            }
                            const canvas = document.createElement('canvas');
                            const ctx = canvas.getContext('2d', { willReadFrequently: true });
                            if (video.readyState === video.HAVE_ENOUGH_DATA && ctx) {
                                canvas.width = video.videoWidth;
                                canvas.height = video.videoHeight;
                                ctx.drawImage(video, 0, 0);
                                const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                                const code = jsQR(imgData.data, imgData.width, imgData.height);
                                if (code) {
                                    setRecipient(code.data);
                                    stream.getTracks().forEach(t => t.stop());
                                    setShowScanner(false);
                                    return;
                                }
                            }
                            requestAnimationFrame(scan);
                        };
                        requestAnimationFrame(scan);
                    };
                }
            } catch {
                setError('Failed to access camera');
                setShowScanner(false);
            }
        };

        initCamera();
        return () => {
            isActive = false;
            activeStream?.getTracks().forEach(t => t.stop());
        };
    }, [showScanner, selectedCameraId]);

    const handleSend = async () => {
        const sats = parseInt(amount);
        if (isNaN(sats) || sats <= 0) { setError('Invalid amount'); return; }

        const selectedMintBalance = availableMintUrl ? (mintBalances.get(availableMintUrl) || 0) : 0;
        const needsMultiMint = !availableMintUrl || selectedMintBalance < sats;

        if (needsMultiMint) {
            const split = calculateMultiMintSplit(sats);
            if (split) { setMultiMintPlan(split); return; }
            setError(`Insufficient balance. Need ${sats} sats, have ${totalBalance} sats`);
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const sendResult = await CashuService.sendToken(sats, availableMintUrl!, recipient, undefined, !isPrivate);

            let token: string;
            let usedProofs: Proof[] = [];
            if (typeof sendResult === 'string') {
                token = sendResult;
            } else {
                token = sendResult.token;
                usedProofs = sendResult.usedProofs;
            }

            if (isPrivate) {
                setGeneratedToken(token);
                useEcashStore.getState().addHistoryItem({
                    id: Math.random().toString(36).substring(7),
                    type: 'send', amount: sats, mint: availableMintUrl!,
                    timestamp: Math.floor(Date.now() / 1000), isNutzap: false, recipient, token
                });
                await useEcashStore.getState().publishProofsToNostr(true);
                onSendComplete?.();
            } else {
                // NutZap send
                if (!activePubkey) throw new Error('No active keypair');
                const privateKeyHex: string = await invoke('export_private_key_hex', { pubkey: activePubkey });

                let recipientHex = recipient;
                try {
                    const decoded = nip19.decode(recipient);
                    if (decoded.type === 'npub') recipientHex = decoded.data as string;
                } catch { /* use as-is */ }

                const { publishNutZapWithRetry } = await import('@/services/nutZapPublisher');
                const pendingSendId = `pending-${Date.now()}`;
                const proofSecrets = usedProofs.map(p => p.secret);

                useEcashStore.getState().addPendingSend({
                    id: pendingSendId, token, recipient: recipientHex, amount: sats,
                    mint: availableMintUrl!, timestamp: Math.floor(Date.now() / 1000),
                    attempts: 0, proofSecrets
                });

                const publishResult = await publishNutZapWithRetry(
                    token, availableMintUrl!, sats, recipientHex, privateKeyHex
                );

                if (!publishResult.success) {
                    useEcashStore.getState().updatePendingSendAttempt(pendingSendId, publishResult.error);
                    throw new Error(
                        `Failed to publish NutZap after 3 attempts: ${publishResult.error}\n\n` +
                        `Your proofs are protected in pending sends.`
                    );
                }

                useEcashStore.getState().removePendingSend(pendingSendId);

                useEcashStore.getState().addHistoryItem({
                    id: Math.random().toString(36).substring(7) + '-send',
                    type: 'send', amount: sats, mint: availableMintUrl!,
                    timestamp: Math.floor(Date.now() / 1000), isNutzap: true, recipient
                });

                await useEcashStore.getState().publishProofsToNostr(true);
                onSendComplete?.();
                onClose();
            }
        } catch (e: any) {
            setError(e.message || 'Send failed');
        } finally { setLoading(false); }
    };

    const executeMultiMintSend = async () => {
        if (!multiMintPlan) return;
        setLoading(true);
        setError(null);
        setSendingProgress({ total: multiMintPlan.length, sent: 0, failed: 0 });

        for (let i = 0; i < multiMintPlan.length; i++) {
            const { mintUrl, amount: mintAmount } = multiMintPlan[i];
            setMultiMintPlan(prev => prev!.map((item, idx) =>
                idx === i ? { ...item, status: 'sending' } : item
            ));

            try {
                const sendResult = await CashuService.sendToken(mintAmount, mintUrl, recipient, undefined, !isPrivate);
                let token: string;
                let usedProofs: Proof[] = [];
                if (typeof sendResult === 'string') token = sendResult;
                else { token = sendResult.token; usedProofs = sendResult.usedProofs; }

                if (!isPrivate && activePubkey) {
                    const privateKeyHex: string = await invoke('export_private_key_hex', { pubkey: activePubkey });
                    let recipientHex = recipient;
                    try { const d = nip19.decode(recipient); if (d.type === 'npub') recipientHex = d.data as string; } catch { }

                    const pendingSendId = `pending-multi-${Date.now()}-${i}`;
                    useEcashStore.getState().addPendingSend({
                        id: pendingSendId, token, recipient: recipientHex, amount: mintAmount,
                        mint: mintUrl, timestamp: Math.floor(Date.now() / 1000), attempts: 0,
                        proofSecrets: usedProofs.map(p => p.secret)
                    });

                    const { publishNutZapWithRetry } = await import('@/services/nutZapPublisher');
                    const publishResult = await publishNutZapWithRetry(token, mintUrl, mintAmount, recipientHex, privateKeyHex);
                    if (!publishResult.success) throw new Error(publishResult.error);

                    useEcashStore.getState().removePendingSend(pendingSendId);

                    useEcashStore.getState().addHistoryItem({
                        id: Math.random().toString(36).substring(7),
                        type: 'send', amount: mintAmount, mint: mintUrl,
                        timestamp: Math.floor(Date.now() / 1000), isNutzap: !isPrivate, recipient
                    });

                    await useEcashStore.getState().publishProofsToNostr(true);
                } else {
                    useEcashStore.getState().addHistoryItem({
                        id: Math.random().toString(36).substring(7),
                        type: 'send', amount: mintAmount, mint: mintUrl,
                        timestamp: Math.floor(Date.now() / 1000), isNutzap: false, recipient
                    });
                }

                setMultiMintPlan(prev => prev!.map((item, idx) =>
                    idx === i ? { ...item, status: 'success' } : item
                ));
                setSendingProgress(prev => ({ ...prev, sent: prev.sent + 1 }));
            } catch (e: any) {
                console.error(`Failed to send from ${mintUrl}:`, e);
                setMultiMintPlan(prev => prev!.map((item, idx) =>
                    idx === i ? { ...item, status: 'failed' } : item
                ));
                setSendingProgress(prev => ({ ...prev, failed: prev.failed + 1 }));
            }
        }
        setLoading(false);
        onSendComplete?.();
        setTimeout(onClose, 2000);
    };

    if (!isOpen) return null;

    // Success view
    if (generatedToken === 'paid') {
        return (
            <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                <div className="flex min-h-full items-center justify-center px-4 py-20">
                    <div className="bg-card border border-border rounded-2xl w-[400px] p-8 text-center shadow-2xl">
                        <div className="w-16 h-16 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
                            <Check className="w-8 h-8 text-green-500" />
                        </div>
                        <h3 className="text-xl font-bold text-foreground mb-2">Payment Sent!</h3>
                        <p className="text-muted-foreground">Lightning payment completed successfully.</p>
                    </div>
                </div>
            </div>
        );
    }

    if (generatedToken) {
        return (
            <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                <div className="flex min-h-full items-center justify-center px-4 py-20">
                    <div className="bg-card border border-border rounded-2xl w-[400px] shadow-2xl">
                        <div className="flex items-center justify-between p-4 border-b border-border">
                            <h3 className="text-lg font-bold text-foreground">Token Generated</h3>
                            <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-4 space-y-4">
                            <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-xl text-sm text-green-500">
                                Send this token to the recipient. They can claim it in their eCash wallet.
                            </div>
                            <textarea
                                readOnly
                                value={generatedToken}
                                className="w-full h-32 bg-background border border-border rounded-xl p-3 text-foreground text-xs font-mono resize-none"
                            />
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(generatedToken);
                                    setCopied(true);
                                    setTimeout(() => setCopied(false), 2000);
                                }}
                                className="w-full py-3 bg-primary hover:bg-primary/80 text-primary-foreground font-bold rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer"
                            >
                                {copied ? <Check className="w-4 h-4" /> : <CopyIcon className="w-4 h-4" />}
                                {copied ? 'Copied!' : 'Copy Token'}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // Multi-mint confirmation
    if (multiMintPlan) {
        return (
            <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                <div className="flex min-h-full items-center justify-center px-4 py-20">
                    <div className="bg-card border border-border rounded-2xl w-[400px] shadow-2xl">
                        <div className="flex items-center justify-between p-4 border-b border-border">
                            <h3 className="text-lg font-bold text-foreground">Multi-Mint Send</h3>
                            <button onClick={() => { setMultiMintPlan(null); setLoading(false); }} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-4 space-y-3">
                            <p className="text-sm text-muted-foreground">
                                No single mint has enough balance. Splitting across {multiMintPlan.length} mints:
                            </p>
                            {multiMintPlan.map((item, i) => (
                                <div key={i} className="flex items-center gap-3 p-3 bg-secondary/30 rounded-xl">
                                    <div className={cn(
                                        "w-2 h-2 rounded-full",
                                        item.status === 'success' ? "bg-green-500" :
                                            item.status === 'failed' ? "bg-red-500" :
                                                item.status === 'sending' ? "bg-yellow-500 animate-pulse" :
                                                    "bg-muted-foreground"
                                    )} />
                                    <span className="text-sm text-foreground flex-1 truncate">
                                        {item.mintUrl.replace('https://', '').replace(/\/$/, '')}
                                    </span>
                                    <span className="text-sm font-bold text-foreground">{item.amount} sats</span>
                                </div>
                            ))}
                            {!loading ? (
                                <button
                                    onClick={executeMultiMintSend}
                                    className="w-full py-3 bg-primary hover:bg-primary/80 text-primary-foreground font-bold rounded-xl transition-colors cursor-pointer"
                                >
                                    Confirm Multi-Mint Send
                                </button>
                            ) : (
                                <div className="text-center text-sm text-muted-foreground">
                                    Sending... {sendingProgress.sent}/{sendingProgress.total}
                                    {sendingProgress.failed > 0 && ` (${sendingProgress.failed} failed)`}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // Main send form
    return (
        <>
            <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                <div className="flex min-h-full items-center justify-center px-4 py-20">
                    <div className="bg-card border border-border rounded-2xl w-[400px] shadow-2xl">
                        {/* Header */}
                        <div className="flex items-center justify-between p-4 border-b border-border">
                            <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                                <Send className="w-5 h-5 text-primary" />
                                Send eCash
                            </h3>
                            <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-4 space-y-4">
                            {/* Balance info */}
                            <div className="flex items-center justify-between text-sm">
                                <span className="text-muted-foreground">Available</span>
                                <span className="text-foreground font-bold">{totalBalance.toLocaleString()} sats</span>
                            </div>

                            {/* Recipient input */}
                            <div>
                                <label className="text-xs text-muted-foreground font-medium mb-1 block">Recipient</label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={recipient}
                                        onChange={(e) => setRecipient(e.target.value)}
                                        placeholder="npub..., lnbc..., or user@domain.com"
                                        className="flex-1 bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-sm focus:ring-2 focus:ring-primary outline-none"
                                    />
                                    {!hideFollowsSelector && activePubkey && (
                                        <button
                                            onClick={() => setShowFollowsSelector(true)}
                                            className="px-3 py-2.5 bg-primary/10 hover:bg-primary/20 border border-primary/20 rounded-xl transition-colors cursor-pointer"
                                            title="Select from follows"
                                        >
                                            <Users className="w-4 h-4 text-primary" />
                                        </button>
                                    )}
                                    <button
                                        onClick={() => setShowScanner(true)}
                                        className="px-3 py-2.5 bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors cursor-pointer"
                                    >
                                        <QrCode className="w-4 h-4 text-muted-foreground" />
                                    </button>
                                </div>
                                {/* Input type indicator */}
                                {inputType !== 'unknown' && (
                                    <div className="mt-1.5 flex items-center gap-1.5">
                                        {inputType === 'npub' && <Globe className="w-3 h-3 text-primary" />}
                                        {inputType === 'lightning_invoice' && <Zap className="w-3 h-3 text-yellow-500" />}
                                        {inputType === 'lightning_address' && <Zap className="w-3 h-3 text-yellow-500" />}
                                        <span className="text-xs text-muted-foreground">
                                            {inputType === 'npub' ? 'Nostr pubkey — will send as NutZap or private token' :
                                                inputType === 'lightning_invoice' ? 'Lightning invoice detected' :
                                                    inputType === 'lightning_address' ? 'Lightning address detected' : ''}
                                        </span>
                                    </div>
                                )}
                            </div>

                            {/* Amount input (not needed for Lightning invoices that include amount) */}
                            <div>
                                <label className="text-xs text-muted-foreground font-medium mb-1 block">Amount (sats)</label>
                                <input
                                    type="number"
                                    value={amount}
                                    onChange={(e) => setAmount(e.target.value)}
                                    placeholder="Enter amount"
                                    className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-foreground text-sm focus:ring-2 focus:ring-primary outline-none"
                                    disabled={inputType === 'lightning_invoice' && !!amount}
                                />
                            </div>

                            {/* Private/Public toggle (only for npub recipients) */}
                            {inputType === 'npub' && !forcePublic && (
                                <div className="flex items-center gap-3 p-3 bg-secondary/30 rounded-xl">
                                    <button
                                        onClick={() => setIsPrivate(!isPrivate)}
                                        className={cn(
                                            "relative w-10 h-6 rounded-full transition-colors cursor-pointer",
                                            isPrivate ? "bg-primary" : "bg-muted-foreground/30"
                                        )}
                                    >
                                        <div className={cn(
                                            "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                                            isPrivate ? "left-5" : "left-1"
                                        )} />
                                    </button>
                                    <div className="flex-1">
                                        <div className="text-sm font-medium text-foreground flex items-center gap-1.5">
                                            {isPrivate ? <ShieldCheck className="w-3.5 h-3.5 text-primary" /> : <Globe className="w-3.5 h-3.5" />}
                                            {isPrivate ? 'Private Send' : 'NutZap (Public)'}
                                        </div>
                                        <div className="text-xs text-muted-foreground">
                                            {isPrivate
                                                ? 'Generate token to copy & share manually'
                                                : 'Publish NutZap event to Nostr relays'}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Send button */}
                            <button
                                onClick={
                                    inputType === 'lightning_invoice' ? handlePayLightning :
                                        inputType === 'lightning_address' ? handlePayLightningAddress :
                                            handleSend
                                }
                                disabled={loading || !amount || !recipient.trim()}
                                className="w-full py-3 bg-primary hover:bg-primary/80 disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground font-bold rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer"
                            >
                                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> :
                                    inputType === 'lightning_invoice' || inputType === 'lightning_address' ?
                                        <Zap className="w-4 h-4" /> : <Send className="w-4 h-4" />}
                                {loading ? 'Sending...' :
                                    inputType === 'lightning_invoice' ? 'Pay Invoice' :
                                        inputType === 'lightning_address' ? 'Pay Lightning Address' :
                                            isPrivate ? 'Generate Token' : 'Send NutZap'}
                            </button>

                            {/* Error */}
                            {error && (
                                <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive whitespace-pre-line">
                                    {error}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* QR Scanner Modal */}
                {showScanner && (
                    <div className="fixed inset-0 z-[60] bg-background flex flex-col items-center justify-center" id="qr-modal">
                        <div className="w-full max-w-sm px-4 space-y-6">
                            {/* Scanner header */}
                            <div className="text-center">
                                <h3 className="text-lg font-bold text-foreground mb-1">Scan QR Code</h3>
                                <p className="text-sm text-muted-foreground">Point the camera at a QR code</p>
                            </div>

                            {/* Camera viewfinder */}
                            <div className="relative w-full aspect-square rounded-2xl overflow-hidden border-2 border-white/20 shadow-2xl">
                                <video ref={videoRef} className="w-full h-full object-cover" autoPlay playsInline muted />
                                {/* Corner markers */}
                                <div className="absolute top-3 left-3 w-8 h-8 border-t-3 border-l-3 border-primary rounded-tl-lg" />
                                <div className="absolute top-3 right-3 w-8 h-8 border-t-3 border-r-3 border-primary rounded-tr-lg" />
                                <div className="absolute bottom-3 left-3 w-8 h-8 border-b-3 border-l-3 border-primary rounded-bl-lg" />
                                <div className="absolute bottom-3 right-3 w-8 h-8 border-b-3 border-r-3 border-primary rounded-br-lg" />
                                {/* Scanning indicator */}
                                <div className="absolute inset-x-6 top-1/2 -translate-y-1/2 h-0.5 bg-primary/60 animate-pulse" />
                            </div>

                            {/* Camera selector */}
                            {cameras.length > 1 && (
                                <CustomSelect
                                    value={selectedCameraId}
                                    onChange={setSelectedCameraId}
                                    options={cameras.map((cam, i) => ({
                                        value: cam.deviceId,
                                        label: cam.label || `Camera ${i + 1}`
                                    }))}
                                    variant="overlay"
                                />
                            )}

                            {/* Buttons */}
                            <div className="flex gap-3">
                                <button
                                    onClick={() => fileInputRef.current?.click()}
                                    className="flex-1 py-3 bg-secondary hover:bg-secondary/80 text-foreground font-medium rounded-xl transition-colors cursor-pointer flex items-center justify-center gap-2"
                                >
                                    <QrCode className="w-4 h-4" />
                                    Upload Image
                                </button>
                                <button
                                    onClick={() => setShowScanner(false)}
                                    className="flex-1 py-3 bg-destructive hover:bg-destructive/80 text-destructive-foreground font-medium rounded-xl transition-colors cursor-pointer flex items-center justify-center gap-2"
                                >
                                    <X className="w-4 h-4" />
                                    Cancel
                                </button>
                            </div>
                        </div>
                        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
                    </div>
                )}
            </div>

            {/* Follows Selector for eCash send */}
            {activePubkey && (
                <FollowsSelector
                    isOpen={showFollowsSelector}
                    onClose={() => setShowFollowsSelector(false)}
                    onSelect={(npub) => setRecipient(npub)}
                    activePubkey={activePubkey}
                    showTaprootAddress={false}
                />
            )}
        </>
    );
};
