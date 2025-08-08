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

    // Calculate cost per liter for each equipment box to determine most economical choice
    interface BoxWithCostPerLiter {
        id: string;
        name: string;
        price: number;
        effectiveVolumeInLitres: number;
        costPerLiter: number;
    }

    const boxesWithCostPerLiter: BoxWithCostPerLiter[] = equipmentBoxes.map(box => ({
        id: box.id,
        name: box.name,
        price: Number(box.price),
        effectiveVolumeInLitres: Number(box.effectiveVolumeInLitres),
        costPerLiter: Number(box.price) / Number(box.effectiveVolumeInLitres)
    }));

    // Sort by cost per liter (cheapest first) for economical packing
    boxesWithCostPerLiter.sort((a, b) => a.costPerLiter - b.costPerLiter);

    console.log('Equipment boxes sorted by cost per liter:', boxesWithCostPerLiter.map(box => 
        `${box.name}: ${box.effectiveVolumeInLitres}L @ ZAR${box.price} = ZAR${box.costPerLiter.toFixed(2)}/L`
    ));

    // Use most economical boxes first
    while (remainingVolume > 0) {
        let bestOption: BoxWithCostPerLiter | null = null;
        let bestCost = Infinity;
        let bestBoxesNeeded = 0;

        // Find the most economical combination for remaining volume
        for (const box of boxesWithCostPerLiter) {
            const effectiveVolume = box.effectiveVolumeInLitres;
            
            // Calculate how many of this box type we need
            const boxesNeeded = Math.ceil(remainingVolume / effectiveVolume);
            const totalCost = boxesNeeded * box.price;
            
            // Check if this is the most economical option so far
            if (totalCost < bestCost) {
                bestOption = box;
                bestCost = totalCost;
                bestBoxesNeeded = boxesNeeded;
            }
        }

        if (!bestOption) {
            // Fallback: use the smallest box if no economical option found
            const smallestBox = boxesWithCostPerLiter[boxesWithCostPerLiter.length - 1];
            const existingBox = equipmentBoxesMap.get(smallestBox.id);
            if (existingBox) {
                existingBox.quantity += 1;
                existingBox.volumeUsed += remainingVolume;
            } else {
                equipmentBoxesMap.set(smallestBox.id, {
                    equipmentBoxId: smallestBox.id,
                    price: smallestBox.price,
                    quantity: 1,
                    effectiveVolume: smallestBox.effectiveVolumeInLitres,
                    volumeUsed: remainingVolume
                });
            }
            break;
        }

        // Add the most economical option to our map
        const existingBox = equipmentBoxesMap.get(bestOption.id);
        if (existingBox) {
            existingBox.quantity += bestBoxesNeeded;
            existingBox.volumeUsed += Math.min(remainingVolume, bestOption.effectiveVolumeInLitres * bestBoxesNeeded);
        } else {
            equipmentBoxesMap.set(bestOption.id, {
                equipmentBoxId: bestOption.id,
                price: bestOption.price,
                quantity: bestBoxesNeeded,
                effectiveVolume: bestOption.effectiveVolumeInLitres,
                volumeUsed: Math.min(remainingVolume, bestOption.effectiveVolumeInLitres * bestBoxesNeeded)
            });
        }

        // Update remaining volume
        remainingVolume -= bestOption.effectiveVolumeInLitres * bestBoxesNeeded;
        
        console.log(`Selected ${bestBoxesNeeded}x ${bestOption.name} (${bestOption.effectiveVolumeInLitres}L each) for ZAR${bestCost.toFixed(2)}. Remaining volume: ${remainingVolume.toFixed(2)}L`);
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