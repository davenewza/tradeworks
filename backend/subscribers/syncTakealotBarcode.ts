import { SyncTakealotBarcode } from '@teamkeel/sdk';
import { syncProductBarcodeFromTakealot } from '../lib/takealotOfferHelpers';

// Keeps a product's Takealot channel code in step with the barcode Takealot
// holds against its offer. Fires on every product create and update, but only
// calls out when the SKU is new or changed — the SKU is what identifies the
// offer, so any other edit cannot alter which barcode applies. Bulk backfill
// is the SyncTakealotBarcodes flow; this covers day-to-day catalogue changes.
export default SyncTakealotBarcode(async (ctx, event) => {
    if (event.eventName === 'product.updated' && event.target.data.sku === event.target.previousData.sku) {
        return;
    }

    // Without a key (e.g. local dev) skip quietly rather than failing the
    // event on every product write.
    if (!ctx.secrets.TAKEALOT_API_KEY) {
        console.log(`Takealot barcode sync skipped for ${event.target.data.sku}: TAKEALOT_API_KEY is not set`);
        return;
    }

    const result = await syncProductBarcodeFromTakealot(ctx, {
        id: event.target.id,
        sku: event.target.data.sku,
    });

    console.log(`Takealot barcode sync for ${event.target.data.sku}: ${result.outcome}`);
});
