/**
 * BlossomImage — Renders an image fetched from blossom servers
 * with SHA-256 hash verification and automatic failover.
 *
 * Usage:
 *   <BlossomImage hash="abc123..." size={24} fallbackColor="#F7931A" />
 */
import React, { useState, useEffect, useRef } from 'react';
import { blossomServers } from '@/services/blossomServers';

interface BlossomImageProps {
    /** SHA-256 hash of the image file */
    hash: string;
    /** Size in pixels (width & height) */
    size?: number;
    /** Fallback background color when image can't load */
    fallbackColor?: string;
    /** Optional CSS class */
    className?: string;
    /** Alt text */
    alt?: string;
}

/** In-memory cache: hash → verified object URL */
const verifiedUrlCache = new Map<string, string>();

/**
 * Fetch the image blob, verify its SHA-256, and return an object URL.
 * Tries each blossom server in order until one succeeds.
 */
async function fetchVerifiedImage(hash: string): Promise<string | null> {
    // Check cache first
    if (verifiedUrlCache.has(hash)) return verifiedUrlCache.get(hash)!;

    const servers = blossomServers.getServers();

    for (const server of servers) {
        try {
            const url = `${server}/${hash}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (!res.ok) continue;

            const blob = await res.blob();
            const arrayBuffer = await blob.arrayBuffer();

            // SHA-256 verification
            const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const computedHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

            if (computedHash !== hash.toLowerCase()) {
                console.warn(`[BlossomImage] Hash mismatch from ${server}: expected ${hash}, got ${computedHash}`);
                continue;
            }

            // Verified — create object URL and cache it
            const objectUrl = URL.createObjectURL(blob);
            verifiedUrlCache.set(hash, objectUrl);
            return objectUrl;
        } catch {
            // Try next server
            continue;
        }
    }

    return null; // All servers failed
}

export const BlossomImage: React.FC<BlossomImageProps> = ({
    hash,
    size = 20,
    fallbackColor = '#627EEA',
    className = '',
    alt = '',
}) => {
    const [src, setSrc] = useState<string | null>(verifiedUrlCache.get(hash) || null);
    const [failed, setFailed] = useState(false);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        if (!hash) { setFailed(true); return; }
        if (verifiedUrlCache.has(hash)) { setSrc(verifiedUrlCache.get(hash)!); return; }

        setFailed(false);
        setSrc(null);

        fetchVerifiedImage(hash).then(url => {
            if (!mountedRef.current) return;
            if (url) setSrc(url);
            else setFailed(true);
        });

        return () => { mountedRef.current = false; };
    }, [hash]);

    if (!hash || failed || !src) {
        // Fallback: colored circle
        return (
            <div
                className={`rounded-full shrink-0 ${className}`}
                style={{ width: size, height: size, backgroundColor: fallbackColor }}
            />
        );
    }

    return (
        <img
            src={src}
            alt={alt}
            className={`rounded-full object-cover shrink-0 ${className}`}
            style={{ width: size, height: size }}
            onError={() => setFailed(true)}
        />
    );
};
