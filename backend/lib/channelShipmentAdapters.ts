// The registry of platforms we can pull fulfilment-centre consignments from.
//
// Adding a channel is an entry here plus a module that produces
// `ExternalShipment[]` — the flow, the models and the label printing already
// know nothing about which platform they are looking at.

import { ExternalShipment, ShipmentFetchOptions } from './channelShipmentHelpers';

export type { ShipmentFetchOptions };
import { TakealotCtx } from './takealotOfferHelpers';
import { fetchTakealotShipments } from './takealotShipmentHelpers';
import { TAKEALOT_CHANNEL_NAME } from './zohoChannelFeeHelpers';
import { ProgressReporter } from './progress';

// The slice of ctx the adapters need — the intersection of every platform's env
// vars and secrets. A flow, function or subscriber ctx satisfies it
// structurally. As adapters are added this becomes `TakealotCtx & AmazonCtx`.
export type ShipmentSyncCtx = TakealotCtx;


export interface ChannelShipmentAdapter {
    // Must match the Channel row's name — the same name the fee and barcode
    // syncs key on, so all three land on one channel.
    channelName: string;
    // False when the platform's credentials are not set (local dev, or before a
    // key is issued). The flow says so rather than failing mid-fetch.
    isConfigured(ctx: ShipmentSyncCtx): boolean;
    fetch(
        ctx: ShipmentSyncCtx,
        options: ShipmentFetchOptions,
        progress?: ProgressReporter
    ): Promise<ExternalShipment[]>;
}

const takealotAdapter: ChannelShipmentAdapter = {
    channelName: TAKEALOT_CHANNEL_NAME,
    isConfigured: (ctx) => Boolean(ctx.secrets.TAKEALOT_API_KEY && ctx.env.TAKEALOT_API_BASE_URL),
    fetch: (ctx, options, progress) => fetchTakealotShipments(ctx, options, progress),
};

export const SHIPMENT_ADAPTERS: ChannelShipmentAdapter[] = [takealotAdapter];

/** The adapter for a channel name, or undefined if we cannot pull its shipments. */
export function adapterFor(channelName: string): ChannelShipmentAdapter | undefined {
    return SHIPMENT_ADAPTERS.find((a) => a.channelName === channelName);
}

/** Adapters whose credentials are actually set, in name order. */
export function configuredAdapters(ctx: ShipmentSyncCtx): ChannelShipmentAdapter[] {
    return SHIPMENT_ADAPTERS.filter((a) => a.isConfigured(ctx)).sort((a, b) =>
        a.channelName.localeCompare(b.channelName)
    );
}
