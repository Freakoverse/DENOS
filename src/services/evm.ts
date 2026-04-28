/**
 * Unified EVM Service for DENOS
 * Covers: Ethereum, BNB Chain, Polygon, Avalanche C-Chain, Base
 * All address derivation uses even-y (BIP-340/Nostr convention) for deterministic npub→address.
 */

import { keccak256 } from 'js-sha3';
import * as ecc from '@bitcoinerlab/secp256k1';
import { getECPair } from '@/services/bitcoin';
import { nip19 } from 'nostr-tools';
import { Buffer } from 'buffer';
import { chainIcons, tokenIcons } from '@/assets/icons/blockchain';

// ── Types ──

export interface EvmToken {
    symbol: string;
    name: string;
    contractAddress: string | null;  // null = native token
    decimals: number;
    color: string;
    icon?: string;  // Vite-resolved icon URL
}

export interface EvmChain {
    id: string;
    name: string;
    symbol: string;
    chainId: number;
    storageKey: string;
    defaultNodes: string[];
    explorerApi: string;       // block explorer API base
    explorerUrl: string;       // block explorer web URL
    tokens: EvmToken[];
    color: string;
    icon?: string;  // Vite-resolved icon URL
}

export interface EvmTx {
    hash: string;
    from: string;
    to: string;
    value: string;
    timeStamp: string;
    isError: string;
    gasUsed: string;
    gasPrice: string;
    blockNumber: string;
    confirmations: string;
    tokenSymbol?: string;
    tokenDecimal?: string;
}

export interface GasEstimate {
    slow: bigint;
    standard: bigint;
    fast: bigint;
}

// ── Chain Registry ──

