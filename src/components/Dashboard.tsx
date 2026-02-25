import type { AppState } from '../App';
import { Radio, Shield } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface Props {
    appState: AppState;
}

export function Dashboard({ appState }: Props) {
    const activeKp = appState.keypairs.find((kp) => kp.pubkey === appState.active_keypair);

    if (!activeKp) {
        return (
            <div className="flex flex-col items-center justify-center py-16 gap-4 text-muted-foreground">
                <Shield className="w-16 h-16 opacity-20" />
                <h3 className="text-xl font-semibold text-foreground">No Active Keypair</h3>
                <p className="text-base">Select a keypair from the Keys tab to get started</p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle>Active Signer</CardTitle>
                    <Badge variant="destructive" className="gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-destructive" />
                        Disconnected
                    </Badge>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-col gap-1">
                        <span className="text-base font-medium">{activeKp.name || 'Unnamed Key'}</span>
                        <span className="text-sm text-muted-foreground font-mono break-all">
                            {activeKp.npub}
                        </span>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Connections</CardTitle>
                    <Badge variant="secondary">NIP-46</Badge>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-col items-center py-8 gap-3 text-muted-foreground">
                        <Radio className="w-12 h-12 opacity-20" />
                        <p className="text-base text-center max-w-xs">
                            No active connections. Connect via bunker:// URI or scan a nostrconnect:// QR code.
                        </p>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Recent Activity</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground text-center py-4">No signing activity yet</p>
                </CardContent>
            </Card>
        </div>
    );
}
