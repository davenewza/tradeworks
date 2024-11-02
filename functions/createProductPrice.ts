import { CreateProductPrice, CreateProductPriceHooks, models } from '@teamkeel/sdk';

// To learn more about what you can do with hooks, visit https://docs.keel.so/functions
const hooks : CreateProductPriceHooks = {};

export default CreateProductPrice({


    async beforeWrite(ctx, inputs, values) {
        const product = await models.product.findOne({ id: values.product.id });
        if (!product) {
            return {
                name: "validation error",
                message: "product not found"
            }
        }
        const totalCost = product.costPrice + product.freightIn;
        const grossProfit = totalCost / 100 * values.grossProfitMargin;
        return {
            channelId: values.channel.id,
            description: values.description,
            productId: values.product.id,
            grossProfitMargin: values.grossProfitMargin,
            totalCost: totalCost,
            grossProfit: grossProfit,
            retailPrice: totalCost + grossProfit
        };
    },
});
	