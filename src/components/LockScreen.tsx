/**
 * LockScreen — Full-screen PIN lock overlay.
 *
 * Two modes:
 * 1. Setup mode (first launch, no PIN set) — create PIN + confirm
 * 2. Unlock mode — enter 8-digit PIN to unlock
 *
 * Shows "Signer active" badge when NIP-46 is running while locked.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { Lock, Shield, Eye, EyeOff, Radio } from 'lucide-react';
import { cn } from '@/lib/utils';

interface LockScreenProps {
    pinSet: boolean;
    signerRunning?: boolean;
    onUnlock: () => void;
}

export const LockScreen: React.FC<LockScreenProps> = ({
    pinSet,
    signerRunning = false,
    onUnlock,
}) => {
    const [isLight, setIsLight] = useState(() => document.documentElement.classList.contains('light'));
    const logoSrc = isLight ? '/denos-logo-reverse.png' : '/denos-logo.png';

    useEffect(() => {
        const observer = new MutationObserver(() => {
            setIsLight(document.documentElement.classList.contains('light'));
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);
    // Setup mode state
    const [setupStep, setSetupStep] = useState<'create' | 'confirm'>('create');
    const [newPin, setNewPin] = useState('');
    const [confirmPin, setConfirmPin] = useState('');

    // Unlock mode state
    const [pin, setPin] = useState('');
    const [error, setError] = useState('');
    const [shake, setShake] = useState(false);
    const [showPin, setShowPin] = useState(false);
    const [loading, setLoading] = useState(false);

    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        // Focus the input on mount
        setTimeout(() => inputRef.current?.focus(), 100);
    }, [setupStep, pinSet]);

    const triggerShake = useCallback(() => {
        setShake(true);
        setTimeout(() => setShake(false), 500);
    }, []);

    // --- Setup Mode ---
    const handleSetupCreate = () => {
        if (newPin.length !== 8) {
            setError('PIN must be exactly 8 digits');
            triggerShake();
            return;
        }
        if (!/^\d{8}$/.test(newPin)) {
            setError('PIN must contain only digits');
            triggerShake();
            return;
        }
        setError('');
        setSetupStep('confirm');
        setConfirmPin('');
    };

    const handleSetupConfirm = async () => {
        if (confirmPin !== newPin) {
            setError('PINs do not match');
            setConfirmPin('');
            triggerShake();
            return;
        }
        setLoading(true);
        try {
            await invoke('set_pin', { pin: newPin });
            onUnlock();
        } catch (e) {
            setError(String(e));
            setLoading(false);
        }
    };

    // --- Unlock Mode ---
    const handleUnlock = async () => {
        if (pin.length !== 8) {
            setError('PIN must be 8 digits');
            triggerShake();
            return;
        }
        setLoading(true);
        try {
            const valid = await invoke<boolean>('verify_pin', { pin });
            if (valid) {
                onUnlock();
            } else {
                setError('Incorrect PIN');
                setPin('');
                triggerShake();
                setLoading(false);
            }
        } catch (e) {
            setError(String(e));
            setLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            if (!pinSet) {
                if (setupStep === 'create') handleSetupCreate();
                else handleSetupConfirm();
            } else {
                handleUnlock();
            }
        }
    };

    const currentPin = !pinSet
        ? (setupStep === 'create' ? newPin : confirmPin)
        : pin;

    const setCurrentPin = (val: string) => {
        // Only allow digits, max 8
        const cleaned = val.replace(/\D/g, '').slice(0, 8);
        if (!pinSet) {
            if (setupStep === 'create') setNewPin(cleaned);
            else setConfirmPin(cleaned);
        } else {
            setPin(cleaned);
        }
        setError('');
    };

    return createPortal(
        <div className="fixed inset-0 z-[95] bg-background flex flex-col items-center justify-center select-none">
            {/* Background pattern */}
            <div className="absolute inset-0 opacity-[0.02]"
                style={{
                    backgroundImage: 'radial-gradient(circle at 2px 2px, currentColor 1px, transparent 0)',
                    backgroundSize: '32px 32px',
                }}
            />

            <div className={cn(
                "relative flex flex-col items-center gap-6 px-8",
                shake && "animate-shake"
            )}>
                {/* Logo */}
                <div className="flex flex-col items-center gap-3 mb-2">
                    <div className="w-20 h-20 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <img src={logoSrc} alt="DENOS" className="w-14 h-14 rounded-xl" />
                    </div>
                    <h1 className="text-2xl font-bold text-foreground">DENOS</h1>
                    <p className="text-sm text-muted-foreground">
                        {!pinSet
                            ? (setupStep === 'create' ? 'Create your 8-digit PIN' : 'Confirm your PIN')
                            : 'Enter your PIN to unlock'}
                    </p>
                </div>

                {/* PIN Input */}
                <div className="w-72 space-y-3">
                    <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <input
                            ref={inputRef}
                            type={showPin ? 'text' : 'password'}
                            value={currentPin}
                            onChange={(e) => setCurrentPin(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="• • • • • • • •"
                            maxLength={8}
                            inputMode="numeric"
                            autoComplete="off"
                            className="w-full bg-secondary/50 border border-border rounded-xl pl-10 pr-10 py-3 text-foreground text-center text-lg tracking-[0.3em] font-mono focus:ring-2 focus:ring-primary outline-none"
                        />
                        <button
                            onClick={() => setShowPin(!showPin)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                        >
                            {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                    </div>

                    {/* Digit count indicator */}
                    <div className="flex justify-center gap-1.5">
                        {Array.from({ length: 8 }).map((_, i) => (
                            <div
                                key={i}
                                className={cn(
                                    "w-2 h-2 rounded-full transition-colors",
                                    i < currentPin.length ? "bg-primary" : "bg-muted-foreground/20"
                                )}
                            />
                        ))}
                    </div>

                    {/* Error */}
                    {error && (
                        <p className="text-xs text-destructive text-center animate-fade-in">{error}</p>
                    )}

                    {/* Action button */}
                    <button
                        onClick={() => {
                            if (!pinSet) {
                                if (setupStep === 'create') handleSetupCreate();
                                else handleSetupConfirm();
                            } else {
                                handleUnlock();
                            }
                        }}
                        disabled={currentPin.length !== 8 || loading}
                        className={cn(
                            "w-full py-3 font-bold rounded-xl transition-all flex items-center justify-center gap-2 cursor-pointer text-sm",
                            currentPin.length === 8 && !loading
                                ? "bg-primary hover:bg-primary/80 text-primary-foreground"
                                : "bg-secondary text-muted-foreground/60 border border-border cursor-not-allowed"
                        )}
                    >
                        <Shield className="w-4 h-4" />
                        {loading ? 'Please wait...' :
                            !pinSet
                                ? (setupStep === 'create' ? 'Set PIN' : 'Confirm & Unlock')
                                : 'Unlock'}
                    </button>

                    {/* Back button in confirm step */}
                    {!pinSet && setupStep === 'confirm' && (
                        <button
                            onClick={() => {
                                setSetupStep('create');
                                setConfirmPin('');
                                setError('');
                            }}
                            className="w-full py-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                        >
                            ← Go back and change PIN
                        </button>
                    )}
                </div>
            </div>

            {/* Signer status indicator */}
            {signerRunning && (
                <div className="absolute bottom-6 flex items-center gap-2 text-xs text-muted-foreground">
                    <Radio className="w-3 h-3 text-green-500 animate-pulse" />
                    Signer is actively listening
                </div>
            )}
        </div>,
        document.body
    );
};
