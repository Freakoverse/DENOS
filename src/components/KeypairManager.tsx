import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AppState, Keypair } from '../App';
import {
    Plus, Download, Trash2, Copy, Eye, EyeOff, Check,
    ChevronRight, ArrowLeft, ShieldAlert, Key, Sprout,
    Pencil, KeyRound, Lock, FileDown, FileUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useFeedback } from '@/components/ui/feedback';
import { PinPrompt } from '@/components/PinPrompt';

interface Props {
    appState: AppState;
    onBack?: () => void;
}

type View =
    | { page: 'list' }
    | { page: 'seed-detail'; seedId: string }
    | { page: 'key-detail'; keypair: Keypair }
    | { page: 'generate-seed' }
    | { page: 'import-seed' }
    | { page: 'import-nsec' }
    | { page: 'show-mnemonic'; mnemonic: string; seedId: string };

function truncateMiddle(str: string, startLen = 12, endLen = 8): string {
    if (str.length <= startLen + endLen + 3) return str;
    return `${str.slice(0, startLen)}…${str.slice(-endLen)}`;
}

export function KeypairManager({ appState, onBack }: Props) {
    const [view, setView] = useState<View>({ page: 'list' });
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [showPrivateKey, setShowPrivateKey] = useState(false);
    const [privateKeyDisplay, setPrivateKeyDisplay] = useState('');
    const [nsecRevealed, setNsecRevealed] = useState(false);
    const [showSeedWords, setShowSeedWords] = useState(false);
    const [seedWordsDisplay, setSeedWordsDisplay] = useState('');
    const [seedWordsRevealed, setSeedWordsRevealed] = useState(false);

    // Form state
    const [seedName, setSeedName] = useState('');
    const [seedWords, setSeedWords] = useState<string[]>(Array(24).fill(''));
    const [importNsec, setImportNsec] = useState('');
    const [keypairName, setKeypairName] = useState('');
    const [editingName, setEditingName] = useState<string | null>(null);
    const [editNameValue, setEditNameValue] = useState('');
    const [showExportModal, setShowExportModal] = useState(false);
    const [exportPassword, setExportPassword] = useState('');
    const [exportConfirmPassword, setExportConfirmPassword] = useState('');
    const [exportError, setExportError] = useState('');
    const [showDecryptModal, setShowDecryptModal] = useState(false);
    const [decryptPassword, setDecryptPassword] = useState('');
    const [decryptError, setDecryptError] = useState('');
    const [decryptFileData, setDecryptFileData] = useState('');
    const { confirm: showConfirm, toast } = useFeedback();

    // PIN prompt for sensitive ops
    const [showPinPrompt, setShowPinPrompt] = useState(false);
    const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
    const [pinPromptTitle, setPinPromptTitle] = useState('Enter PIN');
    const [pinPromptDesc, setPinPromptDesc] = useState('Enter your PIN to continue');

    const requirePin = (title: string, desc: string, action: () => void) => {
        if (!appState.pin_set) {
            // No PIN set, just execute
            action();
            return;
        }
        setPinPromptTitle(title);
        setPinPromptDesc(desc);
        setPendingAction(() => action);
        setShowPinPrompt(true);
    };

    const pinPromptElement = (
        <PinPrompt
            isOpen={showPinPrompt}
            title={pinPromptTitle}
            description={pinPromptDesc}
            onSuccess={() => {
                setShowPinPrompt(false);
                if (pendingAction) {
                    pendingAction();
                    setPendingAction(null);
                }
            }}
            onCancel={() => {
                setShowPinPrompt(false);
                setPendingAction(null);
            }}
        />
    );

    const copyText = (text: string, id: string) => {
        navigator.clipboard.writeText(text);
        setCopiedId(id);
        toast('Copied!', 'success');
        setTimeout(() => setCopiedId(null), 2000);
    };

    const importedKeypairs = appState.keypairs.filter(kp => !kp.seed_id);
    const seeds = appState.seeds;

    // ── Actions ──

    const generateSeed = async () => {
        setLoading(true);
        setError('');
        try {
            const result = await invoke<{ seed_id: string; mnemonic: string; first_pubkey: string }>(
                'generate_seed', { name: seedName || undefined }
            );
            setSeedName('');
            setView({ page: 'show-mnemonic', mnemonic: result.mnemonic, seedId: result.seed_id });
        } catch (e) {
            setError(String(e));
        }
        setLoading(false);
    };

    const importSeedPhrase = async () => {
        setLoading(true);
        setError('');
        const mnemonic = seedWords.map(w => w.trim().toLowerCase()).filter(Boolean).join(' ');
        try {
            await invoke('import_seed_phrase', { mnemonic, name: seedName || undefined });
            setSeedWords(Array(24).fill(''));
            setSeedName('');
            setView({ page: 'list' });
        } catch (e) {
            setError(String(e));
        }
        setLoading(false);
    };

    const handleWordChange = (index: number, value: string) => {
        // If pasting multiple words into the first field
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

    const fillWordsFromMnemonic = (mnemonic: string) => {
        const words = mnemonic.trim().split(/\s+/);
        const newWords = Array(24).fill('');
        for (let i = 0; i < words.length && i < 24; i++) {
            newWords[i] = words[i].toLowerCase();
        }
        setSeedWords(newWords);
    };

    const handleFileImport = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                if (data.version && data.alg && data.ciphertext) {
                    // Encrypted backup — show decrypt modal
                    setDecryptFileData(text);
                    setDecryptPassword('');
                    setDecryptError('');
                    setShowDecryptModal(true);
                } else {
                    setError('Unrecognized file format.');
                }
            } catch {
                setError('Failed to read file.');
            }
        };
        input.click();
    };

    const decryptBackup = async () => {
        setDecryptError('');
        if (!decryptPassword) {
            setDecryptError('Password is required.');
            return;
        }
        try {
            const data = JSON.parse(decryptFileData);
            const enc = new TextEncoder();
            const salt = Uint8Array.from(atob(data.salt), c => c.charCodeAt(0));
            const iv = Uint8Array.from(atob(data.iv), c => c.charCodeAt(0));
            const ciphertext = Uint8Array.from(atob(data.ciphertext), c => c.charCodeAt(0));

            const keyMaterial = await crypto.subtle.importKey(
                'raw', enc.encode(decryptPassword), 'PBKDF2', false, ['deriveKey']
            );
            const key = await crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt, iterations: data.iterations || 600000, hash: 'SHA-256' },
                keyMaterial,
                { name: 'AES-GCM', length: 256 },
                false,
                ['decrypt']
            );
            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                key,
                ciphertext
            );
            const mnemonic = new TextDecoder().decode(decrypted);
            fillWordsFromMnemonic(mnemonic);
            setShowDecryptModal(false);
            setDecryptFileData('');
            toast('Seed phrase decrypted!', 'success');
        } catch {
            setDecryptError('Wrong password or corrupted file.');
        }
    };

    const importNsecKey = async () => {
        setLoading(true);
        setError('');
        try {
            await invoke('import_nsec', { nsec: importNsec, name: keypairName || undefined });
            setImportNsec('');
            setKeypairName('');
            setView({ page: 'list' });
        } catch (e) {
            setError(String(e));
        }
        setLoading(false);
    };

    const deriveNextKeypair = async (seedId: string) => {
        setLoading(true);
        setError('');
        try {
            await invoke('derive_next_keypair', { seedId });
        } catch (e) {
            setError(String(e));
        }
        setLoading(false);
    };

    const deleteSeed = async (seedId: string) => {
        const seed = seeds.find(s => s.id === seedId);
        requirePin('Delete Seed', 'Enter your PIN to delete this seed', () => {
            showConfirm({
                title: 'Delete Seed?',
                description: `This will delete "${seed?.name}" and all its derived keypairs. This cannot be undone.`,
                confirmLabel: 'Delete',
                variant: 'destructive',
                onConfirm: async () => {
                    try {
                        await invoke('delete_seed', { seedId });
                        setView({ page: 'list' });
                    } catch (e) {
                        setError(String(e));
                    }
                },
            });
        });
    };

    const deleteKeypair = async (pubkey: string) => {
        requirePin('Delete Keypair', 'Enter your PIN to delete this keypair', () => {
            showConfirm({
                title: 'Delete Keypair?',
                description: 'This cannot be undone. The keypair will be permanently removed.',
                confirmLabel: 'Delete',
                variant: 'destructive',
                onConfirm: async () => {
                    try {
                        await invoke('delete_keypair', { pubkey });
                        setView({ page: 'list' });
                    } catch (e) {
                        setError(String(e));
                    }
                },
            });
        });
    };

    const setActive = async (pubkey: string) => {
        try {
            await invoke('set_active_keypair', { pubkey });
        } catch (e) {
            setError(String(e));
        }
    };

    const viewPrivateKey = async (pubkey: string) => {
        requirePin('View Private Key', 'Enter your PIN to reveal the nsec', async () => {
            try {
                const nsec = await invoke<string>('export_nsec', { pubkey });
                setPrivateKeyDisplay(nsec);
                setShowPrivateKey(true);
            } catch (e) {
                setError(String(e));
            }
        });
    };

    const saveName = async (type: 'seed' | 'keypair', id: string) => {
        try {
            if (type === 'seed') {
                await invoke('rename_seed', { seedId: id, name: editNameValue });
            } else {
                await invoke('rename_keypair', { pubkey: id, name: editNameValue });
            }
            setEditingName(null);
        } catch (e) {
            setError(String(e));
        }
    };

    // ── Shared export function ──
    const exportEncrypted = async (mnemonic: string) => {
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

            // Download as file via blob URL
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
            setShowExportModal(false);
            setExportPassword('');
            setExportConfirmPassword('');
        } catch (e) {
            setExportError(String(e));
        }
    };

    // ── SHOW MNEMONIC PAGE ──
    if (view.page === 'show-mnemonic') {
        const words = view.mnemonic.split(' ');

        return (
            <div className="space-y-4 animate-fade-in pb-[100px]">
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <ShieldAlert className="w-5 h-5 text-warning" />
                            Backup Your Seed Phrase
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

                        <div className="flex gap-2">
                            <Button
                                variant="outline"
                                className="flex-1 gap-2"
                                onClick={() => copyText(view.mnemonic, 'mnemonic')}
                            >
                                {copiedId === 'mnemonic'
                                    ? <><Check className="w-4 h-4" /> Copied!</>
                                    : <><Copy className="w-4 h-4" /> Copy</>
                                }
                            </Button>
                            <Button
                                variant="outline"
                                className="flex-1 gap-2"
                                onClick={() => { setShowExportModal(true); setExportError(''); }}
                            >
                                <FileDown className="w-4 h-4" /> Export
                            </Button>
                        </div>

                        <Button
                            className="w-full"
                            onClick={() => setView({ page: 'list' })}
                        >
                            Done
                        </Button>
                    </CardContent>
                </Card>

                {/* Export password modal */}
                {showExportModal && (
                    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                        <div className="flex min-h-full items-center justify-center px-4 py-20">
                            <Card className="w-[340px] shadow-2xl">
                                <CardHeader>
                                    <CardTitle className="flex items-center gap-2 text-base">
                                        <Lock className="w-4 h-4" />
                                        Encrypt Backup
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <p className="text-xs text-muted-foreground">
                                        Choose a password to encrypt your seed backup file. You'll need this password to decrypt it later.
                                    </p>
                                    {exportError && (
                                        <Alert variant="destructive">
                                            <AlertDescription className="text-xs">{exportError}</AlertDescription>
                                        </Alert>
                                    )}
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-medium text-muted-foreground">Password</label>
                                        <Input
                                            type="password"
                                            value={exportPassword}
                                            onChange={e => setExportPassword(e.target.value)}
                                            placeholder="Enter password"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-medium text-muted-foreground">Confirm Password</label>
                                        <Input
                                            type="password"
                                            value={exportConfirmPassword}
                                            onChange={e => setExportConfirmPassword(e.target.value)}
                                            placeholder="Confirm password"
                                            onKeyDown={e => e.key === 'Enter' && exportEncrypted(view.mnemonic)}
                                        />
                                    </div>
                                    <div className="flex gap-2 pt-1">
                                        <Button
                                            variant="outline"
                                            className="flex-1"
                                            onClick={() => { setShowExportModal(false); setExportPassword(''); setExportConfirmPassword(''); }}
                                        >
                                            Cancel
                                        </Button>
                                        <Button
                                            className="flex-1 gap-1.5"
                                            onClick={() => exportEncrypted(view.mnemonic)}
                                            disabled={!exportPassword}
                                        >
                                            <FileDown className="w-4 h-4" /> Export
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // ── GENERATE SEED PAGE ──
    if (view.page === 'generate-seed') {
        return (
            <div className="flex flex-col h-[calc(100vh-115px)] animate-fade-in">
                <div className="flex items-center gap-3 shrink-0 pb-3">
                    <button
                        onClick={() => setView({ page: 'list' })}
                        className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors"
                    >
                        <ArrowLeft className="w-4.5 h-4.5 text-muted-foreground" />
                    </button>
                    <h2 className="text-base font-semibold">Generate Seed</h2>
                </div>
                <div className="flex-1 overflow-y-auto space-y-4 pb-[100px]">

                    <Card>
                        <CardHeader>
                            <CardTitle>Generate New Seed</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {error && (
                                <Alert variant="destructive">
                                    <AlertDescription>{error}</AlertDescription>
                                </Alert>
                            )}
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-muted-foreground">Seed Name (optional)</label>
                                <Input
                                    placeholder="My Seed"
                                    value={seedName}
                                    onChange={(e) => setSeedName(e.target.value)}
                                />
                            </div>
                            <p className="text-xs text-muted-foreground">
                                A new 24-word BIP-39 seed phrase will be generated. The first keypair will be derived automatically using NIP-06.
                            </p>
                            <Button onClick={generateSeed} disabled={loading} className="w-full gap-2">
                                <Sprout className="w-4 h-4" />
                                Generate Seed
                            </Button>
                        </CardContent>
                    </Card>
                </div>
            </div>
        );
    }

    // ── IMPORT SEED PAGE ──
    if (view.page === 'import-seed') {
        const filledCount = seedWords.filter(w => w.trim()).length;
        return (
            <div className="flex flex-col h-[calc(100vh-115px)] animate-fade-in">
                <div className="flex items-center gap-3 shrink-0 pb-3">
                    <button
                        onClick={() => { setView({ page: 'list' }); setSeedWords(Array(24).fill('')); }}
                        className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors"
                    >
                        <ArrowLeft className="w-4.5 h-4.5 text-muted-foreground" />
                    </button>
                    <h2 className="text-base font-semibold">Import Seed</h2>
                </div>
                <div className="flex-1 overflow-y-auto space-y-4 pb-[100px]">

                    <Card>
                        <CardHeader>
                            <CardTitle>Import Seed Phrase</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {error && (
                                <Alert variant="destructive">
                                    <AlertDescription>{error}</AlertDescription>
                                </Alert>
                            )}
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-muted-foreground">Seed Name (optional)</label>
                                <Input
                                    placeholder="Imported Seed"
                                    value={seedName}
                                    onChange={(e) => setSeedName(e.target.value)}
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-sm font-medium text-muted-foreground">Seed Words</label>
                                <div className="grid grid-cols-2 min-[480px]:grid-cols-3 gap-1.5">
                                    {seedWords.map((word, i) => (
                                        <div key={i} className="flex items-center gap-1.5">
                                            <span className="text-[10px] text-muted-foreground w-5 text-right shrink-0">{i + 1}.</span>
                                            <Input
                                                value={word}
                                                onChange={e => handleWordChange(i, e.target.value)}
                                                onPaste={e => {
                                                    const pasted = e.clipboardData.getData('text').trim();
                                                    if (pasted.split(/\s+/).length > 1) {
                                                        e.preventDefault();
                                                        handleWordChange(i, pasted);
                                                    }
                                                }}
                                                className="h-8 text-xs font-mono px-2"
                                                placeholder={`word ${i + 1}`}
                                                autoComplete="off"
                                                spellCheck={false}
                                            />
                                        </div>
                                    ))}
                                </div>
                                <p className="text-[10px] text-muted-foreground">Paste all words into the first field to auto-fill.</p>
                            </div>

                            <div className="flex gap-2">
                                <Button
                                    variant="outline"
                                    className="flex-1 gap-2"
                                    onClick={handleFileImport}
                                >
                                    <FileUp className="w-4 h-4" /> Import from File
                                </Button>
                            </div>

                            <Button
                                onClick={importSeedPhrase}
                                disabled={loading || filledCount < 12}
                                className="w-full gap-2"
                            >
                                <Download className="w-4 h-4" />
                                Import Seed ({filledCount} words)
                            </Button>
                        </CardContent>
                    </Card>

                    {/* Decrypt file modal */}
                    {showDecryptModal && (
                        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                            <div className="flex min-h-full items-center justify-center px-4 py-20">
                                <Card className="w-[340px] shadow-2xl">
                                    <CardHeader>
                                        <CardTitle className="flex items-center gap-2 text-base">
                                            <Lock className="w-4 h-4" />
                                            Decrypt Backup
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="space-y-3">
                                        <p className="text-xs text-muted-foreground">
                                            This backup file is encrypted. Enter the password used when exporting.
                                        </p>
                                        {decryptError && (
                                            <Alert variant="destructive">
                                                <AlertDescription className="text-xs">{decryptError}</AlertDescription>
                                            </Alert>
                                        )}
                                        <div className="space-y-1.5">
                                            <label className="text-xs font-medium text-muted-foreground">Password</label>
                                            <Input
                                                type="password"
                                                value={decryptPassword}
                                                onChange={e => setDecryptPassword(e.target.value)}
                                                placeholder="Enter password"
                                                onKeyDown={e => e.key === 'Enter' && decryptBackup()}
                                                autoFocus
                                            />
                                        </div>
                                        <div className="flex gap-2 pt-1">
                                            <Button
                                                variant="outline"
                                                className="flex-1"
                                                onClick={() => { setShowDecryptModal(false); setDecryptFileData(''); }}
                                            >
                                                Cancel
                                            </Button>
                                            <Button
                                                className="flex-1 gap-1.5"
                                                onClick={decryptBackup}
                                                disabled={!decryptPassword}
                                            >
                                                <Lock className="w-4 h-4" /> Decrypt
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // ── IMPORT NSEC PAGE ──
    if (view.page === 'import-nsec') {
        return (
            <div className="flex flex-col h-[calc(100vh-115px)] animate-fade-in">
                <div className="flex items-center gap-3 shrink-0 pb-3">
                    <button
                        onClick={() => setView({ page: 'list' })}
                        className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors"
                    >
                        <ArrowLeft className="w-4.5 h-4.5 text-muted-foreground" />
                    </button>
                    <h2 className="text-base font-semibold">Import Private Key</h2>
                </div>
                <div className="flex-1 overflow-y-auto space-y-4 pb-[100px]">

                    <Card>
                        <CardHeader>
                            <CardTitle>Import Private Key</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {error && (
                                <Alert variant="destructive">
                                    <AlertDescription>{error}</AlertDescription>
                                </Alert>
                            )}
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-muted-foreground">Name (optional)</label>
                                <Input
                                    placeholder="My Key"
                                    value={keypairName}
                                    onChange={(e) => setKeypairName(e.target.value)}
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-muted-foreground">Private Key (nsec...)</label>
                                <textarea
                                    className="flex w-full rounded-lg border border-input bg-background px-4 py-3 text-base text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y min-h-16"
                                    placeholder="nsec1..."
                                    value={importNsec}
                                    onChange={(e) => setImportNsec(e.target.value)}
                                    rows={1}
                                />
                            </div>
                            <Button onClick={importNsecKey} disabled={loading || !importNsec.trim()} className="w-full gap-2">
                                <Download className="w-4 h-4" />
                                Import Key
                            </Button>
                        </CardContent>
                    </Card>
                </div>
            </div>
        );
    }

    // ── KEY DETAIL PAGE ──
    if (view.page === 'key-detail') {
        const kp = view.keypair;
        // Refresh keypair from state in case it was updated
        const fresh = appState.keypairs.find(k => k.pubkey === kp.pubkey);
        if (!fresh) {
            setView({ page: 'list' });
            return null;
        }
        const isActive = fresh.pubkey === appState.active_keypair;
        const parentSeed = fresh.seed_id ? seeds.find(s => s.id === fresh.seed_id) : null;

        return (
            <>
                <div className="flex flex-col h-[calc(100vh-115px)] animate-fade-in">
                    <div className="flex items-center gap-3 shrink-0 pb-3">
                        <button
                            onClick={() => {
                                setShowPrivateKey(false);
                                setPrivateKeyDisplay('');
                                setNsecRevealed(false);
                                if (parentSeed) {
                                    setView({ page: 'seed-detail', seedId: parentSeed.id });
                                } else {
                                    setView({ page: 'list' });
                                }
                            }}
                            className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors"
                        >
                            <ArrowLeft className="w-4.5 h-4.5 text-muted-foreground" />
                        </button>
                        <h2 className="text-base font-semibold">{fresh.name || 'Key Detail'}</h2>
                    </div>
                    <div className="flex-1 overflow-y-auto space-y-4 pb-[100px]">

                        <Card>
                            <CardContent className="pt-5 space-y-5">
                                {/* Name + active badge */}
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                                            <Key className="w-5 h-5 text-primary" />
                                        </div>
                                        <div>
                                            {editingName === fresh.pubkey ? (
                                                <div className="flex items-center gap-1">
                                                    <Input
                                                        value={editNameValue}
                                                        onChange={e => setEditNameValue(e.target.value)}
                                                        className="h-7 text-sm w-36"
                                                        onKeyDown={e => e.key === 'Enter' && saveName('keypair', fresh.pubkey)}
                                                        autoFocus
                                                    />
                                                    <Button size="xs" onClick={() => saveName('keypair', fresh.pubkey)}>
                                                        <Check className="w-3 h-3" />
                                                    </Button>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-1">
                                                    <h3 className="text-lg font-bold">{fresh.name || 'Unnamed Key'}</h3>
                                                    <button
                                                        onClick={() => { setEditingName(fresh.pubkey); setEditNameValue(fresh.name || ''); }}
                                                        className="text-muted-foreground hover:text-foreground cursor-pointer"
                                                    >
                                                        <Pencil className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            )}
                                            <div className="flex items-center gap-1.5 mt-0.5">
                                                {isActive && <Badge variant="default" className="text-[10px] py-0 px-1.5">Active</Badge>}
                                                {parentSeed && (
                                                    <Badge variant="secondary" className="text-[10px] py-0 px-1.5">
                                                        m/44'/1237'/{fresh.account_index ?? 0}'/0/0
                                                    </Badge>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                    {!isActive && (
                                        <Button size="sm" onClick={() => setActive(fresh.pubkey)}>
                                            Set Active
                                        </Button>
                                    )}
                                </div>

                                {/* npub */}
                                <div className="space-y-1">
                                    <span className="text-xs text-muted-foreground font-medium">Public Key (npub)</span>
                                    <button
                                        onClick={() => copyText(fresh.npub, 'npub')}
                                        className="flex items-center gap-2 w-full p-3 bg-secondary rounded-lg cursor-pointer hover:bg-secondary/80 transition-colors group"
                                    >
                                        <span className="font-mono text-sm truncate flex-1 text-left">{fresh.npub}</span>
                                        {copiedId === 'npub'
                                            ? <Check className="w-4 h-4 text-success shrink-0" />
                                            : <Copy className="w-4 h-4 text-muted-foreground group-hover:text-foreground shrink-0" />
                                        }
                                    </button>
                                </div>

                                {/* pubkey hex */}
                                <div className="space-y-1">
                                    <span className="text-xs text-muted-foreground font-medium">Public Key (hex)</span>
                                    <button
                                        onClick={() => copyText(fresh.pubkey, 'hex')}
                                        className="flex items-center gap-2 w-full p-3 bg-secondary rounded-lg cursor-pointer hover:bg-secondary/80 transition-colors group"
                                    >
                                        <span className="font-mono text-sm truncate flex-1 text-left">{fresh.pubkey}</span>
                                        {copiedId === 'hex'
                                            ? <Check className="w-4 h-4 text-success shrink-0" />
                                            : <Copy className="w-4 h-4 text-muted-foreground group-hover:text-foreground shrink-0" />
                                        }
                                    </button>
                                </div>

                                {/* Private key section */}
                                <div className="space-y-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => {
                                            if (showPrivateKey) {
                                                setShowPrivateKey(false);
                                                setPrivateKeyDisplay('');
                                                setNsecRevealed(false);
                                            } else {
                                                viewPrivateKey(fresh.pubkey);
                                            }
                                        }}
                                        className="gap-1.5 w-full"
                                    >
                                        {showPrivateKey
                                            ? <><EyeOff className="w-4 h-4" /> Hide Private Key</>
                                            : <><Eye className="w-4 h-4" /> Reveal Private Key</>
                                        }
                                    </Button>
                                    {showPrivateKey && privateKeyDisplay && (
                                        <Alert variant="destructive" className="animate-slide-up">
                                            <div className="space-y-2 w-full">
                                                <div className="flex items-center gap-1.5 text-sm font-medium">
                                                    <ShieldAlert className="w-4 h-4" /> Keep this secret!
                                                </div>
                                                <p className={cn(
                                                    "font-mono text-xs break-all transition-all duration-200",
                                                    nsecRevealed ? "opacity-80" : "blur-sm select-none opacity-50"
                                                )}>
                                                    {privateKeyDisplay}
                                                </p>
                                                <div className="flex gap-2">
                                                    <Button
                                                        variant="outline"
                                                        size="xs"
                                                        className="flex-1"
                                                        onClick={() => setNsecRevealed(r => !r)}
                                                    >
                                                        {nsecRevealed
                                                            ? <><EyeOff className="w-3 h-3" /> Hide</>
                                                            : <><Eye className="w-3 h-3" /> Show</>
                                                        }
                                                    </Button>
                                                    <Button variant="outline" size="xs" className="flex-1" onClick={() => copyText(privateKeyDisplay, 'nsec')}>
                                                        <Copy className="w-3 h-3" /> Copy
                                                    </Button>
                                                </div>
                                            </div>
                                        </Alert>
                                    )}
                                </div>
                            </CardContent>
                        </Card>

                        {/* Danger zone — only for imported (non-seed) keys */}
                        {!fresh.seed_id && (
                            <Card className="border-destructive/30">
                                <CardContent className="pt-5">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <p className="text-sm font-medium text-destructive">Delete Keypair</p>
                                            <p className="text-xs text-muted-foreground">This action cannot be undone.</p>
                                        </div>
                                        <Button variant="destructive" size="sm" onClick={() => deleteKeypair(fresh.pubkey)} className="gap-1.5">
                                            <Trash2 className="w-4 h-4" /> Delete
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        )}
                    </div>
                </div>
                {pinPromptElement}
            </>
        );
    }

    // ── SEED DETAIL PAGE ──
    if (view.page === 'seed-detail') {
        const seed = seeds.find(s => s.id === view.seedId);
        if (!seed) {
            setView({ page: 'list' });
            return null;
        }
        const seedKeypairs = appState.keypairs.filter(kp => kp.seed_id === seed.id);

        return (
            <>
                <div className="flex flex-col h-[calc(100vh-115px)] animate-fade-in">
                    <div className="flex items-center gap-3 shrink-0 pb-3">
                        <button
                            onClick={() => setView({ page: 'list' })}
                            className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors"
                        >
                            <ArrowLeft className="w-4.5 h-4.5 text-muted-foreground" />
                        </button>
                        <h2 className="text-base font-semibold">{seed.name}</h2>
                    </div>
                    <div className="flex-1 overflow-y-auto space-y-4 pb-[100px]">

                        <Card>
                            <CardHeader>
                                <div className="flex items-center gap-2">
                                    <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
                                        <Sprout className="w-5 h-5 text-emerald-500" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        {editingName === seed.id ? (
                                            <div className="flex items-center gap-1">
                                                <Input
                                                    value={editNameValue}
                                                    onChange={e => setEditNameValue(e.target.value)}
                                                    className="h-7 text-sm w-40"
                                                    onKeyDown={e => e.key === 'Enter' && saveName('seed', seed.id)}
                                                    autoFocus
                                                />
                                                <Button size="xs" onClick={() => saveName('seed', seed.id)}>
                                                    <Check className="w-3 h-3" />
                                                </Button>
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-1.5">
                                                <CardTitle className="text-lg">{seed.name}</CardTitle>
                                                <button
                                                    onClick={() => { setEditingName(seed.id); setEditNameValue(seed.name); }}
                                                    className="text-muted-foreground hover:text-foreground cursor-pointer"
                                                >
                                                    <Pencil className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                        )}
                                        <p className="text-xs text-muted-foreground mt-0.5">{seedKeypairs.length} derived keypair{seedKeypairs.length !== 1 ? 's' : ''}</p>
                                    </div>
                                </div>
                                <Button size="sm" onClick={() => deriveNextKeypair(seed.id)} disabled={loading} className="gap-1.5">
                                    <Plus className="w-4 h-4" /> Derive Key
                                </Button>
                            </CardHeader>

                            <CardContent className="space-y-2">
                                {error && (
                                    <Alert variant="destructive">
                                        <AlertDescription>{error}</AlertDescription>
                                    </Alert>
                                )}

                                {seedKeypairs.map((kp) => {
                                    const isActive = kp.pubkey === appState.active_keypair;
                                    return (
                                        <div
                                            key={kp.pubkey}
                                            className={cn(
                                                "flex items-center justify-between p-4 rounded-xl cursor-pointer transition-all duration-200",
                                                "hover:bg-secondary",
                                                isActive
                                                    ? "bg-emerald-500/5 border border-emerald-500/20"
                                                    : "bg-secondary/50"
                                            )}
                                            onClick={() => setView({ page: 'key-detail', keypair: kp })}
                                        >
                                            <div className="flex flex-col gap-1 min-w-0 flex-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-base font-medium truncate">{kp.name || 'Unnamed Key'}</span>
                                                    {isActive && (
                                                        <Badge variant="default" className="text-[10px] py-0 px-1.5">Active</Badge>
                                                    )}
                                                    <Badge variant="secondary" className="text-[10px] py-0 px-1.5 font-mono">
                                                        #{kp.account_index ?? 0}
                                                    </Badge>
                                                </div>
                                                <button
                                                    className="text-sm text-muted-foreground font-mono text-left hover:text-foreground transition-colors flex items-center gap-1 cursor-pointer"
                                                    onClick={(e) => { e.stopPropagation(); copyText(kp.npub, kp.pubkey); }}
                                                    title="Click to copy"
                                                >
                                                    {truncateMiddle(kp.npub)}
                                                    {copiedId === kp.pubkey
                                                        ? <Check className="w-3 h-3 text-success" />
                                                        : <Copy className="w-3 h-3 opacity-40" />
                                                    }
                                                </button>
                                            </div>
                                            <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0 ml-2" />
                                        </div>
                                    );
                                })}
                            </CardContent>
                        </Card>

                        {/* Seed Words Reveal */}
                        <Card>
                            <CardContent className="pt-5 space-y-3">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={async () => {
                                        if (showSeedWords) {
                                            setShowSeedWords(false);
                                            setSeedWordsDisplay('');
                                            setSeedWordsRevealed(false);
                                        } else {
                                            requirePin('View Seed Words', 'Enter your PIN to reveal seed words', async () => {
                                                try {
                                                    const words = await invoke<string>('export_seed_words', { seedId: seed.id });
                                                    setSeedWordsDisplay(words);
                                                    setShowSeedWords(true);
                                                } catch (e) {
                                                    setError(String(e));
                                                }
                                            });
                                        }
                                    }}
                                    className="gap-1.5 w-full"
                                >
                                    {showSeedWords
                                        ? <><EyeOff className="w-4 h-4" /> Hide Seed Words</>
                                        : <><Eye className="w-4 h-4" /> View Seed Words</>
                                    }
                                </Button>
                                {showSeedWords && seedWordsDisplay && (
                                    <Alert variant="destructive" className="animate-slide-up">
                                        <div className="space-y-3 w-full">
                                            <div className="flex items-center gap-1.5 text-sm font-medium">
                                                <ShieldAlert className="w-4 h-4" /> Keep these secret!
                                            </div>
                                            <div className={cn(
                                                "grid grid-cols-2 min-[480px]:grid-cols-3 gap-1.5 transition-all duration-200",
                                                seedWordsRevealed ? "opacity-80" : "blur-sm select-none opacity-50"
                                            )}>
                                                {seedWordsDisplay.split(' ').map((word, i) => (
                                                    <div key={i} className="flex items-center gap-1.5 p-1.5 bg-background/50 rounded">
                                                        <span className="text-[10px] text-muted-foreground w-4 text-right">{i + 1}.</span>
                                                        <span className="font-mono text-xs">{word}</span>
                                                    </div>
                                                ))}
                                            </div>
                                            <div className="flex gap-2">
                                                <Button variant="outline" size="xs" className="flex-1" onClick={() => setSeedWordsRevealed(r => !r)}>
                                                    {seedWordsRevealed
                                                        ? <><EyeOff className="w-3 h-3" /> Hide</>
                                                        : <><Eye className="w-3 h-3" /> Show</>
                                                    }
                                                </Button>
                                                <Button variant="outline" size="xs" className="flex-1" onClick={() => copyText(seedWordsDisplay, 'seed-words')}>
                                                    <Copy className="w-3 h-3" /> Copy
                                                </Button>
                                            </div>
                                            <Button
                                                variant="outline"
                                                size="xs"
                                                className="w-full gap-1.5"
                                                onClick={() => { setShowExportModal(true); setExportError(''); }}
                                            >
                                                <FileDown className="w-3 h-3" /> Export Encrypted Backup
                                            </Button>
                                        </div>
                                    </Alert>
                                )}
                            </CardContent>
                        </Card>

                        {/* Export password modal (seed detail view) */}
                        {showExportModal && (
                            <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
                                <div className="flex min-h-full items-center justify-center px-4 py-20">
                                    <Card className="w-[340px] shadow-2xl">
                                        <CardHeader>
                                            <CardTitle className="flex items-center gap-2 text-base">
                                                <Lock className="w-4 h-4" />
                                                Encrypt Backup
                                            </CardTitle>
                                        </CardHeader>
                                        <CardContent className="space-y-3">
                                            <p className="text-xs text-muted-foreground">
                                                Choose a password to encrypt your seed backup file. You'll need this password to decrypt it later.
                                            </p>
                                            {exportError && (
                                                <Alert variant="destructive">
                                                    <AlertDescription className="text-xs">{exportError}</AlertDescription>
                                                </Alert>
                                            )}
                                            <div className="space-y-1.5">
                                                <label className="text-xs font-medium text-muted-foreground">Password</label>
                                                <Input
                                                    type="password"
                                                    value={exportPassword}
                                                    onChange={e => setExportPassword(e.target.value)}
                                                    placeholder="Enter password"
                                                />
                                            </div>
                                            <div className="space-y-1.5">
                                                <label className="text-xs font-medium text-muted-foreground">Confirm Password</label>
                                                <Input
                                                    type="password"
                                                    value={exportConfirmPassword}
                                                    onChange={e => setExportConfirmPassword(e.target.value)}
                                                    onKeyDown={e => e.key === 'Enter' && exportEncrypted(seedWordsDisplay)}
                                                />
                                            </div>
                                            <div className="flex gap-2 pt-1">
                                                <Button
                                                    variant="outline"
                                                    className="flex-1"
                                                    onClick={() => { setShowExportModal(false); setExportPassword(''); setExportConfirmPassword(''); }}
                                                >
                                                    Cancel
                                                </Button>
                                                <Button
                                                    className="flex-1 gap-1.5"
                                                    onClick={() => exportEncrypted(seedWordsDisplay)}
                                                    disabled={!exportPassword}
                                                >
                                                    <FileDown className="w-4 h-4" /> Export
                                                </Button>
                                            </div>
                                        </CardContent>
                                    </Card>
                                </div>
                            </div>
                        )}

                        {/* Danger zone */}
                        <Card className="border-destructive/30">
                            <CardContent className="pt-5">
                                <div className="flex items-center justify-between gap-2 flex-wrap">
                                    <div>
                                        <p className="text-sm font-medium text-destructive">Delete Seed</p>
                                        <p className="text-xs text-muted-foreground">Removes seed and all {seedKeypairs.length} derived keypairs.</p>
                                    </div>
                                    <Button variant="destructive" size="sm" onClick={() => deleteSeed(seed.id)} className="gap-1.5">
                                        <Trash2 className="w-4 h-4" /> Delete
                                    </Button>
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                </div>
                {pinPromptElement}
            </>
        );
    }

    // ── LIST PAGE (Main) ──
    return (
        <>
            <div className="flex flex-col h-[calc(100vh-115px)]">
                {onBack && (
                    <div className="flex items-center gap-3 shrink-0 pb-3">
                        <button
                            onClick={onBack}
                            className="w-9 h-9 rounded-xl bg-secondary flex items-center justify-center shrink-0 cursor-pointer hover:bg-secondary/80 transition-colors"
                        >
                            <ArrowLeft className="w-4.5 h-4.5 text-muted-foreground" />
                        </button>
                        <h2 className="text-base font-semibold">Accounts</h2>
                    </div>
                )}
                <div className="flex-1 overflow-y-auto space-y-4 pb-[100px]">
                    {error && (
                        <Alert variant="destructive">
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    )}

                    {/* ─── Seeds Section ─── */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Sprout className="w-5 h-5" />
                                Seeds
                            </CardTitle>
                            <div className="flex gap-2 flex-wrap">
                                <Button variant="outline" size="sm" onClick={() => { setError(''); setView({ page: 'import-seed' }); }}>
                                    <Download className="w-4 h-4" />
                                    Import
                                </Button>
                                <Button size="sm" onClick={() => { setError(''); setView({ page: 'generate-seed' }); }}>
                                    <Plus className="w-4 h-4" />
                                    Generate
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent>
                            {seeds.length === 0 ? (
                                <div className="flex flex-col items-center py-6 text-muted-foreground">
                                    <Sprout className="w-8 h-8 mb-2 opacity-40" />
                                    <p className="text-sm">No seeds yet. Generate one to get started.</p>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {seeds.map((seed) => {
                                        const seedKeypairs = appState.keypairs.filter(kp => kp.seed_id === seed.id);
                                        const hasActiveKey = seedKeypairs.some(kp => kp.pubkey === appState.active_keypair);
                                        return (
                                            <div
                                                key={seed.id}
                                                className={cn(
                                                    "flex items-center justify-between p-4 rounded-xl cursor-pointer transition-all duration-200",
                                                    "hover:bg-secondary",
                                                    hasActiveKey
                                                        ? "bg-emerald-500/5 border border-emerald-500/20"
                                                        : "bg-secondary/50"
                                                )}
                                                onClick={() => setView({ page: 'seed-detail', seedId: seed.id })}
                                            >
                                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                                    <div className="w-9 h-9 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                                                        <Sprout className="w-4.5 h-4.5 text-emerald-500" />
                                                    </div>
                                                    <div className="flex flex-col gap-0.5 min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-base font-medium truncate">{seed.name}</span>
                                                            {hasActiveKey && (
                                                                <Badge variant="default" className="text-[10px] py-0 px-1.5">Active</Badge>
                                                            )}
                                                        </div>
                                                        <span className="text-xs text-muted-foreground">
                                                            {seedKeypairs.length} keypair{seedKeypairs.length !== 1 ? 's' : ''}
                                                        </span>
                                                    </div>
                                                </div>
                                                <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0 ml-2" />
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {/* ─── Imported Keys Section ─── */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <KeyRound className="w-5 h-5" />
                                Imported Keys
                            </CardTitle>
                            <div className="flex gap-2">
                                <Button variant="outline" size="sm" onClick={() => { setError(''); setView({ page: 'import-nsec' }); }}>
                                    <Download className="w-4 h-4" />
                                    Import nsec
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent>
                            {importedKeypairs.length === 0 ? (
                                <div className="flex flex-col items-center py-4 text-muted-foreground">
                                    <p className="text-sm">No imported keys.</p>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {importedKeypairs.map((kp) => {
                                        const isActive = kp.pubkey === appState.active_keypair;
                                        return (
                                            <div
                                                key={kp.pubkey}
                                                className={cn(
                                                    "flex items-center justify-between p-4 rounded-xl cursor-pointer transition-all duration-200",
                                                    "hover:bg-secondary",
                                                    isActive
                                                        ? "bg-primary/5 border border-primary/20"
                                                        : "bg-secondary/50"
                                                )}
                                                onClick={() => setView({ page: 'key-detail', keypair: kp })}
                                            >
                                                <div className="flex flex-col gap-1 min-w-0 flex-1">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-base font-medium truncate">{kp.name || 'Unnamed Key'}</span>
                                                        {isActive && (
                                                            <Badge variant="default" className="text-[10px] py-0 px-1.5">Active</Badge>
                                                        )}
                                                    </div>
                                                    <button
                                                        className="text-sm text-muted-foreground font-mono text-left hover:text-foreground transition-colors flex items-center gap-1 cursor-pointer"
                                                        onClick={(e) => { e.stopPropagation(); copyText(kp.npub, kp.pubkey); }}
                                                        title="Click to copy"
                                                    >
                                                        {truncateMiddle(kp.npub)}
                                                        {copiedId === kp.pubkey
                                                            ? <Check className="w-3 h-3 text-success" />
                                                            : <Copy className="w-3 h-3 opacity-40" />
                                                        }
                                                    </button>
                                                </div>
                                                <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0 ml-2" />
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            </div>

            <PinPrompt
                isOpen={showPinPrompt}
                title={pinPromptTitle}
                description={pinPromptDesc}
                onSuccess={() => {
                    setShowPinPrompt(false);
                    if (pendingAction) {
                        pendingAction();
                        setPendingAction(null);
                    }
                }}
                onCancel={() => {
                    setShowPinPrompt(false);
                    setPendingAction(null);
                }}
            />
        </>
    );
}
