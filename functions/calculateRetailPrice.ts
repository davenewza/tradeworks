import { CalculateRetailPrice, models } from '@teamkeel/sdk';

export default CalculateRetailPrice(async (ctx, inputs) => {

    const product = await models.product.findOne({ id: inputs.id });

    if (!product) {
        return {
            name: "validation error",
            message: "product not found"
        };
    }

    const totalCost =    product.costPrice + product.freightIn;
    const retailPrice = totalCost / 100 * inputs.grossProfit + totalCost;

    return {
        totalCost,
        grossProfitPercentage: inputs.grossProfit,
        grossProfit: retailPrice - totalCost,
        retailPrice,
    };
});