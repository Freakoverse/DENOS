import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useFeedback } from '@/components/ui/feedback';
import {
    Plus, Download, ShieldAlert, Copy, Check,
    X, FileDown, ArrowLeft,
} from 'lucide-react';

interface Props {
    onComplete: () => void;
}

export function Onboarding({ onComplete }: Props) {
    const [mode, setMode] = useState<'home' | 'generate' | 'import'>('home');
    const { toast } = useFeedback();

    if (mode === 'generate') {
        return <GenerateFlow onBack={() => setMode('home')} onComplete={onComplete} toast={toast} />;
    }
    if (mode === 'import') {
        return <ImportFlow onBack={() => setMode('home')} onComplete={onComplete} toast={toast} />;
    }

    // ── Home / Welcome ──
    return (
        <div className="flex flex-col items-center justify-center h-full gap-6 animate-fade-in px-4">
            <div className="flex flex-col items-center gap-4 mb-2">
                <h2 className="text-2xl font-bold text-foreground text-center">Welcome to DENOS</h2>
                <p className="text-base text-muted-foreground text-center max-w-xs">
                    Your decentralized Nostr signer. Create or import an account to get started.
                </p>
            </div>

            <div className="flex flex-col gap-3 w-full max-w-xs">
                <Button
                    onClick={() => setMode('generate')}
                    className="w-full h-12 text-base font-semibold gap-2 rounded-xl"
                >
                    <Plus className="w-5 h-5" />
                    Generate Account
                </Button>
                <Button
                    variant="outline"
                    onClick={() => setMode('import')}
                    className="w-full h-12 text-base font-semibold gap-2 rounded-xl"
                >
                    <Download className="w-5 h-5" />
                    Import Account
                </Button>
            </div>
        </div>
    );
}


// ─────────────────────────────────────────────
// Generate Flow
// ─────────────────────────────────────────────

