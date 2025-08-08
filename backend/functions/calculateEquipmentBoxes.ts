import { CalculateEquipmentBoxes, models } from '@teamkeel/sdk';

// To learn more about what you can do with custom functions, visit https://docs.keel.so/functions
export default CalculateEquipmentBoxes(async (ctx, inputs) => {
    const quote = await models.quote.findOne({id: inputs.id});

    if (!quote) {
        throw new Error('Quote not found');
    }

    await models.quote.update({id: quote.id}, {boxType: inputs.boxType});

    // Get all available equipment boxes, sorted by effective volume (largest first)
    const equipmentBoxes = await models.equipmentBox.findMany({ where: { boxType: inputs.boxType } });

    if (equipmentBoxes.length === 0) {
        throw new Error('No equipment boxes available');
    }

    // Sort equipment boxes by effective volume (largest first)
    equipmentBoxes.sort((a, b) => Number(b.effectiveVolumeInLitres) - Number(a.effectiveVolumeInLitres));

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

    // Calculate equipment boxes needed
    interface EquipmentBoxNeeded {
        equipmentBoxId: string;
        price: number;
        quantity: number;
        effectiveVolume: number;
        volumeUsed: number;
    }
    
    // Use a Map to track equipment box needs and avoid duplicates
    const equipmentBoxesMap = new Map<string, EquipmentBoxNeeded>();
    let remainingVolume = totalVolumeNeeded;

    // Use largest boxes first for most of the volume
    for (let i = 0; i < equipmentBoxes.length - 1; i++) {
        const equipmentBox = equipmentBoxes[i];
        const effectiveVolume = Number(equipmentBox.effectiveVolumeInLitres);
        
        if (remainingVolume <= 0) {
            break;
        }

        // Calculate how many of this equipment box type we need
        const boxesNeeded = Math.floor(remainingVolume / effectiveVolume);
        
        if (boxesNeeded > 0) {
            equipmentBoxesMap.set(equipmentBox.id, {
                equipmentBoxId: equipmentBox.id,
                price: equipmentBox.price,
                quantity: boxesNeeded,
                effectiveVolume: effectiveVolume,
                volumeUsed: effectiveVolume * boxesNeeded
            });
            
            remainingVolume -= effectiveVolume * boxesNeeded;
            console.log(`Selected ${boxesNeeded}x ${equipmentBox.name} (${effectiveVolume}L each). Remaining volume: ${remainingVolume.toFixed(2)}L`);
        }
    }

    // For the final remaining volume, find the smallest box that can fit it
    if (remainingVolume > 0) {
        // Sort equipment boxes by effective volume (smallest first) to find the smallest that fits
        const sortedBySmallest = [...equipmentBoxes].sort((a, b) => Number(a.effectiveVolumeInLitres) - Number(b.effectiveVolumeInLitres));
        
        // Find the smallest box that can fit the remaining volume
        const smallestBoxThatFits = sortedBySmallest.find(box => Number(box.effectiveVolumeInLitres) >= remainingVolume);
        
        if (smallestBoxThatFits) {
            const existingBox = equipmentBoxesMap.get(smallestBoxThatFits.id);
            if (existingBox) {
                existingBox.quantity += 1;
                existingBox.volumeUsed += remainingVolume;
            } else {
                equipmentBoxesMap.set(smallestBoxThatFits.id, {
                    equipmentBoxId: smallestBoxThatFits.id,
                    price: smallestBoxThatFits.price,
                    quantity: 1,
                    effectiveVolume: Number(smallestBoxThatFits.effectiveVolumeInLitres),
                    volumeUsed: remainingVolume
                });
            }
            console.log(`Selected 1x ${smallestBoxThatFits.name} (${smallestBoxThatFits.effectiveVolumeInLitres}L) for remaining volume: ${remainingVolume.toFixed(2)}L`);
        } else {
            // If no box is small enough, use the smallest available box
            const smallestBox = sortedBySmallest[0];
            const existingBox = equipmentBoxesMap.get(smallestBox.id);
            if (existingBox) {
                existingBox.quantity += 1;
                existingBox.volumeUsed += remainingVolume;
            } else {
                equipmentBoxesMap.set(smallestBox.id, {
                    equipmentBoxId: smallestBox.id,
                    price: smallestBox.price,
                    quantity: 1,
                    effectiveVolume: Number(smallestBox.effectiveVolumeInLitres),
                    volumeUsed: remainingVolume
                });
            }
            console.log(`Selected 1x ${smallestBox.name} (${smallestBox.effectiveVolumeInLitres}L) for remaining volume: ${remainingVolume.toFixed(2)}L`);
        }
    }

    // Convert map to array
    const equipmentBoxesNeeded = Array.from(equipmentBoxesMap.values());

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