export const EVM_CHAINS: Record<string, EvmChain> = {
    ethereum: {
        id: 'ethereum',
        name: 'Ethereum',
        symbol: 'ETH',
        chainId: 1,
        storageKey: 'denos-ethereum-nodes',
        defaultNodes: [
            'https://eth.llamarpc.com',
            'https://ethereum-rpc.publicnode.com',
            'https://1rpc.io/eth',
        ],
        icon: chainIcons.ethereum,
        explorerApi: 'https://api.etherscan.io/api',
        explorerUrl: 'https://etherscan.io',
        color: '#627EEA',
        tokens: [
            { symbol: 'ETH', name: 'Ethereum', contractAddress: null, decimals: 18, color: '#627EEA', icon: tokenIcons.ETH },
            { symbol: 'USDT', name: 'Tether USD', contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, color: '#26A17B', icon: tokenIcons.USDT },
            { symbol: 'USDC', name: 'USD Coin', contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, color: '#2775CA', icon: tokenIcons.USDC },
            { symbol: 'DAI', name: 'Dai Stablecoin', contractAddress: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, color: '#F5AC37', icon: tokenIcons.DAI },
            { symbol: 'PYUSD', name: 'PayPal USD', contractAddress: '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8', decimals: 6, color: '#0070BA', icon: tokenIcons.PYUSD },
            { symbol: 'EURC', name: 'Euro Coin', contractAddress: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', decimals: 6, color: '#2B6CB0', icon: tokenIcons.EURC },
        ],
    },
    bnb: {
        id: 'bnb',
        name: 'BNB Chain',
        symbol: 'BNB',
        chainId: 56,
        storageKey: 'denos-bnb-nodes',
        defaultNodes: [
            'https://bsc-dataseed1.binance.org',
            'https://bsc-dataseed2.binance.org',
            'https://bsc-rpc.publicnode.com',
        ],
        icon: chainIcons.bnb,
        explorerApi: 'https://api.bscscan.com/api',
        explorerUrl: 'https://bscscan.com',
        color: '#F0B90B',
        tokens: [
            { symbol: 'BNB', name: 'BNB', contractAddress: null, decimals: 18, color: '#F0B90B', icon: tokenIcons.BNB },
            { symbol: 'USDT', name: 'Tether USD', contractAddress: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, color: '#26A17B', icon: tokenIcons.USDT },
            { symbol: 'USDC', name: 'USD Coin', contractAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, color: '#2775CA', icon: tokenIcons.USDC },
            { symbol: 'BUSD', name: 'Binance USD', contractAddress: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18, color: '#F0B90B', icon: tokenIcons.BUSD },
        ],
    },
    polygon: {
        id: 'polygon',
        name: 'Polygon',
        symbol: 'POL',
        chainId: 137,
        storageKey: 'denos-polygon-nodes',
        defaultNodes: [
            'https://polygon-bor-rpc.publicnode.com',
            'https://1rpc.io/matic',
            'https://polygon.drpc.org',
        ],
        icon: chainIcons.polygon,
        explorerApi: 'https://api.polygonscan.com/api',
        explorerUrl: 'https://polygonscan.com',
        color: '#8247E5',
        tokens: [
            { symbol: 'POL', name: 'Polygon', contractAddress: null, decimals: 18, color: '#8247E5', icon: tokenIcons.POL },
            { symbol: 'USDT', name: 'Tether USD', contractAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, color: '#26A17B', icon: tokenIcons.USDT },
            { symbol: 'USDC', name: 'USD Coin', contractAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, color: '#2775CA', icon: tokenIcons.USDC },
        ],
    },
    avalanche: {
        id: 'avalanche',
        name: 'Avalanche',
        symbol: 'AVAX',
        chainId: 43114,
        storageKey: 'denos-avalanche-nodes',
        defaultNodes: [
            'https://api.avax.network/ext/bc/C/rpc',
            'https://avalanche-c-chain-rpc.publicnode.com',
            'https://1rpc.io/avax/c',
        ],
        icon: chainIcons.avalanche,
        explorerApi: 'https://api.snowtrace.io/api',
        explorerUrl: 'https://snowtrace.io',
        color: '#E84142',
        tokens: [
            { symbol: 'AVAX', name: 'Avalanche', contractAddress: null, decimals: 18, color: '#E84142', icon: tokenIcons.AVAX },
            { symbol: 'USDT', name: 'Tether USD', contractAddress: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6, color: '#26A17B', icon: tokenIcons.USDT },
            { symbol: 'USDC', name: 'USD Coin', contractAddress: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6, color: '#2775CA', icon: tokenIcons.USDC },
        ],
    },
    base: {
        id: 'base',
        name: 'Base',
        symbol: 'ETH',
        chainId: 8453,
        storageKey: 'denos-base-nodes',
        defaultNodes: [
            'https://mainnet.base.org',
            'https://base-rpc.publicnode.com',
            'https://1rpc.io/base',
        ],
        icon: chainIcons.base,
        explorerApi: 'https://api.basescan.org/api',
        explorerUrl: 'https://basescan.org',
        color: '#0052FF',
        tokens: [
            { symbol: 'ETH', name: 'Ethereum', contractAddress: null, decimals: 18, color: '#627EEA', icon: tokenIcons.ETH },
            { symbol: 'USDC', name: 'USD Coin', contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, color: '#2775CA', icon: tokenIcons.USDC },
            { symbol: 'EURC', name: 'Euro Coin', contractAddress: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', decimals: 6, color: '#2B6CB0', icon: tokenIcons.EURC },
        ],
    },
};

// ── Address Derivation ──

/**
 * Get the even-y compressed pubkey from a private key.
 * If the natural y is odd, negate the private key.
 * Returns { privateKey, compressedPubkey, uncompressedXY }
 */
function deriveEvenYKeys(privateKeyHex: string): {
    effectivePrivateKey: Buffer;
    compressedPubkey: Buffer;
    uncompressedXY: Buffer;  // 64 bytes: x || y (no 04 prefix)
} {
    const privateKeyBuffer = Buffer.from(privateKeyHex, 'hex');
    const keyPair = getECPair().fromPrivateKey(privateKeyBuffer);
    const compressed = keyPair.publicKey; // 33 bytes: 02/03 || x

    if (compressed[0] === 0x02) {
        // Already even y
        const uncompressed = Buffer.from(ecc.pointCompress(compressed, false));
        return {
            effectivePrivateKey: privateKeyBuffer,
            compressedPubkey: compressed,
            uncompressedXY: uncompressed.slice(1), // strip 04 prefix
        };
    } else {
        // Odd y — negate private key to get even y
        // n (secp256k1 order) - d
        const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
        const d = BigInt('0x' + privateKeyHex);
        const negated = n - d;
        const negatedHex = negated.toString(16).padStart(64, '0');
        const negatedBuffer = Buffer.from(negatedHex, 'hex');
        const negatedKeyPair = getECPair().fromPrivateKey(negatedBuffer);
        const negCompressed = negatedKeyPair.publicKey;
        const uncompressed = Buffer.from(ecc.pointCompress(negCompressed, false));
        return {
            effectivePrivateKey: negatedBuffer,
            compressedPubkey: negCompressed,
            uncompressedXY: uncompressed.slice(1),
        };
    }
}

/**
 * Get the natural (non-forced) keys for the "Standard" address toggle.
 */
function deriveNaturalKeys(privateKeyHex: string): {
    compressedPubkey: Buffer;
    uncompressedXY: Buffer;
} {
    const privateKeyBuffer = Buffer.from(privateKeyHex, 'hex');
    const keyPair = getECPair().fromPrivateKey(privateKeyBuffer);
    const compressed = keyPair.publicKey;
    const uncompressed = Buffer.from(ecc.pointCompress(compressed, false));
    return {
        compressedPubkey: compressed,
        uncompressedXY: uncompressed.slice(1),
    };
}

/**
 * Derive EVM address from uncompressed pubkey XY (64 bytes).
 * Keccak-256 → last 20 bytes → checksum encoding (EIP-55)
 */
function pubkeyXYToEvmAddress(xy: Buffer): string {
    const hash = keccak256(xy);
    const rawAddr = hash.slice(-40);
    return toChecksumAddress('0x' + rawAddr);
}

/**
 * EIP-55 checksum encoding
 */
function toChecksumAddress(address: string): string {
    const addr = address.toLowerCase().replace('0x', '');
    const hash = keccak256(addr);
    let checksummed = '0x';
    for (let i = 0; i < addr.length; i++) {
        checksummed += parseInt(hash[i], 16) >= 8 ? addr[i].toUpperCase() : addr[i];
    }
    return checksummed;
}

/**
 * Derive EVM address from private key (even-y forced).
 */
export function deriveEvmAddress(privateKeyHex: string): string {
    const { uncompressedXY } = deriveEvenYKeys(privateKeyHex);
    return pubkeyXYToEvmAddress(uncompressedXY);
}

/**
 * Derive the "standard" (natural y) EVM address for comparison.
 */
export function deriveStandardEvmAddress(privateKeyHex: string): string {
    const { uncompressedXY } = deriveNaturalKeys(privateKeyHex);
    return pubkeyXYToEvmAddress(uncompressedXY);
}

/**
 * Get the effective private key (even-y normalized) for signing EVM transactions.
 */
export function getEvmSigningKey(privateKeyHex: string): string {
    const { effectivePrivateKey } = deriveEvenYKeys(privateKeyHex);
    return effectivePrivateKey.toString('hex');
}

/**
 * Get the natural (un-negated) private key for signing standard EVM transactions.
 */
export function getStandardSigningKey(privateKeyHex: string): string {
    return privateKeyHex;
}

/**
 * Derive EVM address from npub (public-only, always even-y).
 */
export function npubToEvmAddress(npub: string): string {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') throw new Error('Invalid npub format');
    const pubkeyHex = decoded.data as string;
    // npub = x-only, assume even y → prefix with 02
    const compressed = Buffer.from('02' + pubkeyHex, 'hex');
    const uncompressed = Buffer.from(ecc.pointCompress(compressed, false));
    const xy = uncompressed.slice(1);
    return pubkeyXYToEvmAddress(xy);
}

/**
 * Derive EVM address from raw hex pubkey (32-byte x-only, assumes even y).
 */
export function pubkeyHexToEvmAddress(pubkeyHex: string): string {
    const compressed = Buffer.from('02' + pubkeyHex, 'hex');
    const uncompressed = Buffer.from(ecc.pointCompress(compressed, false));
    const xy = uncompressed.slice(1);
    return pubkeyXYToEvmAddress(xy);
}

// ── RPC Node Management ──

export const evmNodes = {
    getNodes(chainId: string): string[] {
        const chain = EVM_CHAINS[chainId];
        if (!chain) return [];
        try {
            const stored = localStorage.getItem(chain.storageKey);
            if (stored) {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    // Merge: user's stored nodes first, then defaults as fallbacks (deduplicated)
                    const merged = [...parsed];
                    for (const def of chain.defaultNodes) {
                        if (!merged.includes(def)) merged.push(def);
                    }
                    return merged;
                }
            }
        } catch { }
        return [...chain.defaultNodes];
    },

    setNodes(chainId: string, nodes: string[]) {
        const chain = EVM_CHAINS[chainId];
        if (chain) localStorage.setItem(chain.storageKey, JSON.stringify(nodes));
    },

    addNode(chainId: string, url: string) {
        const nodes = this.getNodes(chainId);
        const normalized = url.replace(/\/+$/, '');
        if (!nodes.includes(normalized)) {
            nodes.push(normalized);
            this.setNodes(chainId, nodes);
        }
    },

    removeNode(chainId: string, url: string) {
        const nodes = this.getNodes(chainId).filter(n => n !== url);
        this.setNodes(chainId, nodes);
    },

    async checkNodeHealth(url: string): Promise<boolean> {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) return false;
            const data = await res.json();
            return !!data.result;
        } catch {
            return false;
        }
    },

    getDefaultNodes(chainId: string): string[] {
        return [...(EVM_CHAINS[chainId]?.defaultNodes || [])];
    },
};

