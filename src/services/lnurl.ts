/**
 * Lightning Address (LNURL-pay) Service
 * Implements LUD-16 specification for resolving Lightning addresses.
 * Port of PWANS services/lnurl.ts.
 */

interface LnurlPayResponse {
    callback: string;
    minSendable: number;
    maxSendable: number;
    metadata: string;
    tag: string;
}

interface InvoiceResponse {
    pr: string; // BOLT11 invoice
    routes?: any[];
}

export class LnurlService {
    /**
     * Check if input is a valid Lightning address.
     */
    static isLightningAddress(input: string): boolean {
        const regex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
        return regex.test(input.trim());
    }

    /**
     * Parse Lightning address into username and domain.
     */
    static parseLightningAddress(address: string): { username: string; domain: string } {
        const [username, domain] = address.split('@');
        return { username, domain };
    }

    /**
     * Resolve Lightning address to BOLT11 invoice.
     * @param address - Lightning address (name@domain.com)
     * @param amountSats - Amount in satoshis
     * @returns BOLT11 invoice string
     */
    static async resolveToInvoice(
        address: string,
        amountSats: number
    ): Promise<string> {
        try {
            const { username, domain } = this.parseLightningAddress(address);
            console.log(`🔍 Resolving ${username}@${domain} for ${amountSats} sats`);

            // Step 1: Get LNURL-pay endpoint
            const lnurlEndpoint = `https://${domain}/.well-known/lnurlp/${username}`;
            console.log(`📡 Fetching: ${lnurlEndpoint}`);

            const lnurlResponse = await fetch(lnurlEndpoint);
            if (!lnurlResponse.ok) {
                throw new Error(`Failed to fetch Lightning address info: ${lnurlResponse.statusText}`);
            }

            const lnurlData: LnurlPayResponse = await lnurlResponse.json();

            // Validate response
            if (lnurlData.tag !== 'payRequest') {
                throw new Error('Invalid LNURL-pay response');
            }

            // Step 2: Check amount limits
            const amountMsat = amountSats * 1000;
            if (amountMsat < lnurlData.minSendable || amountMsat > lnurlData.maxSendable) {
                const minSats = Math.ceil(lnurlData.minSendable / 1000);
                const maxSats = Math.floor(lnurlData.maxSendable / 1000);
                throw new Error(`Amount must be between ${minSats} and ${maxSats} sats`);
            }

            // Step 3: Request invoice
            const callbackUrl = `${lnurlData.callback}?amount=${amountMsat}`;
            console.log(`💰 Requesting invoice: ${callbackUrl}`);

            const invoiceResponse = await fetch(callbackUrl);
            if (!invoiceResponse.ok) {
                throw new Error(`Failed to get invoice: ${invoiceResponse.statusText}`);
            }

            const invoiceData: InvoiceResponse = await invoiceResponse.json();

            if (!invoiceData.pr) {
                throw new Error('No invoice returned from Lightning address');
            }

            console.log('✅ Lightning address resolved to invoice');
            return invoiceData.pr;
        } catch (error: any) {
            console.error('❌ Lightning address resolution failed:', error);
            throw new Error(`Failed to resolve ${address}: ${error.message}`);
        }
    }
}
