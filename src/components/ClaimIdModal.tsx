import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X, CheckCircle, Loader2, AlertCircle } from 'lucide-react';
import { dnnService, type PendingName } from '@/services/dnn';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type ClaimStep = 'intro' | 'publishing' | 'success' | 'error';

const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band'];

interface ClaimIdModalProps {
    pendingName: PendingName;
    activePubkey: string;
    onClose: () => void;
    onSuccess: () => void;
}

export function ClaimIdModal({ pendingName, activePubkey, onClose, onSuccess }: ClaimIdModalProps) {
    const [step, setStep] = useState<ClaimStep>('intro');
    const [progress, setProgress] = useState(0);
    const [statusText, setStatusText] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
    const [claimedDnnId, setClaimedDnnId] = useState('');

    const toCamelCase = (str: string) =>
        str ? str.replace(/-([a-z])/g, (_m, l) => l.toUpperCase()) : '';

    const publishToRelays = async (signedEvent: any): Promise<boolean> => {
        const publishPromises = DEFAULT_RELAYS.map(async (url) => {
            try {
                const ws = new WebSocket(url);
                return new Promise<boolean>((resolve) => {
                    const timeout = setTimeout(() => { ws.close(); resolve(false); }, 5000);

                    ws.onopen = () => {
                        ws.send(JSON.stringify(['EVENT', signedEvent]));
                    };

                    ws.onmessage = (msg) => {
                        try {
                            const data = JSON.parse(msg.data);
                            if (data[0] === 'OK' && data[1] === signedEvent.id) {
                                clearTimeout(timeout);
                                ws.close();
                                resolve(data[2] === true);
                            }
                        } catch { /* ignore */ }
                    };

                    ws.onerror = () => {
                        clearTimeout(timeout);
                        resolve(false);
                    };
                });
            } catch {
                return false;
            }
        });

        const results = await Promise.allSettled(publishPromises);
        const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
        return successCount > 0;
    };

    const handleClaim = async () => {
        setStep('publishing');
        setProgress(0);
        setStatusText('Preparing events...');

        try {
            // Get private key hex via Tauri
            const privateKeyHex = await invoke<string>('export_private_key_hex', { pubkey: activePubkey });
            if (!privateKeyHex) throw new Error('No private key available');

            const privateKeyBytes = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                privateKeyBytes[i] = parseInt(privateKeyHex.slice(i * 2, i * 2 + 2), 16);
            }
            const pubkeyHex = getPublicKey(privateKeyBytes);

            // Generate claim events
            const formatParts = (pendingName.format || '').split('-');
            const desiredName = formatParts.length > 1 ? formatParts[formatParts.length - 1] : pendingName.name || '';

            const { nameEvent, connectionEvent, metadataEvent, anchorEvent, dTags } =
                dnnService.generateClaimEvents(pubkeyHex, pendingName.txid, desiredName);

            // Step 1: Publish Name Event (61600)
            setProgress(10);
            setStatusText('Publishing Name Event (kind 61600)...');

            const signedNameEvent = finalizeEvent({
                ...nameEvent,
                pubkey: pubkeyHex
            }, privateKeyBytes);
            await publishToRelays(signedNameEvent);
            setProgress(25);

            // Step 2: Publish Connection Event (62600)
            setStatusText('Publishing Connection Event (kind 62600)...');

            const signedConnectionEvent = finalizeEvent({
                ...connectionEvent,
                pubkey: pubkeyHex
            }, privateKeyBytes);
            await publishToRelays(signedConnectionEvent);
            setProgress(50);

            // Step 3: Publish Metadata Event (63600)
            setStatusText('Publishing Metadata Event (kind 63600)...');

            const signedMetadataEvent = finalizeEvent({
                ...metadataEvent,
                pubkey: pubkeyHex
            }, privateKeyBytes);
            await publishToRelays(signedMetadataEvent);
            setProgress(75);

            // Step 4: Fill and publish Anchor Event (60600)
            setStatusText('Publishing Anchor Event (kind 60600)...');

            const filledAnchor = dnnService.fillAnchorEvent(anchorEvent, pubkeyHex, dTags, DEFAULT_RELAYS);
            const signedAnchorEvent = finalizeEvent({
                ...filledAnchor,
                pubkey: pubkeyHex
            }, privateKeyBytes);

            const anchorSuccess = await publishToRelays(signedAnchorEvent);
            if (!anchorSuccess) throw new Error('Failed to publish anchor event');

            setProgress(100);
            setClaimedDnnId(pendingName.format || `n${pendingName.dnnBlock}.${pendingName.position}`);
            setStatusText('Claim complete!');
            setStep('success');

        } catch (error) {
            console.error('[ClaimIdModal] Claim failed:', error);
            setErrorMessage(error instanceof Error ? error.message : 'Unknown error occurred');
            setStep('error');
        }
    };

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="flex min-h-full items-center justify-center px-4 py-20">
                <Card className="w-[380px] shadow-2xl">
                    {/* Intro Step */}
                    {step === 'intro' && (
                        <>
                            <CardHeader className="flex-row items-center justify-between">
                                <CardTitle className="text-base">Claim Your DNN ID</CardTitle>
                                <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                                    <X className="w-4 h-4" />
                                </button>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="bg-secondary/50 rounded-lg p-4">
                                    <p className="text-xs text-muted-foreground mb-1">Your DNN ID:</p>
                                    <p className="text-lg font-bold text-primary font-mono">
                                        {toCamelCase(pendingName.format || '')}
                                    </p>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        DNN Block: {pendingName.dnnBlock} • Position: {pendingName.position}
                                    </p>
                                </div>

                                <p className="text-sm text-muted-foreground leading-relaxed">
                                    To claim, we'll publish four Nostr events. The first three will have empty values,
                                    and the fourth will anchor your ID on-chain.
                                </p>

                                <div className="bg-primary/5 border border-primary/20 rounded-lg p-3">
                                    <p className="text-primary text-xs">
                                        <strong>Events:</strong> 61600 (Name), 62600 (Connection), 63600 (Metadata), 60600 (Anchor)
                                    </p>
                                </div>

                                <div className="flex gap-2 pt-2">
                                    <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
                                    <Button className="flex-1" onClick={handleClaim}>Claim</Button>
                                </div>
                            </CardContent>
                        </>
                    )}

                    {/* Publishing Step */}
                    {step === 'publishing' && (
                        <CardContent className="text-center py-8">
                            <Loader2 className="w-12 h-12 text-primary animate-spin mx-auto mb-6" />
                            <h3 className="text-lg font-bold text-foreground mb-2">Publishing Events...</h3>
                            <p className="text-sm text-muted-foreground mb-6">{statusText}</p>
                            <div className="bg-secondary rounded-full h-3 overflow-hidden mb-2">
                                <div
                                    className="bg-primary h-full transition-all duration-300"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                            <p className="text-xs text-muted-foreground">{progress}% complete</p>
                        </CardContent>
                    )}

                    {/* Success Step */}
                    {step === 'success' && (
                        <CardContent className="text-center py-6">
                            <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
                                <CheckCircle className="w-10 h-10 text-green-400" />
                            </div>
                            <h3 className="text-xl font-bold text-foreground mb-3">Congratulations!</h3>
                            <p className="text-muted-foreground mb-4">You have claimed the DNN ID:</p>
                            <div className="bg-secondary/50 rounded-lg p-4 border border-green-500/30 mb-6">
                                <p className="text-2xl font-bold text-primary font-mono">{toCamelCase(claimedDnnId)}</p>
                            </div>
                            <p className="text-xs text-muted-foreground mb-6 leading-relaxed">
                                You can now use this in your NIP-05 address field. DNN-supported clients will be able to
                                identify it and make full use of its benefits.
                            </p>
                            <Button className="w-full" onClick={onSuccess}>Close</Button>
                        </CardContent>
                    )}

                    {/* Error Step */}
                    {step === 'error' && (
                        <CardContent className="text-center py-6">
                            <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
                                <AlertCircle className="w-10 h-10 text-red-400" />
                            </div>
                            <h3 className="text-xl font-bold text-foreground mb-3">Claim Failed</h3>
                            <p className="text-sm text-muted-foreground mb-4">
                                {errorMessage || 'An error occurred while claiming your DNN ID.'}
                            </p>
                            <div className="flex gap-2">
                                <Button variant="outline" className="flex-1" onClick={onClose}>Close</Button>
                                <Button className="flex-1" onClick={() => setStep('intro')}>Try Again</Button>
                            </div>
                        </CardContent>
                    )}
                </Card>
            </div>
        </div>
    );
}
