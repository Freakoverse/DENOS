/**
 * MintsModal — Mint management with NIP-87 discovery.
 * Port of PWANS MintsModal.tsx adapted for DENOS.
 */
import React, { useState } from 'react';
import { X, Server, Trash2, Globe, Search, Plus, Loader2 } from 'lucide-react';
import { useEcashStore } from '@/services/ecashStore';
import { CashuService } from '@/services/cashu';
import { cn } from '@/lib/utils';

interface MintsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export const MintsModal: React.FC<MintsModalProps> = ({ isOpen, onClose }) => {
    const { mints, discoveredMints } = useEcashStore();
    const [newMintUrl, setNewMintUrl] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [tab, setTab] = useState<'my' | 'discover'>('my');

    const handleAddMint = async (url?: string) => {
        const mintUrl = (url || newMintUrl).trim().replace(/\/$/, '');
        if (!mintUrl) return;

        setLoading(true);
        setError(null);

        try {
            // Validate mint is online
            const isValid = await CashuService.validateMint(mintUrl);
            if (!isValid) {
                throw new Error('Mint is offline or unreachable');
            }

            // Load mint keys
            await CashuService.loadMint(mintUrl);
            setNewMintUrl('');
        } catch (e: any) {
            setError(e.message || 'Failed to add mint');
        } finally {
            setLoading(false);
        }
    };

    const handleRemoveMint = (url: string) => {
        useEcashStore.getState().removeMint(url);
    };

    const handleAddDiscoveredMint = async (url: string) => {
        await handleAddMint(url);
    };

    // Filter discovered mints
    const filteredDiscovered = Object.values(discoveredMints)
        .filter(m => !mints[m.url])
        .filter(m => !searchQuery || m.url.toLowerCase().includes(searchQuery.toLowerCase()))
        .sort((a, b) => b.trustScore - a.trustScore);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="flex min-h-full items-center justify-center px-4 py-20">
                <div className="bg-card border border-border rounded-2xl w-[420px] shadow-2xl max-h-[80vh] flex flex-col">
                    {/* Header */}
                    <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
                        <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                            <Server className="w-5 h-5 text-primary" />
                            Mints
                        </h3>
                        <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Tabs */}
                    <div className="flex p-2 mx-4 mt-3 bg-secondary/50 rounded-xl shrink-0">
                        <button
                            onClick={() => setTab('my')}
                            className={cn(
                                "flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors cursor-pointer",
                                tab === 'my' ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            My Mints ({Object.keys(mints).length})
                        </button>
                        <button
                            onClick={() => setTab('discover')}
                            className={cn(
                                "flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors cursor-pointer",
                                tab === 'discover' ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <Globe className="w-3.5 h-3.5 inline mr-1" />
                            Discover ({filteredDiscovered.length})
                        </button>
                    </div>

                    <div className="p-4 space-y-3 overflow-y-auto flex-1">
                        {tab === 'my' ? (
                            <>
                                {/* Add new mint */}
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={newMintUrl}
                                        onChange={(e) => setNewMintUrl(e.target.value)}
                                        placeholder="https://mint.example.com"
                                        className="flex-1 bg-background border border-border rounded-xl px-3 py-2 text-foreground text-sm focus:ring-2 focus:ring-primary outline-none"
                                        onKeyDown={(e) => e.key === 'Enter' && handleAddMint()}
                                    />
                                    <button
                                        onClick={() => handleAddMint()}
                                        disabled={loading || !newMintUrl.trim()}
                                        className="px-3 py-2 bg-primary hover:bg-primary/80 disabled:bg-primary/50 text-primary-foreground rounded-xl transition-colors cursor-pointer disabled:cursor-not-allowed"
                                    >
                                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                                    </button>
                                </div>

                                {/* Error */}
                                {error && (
                                    <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
                                        {error}
                                    </div>
                                )}

                                {/* My mints list */}
                                {Object.keys(mints).length === 0 ? (
                                    <div className="p-6 text-center text-muted-foreground text-sm">
                                        No mints added yet. Add a mint URL above or discover mints from the network.
                                    </div>
                                ) : (
                                    Object.entries(mints).map(([url, mint]) => (
                                        <div key={url} className="flex items-center gap-3 bg-secondary/30 border border-border rounded-xl p-3">
                                            <div className={cn(
                                                "w-2 h-2 rounded-full flex-shrink-0",
                                                mint.active ? "bg-green-500" : "bg-yellow-500"
                                            )} />
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-medium text-foreground truncate">
                                                    {url.replace('https://', '').replace(/\/$/, '')}
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                    {mint.keys?.keysets ? `${(mint.keys.keysets as any[]).length} keysets` : 'Loading...'}
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => handleRemoveMint(url)}
                                                className="p-1.5 text-muted-foreground hover:text-destructive rounded-lg transition-colors cursor-pointer"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    ))
                                )}
                            </>
                        ) : (
                            <>
                                {/* Search */}
                                <div className="relative">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                    <input
                                        type="text"
                                        value={searchQuery}
                                        onChange={(e) => setSearchQuery(e.target.value)}
                                        placeholder="Search mints..."
                                        className="w-full bg-background border border-border rounded-xl pl-9 pr-3 py-2 text-foreground text-sm focus:ring-2 focus:ring-primary outline-none"
                                    />
                                </div>

                                {/* Discovered mints list */}
                                {filteredDiscovered.length === 0 ? (
                                    <div className="p-6 text-center text-muted-foreground text-sm">
                                        {Object.keys(discoveredMints).length === 0
                                            ? 'Discovering mints from the Nostr network...'
                                            : 'No matching mints found.'}
                                    </div>
                                ) : (
                                    filteredDiscovered.map(mint => (
                                        <div key={mint.url} className="flex items-center gap-3 bg-secondary/30 border border-border rounded-xl p-3">
                                            <div className={cn(
                                                "w-2 h-2 rounded-full flex-shrink-0",
                                                mint.status === 'online' ? "bg-green-500" :
                                                    mint.status === 'offline' ? "bg-red-500" : "bg-yellow-500"
                                            )} />
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-medium text-foreground truncate">
                                                    {mint.url.replace('https://', '').replace(/\/$/, '')}
                                                </div>
                                                <div className="text-xs text-muted-foreground flex items-center gap-2">
                                                    {mint.trustScore > 0 && (
                                                        <span className="text-green-500">★ {mint.trustScore}</span>
                                                    )}
                                                    {mint.reviews > 0 && (
                                                        <span>{mint.reviews} reviews</span>
                                                    )}
                                                </div>
                                            </div>
                                            <button
                                                onClick={() => handleAddDiscoveredMint(mint.url)}
                                                disabled={loading}
                                                className="px-3 py-1.5 text-xs bg-primary hover:bg-primary/80 disabled:bg-primary/50 text-primary-foreground rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed"
                                            >
                                                {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Add'}
                                            </button>
                                        </div>
                                    ))
                                )}
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
