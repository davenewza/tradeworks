import { CreateQuoteProduct, CreateQuoteProductHooks, models } from '@teamkeel/sdk';

// To learn more about what you can do with hooks, visit https://docs.keel.so/functions
const hooks: CreateQuoteProductHooks = {};

export default CreateQuoteProduct({
    beforeWrite: async (ctx, inputs, values) => {
        const quote = await models.quote.findOne({ id: inputs.quote.id });
        if (!quote) {
            throw new Error('Quote not found');
        }

        const tiers = await models.discountTier.findMany({
            where: {
                priceList: { id: quote.customerPriceListId }
            },
            orderBy: {
                minQuantity: 'asc',
                maxQuantity: 'asc'
            }
        });

        let discount = 0;
        for (const tier of tiers) {
            if (inputs.quantity >= (tier.minQuantity || 0) && (tier.maxQuantity === null || inputs.quantity <= tier.maxQuantity)) {
                discount = tier.discountPercentage;
                break;
            }
        }

        return { ...inputs, discount };
    }
});