// ── JSON-RPC Helper ──

async function rpcCall(chainId: string, method: string, params: any[] = []): Promise<any> {
    const nodes = evmNodes.getNodes(chainId);
    let lastError: Error | null = null;

    for (const url of nodes) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
                signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) { lastError = new Error(`HTTP ${res.status}`); continue; }
            const data = await res.json();
            if (data.error) { lastError = new Error(data.error.message); continue; }
            return data.result;
        } catch (e: any) {
            lastError = e;
        }
    }
    throw lastError || new Error(`All ${chainId} nodes failed`);
}

// ── Balance ──

export async function fetchEvmBalance(chainId: string, address: string): Promise<bigint> {
    const result = await rpcCall(chainId, 'eth_getBalance', [address, 'latest']);
    return BigInt(result);
}

export async function fetchTokenBalance(chainId: string, contractAddress: string, walletAddress: string): Promise<bigint> {
    // ERC-20 balanceOf(address) = 0x70a08231
    const data = '0x70a08231' + walletAddress.replace('0x', '').padStart(64, '0');
    const result = await rpcCall(chainId, 'eth_call', [
        { to: contractAddress, data },
        'latest',
    ]);
    return BigInt(result);
}

// ── Transaction History (Etherscan V2 Unified API) ──

const ETHERSCAN_V2_BASE = 'https://api.etherscan.io/v2/api';

