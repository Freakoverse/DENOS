import { useRef, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface Props {
    logs: string[];
}

export function DebugConsole({ logs }: Props) {
    const bottomRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);

    return (
        <div>
            <Card>
                <CardHeader>
                    <CardTitle>Debug Console</CardTitle>
                    <Badge variant="secondary">{logs.length} entries</Badge>
                </CardHeader>
                <CardContent>
                    <div className="bg-background rounded-lg p-4 max-h-[calc(100vh-240px)] overflow-y-auto font-mono text-xs leading-relaxed">
                        {logs.length === 0 ? (
                            <div className="text-muted-foreground text-center py-8">
                                Waiting for log events from Rust backend...
                            </div>
                        ) : (
                            logs.map((log, i) => (
                                <div
                                    key={i}
                                    className={`border-b border-border py-0.5 ${log.includes('ERROR') ? 'text-destructive' :
                                            log.includes('WARN') ? 'text-warning' :
                                                log.includes('INFO') ? 'text-success' :
                                                    'text-muted-foreground'
                                        }`}
                                >
                                    {log}
                                </div>
                            ))
                        )}
                        <div ref={bottomRef} />
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
