import { X, ArrowRight } from 'lucide-react';
import { getMinimumDnnIdAmount } from '@/services/dnn';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface AcquireIdModalProps {
    onClose: () => void;
    onOpenSend: () => void;
}

export function AcquireIdModal({ onClose, onOpenSend }: AcquireIdModalProps) {
    return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="flex min-h-full items-center justify-center px-4 py-20">
                <Card className="w-[380px] shadow-2xl">
                    <CardHeader className="flex-row items-center justify-between">
                        <CardTitle className="text-base flex items-center gap-2">
                            Acquire a DNN ID
                        </CardTitle>
                        <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                            <X className="w-4 h-4" />
                        </button>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <p className="text-sm text-muted-foreground leading-relaxed">
                            To acquire a new DNN ID, send Bitcoin to yourself (self-transfer) using your current address.
                        </p>

                        <div className="bg-secondary/50 rounded-lg p-4 space-y-2">
                            <h4 className="font-medium text-sm text-foreground">Requirements:</h4>
                            <ul className="text-xs text-muted-foreground space-y-1.5">
                                <li className="flex items-start gap-2">
                                    <span className="text-primary mt-0.5">•</span>
                                    <span>Minimum amount: <span className="text-foreground font-medium">~{getMinimumDnnIdAmount()} sats</span> (avoid dust limit)</span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-primary mt-0.5">•</span>
                                    <span>Advised minimum fee rate: <span className="text-foreground font-medium">1 sat/vB</span></span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-primary mt-0.5">•</span>
                                    <span>Recipient: <span className="text-foreground font-medium">Your own address</span> (self-transfer)</span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-primary mt-0.5">•</span>
                                    <span>Confirmation time: <span className="text-foreground font-medium">~10 minutes</span></span>
                                </li>
                            </ul>
                        </div>

                        <p className="text-xs text-muted-foreground text-center">
                            After the transaction confirms, come back here to claim your DNN ID.
                        </p>

                        <div className="flex gap-2 pt-2">
                            <Button variant="outline" className="flex-1" onClick={onClose}>
                                Cancel
                            </Button>
                            <Button className="flex-1 gap-1.5" onClick={onOpenSend}>
                                Open Send
                                <ArrowRight className="w-4 h-4" />
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
