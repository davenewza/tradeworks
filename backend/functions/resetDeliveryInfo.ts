import { ResetDeliveryInfo, models, QuoteStatus } from '@teamkeel/sdk';

// To learn more about what you can do with custom functions, visit https://docs.keel.so/functions
export default ResetDeliveryInfo(async (ctx, inputs) => {
    const quote = await models.quote.findOne({id: inputs.id});
    if (!quote) {
        throw new Error('Quote not found');
    }

    if (quote.status !== QuoteStatus.Draft) {
        throw new Error('Quote is not in draft status');
    }

    const quoteEquipmentBoxes = await models.quoteEquipmentBox.findMany({where: {quoteId: quote.id}});
    for (const quoteEquipmentBox of quoteEquipmentBoxes) {
        await models.quoteEquipmentBox.delete({id: quoteEquipmentBox.id});
    }

    await models.quote.update({id: quote.id }, {deliveryService: null, totalDeliveryFees: 0});
});