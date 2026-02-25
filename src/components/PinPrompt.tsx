/**
 * PinPrompt — Small modal for re-entering PIN before sensitive operations.
 * Used for viewing nsec, seed words, etc.
 */
import React, { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Lock, X, Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PinPromptProps {
    isOpen: boolean;
    title?: string;
    description?: string;
    onSuccess: () => void;
    onCancel: () => void;
}

export const PinPrompt: React.FC<PinPromptProps> = ({
    isOpen,
    title = 'Enter PIN',
    description = 'Enter your PIN to continue',
    onSuccess,
    onCancel,
}) => {
    const [pin, setPin] = useState('');
    const [error, setError] = useState('');
    const [shake, setShake] = useState(false);
    const [showPin, setShowPin] = useState(false);
    const [loading, setLoading] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isOpen) {
            setPin('');
            setError('');
            setShake(false);
            setShowPin(false);
            setTimeout(() => inputRef.current?.focus(), 150);
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const handleVerify = async () => {
        if (pin.length !== 8) {
            setError('PIN must be 8 digits');
            setShake(true);
            setTimeout(() => setShake(false), 500);
            return;
        }
        setLoading(true);
        try {
            const valid = await invoke<boolean>('verify_pin', { pin });
            if (valid) {
                onSuccess();
            } else {
                setError('Incorrect PIN');
                setPin('');
                setShake(true);
                setTimeout(() => setShake(false), 500);
            }
        } catch (e) {
            setError(String(e));
        }
        setLoading(false);
    };

    return (
        <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm flex items-center justify-center animate-fade-in">
            <div className={cn(
                "bg-card border border-border rounded-2xl w-[340px] shadow-2xl",
                shake && "animate-shake"
            )}>
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                    <div className="flex items-center gap-2">
                        <Lock className="w-4 h-4 text-primary" />
                        <h3 className="text-sm font-semibold">{title}</h3>
                    </div>
                    <button
                        onClick={onCancel}
                        className="p-1 hover:bg-secondary rounded-lg transition-colors cursor-pointer"
                    >
                        <X className="w-4 h-4 text-muted-foreground" />
                    </button>
                </div>

                {/* Body */}
                <div className="p-4 space-y-3">
                    <p className="text-xs text-muted-foreground">{description}</p>

                    <div className="relative">
                        <input
                            ref={inputRef}
                            type={showPin ? 'text' : 'password'}
                            value={pin}
                            onChange={(e) => {
                                setPin(e.target.value.replace(/\D/g, '').slice(0, 8));
                                setError('');
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleVerify(); }}
                            placeholder="• • • • • • • •"
                            maxLength={8}
                            inputMode="numeric"
                            autoComplete="off"
                            className="w-full bg-secondary/50 border border-border rounded-xl px-3 pr-10 py-2.5 text-foreground text-center text-sm tracking-[0.2em] font-mono focus:ring-2 focus:ring-primary outline-none"
                        />
                        <button
                            onClick={() => setShowPin(!showPin)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                        >
                            {showPin ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </button>
                    </div>

                    {/* Digit dots */}
                    <div className="flex justify-center gap-1.5">
                        {Array.from({ length: 8 }).map((_, i) => (
                            <div
                                key={i}
                                className={cn(
                                    "w-1.5 h-1.5 rounded-full transition-colors",
                                    i < pin.length ? "bg-primary" : "bg-muted-foreground/20"
                                )}
                            />
                        ))}
                    </div>

                    {error && (
                        <p className="text-xs text-destructive text-center">{error}</p>
                    )}

                    <div className="flex gap-2 pt-1">
                        <button
                            onClick={onCancel}
                            className="flex-1 py-2 text-xs text-muted-foreground hover:text-foreground border border-border rounded-xl transition-colors cursor-pointer"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleVerify}
                            disabled={pin.length !== 8 || loading}
                            className={cn(
                                "flex-1 py-2 text-xs font-semibold rounded-xl transition-all cursor-pointer",
                                pin.length === 8 && !loading
                                    ? "bg-primary text-primary-foreground hover:bg-primary/80"
                                    : "bg-secondary text-muted-foreground cursor-not-allowed"
                            )}
                        >
                            {loading ? 'Verifying...' : 'Confirm'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
