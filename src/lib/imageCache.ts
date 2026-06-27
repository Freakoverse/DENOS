/**
 * Image Blob Cache (ported from DEN Chat).
 *
 * L1: in-memory Map (URL → blob: URL) — instant, session-scoped
 * L2: persistent Blossom cache (hash → blob) — survives restart, LRU budget
 * L3: network fetch (write-through to both layers)
 *
 * For Blossom/hash-based URLs the persistent layer is content-addressed, so a changed
 * kind:0 picture URL is a cache miss that fetches fresh media automatically.
 */
import { useState, useEffect, useRef } from 'react';
import { extractBlossomHash, getFromPersistentCache, putInPersistentCache } from '@/lib/blossomMediaCache';

const blobCache = new Map<string, string>();
export const IMAGE_TOO_LARGE = '__too_large__';
const pendingFetches = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
const failedUrls = new Set<string>();

function isCacheableUrl(url: string): boolean {
    return url.startsWith('http://') || url.startsWith('https://');
}

export function getCachedImageUrl(url: string): string | undefined {
    return blobCache.get(url);
}

export function fetchAndCacheImage(url: string, onCached: () => void): void {
    if (!isCacheableUrl(url) || blobCache.has(url) || failedUrls.has(url)) return;
    if (!listeners.has(url)) listeners.set(url, new Set());
    listeners.get(url)!.add(onCached);
    if (!pendingFetches.has(url)) _doFetch(url);
}

function _doFetch(url: string, maxBytes?: number): void {
    pendingFetches.add(url);
    (async () => {
        try {
            const blossomHash = extractBlossomHash(url);
            if (blossomHash) {
                const cachedBlob = await getFromPersistentCache(blossomHash);
                if (cachedBlob) {
                    if (maxBytes && cachedBlob.size > maxBytes) { blobCache.set(url, IMAGE_TOO_LARGE); _notify(url); return; }
                    blobCache.set(url, URL.createObjectURL(cachedBlob));
                    _notify(url);
                    return;
                }
            }

            const res = await fetch(url, { mode: 'cors' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            if (maxBytes) {
                const cl = res.headers.get('content-length');
                if (cl) { const size = Number(cl); if (!isNaN(size) && size > maxBytes) { blobCache.set(url, IMAGE_TOO_LARGE); _notify(url); return; } }
            }

            const blob = await res.blob();
            if (maxBytes && blob.size > maxBytes) { blobCache.set(url, IMAGE_TOO_LARGE); _notify(url); return; }
            blobCache.set(url, URL.createObjectURL(blob));
            _notify(url);
            if (blossomHash) putInPersistentCache(blossomHash, blob).catch(() => { });
        } catch {
            failedUrls.add(url);
        } finally {
            pendingFetches.delete(url);
            listeners.delete(url);
        }
    })();
}

function _notify(url: string): void {
    const cbs = listeners.get(url);
    if (cbs) for (const cb of cbs) cb();
}

/**
 * Returns the best available URL for an image:
 * - cached blob URL (instant, no network) when available
 * - otherwise the original URL while it fetches in the background, then re-renders to blob
 * Passes through non-HTTP URLs (blob:, data:) unchanged.
 */
export function useCachedImageUrl(src: string | undefined, maxSizeMB?: number): string | undefined {
    const [, forceUpdate] = useState(0);
    const mountedRef = useRef(true);
    useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

    if (!src) return undefined;
    const cached = getCachedImageUrl(src);
    if (cached === IMAGE_TOO_LARGE) return IMAGE_TOO_LARGE;
    if (cached) return cached;

    if (isCacheableUrl(src)) {
        const maxBytes = maxSizeMB != null && maxSizeMB > 0 ? maxSizeMB * 1024 * 1024 : undefined;
        fetchAndCacheImage(src, () => { if (mountedRef.current) forceUpdate(t => t + 1); });
        if (maxBytes && !pendingFetches.has(src) && !blobCache.has(src) && !failedUrls.has(src)) _doFetch(src, maxBytes);
    }
    return src;
}
