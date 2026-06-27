/**
 * CachedImg — drop-in <img> that serves profile pictures / media from the persistent
 * Blossom cache. Shows the original URL while fetching, swaps to the cached blob, and
 * auto-fetches fresh media when the URL changes (content-addressed). Renders nothing if
 * there's no src or the image exceeds the size limit.
 */
import React from 'react';
import { useCachedImageUrl, IMAGE_TOO_LARGE } from '@/lib/imageCache';

interface CachedImgProps extends React.ImgHTMLAttributes<HTMLImageElement> {
    src?: string;
    maxSizeMB?: number;
}

export const CachedImg: React.FC<CachedImgProps> = ({ src, maxSizeMB = 5, ...rest }) => {
    const cached = useCachedImageUrl(src, maxSizeMB);
    if (!src || cached === IMAGE_TOO_LARGE) return null;
    return <img src={cached || src} {...rest} />;
};
