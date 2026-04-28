/**
 * Blockchain icon registry — local PNG imports.
 * No network fetches, no blossom, no hash verification needed.
 * Just drop the PNGs into the native/ and token/ directories.
 */

// ── Native chain icons ──
import bitcoin from '@/assets/icons/blockchain/native/bitcoin128.png';
import ethereum from '@/assets/icons/blockchain/native/ethereum128.png';
import bnbchain from '@/assets/icons/blockchain/native/bnbchain128.png';
import polygon from '@/assets/icons/blockchain/native/polygon128.png';
import avalanche from '@/assets/icons/blockchain/native/avalanche128.png';
import base from '@/assets/icons/blockchain/native/base128.png';
import zcash from '@/assets/icons/blockchain/native/zcash128.png';

// ── Token icons ──
import usdt from '@/assets/icons/blockchain/token/usdt128.png';
import usdc from '@/assets/icons/blockchain/token/usdc128.png';
import dai from '@/assets/icons/blockchain/token/dai128.png';
import busd from '@/assets/icons/blockchain/token/busd128.png';
import pyusd from '@/assets/icons/blockchain/token/pyusd128.png';
import euroc from '@/assets/icons/blockchain/token/euroc128.png';

/** Native chain icons keyed by chain ID */
export const chainIcons: Record<string, string> = {
    bitcoin,
    ethereum,
    bnb: bnbchain,
    polygon,
    avalanche,
    base,
    zcash,
};

/** Token icons keyed by uppercase symbol */
export const tokenIcons: Record<string, string> = {
    USDT: usdt,
    USDC: usdc,
    DAI: dai,
    BUSD: busd,
    PYUSD: pyusd,
    EURC: euroc,
    // Native tokens map to their chain icon
    ETH: ethereum,
    BNB: bnbchain,
    POL: polygon,
    AVAX: avalanche,
    BTC: bitcoin,
    ZEC: zcash,
};