function GenerateFlow({ onBack, onComplete, toast }: {
    onBack: () => void;
    onComplete: () => void;
    toast: (msg: string, type?: 'error' | 'success' | 'info') => void;
}) {
    const [mnemonic, setMnemonic] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [showExport, setShowExport] = useState(false);
    const [exportPassword, setExportPassword] = useState('');
    const [exportConfirmPassword, setExportConfirmPassword] = useState('');
    const [exportError, setExportError] = useState('');
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const generatedRef = useRef(false);

    // Auto-generate on mount (ref guard prevents StrictMode double-fire)
    useEffect(() => {
        if (generatedRef.current) return;
        generatedRef.current = true;
        (async () => {
            try {
                const result = await invoke<{ seed_id: string; mnemonic: string; first_pubkey: string }>(
                    'generate_seed', { name: undefined }
                );
                setMnemonic(result.mnemonic);
            } catch (e) {
                setError(String(e));
            }
            setLoading(false);
        })();
    }, []);

    const words = mnemonic.split(' ');

    const copyMnemonic = () => {
        navigator.clipboard.writeText(mnemonic);
        setCopiedId('mnemonic');
        toast('Seed phrase copied!', 'success');
        setTimeout(() => setCopiedId(null), 2000);
    };

    const exportEncrypted = async () => {
        setExportError('');
        if (!exportPassword) {
            setExportError('Password is required.');
            return;
        }
        if (exportPassword !== exportConfirmPassword) {
            setExportError('Passwords do not match.');
            return;
        }
        try {
            const enc = new TextEncoder();
            const keyMaterial = await crypto.subtle.importKey(
                'raw', enc.encode(exportPassword), 'PBKDF2', false, ['deriveKey']
            );
            const salt = crypto.getRandomValues(new Uint8Array(16));
            const key = await crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
                keyMaterial,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt']
            );
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ciphertext = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                key,
                enc.encode(mnemonic)
            );
            const payload = JSON.stringify({
                version: 1,
                alg: 'AES-256-GCM',
                kdf: 'PBKDF2-SHA256',
                iterations: 600000,
                salt: btoa(String.fromCharCode(...salt)),
                iv: btoa(String.fromCharCode(...iv)),
                ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
            });

            const blob = new Blob([payload], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'denos-seed-backup.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            toast('Seed backup exported!', 'success');
            setShowExport(false);
            setExportPassword('');
            setExportConfirmPassword('');
        } catch (e) {
            setExportError(String(e));
        }
    };

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-4 animate-fade-in">
                <div className="w-10 h-10 border-3 border-primary border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-muted-foreground">Generating your account…</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-4 animate-fade-in px-4">
                <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
                <Button variant="outline" onClick={onBack}>Go Back</Button>
            </div>
        );
    }

    return (
        <div className="space-y-4 animate-fade-in px-0 pb-[100px]">
            <button
                onClick={onBack}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
                <ArrowLeft className="w-4 h-4" /> Back
            </button>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <ShieldAlert className="w-5 h-5 text-warning" />
                        Your Seed Phrase
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <Alert variant="destructive">
                        <AlertDescription>
                            Write these words down and store them safely. Anyone with these words can access your keys.
                        </AlertDescription>
                    </Alert>

                    <div className="grid grid-cols-2 min-[480px]:grid-cols-3 gap-2">
                        {words.map((word, i) => (
                            <div
                                key={i}
                                className="flex items-center gap-2 p-2.5 bg-secondary rounded-lg"
                            >
                                <span className="text-xs text-muted-foreground w-5 text-right">{i + 1}.</span>
                                <span className="font-mono text-sm font-medium">{word}</span>
                            </div>
                        ))}
                    </div>

                    <div className="flex gap-2 flex-wrap">
                        <Button variant="outline" className="flex-1 gap-2" onClick={copyMnemonic}>
                            {copiedId === 'mnemonic'
                                ? <><Check className="w-4 h-4" /> Copied!</>
                                : <><Copy className="w-4 h-4" /> Copy</>
                            }
                        </Button>
                        <Button variant="outline" className="flex-1 gap-2" onClick={() => setShowExport(true)}>
                            <FileDown className="w-4 h-4" /> Export Backup
                        </Button>
                    </div>

                    <Button onClick={onComplete} className="w-full h-12 text-base font-semibold gap-2">
                        <Check className="w-5 h-5" /> Complete Setup
                    </Button>
                </CardContent>
            </Card>

            {/* Export encrypted modal */}
            {showExport && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in px-4">
                    <Card className="w-full max-w-sm">
                        <CardHeader className="flex flex-row items-center justify-between">
                            <CardTitle className="text-base">Encrypted Export</CardTitle>
                            <button onClick={() => { setShowExport(false); setExportPassword(''); setExportConfirmPassword(''); setExportError(''); }}
                                className="text-muted-foreground hover:text-foreground cursor-pointer">
                                <X className="w-4 h-4" />
                            </button>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <p className="text-sm text-muted-foreground">
                                Encrypt your seed with a password before exporting.
                            </p>
                            <div className="relative">
                                <Input
                                    type="password"
                                    placeholder="Password"
                                    value={exportPassword}
                                    onChange={e => setExportPassword(e.target.value)}
                                />
                            </div>
                            <div className="relative">
                                <Input
                                    type="password"
                                    placeholder="Confirm password"
                                    value={exportConfirmPassword}
                                    onChange={e => setExportConfirmPassword(e.target.value)}
                                />
                            </div>
                            {exportError && (
                                <p className="text-xs text-destructive">{exportError}</p>
                            )}
                            <Button onClick={exportEncrypted} className="w-full gap-2">
                                <FileDown className="w-4 h-4" /> Export
                            </Button>
                        </CardContent>
                    </Card>
                </div>
            )}
        </div>
    );
}


// ─────────────────────────────────────────────
// Import Flow
// ─────────────────────────────────────────────

