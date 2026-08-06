import { CalculateEquipmentBoxes, models, QuoteStatus } from '@teamkeel/sdk';
import { PackableBox, packEquipmentBoxes } from '../lib/deliveryHelpers';

// To learn more about what you can do with custom functions, visit https://docs.keel.so/functions
export default CalculateEquipmentBoxes(async (ctx, inputs) => {
    const quote = await models.quote.findOne({id: inputs.id});

    if (!quote) {
        throw new Error('Quote not found');
    }

    if (quote.status !== QuoteStatus.Draft) {
        throw new Error('Quote is not in draft status');
    }

    await models.quote.update({id: quote.id}, {boxType: inputs.boxType});

    // Get all available equipment boxes for the selected box type
    const equipmentBoxes = await models.equipmentBox.findMany({ where: { boxType: inputs.boxType, isEnabled: true } });

    if (equipmentBoxes.length === 0) {
        throw new Error('No equipment boxes available');
    }

    // Get all quote products
    const quoteProducts = await models.quoteProduct.findMany({
        where: { quoteId: quote.id }
    });

    if (quoteProducts.length === 0) {
        // Clear existing quote equipment boxes for this quote since there are no products
        const existingQuoteEquipmentBoxes = await models.quoteEquipmentBox.findMany({
            where: { quoteId: quote.id }
        });

        for (const existingBox of existingQuoteEquipmentBoxes) {
            await models.quoteEquipmentBox.delete({ id: existingBox.id });
        }

        // Return summary indicating no equipment boxes needed
        return {
            quoteId: quote.id,
            totalVolumeNeeded: 0,
            equipmentBoxesUsed: [],
            totalEquipmentBoxes: 0,
            createdQuoteEquipmentBoxes: [],
            message: 'No products in quote - all equipment boxes removed'
        };
    }

    // Calculate total volume needed for all products
    let totalVolumeNeeded = 0;

    for (const quoteProduct of quoteProducts) {
        // Get the product details
        const product = await models.product.findOne({ id: quoteProduct.productId });

        if (!product) {
            throw new Error(`Product not found for quote product ${quoteProduct.id}`);
        }

        if (!product.volumeInLitres) {
            throw new Error(`Product ${product.name} (${product.sku}) does not have volume information`);
        }

        // Calculate volume for this product line item (product volume * quantity)
        const productLineVolume = Number(product.volumeInLitres) * quoteProduct.quantity;
        totalVolumeNeeded += productLineVolume;
    }

    console.log(`Total volume needed: ${totalVolumeNeeded} cm³`);

    // Clear existing quote equipment boxes for this quote
    const existingQuoteEquipmentBoxes = await models.quoteEquipmentBox.findMany({
        where: { quoteId: quote.id }
    });

    for (const existingBox of existingQuoteEquipmentBoxes) {
        await models.quoteEquipmentBox.delete({ id: existingBox.id });
    }

    const packableBoxes: PackableBox[] = equipmentBoxes.map(box => ({
        id: box.id,
        name: box.name,
        sku: box.sku,
        price: Number(box.price),
        priceInclVat: Number(box.priceInclVat),
        lengthInCm: Number(box.lengthInCm),
        widthInCm: Number(box.widthInCm),
        heightInCm: Number(box.heightInCm),
        weightInGrams: Number(box.weightInGrams),
        effectiveVolumeInLitres: Number(box.effectiveVolumeInLitres)
    }));

    const packed = packEquipmentBoxes(totalVolumeNeeded, packableBoxes);

    for (const { box, quantity, volumeUsed } of packed) {
        console.log(`Selected ${quantity}x ${box.name} (${box.effectiveVolumeInLitres}L each, ${volumeUsed.toFixed(2)}L used)`);
    }

    // Create quote equipment boxes
    const createdQuoteEquipmentBoxes: any[] = [];

    for (const boxNeeded of packed) {
        const quoteEquipmentBox = await models.quoteEquipmentBox.create({
            quoteId: quote.id,
            equipmentBoxId: boxNeeded.box.id,
            quantity: boxNeeded.quantity,
            price: boxNeeded.box.price
        });

        createdQuoteEquipmentBoxes.push(quoteEquipmentBox);
    }

    // Return summary of the calculation
    return {
        quoteId: quote.id,
        totalVolumeNeeded: totalVolumeNeeded,
        equipmentBoxesUsed: packed.map(boxNeeded => ({
            equipmentBoxId: boxNeeded.box.id,
            quantity: boxNeeded.quantity,
            effectiveVolume: boxNeeded.box.effectiveVolumeInLitres,
            volumeUsed: boxNeeded.volumeUsed
        })),
        totalEquipmentBoxes: packed.reduce((sum, boxNeeded) => sum + boxNeeded.quantity, 0),
        createdQuoteEquipmentBoxes: createdQuoteEquipmentBoxes
    };
});
