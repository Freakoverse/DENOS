/**
 * NutZap Publisher — Publish NutZap events with retry logic.
 * Port of PWANS services/nutZapPublisher.ts adapted for DENOS (nostr-tools signing, raw WebSocket).
 */
import { Nip61Service } from './nip61';

const DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
    'wss://relay.primal.net',
    'wss://relay.snort.social',
    'wss://relay.azzamo.net',
    'wss://relay.cashumints.space'
];

/**
 * Publish a signed event to relays, counting successes.
 */
async function publishEventToRelays(
    signedEvent: any,
    relayUrls: string[]
): Promise<number> {
    let successCount = 0;

    const promises = relayUrls.map(relayUrl => {
        return new Promise<void>((resolve) => {
            try {
                const ws = new WebSocket(relayUrl);
                const timer = setTimeout(() => {
                    try { ws.close(); } catch { /* ignore */ }
                    resolve();
                }, 8000);

                ws.onopen = () => {
                    ws.send(JSON.stringify(['EVENT', signedEvent]));
                };

                ws.onmessage = (msg) => {
                    try {
                        const data = JSON.parse(msg.data);
                        if (data[0] === 'OK' && data[2] === true) {
                            successCount++;
                        }
                    } catch { /* ignore */ }
                    clearTimeout(timer);
                    try { ws.close(); } catch { /* ignore */ }
                    resolve();
                };

                ws.onerror = () => {
                    clearTimeout(timer);
                    resolve();
                };
            } catch {
                resolve();
            }
        });
    });

    await Promise.allSettled(promises);
    return successCount;
}

/**
 * Publish a NutZap event with retry logic (exponential backoff).
 *
 * @param token - Cashu token string
 * @param mintUrl - Mint URL
 * @param amount - Amount in sats
 * @param recipientPubkeyHex - Recipient's hex pubkey
 * @param senderPrivateKeyHex - Sender's private key hex
 * @param maxRetries - Maximum number of retry attempts (default 3)
 *
 * @returns { success, relayCount, error? }
 */
export async function publishNutZapWithRetry(
    token: string,
    mintUrl: string,
    amount: number,
    recipientPubkeyHex: string,
    senderPrivateKeyHex: string,
    maxRetries = 3
): Promise<{ success: boolean; relayCount: number; error?: string }> {
    // Create the signed NutZap event
    const signedEvent = Nip61Service.createNutZapEvent(
        token,
        mintUrl,
        amount,
        recipientPubkeyHex,
        senderPrivateKeyHex
    );

    console.log(`📡 Publishing NutZap (${amount} sats to ${recipientPubkeyHex.slice(0, 8)}...)`);

    let lastError = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const relayCount = await publishEventToRelays(signedEvent, DEFAULT_RELAYS);

            if (relayCount > 0) {
                console.log(`✅ NutZap published to ${relayCount} relays (attempt ${attempt})`);
                return { success: true, relayCount };
            }

            lastError = `Published to 0 relays on attempt ${attempt}`;
            console.warn(`⚠️ ${lastError}`);
        } catch (e: any) {
            lastError = e.message || `Unknown error on attempt ${attempt}`;
            console.error(`❌ Attempt ${attempt} failed:`, lastError);
        }

        // Exponential backoff: 2s, 4s, 8s
        if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 1000;
            console.log(`⏳ Retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    return {
        success: false,
        relayCount: 0,
        error: lastError || 'Failed after all retry attempts'
    };
}
