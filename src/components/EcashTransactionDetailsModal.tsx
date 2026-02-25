/**
 * EcashTransactionDetailsModal — Display detailed transaction info.
 * Port of PWANS EcashTransactionDetailsModal.tsx adapted for DENOS.
 */
import React, { useState, useEffect } from 'react';
import { X, ArrowDownLeft, ArrowUpRight, Copy, Check, User, CircleCheckBig } from 'lucide-react';
import { type HistoryItem } from '@/services/ecashStore';
import { fetchNostrProfile, type NostrProfile } from '@/services/nostrProfile';
import { nip19 } from 'nostr-tools';

interface EcashTransactionDetailsModalProps {
    isOpen: boolean;
    onClose: () => void;
    transaction: HistoryItem | null;
}

export const EcashTransactionDetailsModal: React.FC<EcashTransactionDetailsModalProps> = ({
    isOpen, onClose, transaction
}) => {
    const [senderProfile, setSenderProfile] = useState<NostrProfile | null>(null);
    const [recipientProfile, setRecipientProfile] = useState<NostrProfile | null>(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!isOpen || !transaction) return;
        setSenderProfile(null);
        setRecipientProfile(null);

        const fetchProfile = async (npub: string): Promise<NostrProfile | null> => {
            try {
                let hex = npub;
                try {
                    const decoded = nip19.decode(npub);
                    if (decoded.type === 'npub') hex = decoded.data as string;
                } catch { }
                return await fetchNostrProfile(hex);
            } catch { return null; }
        };

        if (transaction.sender) fetchProfile(transaction.sender).then(setSenderProfile);
        if (transaction.recipient) fetchProfile(transaction.recipient).then(setRecipientProfile);
    }, [isOpen, transaction]);

    const copyToken = () => {
        if (transaction?.token) {
            navigator.clipboard.writeText(transaction.token);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    if (!isOpen || !transaction) return null;

    const isReceive = transaction.type === 'receive';
    const displayProfile = isReceive ? senderProfile : recipientProfile;
    const displayNpub = isReceive ? transaction.sender : transaction.recipient;

    return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="flex min-h-full items-center justify-center px-4 py-20">
                <div className="bg-card border border-border rounded-2xl w-[400px] shadow-2xl">
                    {/* Header */}
                    <div className="flex items-center justify-between p-4 border-b border-border">
                        <h3 className="text-lg font-bold text-foreground">Transaction Details</h3>
                        <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    <div className="p-4 space-y-4">
                        {/* Amount */}
                        <div className="text-center py-4">
                            <div className={`inline-flex items-center gap-2 p-3 rounded-full ${isReceive ? 'bg-green-500/10' : 'bg-primary/10'} mb-3`}>
                                {isReceive
                                    ? <ArrowDownLeft className="w-6 h-6 text-green-500" />
                                    : <ArrowUpRight className="w-6 h-6 text-primary" />}
                            </div>
                            <div className={`text-3xl font-bold ${isReceive ? 'text-green-500' : 'text-foreground'}`}>
                                {isReceive ? '+' : '-'}{transaction.amount.toLocaleString()} sats
                            </div>
                            <div className="text-sm text-muted-foreground mt-1">
                                {transaction.isNutzap ? 'NutZap' : 'eCash'} · {isReceive ? 'Received' : 'Sent'}
                            </div>
                        </div>

                        {/* Profile */}
                        {displayNpub && (
                            <div className="flex items-center gap-3 p-3 bg-secondary/30 rounded-xl">
                                {displayProfile?.picture ? (
                                    <img src={displayProfile.picture} className="w-10 h-10 rounded-full object-cover" />
                                ) : (
                                    <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
                                        <User className="w-5 h-5 text-muted-foreground" />
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5">
                                        <span className="font-bold text-foreground">
                                            {displayProfile?.name || displayProfile?.display_name || `${displayNpub.slice(0, 12)}...`}
                                        </span>
                                        {displayProfile?.nip05 && <CircleCheckBig className="w-3.5 h-3.5 text-primary" />}
                                    </div>
                                    {displayProfile?.nip05 && (
                                        <span className="text-xs text-muted-foreground">{displayProfile.nip05}</span>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Details */}
                        <div className="space-y-2 text-sm">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Date</span>
                                <span className="text-foreground">
                                    {new Date(transaction.timestamp * 1000).toLocaleString()}
                                </span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Mint</span>
                                <span className="text-foreground truncate max-w-[200px]">
                                    {transaction.mint?.replace('https://', '').replace(/\/$/, '') || 'Unknown'}
                                </span>
                            </div>
                            {transaction.memo && (
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Memo</span>
                                    <span className="text-foreground">{transaction.memo}</span>
                                </div>
                            )}
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Type</span>
                                <span className="text-foreground">
                                    {transaction.isNutzap ? 'NutZap (NIP-61)' : 'Direct eCash'}
                                </span>
                            </div>
                        </div>

                        {/* Token (if outgoing) */}
                        {transaction.token && (
                            <div>
                                <label className="text-xs text-muted-foreground font-medium mb-1 block">Token</label>
                                <div className="bg-background border border-border rounded-xl p-3 text-xs font-mono text-muted-foreground break-all max-h-24 overflow-y-auto">
                                    {transaction.token}
                                </div>
                                <button
                                    onClick={copyToken}
                                    className="mt-2 w-full py-2 bg-secondary/50 hover:bg-secondary text-foreground text-sm rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                                >
                                    {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                                    {copied ? 'Copied!' : 'Copy Token'}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
