import { SyncAmazonFnsku } from '@teamkeel/sdk';
import { amazonIsConfigured } from '../lib/amazonApi';
import { syncProductFnskuFromAmazon } from '../lib/amazonFnskuHelpers';

// Keeps a product's Amazon channel code in step with the FNSKU Amazon holds
// against its FBA listing. Fires on every product create and update, but only
// calls out when the SKU is new or changed — the seller SKU is what identifies
// the listing, so any other edit cannot alter which FNSKU applies.
//
// Unlike the Takealot barcode, an FNSKU only exists once the FBA listing does,
// and that is usually after the product reaches us from Zoho — so this often
// finds nothing, which is why it is not the only path. The
// ScheduledSyncChannelCodes sweep picks the code up once Amazon mints it, and
// SyncAmazonFnskus is the manual backfill.
export default SyncAmazonFnsku(async (ctx, event) => {
    if (event.eventName === 'product.updated' && event.target.data.sku === event.target.previousData.sku) {
        return;
    }

    // Without credentials (e.g. local dev) skip quietly rather than failing the
    // event on every product write.
    if (!amazonIsConfigured(ctx)) {
        console.log(`Amazon FNSKU sync skipped for ${event.target.data.sku}: Amazon credentials are not set`);
        return;
    }

    const result = await syncProductFnskuFromAmazon(ctx, {
        id: event.target.id,
        sku: event.target.data.sku,
    });

    console.log(`Amazon FNSKU sync for ${event.target.data.sku}: ${result.outcome}`);
});