export const etherscanApiKey = {
    get(): string {
        return localStorage.getItem('denos-etherscan-apikey') || 'TZHM2F3WW2TX651G659YREYMMQDNY1XR84';
    },
    set(key: string) {
        localStorage.setItem('denos-etherscan-apikey', key.trim());
    },
};

// ── GoldRush (Covalent) API for cross-chain history fallback ──

const GOLDRUSH_BASE = 'https://api.covalenthq.com/v1';

// GoldRush uses chain name strings, not chain IDs
const GOLDRUSH_CHAIN_NAMES: Record<number, string> = {
    1: 'eth-mainnet',
    56: 'bsc-mainnet',
    137: 'matic-mainnet',
    43114: 'avalanche-mainnet',
    8453: 'base-mainnet',
};

export const goldrushApiKey = {
    get(): string {
        return localStorage.getItem('denos-goldrush-apikey') || 'cqt_rQv6TCdCPb9jqdggvT77fGRyjFcG';
    },
    set(key: string) {
        localStorage.setItem('denos-goldrush-apikey', key.trim());
    },
};

/** Fetch native tx history from GoldRush and convert to EvmTx format */
async function fetchGoldRushNativeHistory(chainId: number, address: string): Promise<EvmTx[] | null> {
    const chainName = GOLDRUSH_CHAIN_NAMES[chainId];
    if (!chainName) return null;
    const apiKey = goldrushApiKey.get();
    if (!apiKey) return null;

    try {
        const url = `${GOLDRUSH_BASE}/${chainName}/address/${address}/transactions_v3/?page-size=25&no-logs=true`;
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(12000),
        });
        if (!res.ok) { console.warn(`[GoldRush Native] HTTP ${res.status} for chainId ${chainId}`); return null; }
        const data = await res.json();
        if (!data.data?.items || !Array.isArray(data.data.items)) {
            console.warn(`[GoldRush Native] No items for chainId ${chainId}:`, data.error_message || 'unknown');
            return null;
        }
        console.log(`[GoldRush Native] chainId=${chainId} results=${data.data.items.length}`);
        return data.data.items
            // Filter out 0-value contract interactions (approvals, spam, internal calls)
            .filter((item: any) => item.value && item.value !== '0' && BigInt(item.value) !== 0n)
            .map((item: any) => ({
                hash: item.tx_hash || '',
                from: item.from_address || '',
                to: item.to_address || '',
                value: item.value || '0',
                timeStamp: Math.floor(new Date(item.block_signed_at).getTime() / 1000).toString(),
                isError: item.successful ? '0' : '1',
                gasUsed: (item.gas_spent || 0).toString(),
                gasPrice: (item.gas_price || 0).toString(),
                blockNumber: (item.block_height || 0).toString(),
                confirmations: '1',
            }));
    } catch (e) {
        console.error('[GoldRush Native] fetch error:', e);
        return null;
    }
}