function ImportFlow({ onBack, onComplete, toast }: {
    onBack: () => void;
    onComplete: () => void;
    toast: (msg: string, type?: 'error' | 'success' | 'info') => void;
}) {
    const [tab, setTab] = useState<'seed' | 'nsec'>('seed');
    const [seedWords, setSeedWords] = useState<string[]>(Array(24).fill(''));
    const [importNsec, setImportNsec] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleWordChange = (index: number, value: string) => {
        const words = value.trim().split(/\s+/);
        if (words.length > 1) {
            const newWords = [...seedWords];
            for (let i = 0; i < words.length && (index + i) < 24; i++) {
                newWords[index + i] = words[i].toLowerCase();
            }
            setSeedWords(newWords);
            return;
        }
        const newWords = [...seedWords];
        newWords[index] = value.toLowerCase();
        setSeedWords(newWords);
    };

    const importSeed = async () => {
        setLoading(true);
        setError('');
        const mnemonic = seedWords.map(w => w.trim().toLowerCase()).filter(Boolean).join(' ');
        try {
            await invoke('import_seed_phrase', { mnemonic, name: undefined });
            toast('Seed imported successfully!', 'success');
            onComplete();
        } catch (e) {
            setError(String(e));
        }
        setLoading(false);
    };

    const importNsecKey = async () => {
        setLoading(true);
        setError('');
        try {
            await invoke('import_nsec', { nsec: importNsec, name: undefined });
            toast('Key imported successfully!', 'success');
            onComplete();
        } catch (e) {
            setError(String(e));
        }
        setLoading(false);
    };

    const filledCount = seedWords.filter(w => w.trim()).length;

    return (
        <div className="space-y-4 animate-fade-in px-0 pb-[100px]">
            <button
                onClick={onBack}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
                <ArrowLeft className="w-4 h-4" /> Back
            </button>

            {/* Tab selector */}
            <div className="flex gap-1 p-1 bg-secondary rounded-xl">
                <button
                    onClick={() => setTab('seed')}
                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all cursor-pointer ${tab === 'seed'
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                        }`}
                >
                    Seed Phrase
                </button>
                <button
                    onClick={() => setTab('nsec')}
                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all cursor-pointer ${tab === 'nsec'
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                        }`}
                >
                    Import nsec
                </button>
            </div>

            {error && (
                <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}

            {tab === 'seed' ? (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Enter Seed Phrase</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <p className="text-sm text-muted-foreground">
                            Enter your 24-word recovery phrase. You can paste the entire phrase into the first field.
                        </p>
                        <div className="grid grid-cols-2 min-[480px]:grid-cols-3 gap-2">
                            {seedWords.map((word, i) => (
                                <div key={i} className="flex items-center gap-1.5">
                                    <span className="text-[10px] text-muted-foreground w-4 text-right shrink-0">{i + 1}</span>
                                    <Input
                                        value={word}
                                        onChange={e => handleWordChange(i, e.target.value)}
                                        className="h-8 text-xs px-2 font-mono"
                                        placeholder="·····"
                                        autoComplete="off"
                                        spellCheck={false}
                                    />
                                </div>
                            ))}
                        </div>
                        <Button
                            onClick={importSeed}
                            disabled={loading || filledCount < 12}
                            className="w-full h-12 text-base font-semibold gap-2"
                        >
                            {loading ? 'Importing…' : <><Download className="w-5 h-5" /> Import Seed</>}
                        </Button>
                    </CardContent>
                </Card>
            ) : (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Import Private Key</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <p className="text-sm text-muted-foreground">
                            Paste your nsec (Nostr private key) below.
                        </p>
                        <textarea
                            className="flex w-full rounded-lg border border-input bg-background px-4 py-3 text-base text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y min-h-16 font-mono"
                            placeholder="nsec1..."
                            value={importNsec}
                            onChange={(e) => setImportNsec(e.target.value)}
                            rows={2}
                        />
                        <Button
                            onClick={importNsecKey}
                            disabled={loading || !importNsec.trim()}
                            className="w-full h-12 text-base font-semibold gap-2"
                        >
                            {loading ? 'Importing…' : <><Download className="w-5 h-5" /> Import Key</>}
                        </Button>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
