/**
 * FollowsSelector — A modal that lets the user pick a recipient
 * from their Nostr follows list (kind 3).
 *
 * Features:
 * - Fetches kind:3 contact list on open
 * - Incrementally loads kind:0 profiles (name, picture)
 * - Optionally shows derived Taproot (P2TR) address for Bitcoin sends
 * - Search/filter by name or npub
 * - Single-select with "Send to" confirmation button
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { X, Search, Users, Loader2, Check } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { cn } from '@/lib/utils';
import { fetchFollows } from '@/services/nostrFollows';
import { fetchNostrProfile, type NostrProfile } from '@/services/nostrProfile';
import { npubToTaprootAddress } from '@/services/bitcoin';

interface FollowsSelectorProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (npub: string) => void;
    activePubkey: string;
    /** If true, derives and shows taproot address for each contact (Bitcoin mode) */
    showTaprootAddress?: boolean;
}

interface ContactInfo {
    pubkeyHex: string;
    npub: string;
    profile: NostrProfile | null;
    taprootAddress?: string;
    loading: boolean;
}

export const FollowsSelector: React.FC<FollowsSelectorProps> = ({
    isOpen,
    onClose,
    onSelect,
    activePubkey,
    showTaprootAddress = false,
}) => {
    const [contacts, setContacts] = useState<ContactInfo[]>([]);
    const [loadingFollows, setLoadingFollows] = useState(false);
    const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [error, setError] = useState<string | null>(null);
    const fetchedRef = useRef(false);

    // Reset state when opened
    useEffect(() => {
        if (!isOpen) {
            fetchedRef.current = false;
            setContacts([]);
            setSelectedPubkey(null);
            setSearch('');
            setError(null);
            return;
        }

        if (fetchedRef.current) return;
        fetchedRef.current = true;

        const loadFollows = async () => {
            setLoadingFollows(true);
            try {
                const pubkeys = await fetchFollows(activePubkey);
                if (pubkeys.length === 0) {
                    setError('No follows found. Make sure you have a kind:3 contact list on Nostr relays.');
                    setLoadingFollows(false);
                    return;
                }

                // Initialize contacts with loading state
                const initialContacts: ContactInfo[] = pubkeys.map(hex => {
                    let npub = '';
                    try { npub = nip19.npubEncode(hex); } catch { npub = hex; }

                    const info: ContactInfo = {
                        pubkeyHex: hex,
                        npub,
                        profile: null,
                        loading: true
                    };

                    if (showTaprootAddress && npub.startsWith('npub')) {
                        try { info.taprootAddress = npubToTaprootAddress(npub); } catch { /* skip */ }
                    }

                    return info;
                });

                setContacts(initialContacts);
                setLoadingFollows(false);

                // Fetch profiles incrementally in batches
                const BATCH_SIZE = 5;
                for (let i = 0; i < pubkeys.length; i += BATCH_SIZE) {
                    const batch = pubkeys.slice(i, i + BATCH_SIZE);
                    const profilePromises = batch.map(async (hex) => {
                        try {
                            const profile = await fetchNostrProfile(hex);
                            return { hex, profile };
                        } catch {
                            return { hex, profile: null };
                        }
                    });

                    const results = await Promise.allSettled(profilePromises);

                    setContacts(prev => prev.map(c => {
                        const found = results.find(r =>
                            r.status === 'fulfilled' && r.value.hex === c.pubkeyHex
                        );
                        if (found && found.status === 'fulfilled') {
                            return { ...c, profile: found.value.profile, loading: false };
                        }
                        return c;
                    }));
                }

                // Mark any remaining as done loading
                setContacts(prev => prev.map(c => ({ ...c, loading: false })));
            } catch (e) {
                console.error('Failed to fetch follows:', e);
                setError('Failed to fetch follows. Please try again.');
                setLoadingFollows(false);
            }
        };

        loadFollows();
    }, [isOpen, activePubkey, showTaprootAddress]);

    // Filtered contacts based on search
    const filteredContacts = useMemo(() => {
        if (!search.trim()) return contacts;
        const q = search.toLowerCase().trim();
        return contacts.filter(c => {
            const name = (c.profile?.display_name || c.profile?.name || '').toLowerCase();
            const npubLower = c.npub.toLowerCase();
            const nip05 = (c.profile?.nip05 || '').toLowerCase();
            return name.includes(q) || npubLower.includes(q) || nip05.includes(q);
        });
    }, [contacts, search]);

    const selectedContact = useMemo(
        () => contacts.find(c => c.pubkeyHex === selectedPubkey) || null,
        [contacts, selectedPubkey]
    );

    const handleConfirm = useCallback(() => {
        if (selectedContact) {
            onSelect(selectedContact.npub);
            onClose();
        }
    }, [selectedContact, onSelect, onClose]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[55] overflow-hidden bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="flex h-full items-center justify-center px-4 py-20">
                <div className="bg-card border border-border rounded-2xl w-[400px] max-h-[80vh] shadow-2xl flex flex-col">
                    {/* Header */}
                    <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
                        <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                            <Users className="w-5 h-5 text-primary" />
                            Select Recipient
                        </h3>
                        <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Search */}
                    <div className="p-4 pb-2 shrink-0">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search by name or npub..."
                                className="w-full bg-background border border-border rounded-xl pl-10 pr-3 py-2.5 text-foreground text-sm focus:ring-2 focus:ring-primary outline-none"
                                autoFocus
                            />
                        </div>
                    </div>

                    {/* Contact list */}
                    <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-2">
                        {loadingFollows ? (
                            <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
                                <Loader2 className="w-6 h-6 animate-spin" />
                                <span className="text-sm">Loading follows...</span>
                            </div>
                        ) : error ? (
                            <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                                <Users className="w-8 h-8 opacity-30" />
                                <p className="text-sm text-center">{error}</p>
                            </div>
                        ) : filteredContacts.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                                <Search className="w-8 h-8 opacity-30" />
                                <p className="text-sm">No matches found</p>
                            </div>
                        ) : (
                            <div className="space-y-1.5">
                                {filteredContacts.map((contact) => {
                                    const isSelected = selectedPubkey === contact.pubkeyHex;
                                    const displayName = contact.profile?.display_name || contact.profile?.name || null;
                                    const npubShort = contact.npub.slice(0, 12) + '...' + contact.npub.slice(-6);

                                    return (
                                        <button
                                            key={contact.pubkeyHex}
                                            onClick={() => setSelectedPubkey(
                                                isSelected ? null : contact.pubkeyHex
                                            )}
                                            className={cn(
                                                "w-full text-left p-3 rounded-xl transition-all cursor-pointer",
                                                isSelected
                                                    ? "bg-primary/15 border-2 border-primary/50"
                                                    : "bg-secondary/30 hover:bg-secondary/60 border-2 border-transparent"
                                            )}
                                        >
                                            <div className="flex items-center gap-3">
                                                {/* Avatar */}
                                                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0 overflow-hidden">
                                                    {contact.profile?.picture ? (
                                                        <img
                                                            src={contact.profile.picture}
                                                            alt=""
                                                            className="w-full h-full object-cover"
                                                            onError={(e) => {
                                                                (e.target as HTMLImageElement).style.display = 'none';
                                                            }}
                                                        />
                                                    ) : contact.loading ? (
                                                        <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                                                    ) : (
                                                        <span className="text-primary font-bold text-sm">
                                                            {(displayName || contact.npub.slice(5, 7)).toUpperCase().slice(0, 2)}
                                                        </span>
                                                    )}
                                                </div>

                                                {/* Info */}
                                                <div className="flex-1 min-w-0">
                                                    {displayName ? (
                                                        <>
                                                            <div className="text-sm font-medium text-foreground truncate">{displayName}</div>
                                                            <div className="text-[11px] text-muted-foreground font-mono truncate">{npubShort}</div>
                                                        </>
                                                    ) : (
                                                        <div className="text-sm text-foreground font-mono truncate">{npubShort}</div>
                                                    )}
                                                    {showTaprootAddress && contact.taprootAddress && (
                                                        <div className="text-[10px] text-muted-foreground/70 font-mono truncate mt-0.5">
                                                            {contact.taprootAddress.slice(0, 14)}...{contact.taprootAddress.slice(-8)}
                                                        </div>
                                                    )}
                                                </div>

                                                {/* Selection indicator */}
                                                {isSelected && (
                                                    <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center shrink-0">
                                                        <Check className="w-3.5 h-3.5 text-primary-foreground" />
                                                    </div>
                                                )}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* Footer with Send To button */}
                    <div className="p-4 border-t border-border shrink-0">
                        <button
                            onClick={handleConfirm}
                            disabled={!selectedContact}
                            className={cn(
                                "w-full py-3 font-bold rounded-xl transition-colors cursor-pointer text-sm",
                                selectedContact
                                    ? "bg-primary hover:bg-primary/80 text-primary-foreground"
                                    : "bg-secondary text-muted-foreground cursor-not-allowed"
                            )}
                        >
                            {selectedContact
                                ? `Send to ${selectedContact.profile?.display_name || selectedContact.profile?.name || selectedContact.npub.slice(0, 12) + '...'}`
                                : 'Select a contact'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
