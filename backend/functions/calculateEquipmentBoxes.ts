import { CalculateEquipmentBoxes, models } from '@teamkeel/sdk';

// To learn more about what you can do with custom functions, visit https://docs.keel.so/functions
export default CalculateEquipmentBoxes(async (ctx, inputs) => {
    const quote = await models.quote.findOne({id: inputs.id});

    if (!quote) {
        throw new Error('Quote not found');
    }

    // Get all available equipment boxes, sorted by effective volume (largest first)
    const equipmentBoxes = await models.equipmentBox.findMany({ where: { boxType: inputs.boxType } });

    if (equipmentBoxes.length === 0) {
        throw new Error('No equipment boxes available');
    }

    // Sort equipment boxes by effective volume (largest first)
    equipmentBoxes.sort((a, b) => Number(b.effectiveVolume) - Number(a.effectiveVolume));

    // Get all quote products
    const quoteProducts = await models.quoteProduct.findMany({
        where: { quoteId: quote.id }
    });

    if (quoteProducts.length === 0) {
        throw new Error('No products found in quote');
    }

    // Calculate total volume needed for all products
    let totalVolumeNeeded = 0;
    
    for (const quoteProduct of quoteProducts) {
        // Get the product details
        const product = await models.product.findOne({ id: quoteProduct.productId });
        
        if (!product) {
            throw new Error(`Product not found for quote product ${quoteProduct.id}`);
        }
        
        if (!product.volume) {
            throw new Error(`Product ${product.name} (${product.sku}) does not have volume information`);
        }
        
        // Calculate volume for this product line item (product volume * quantity)
        const productLineVolume = Number(product.volume) * quoteProduct.quantity;
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

    // Calculate equipment boxes needed
    interface EquipmentBoxNeeded {
        equipmentBoxId: string;
        price: number;
        quantity: number;
        effectiveVolume: number;
        volumeUsed: number;
    }
    
    const equipmentBoxesNeeded: EquipmentBoxNeeded[] = [];
    let remainingVolume = totalVolumeNeeded;

    for (const equipmentBox of equipmentBoxes) {
        const effectiveVolume = Number(equipmentBox.effectiveVolume);
        
        if (remainingVolume <= 0) {
            break;
        }

        // Calculate how many of this equipment box type we need
        const boxesNeeded = Math.ceil(remainingVolume / effectiveVolume);
        
        if (boxesNeeded > 0) {
            equipmentBoxesNeeded.push({
                equipmentBoxId: equipmentBox.id,
                price: equipmentBox.price,
                quantity: boxesNeeded,
                effectiveVolume: effectiveVolume,
                volumeUsed: Math.min(remainingVolume, effectiveVolume * boxesNeeded)
            });
            
            remainingVolume -= effectiveVolume * boxesNeeded;
        }
    }

    // Create quote equipment boxes
    const createdQuoteEquipmentBoxes: any[] = [];
    
    for (const boxNeeded of equipmentBoxesNeeded) {
        const quoteEquipmentBox = await models.quoteEquipmentBox.create({
            quoteId: quote.id,
            equipmentBoxId: boxNeeded.equipmentBoxId,
            quantity: boxNeeded.quantity,
            price: boxNeeded.price
        });
        
        createdQuoteEquipmentBoxes.push(quoteEquipmentBox);
    }

    // Return summary of the calculation
    return {
        quoteId: quote.id,
        totalVolumeNeeded: totalVolumeNeeded,
        equipmentBoxesUsed: equipmentBoxesNeeded.map(box => ({
            equipmentBoxId: box.equipmentBoxId,
            quantity: box.quantity,
            effectiveVolume: box.effectiveVolume,
            volumeUsed: box.volumeUsed
        })),
        totalEquipmentBoxes: equipmentBoxesNeeded.reduce((sum, box) => sum + box.quantity, 0),
        createdQuoteEquipmentBoxes: createdQuoteEquipmentBoxes
    };
});