/** Fetch ERC-20 token transfer history from GoldRush */
async function fetchGoldRushTokenHistory(chainId: number, address: string, contractAddress: string): Promise<EvmTx[] | null> {
    const chainName = GOLDRUSH_CHAIN_NAMES[chainId];
    if (!chainName) return null;
    const apiKey = goldrushApiKey.get();
    if (!apiKey) return null;

    try {
        const url = `${GOLDRUSH_BASE}/${chainName}/address/${address}/transfers_v2/?contract-address=${contractAddress}&page-size=25`;
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(12000),
        });
        if (!res.ok) { console.warn(`[GoldRush Token] HTTP ${res.status} for chainId ${chainId}`); return null; }
        const data = await res.json();
        if (!data.data?.items || !Array.isArray(data.data.items)) {
            console.warn(`[GoldRush Token] No items for chainId ${chainId}:`, data.error_message || 'unknown');
            return null;
        }
        // Each item has a `transfers` array with individual token movements
        const txs: EvmTx[] = [];
        for (const item of data.data.items) {
            if (!item.transfers) continue;
            for (const t of item.transfers) {
                txs.push({
                    hash: item.tx_hash || '',
                    from: t.from_address || '',
                    to: t.to_address || '',
                    value: t.delta || '0',
                    timeStamp: Math.floor(new Date(item.block_signed_at).getTime() / 1000).toString(),
                    isError: item.successful ? '0' : '1',
                    gasUsed: (item.gas_spent || 0).toString(),
                    gasPrice: (item.gas_price || 0).toString(),
                    blockNumber: (item.block_height || 0).toString(),
                    confirmations: '1',
                    tokenSymbol: t.contract_ticker_symbol || undefined,
                    tokenDecimal: t.contract_decimals?.toString() || undefined,
                });
            }
        }
        console.log(`[GoldRush Token] chainId=${chainId} results=${txs.length}`);
        return txs;
    } catch (e) {
        console.error('[GoldRush Token] fetch error:', e);
        return null;
    }
}

/**
 * Helper: try fetching from a given base URL with params.
 * Returns the result array, or null if the API rejected/failed.
 */
