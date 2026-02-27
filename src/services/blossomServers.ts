/**
 * Blossom server management — localStorage-backed with defaults.
 * Mirrors the pattern used by bitcoinNodes in bitcoin.ts.
 */

const STORAGE_KEY = 'denos_blossom_servers';

const DEFAULT_SERVERS = [
    'https://video.nostr.build',
    'https://cdn.sovbit.host',
    'https://blossom.yakihonne.com',
    'https://mibo.eu.nostria.app',
    'https://blossom.primal.net',
    'https://blossom.data.haus',
    'https://cdn.satellite.earth',
    'https://blossom-01.uid.ovh',
    'https://blossom-02.uid.ovh',
    'https://blossom.azzamo.media',
    'https://blossom.band',
    'https://blossom.nostr.hu',
    'https://blossom.nogood.studio',
];

function normalize(url: string): string {
    return url.replace(/\/+$/, '');
}

export const blossomServers = {
    getServers(): string[] {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed) && parsed.length > 0) return parsed;
            }
        } catch { /* ignore */ }
        return [...DEFAULT_SERVERS];
    },

    addServer(url: string): void {
        const servers = this.getServers();
        const normalized = normalize(url);
        if (!servers.includes(normalized)) {
            servers.push(normalized);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
        }
    },

    removeServer(url: string): void {
        const servers = this.getServers().filter(s => s !== url);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
    },

    getDefaults(): string[] {
        return [...DEFAULT_SERVERS];
    },

    resetToDefaults(): void {
        localStorage.removeItem(STORAGE_KEY);
    },

    /** Check if a server responds (HEAD request to root) */
    async checkHealth(url: string): Promise<boolean> {
        try {
            const res = await fetch(normalize(url), { method: 'HEAD', signal: AbortSignal.timeout(5000) });
            return res.ok || res.status === 405; // some servers return 405 for HEAD
        } catch {
            return false;
        }
    },

    /** Get all server hostnames for BlossomVideo to cycle through */
    getHostnames(): string[] {
        return this.getServers().map(url => {
            try {
                return new URL(url).hostname;
            } catch {
                return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
            }
        });
    },
};
