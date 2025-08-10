import { PricelistUpdate, models } from '@teamkeel/sdk';

// To learn more about events and subscribers, visit https://docs.keel.so/events
export default PricelistUpdate(async (ctx, event) => {
    const user = await models.user.findOne({
        identityId: event.identityId!
    });

    switch (event.eventName) {
        case 'product_price.updated':
            await models.priceListChangeLog.create({
                priceListId: event.target.data.priceListId,
                description: `${event.target.data.productSku} price updated from ${event.target.previousData.priceInclVat} to ${event.target.data.priceInclVat}.`,
                userId: user!.id,
            });
            break;
        case 'product_price.created':
            await models.priceListChangeLog.create({
                priceListId: event.target.data.priceListId,
                description: `${event.target.data.productSku} added to the price list with a price of ${event.target.data.priceInclVat}.`,
                userId: user!.id,
            });
            break;
        case 'product_price.deleted':
            await models.priceListChangeLog.create({
                priceListId: event.target.data.priceListId,
                description: `${event.target.data.productSku} removed from the price list.`,
                userId: user!.id,
            });
            break;
        case 'price_list.created':
            await models.priceListChangeLog.create({
                priceListId: event.target.id,
                description: `${event.target.data.name} created.`,
                userId: user!.id,
            });
            break;
        case 'price_list.updated':
            if (event.target.data.name != event.target.previousData.name) {
                await models.priceListChangeLog.create({
                    priceListId: event.target.id,
                    description: `${event.target.previousData.name} renamed to ${event.target.data.name}.`,
                    userId: user!.id,
                });
            }
            if (event.target.data.description != event.target.previousData.description) {
                await models.priceListChangeLog.create({
                    priceListId: event.target.id,
                    description: `Description updated to ${event.target.data.description}.`,
                    userId: user!.id,
                });
            }
            break;
    }
});