async function tryFetchHistory(baseUrl: string, params: URLSearchParams, label: string): Promise<EvmTx[] | null> {
    try {
        const res = await fetch(`${baseUrl}?${params}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) { console.warn(`[${label}] HTTP ${res.status}`); return null; }
        const data = await res.json();
        console.log(`[${label}] status=${data.status} msg=${data.message} results=${Array.isArray(data.result) ? data.result.length : String(data.result).slice(0, 80)}`);
        if (data.status === '1' && Array.isArray(data.result)) return data.result;
        return null;
    } catch (e) {
        console.error(`[${label}] fetch error:`, e);
        return null;
    }
}

// Routescan provides free Etherscan-compatible APIs for many chains (no key needed, 2 rps)
// Note: BNB Chain was dropped by Routescan in March 2026
const ROUTESCAN_BASE = 'https://api.routescan.io/v2/network/mainnet/evm';

export async function fetchEvmTxHistory(chainId: string, address: string): Promise<EvmTx[]> {
    const chain = EVM_CHAINS[chainId];
    if (!chain) return [];
    const apiKey = etherscanApiKey.get();

    const baseParams: Record<string, string> = {
        module: 'account',
        action: 'txlist',
        address,
        startblock: '0',
        endblock: '99999999',
        sort: 'desc',
        page: '1',
        offset: '25',
    };

    // Try V2 unified endpoint first
    const v2Params = new URLSearchParams({ ...baseParams, chainid: chain.chainId.toString() });
    if (apiKey) v2Params.set('apikey', apiKey);
    const v2Result = await tryFetchHistory(ETHERSCAN_V2_BASE, v2Params, `EVM History V2 ${chainId}`);
    if (v2Result !== null) return v2Result;

    // Fallback to chain-specific explorer API
    const fallbackParams = new URLSearchParams(baseParams);
    const fallbackResult = await tryFetchHistory(chain.explorerApi, fallbackParams, `EVM History chain-api ${chainId}`);
    if (fallbackResult !== null) return fallbackResult;

    // Final fallback: Routescan (Etherscan-compatible, free tier)
    const routescanUrl = `${ROUTESCAN_BASE}/${chain.chainId}/etherscan/api`;
    const routescanParams = new URLSearchParams(baseParams);
    const routescanResult = await tryFetchHistory(routescanUrl, routescanParams, `EVM History routescan ${chainId}`);
    if (routescanResult !== null) return routescanResult;

    // Last resort: GoldRush (Covalent) — covers BNB, Base, and all other chains
    const goldRushResult = await fetchGoldRushNativeHistory(chain.chainId, address);
    return goldRushResult ?? [];
}

export async function fetchTokenTxHistory(chainId: string, address: string, contractAddress: string): Promise<EvmTx[]> {
    const chain = EVM_CHAINS[chainId];
    if (!chain) return [];
    const apiKey = etherscanApiKey.get();

    const baseParams: Record<string, string> = {
        module: 'account',
        action: 'tokentx',
        contractaddress: contractAddress,
        address,
        startblock: '0',
        endblock: '99999999',
        sort: 'desc',
        page: '1',
        offset: '25',
    };

    // Try V2 unified endpoint first
    const v2Params = new URLSearchParams({ ...baseParams, chainid: chain.chainId.toString() });
    if (apiKey) v2Params.set('apikey', apiKey);
    const v2Result = await tryFetchHistory(ETHERSCAN_V2_BASE, v2Params, `Token History V2 ${chainId}`);
    if (v2Result !== null) return v2Result;

    // Fallback to chain-specific explorer API
    const fallbackParams = new URLSearchParams(baseParams);
    const fallbackResult = await tryFetchHistory(chain.explorerApi, fallbackParams, `Token History chain-api ${chainId}`);
    if (fallbackResult !== null) return fallbackResult;

    // Final fallback: Routescan
    const routescanUrl = `${ROUTESCAN_BASE}/${chain.chainId}/etherscan/api`;
    const routescanParams = new URLSearchParams(baseParams);
    const routescanResult = await tryFetchHistory(routescanUrl, routescanParams, `Token History routescan ${chainId}`);
    if (routescanResult !== null) return routescanResult;

    // Last resort: GoldRush (Covalent)
    const goldRushResult = await fetchGoldRushTokenHistory(chain.chainId, address, contractAddress);
    return goldRushResult ?? [];
}

// ── Gas Estimation ──

export async function getGasEstimate(chainId: string): Promise<GasEstimate> {
    const gasPrice = await rpcCall(chainId, 'eth_gasPrice');
    const base = BigInt(gasPrice);
    return {
        slow: base * 80n / 100n,
        standard: base,
        fast: base * 130n / 100n,
    };
}

// ── Transaction Nonce ──

export async function getNonce(chainId: string, address: string): Promise<number> {
    const result = await rpcCall(chainId, 'eth_getTransactionCount', [address, 'latest']);
    return parseInt(result, 16);
}

// ── RLP Encoding (minimal, for transaction serialization) ──

function rlpEncode(input: any): Buffer {
    if (Buffer.isBuffer(input)) {
        if (input.length === 1 && input[0] < 0x80) return input;
        return Buffer.concat([rlpLength(input.length, 0x80), input]);
    }
    if (Array.isArray(input)) {
        const encoded = Buffer.concat(input.map(rlpEncode));
        return Buffer.concat([rlpLength(encoded.length, 0xc0), encoded]);
    }
    if (typeof input === 'string') {
        return rlpEncode(Buffer.from(input.replace('0x', ''), 'hex'));
    }
    return rlpEncode(Buffer.alloc(0));
}

function rlpLength(len: number, offset: number): Buffer {
    if (len < 56) return Buffer.from([len + offset]);
    const hexLen = len.toString(16);
    const lenBytes = Buffer.from(hexLen.length % 2 ? '0' + hexLen : hexLen, 'hex');
    return Buffer.concat([Buffer.from([offset + 55 + lenBytes.length]), lenBytes]);
}

function bigintToBuffer(val: bigint): Buffer {
    if (val === 0n) return Buffer.alloc(0);
    let hex = val.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    return Buffer.from(hex, 'hex');
}

// ── EIP-155 Recovery ID ──
// secp256k1 curve order
const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

function modInverse(a: bigint, m: bigint): bigint {
    let [old_r, r] = [((a % m) + m) % m, m];
    let [old_s, s] = [1n, 0n];
    while (r !== 0n) {
        const q = old_r / r;
        [old_r, r] = [r, old_r - q * r];
        [old_s, s] = [s, old_s - q * s];
    }
    return ((old_s % m) + m) % m;
}

function bigintTo32Bytes(val: bigint): Buffer {
    return Buffer.from(val.toString(16).padStart(64, '0'), 'hex');
}

/** Determine the correct EIP-155 recovery id (0 or 1) for a signature */
function findRecoveryId(msgHash: Buffer, r: Buffer, s: Buffer, expectedPubkey: Uint8Array): number {
    const rBI = BigInt('0x' + r.toString('hex'));
    const sBI = BigInt('0x' + s.toString('hex'));
    const z = BigInt('0x' + msgHash.toString('hex'));
    const rInv = modInverse(rBI, SECP256K1_N);
    const u1 = ((SECP256K1_N - (z % SECP256K1_N)) * rInv) % SECP256K1_N;
    const u2 = (sBI * rInv) % SECP256K1_N;

    for (let recId = 0; recId < 2; recId++) {
        try {
            const prefix = recId === 0 ? 0x02 : 0x03;
            const rPoint = Buffer.concat([Buffer.from([prefix]), r]);
            const u1G = ecc.pointFromScalar(bigintTo32Bytes(u1));
            const u2R = ecc.pointMultiply(rPoint, bigintTo32Bytes(u2));
            if (u1G && u2R) {
                const Q = ecc.pointAdd(u1G, u2R);
                if (Q && Buffer.from(Q).equals(Buffer.from(expectedPubkey))) {
                    return recId;
                }
            }
        } catch { continue; }
    }
    return 0;
}

/** Sign an EIP-155 transaction and return { r, s, v } with correct recovery id */
function signEip155(msgHash: Buffer, signingKey: string, chainIdNum: bigint): { r: Buffer; s: Buffer; v: bigint } {
    const keyBuf = Buffer.from(signingKey, 'hex');
    const sig = ecc.sign(msgHash, keyBuf);
    const r = Buffer.from(sig.slice(0, 32));
    const s = Buffer.from(sig.slice(32, 64));
    const expectedPubkey = ecc.pointFromScalar(keyBuf);
    const recId = expectedPubkey ? findRecoveryId(msgHash, r, s, expectedPubkey) : 0;
    const v = chainIdNum * 2n + 35n + BigInt(recId);
    return { r, s, v };
}

// ── Transaction Signing (EIP-155) ──

export async function sendEvmTransaction(
    chainId: string,
    privateKeyHex: string,
    to: string,
    value: bigint,
    gasPrice: bigint,
    gasLimit: bigint = 21000n,
    useStandard: boolean = false,
): Promise<string> {
    const signingKey = useStandard ? getStandardSigningKey(privateKeyHex) : getEvmSigningKey(privateKeyHex);
    const address = useStandard ? deriveStandardEvmAddress(privateKeyHex) : deriveEvmAddress(privateKeyHex);
    const nonce = await getNonce(chainId, address);
    const chain = EVM_CHAINS[chainId];
    if (!chain) throw new Error('Unknown chain');
    const chainIdNum = BigInt(chain.chainId);

    const rawTx = [
        bigintToBuffer(BigInt(nonce)),
        bigintToBuffer(gasPrice),
        bigintToBuffer(gasLimit),
        Buffer.from(to.replace('0x', ''), 'hex'),
        bigintToBuffer(value),
        Buffer.alloc(0),
        bigintToBuffer(chainIdNum),
        Buffer.alloc(0),
        Buffer.alloc(0),
    ];

    const encoded = rlpEncode(rawTx);
    const msgHash = Buffer.from(keccak256(encoded), 'hex');
    const { r, s, v } = signEip155(msgHash, signingKey, chainIdNum);

    const signedTx = [
        bigintToBuffer(BigInt(nonce)),
        bigintToBuffer(gasPrice),
        bigintToBuffer(gasLimit),
        Buffer.from(to.replace('0x', ''), 'hex'),
        bigintToBuffer(value),
        Buffer.alloc(0),
        bigintToBuffer(v),
        r,
        s,
    ];

    const signedEncoded = rlpEncode(signedTx);
    return await rpcCall(chainId, 'eth_sendRawTransaction', ['0x' + signedEncoded.toString('hex')]);
}

// ── ERC-20 Token Transfer ──

export async function sendTokenTransaction(
    chainId: string,
    privateKeyHex: string,
    contractAddress: string,
    to: string,
    amount: bigint,
    gasPrice: bigint,
    gasLimit?: bigint,
    useStandard: boolean = false,
): Promise<string> {
    const data = '0xa9059cbb'
        + to.replace('0x', '').padStart(64, '0')
        + amount.toString(16).padStart(64, '0');

    const signingKey = useStandard ? getStandardSigningKey(privateKeyHex) : getEvmSigningKey(privateKeyHex);
    const address = useStandard ? deriveStandardEvmAddress(privateKeyHex) : deriveEvmAddress(privateKeyHex);
    const nonce = await getNonce(chainId, address);
    const chain = EVM_CHAINS[chainId];
    if (!chain) throw new Error('Unknown chain');
    const chainIdNum = BigInt(chain.chainId);

    // Estimate gas if not provided — proxy/bridged tokens often need >65K
    if (!gasLimit) {
        try {
            const estimate = await rpcCall(chainId, 'eth_estimateGas', [{
                from: address,
                to: contractAddress,
                data: '0x' + data.replace('0x', ''),
            }]);
            // Add 30% buffer for safety
            gasLimit = BigInt(Math.ceil(parseInt(estimate, 16) * 1.3));
            console.log(`[ERC-20] Estimated gas: ${parseInt(estimate, 16)}, using: ${gasLimit}`);
        } catch (e) {
            console.warn('[ERC-20] eth_estimateGas failed, using 100000:', e);
            gasLimit = 100000n;
        }
    }

    const rawTx = [
        bigintToBuffer(BigInt(nonce)),
        bigintToBuffer(gasPrice),
        bigintToBuffer(gasLimit),
        Buffer.from(contractAddress.replace('0x', ''), 'hex'),
        Buffer.alloc(0),
        Buffer.from(data.replace('0x', ''), 'hex'),
        bigintToBuffer(chainIdNum),
        Buffer.alloc(0),
        Buffer.alloc(0),
    ];

    const encoded = rlpEncode(rawTx);
    const msgHash = Buffer.from(keccak256(encoded), 'hex');
    const { r, s, v } = signEip155(msgHash, signingKey, chainIdNum);

    const signedTx = [
        bigintToBuffer(BigInt(nonce)),
        bigintToBuffer(gasPrice),
        bigintToBuffer(gasLimit),
        Buffer.from(contractAddress.replace('0x', ''), 'hex'),
        Buffer.alloc(0),
        Buffer.from(data.replace('0x', ''), 'hex'),
        bigintToBuffer(v),
        r,
        s,
    ];

    const signedEncoded = rlpEncode(signedTx);
    return await rpcCall(chainId, 'eth_sendRawTransaction', ['0x' + signedEncoded.toString('hex')]);
}

// ── Broadcast (for pre-signed tx) ──

export async function broadcastEvmTransaction(chainId: string, signedTxHex: string): Promise<string> {
    return await rpcCall(chainId, 'eth_sendRawTransaction', [signedTxHex.startsWith('0x') ? signedTxHex : '0x' + signedTxHex]);
}

// ── Formatting Helpers ──

export function formatUnits(value: bigint, decimals: number): string {
    const str = value.toString().padStart(decimals + 1, '0');
    const intPart = str.slice(0, str.length - decimals) || '0';
    const fracPart = str.slice(str.length - decimals);
    // Trim trailing zeros, keep at least 2 decimals, cap at 8 max
    const trimmed = fracPart.replace(/0+$/, '').padEnd(2, '0');
    const capped = trimmed.length > 8 ? trimmed.slice(0, 8) : trimmed;
    return `${intPart}.${capped}`;
}

export function formatUnitsFull(value: bigint, decimals: number): string {
    const str = value.toString().padStart(decimals + 1, '0');
    const intPart = str.slice(0, str.length - decimals) || '0';
    const fracPart = str.slice(str.length - decimals);
    return `${intPart}.${fracPart}`;
}

export function parseUnits(value: string, decimals: number): bigint {
    const [intPart, fracPart = ''] = value.split('.');
    const padded = fracPart.padEnd(decimals, '0').slice(0, decimals);
    return BigInt(intPart + padded);
}
