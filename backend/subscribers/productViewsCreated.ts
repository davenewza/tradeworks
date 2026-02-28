import { ProductViewsCreated, models } from '@teamkeel/sdk';

export default ProductViewsCreated(async (ctx, event) => {
    const { productId, channelId, periodType, periodStart } = event.target.data;

    const existing = await models.productPerformance.findMany({
        where: {
            product: { id: { equals: productId } },
            channel: { id: { equals: channelId } },
            periodType: { equals: periodType },
            periodStart: { equals: periodStart },
        },
    });

    if (existing.length === 0) {
        await models.productPerformance.create({
            product: { id: productId },
            channel: { id: channelId },
            periodType: periodType,
            periodStart: periodStart,
        });
    }
});
