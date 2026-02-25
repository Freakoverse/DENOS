import { useState, useCallback, createContext, useContext, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle, Info, X } from 'lucide-react';
import {
    Dialog, DialogContent, DialogHeader, DialogTitle,
    DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/* ═══════════════════════════════════════════════
 * 1. Toast notifications (replaces alert())
 * ═══════════════════════════════════════════════ */

type ToastVariant = 'error' | 'success' | 'info';

interface Toast {
    id: number;
    message: string;
    variant: ToastVariant;
}

let _nextId = 0;

interface FeedbackContextValue {
    toast: (message: string, variant?: ToastVariant) => void;
    confirm: (opts: ConfirmOptions) => void;
}

interface ConfirmOptions {
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'default' | 'destructive';
    onConfirm: () => void;
}

const FeedbackContext = createContext<FeedbackContextValue>({
    toast: () => { },
    confirm: () => { },
});

export function useFeedback() {
    return useContext(FeedbackContext);
}

const ICON_MAP = {
    error: AlertTriangle,
    success: CheckCircle,
    info: Info,
} as const;

const BG_MAP = {
    error: 'bg-destructive/90 text-destructive-foreground border-destructive/50',
    success: 'bg-success/90 text-white border-success/50',
    info: 'bg-primary/90 text-primary-foreground border-primary/50',
} as const;

export function FeedbackProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [confirmState, setConfirmState] = useState<ConfirmOptions | null>(null);

    const showToast = useCallback((message: string, variant: ToastVariant = 'error') => {
        const id = ++_nextId;
        setToasts(prev => [...prev, { id, message, variant }]);
        setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id));
        }, 4000);
    }, []);

    const dismissToast = useCallback((id: number) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    const showConfirm = useCallback((opts: ConfirmOptions) => {
        setConfirmState(opts);
    }, []);

    return (
        <FeedbackContext.Provider value={{ toast: showToast, confirm: showConfirm }}>
            {children}

            {/* Toast stack */}
            <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[200] flex flex-col gap-2 w-[90%] max-w-sm pointer-events-none">
                {toasts.map(t => {
                    const Icon = ICON_MAP[t.variant];
                    return (
                        <div
                            key={t.id}
                            className={cn(
                                "pointer-events-auto flex items-start gap-2.5 px-4 py-3 rounded-xl border backdrop-blur-lg shadow-xl animate-slide-up",
                                BG_MAP[t.variant]
                            )}
                        >
                            <Icon className="w-4.5 h-4.5 mt-0.5 shrink-0" />
                            <p className="text-sm flex-1 leading-snug">{t.message}</p>
                            <button onClick={() => dismissToast(t.id)} className="shrink-0 cursor-pointer opacity-70 hover:opacity-100 transition-opacity">
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                    );
                })}
            </div>

            {/* Confirmation dialog */}
            <Dialog open={!!confirmState} onOpenChange={(open) => { if (!open) setConfirmState(null); }}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{confirmState?.title}</DialogTitle>
                        <DialogDescription>{confirmState?.description}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setConfirmState(null)}>
                            {confirmState?.cancelLabel || 'Cancel'}
                        </Button>
                        <Button
                            variant={confirmState?.variant || 'default'}
                            onClick={() => {
                                confirmState?.onConfirm();
                                setConfirmState(null);
                            }}
                        >
                            {confirmState?.confirmLabel || 'Confirm'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </FeedbackContext.Provider>
    );
}
