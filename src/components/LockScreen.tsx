/**
 * LockScreen — Full-screen PIN lock overlay with profile selection.
 *
 * Three modes:
 * 1. Setup mode (no profiles exist) — create first profile + PIN
 * 2. Unlock mode — select profile, enter PIN to unlock
 * 3. New-profile mode — create another profile from the lock screen
 *
 * Shows "Signer active" badge when NIP-46 is running while locked.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { Lock, Shield, Eye, EyeOff, Radio, UserPlus, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProfileListItem } from '@/App';

export interface LockScreenProps {
    pinSet: boolean;
    profiles: ProfileListItem[];
    lastProfileId: string | null;
    signerRunning?: boolean;
    onUnlock: () => void;
}

type Mode = 'unlock' | 'setup' | 'new-profile';

export const LockScreen: React.FC<LockScreenProps> = ({
    pinSet,
    profiles,
    lastProfileId,
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

    // Determine initial mode
    const hasProfiles = profiles.length > 0;
    const initialMode: Mode = hasProfiles ? 'unlock' : 'setup';

    const [mode, setMode] = useState<Mode>(initialMode);
    const [selectedProfileId, setSelectedProfileId] = useState<string>(
        lastProfileId || (profiles.length > 0 ? profiles[0].id : '')
    );
    const [dropdownOpen, setDropdownOpen] = useState(false);

    // Setup / new-profile state
    const [setupStep, setSetupStep] = useState<'create' | 'confirm'>('create');
    const [newPin, setNewPin] = useState('');
    const [confirmPin, setConfirmPin] = useState('');

    // Unlock state
    const [pin, setPin] = useState('');
    const [error, setError] = useState('');
    const [shake, setShake] = useState(false);
    const [showPin, setShowPin] = useState(false);
    const [loading, setLoading] = useState(false);

    const inputRef = useRef<HTMLInputElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Update selected profile when profiles change
    useEffect(() => {
        if (profiles.length > 0 && !selectedProfileId) {
            setSelectedProfileId(lastProfileId || profiles[0].id);
        }
    }, [profiles, lastProfileId, selectedProfileId]);

    useEffect(() => {
        setTimeout(() => inputRef.current?.focus(), 100);
    }, [setupStep, mode]);

    // Close dropdown on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const triggerShake = useCallback(() => {
        setShake(true);
        setTimeout(() => setShake(false), 500);
    }, []);

    const selectedProfile = profiles.find(p => p.id === selectedProfileId);

    // --- Setup / New Profile: Create PIN ---
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

    // --- Setup / New Profile: Confirm PIN ---
    const handleSetupConfirm = async () => {
        if (confirmPin !== newPin) {
            setError('PINs do not match');
            setConfirmPin('');
            triggerShake();
            return;
        }
        setLoading(true);
        try {
            if (mode === 'setup') {
                // First-time setup: create_profile creates profile + sets PIN
                await invoke('create_profile', { pin: newPin });
            } else {
                // new-profile mode
                await invoke('create_profile', { pin: newPin });
            }
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
            const valid = await invoke<boolean>('unlock_profile', {
                profileId: selectedProfileId,
                pin,
            });
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
            setPin('');
            setLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            if (mode === 'unlock') {
                handleUnlock();
            } else {
                if (setupStep === 'create') handleSetupCreate();
                else handleSetupConfirm();
            }
        }
    };

    const currentPin = mode === 'unlock'
        ? pin
        : (setupStep === 'create' ? newPin : confirmPin);

    const setCurrentPin = (val: string) => {
        const cleaned = val.replace(/\D/g, '').slice(0, 8);
        if (mode === 'unlock') {
            setPin(cleaned);
        } else {
            if (setupStep === 'create') setNewPin(cleaned);
            else setConfirmPin(cleaned);
        }
        setError('');
    };

    const switchToNewProfile = () => {
        setMode('new-profile');
        setSetupStep('create');
        setNewPin('');
        setConfirmPin('');
        setError('');
        setDropdownOpen(false);
    };

    const switchToUnlock = () => {
        setMode('unlock');
        setPin('');
        setError('');
    };

    const subtitle = mode === 'unlock'
        ? 'Enter your PIN to unlock'
        : (setupStep === 'create'
            ? (mode === 'setup' ? 'Create your 8-digit PIN' : 'Create PIN for new profile')
            : 'Confirm your PIN');

    return createPortal(
        <div className="fixed inset-0 z-[200] bg-background flex flex-col items-center justify-center select-none">
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
                    <p className="text-sm text-muted-foreground">{subtitle}</p>
                </div>

                {/* Profile Selector (unlock mode only, with multiple profiles) */}
                {mode === 'unlock' && profiles.length > 0 && (
                    <div className="w-72 relative" ref={dropdownRef}>
                        <button
                            onClick={() => setDropdownOpen(!dropdownOpen)}
                            className="w-full flex items-center justify-between px-4 py-2.5 bg-secondary/50 border border-border rounded-xl text-foreground text-sm hover:bg-secondary/80 transition-colors cursor-pointer"
                        >
                            <span className="truncate">
                                {selectedProfile?.name || 'Select profile'}
                            </span>
                            <ChevronDown className={cn(
                                "w-4 h-4 text-muted-foreground transition-transform",
                                dropdownOpen && "rotate-180"
                            )} />
                        </button>

                        {dropdownOpen && (
                            <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-xl shadow-lg overflow-hidden z-10">
                                {profiles.map(p => (
                                    <button
                                        key={p.id}
                                        onClick={() => {
                                            setSelectedProfileId(p.id);
                                            setDropdownOpen(false);
                                            setPin('');
                                            setError('');
                                        }}
                                        className={cn(
                                            "w-full text-left px-4 py-2.5 text-sm transition-colors cursor-pointer",
                                            p.id === selectedProfileId
                                                ? "bg-primary/10 text-primary font-medium"
                                                : "text-foreground hover:bg-secondary/50"
                                        )}
                                    >
                                        {p.name}
                                    </button>
                                ))}
                                {/* New Profile button at bottom of dropdown */}
                                <button
                                    onClick={switchToNewProfile}
                                    className="w-full text-left px-4 py-2.5 text-sm text-primary hover:bg-primary/10 transition-colors border-t border-border flex items-center gap-2 cursor-pointer"
                                >
                                    <UserPlus className="w-3.5 h-3.5" />
                                    New Profile
                                </button>
                            </div>
                        )}
                    </div>
                )}

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
                            if (mode === 'unlock') {
                                handleUnlock();
                            } else {
                                if (setupStep === 'create') handleSetupCreate();
                                else handleSetupConfirm();
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
                            mode === 'unlock'
                                ? 'Unlock'
                                : (setupStep === 'create' ? 'Set PIN' : 'Confirm & Create Profile')}
                    </button>

                    {/* Back button in confirm step */}
                    {(mode === 'setup' || mode === 'new-profile') && setupStep === 'confirm' && (
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

                    {/* Cancel new-profile creation */}
                    {mode === 'new-profile' && hasProfiles && (
                        <button
                            onClick={switchToUnlock}
                            className="w-full py-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                        >
                            ← Back to profile selection
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
