import { CalculateDelivery, models, QuoteStatus } from '@teamkeel/sdk';
import {
    COLLECTION_ADDRESS,
    DELIVERY_MARKUP,
    ParcelBoxGroup,
    ShipLogicAddress,
    buildParcels,
    fetchShipLogicRates,
    mapRates
} from '../lib/deliveryHelpers';

export default CalculateDelivery(async (ctx, inputs) => {
    const quote = await models.quote.findOne({ id: inputs.id });

    if (!quote) {
        throw new Error('Quote not found');
    }

    if (quote.status !== QuoteStatus.Draft) {
        throw new Error('Quote is not in draft status');
    }

    if (!quote.deliveryAddressId) {
        throw new Error('No delivery address assigned to this quote.');
    }

    const deliveryAddress = await models.deliveryAddress.findOne({ id: quote.deliveryAddressId });

    if (!deliveryAddress) {
        throw new Error('Delivery address not found for this quote.');
    }


    // Get all equipment boxes for this quote
    const quoteEquipmentBoxes = await models.quoteEquipmentBox.findMany({
        where: { quoteId: quote.id }
    });

    if (quoteEquipmentBoxes.length === 0) {
        throw new Error('No equipment boxes found for this quote. Please calculate equipment boxes first.');
    }

    console.log(`Found ${quoteEquipmentBoxes.length} equipment box types for quote ${quote.id}`);

    // Get all quote products to calculate total product weight
    const quoteProducts = await models.quoteProduct.findMany({
        where: { quoteId: quote.id }
    });

    let totalProductWeightKg = 0;
    const productDetails: Array<{
        productId: string;
        productName: string;
        quantity: number;
        weightPerUnit: number;
        totalWeight: number;
    }> = [];

    // Calculate total product weight and get product details
    for (const quoteProduct of quoteProducts) {
        const product = await models.product.findOne({ id: quoteProduct.productId });
        if (product && product.weightInGrams) {
            const productWeightKg = (Number(product.weightInGrams) * quoteProduct.quantity) / 1000;
            totalProductWeightKg += productWeightKg;
            productDetails.push({
                productId: product.id,
                productName: product.name,
                quantity: quoteProduct.quantity,
                weightPerUnit: Number(product.weightInGrams) / 1000,
                totalWeight: productWeightKg
            });
        }
    }

    console.log(`Total product weight: ${totalProductWeightKg}kg`);
    console.log('Product details:', productDetails);

    // Convert the quote's equipment boxes into parcel groups for the API
    const boxGroups: ParcelBoxGroup[] = [];

    for (const quoteEquipmentBox of quoteEquipmentBoxes) {
        // Get the equipment box details
        const equipmentBox = await models.equipmentBox.findOne({
            id: quoteEquipmentBox.equipmentBoxId
        });

        if (!equipmentBox) {
            console.warn(`Equipment box not found: ${quoteEquipmentBox.equipmentBoxId}`);
            continue;
        }

        boxGroups.push({
            lengthInCm: Number(equipmentBox.lengthInCm),
            widthInCm: Number(equipmentBox.widthInCm),
            heightInCm: Number(equipmentBox.heightInCm),
            weightInGrams: Number(equipmentBox.weightInGrams),
            quantity: quoteEquipmentBox.quantity
        });

        console.log(`Added ${quoteEquipmentBox.quantity} parcels for equipment box: ${equipmentBox.name} (${equipmentBox.lengthInCm}x${equipmentBox.widthInCm}x${equipmentBox.heightInCm}cm, equipment box: ${equipmentBox.weightInGrams}g)`);
    }

    const parcels = buildParcels(boxGroups, totalProductWeightKg);

    if (parcels.length === 0) {
        throw new Error('No valid parcels could be created from equipment boxes');
    }

    console.log(`Total parcels to ship: ${parcels.length}`);

    const deliveryAddressObject: ShipLogicAddress = {
        type: "business",
        company: deliveryAddress.organisation || "",
        street_address: deliveryAddress.addressLine1 + ", " + deliveryAddress.addressLine2,
        local_area: deliveryAddress.suburb || "",
        city: deliveryAddress.city,
        zone: deliveryAddress.province,
        country: deliveryAddress.country,
        code: deliveryAddress.postalCode
    };

    const requestBody = {
        collection_address: COLLECTION_ADDRESS,
        delivery_address: deliveryAddressObject,
        parcels: parcels
    };

    console.log('Calling Shiplogic API with request:', JSON.stringify(requestBody, null, 2));

    try {
        const apiResponse = await fetchShipLogicRates(
            ctx.env.SHIPLOGIC_API_URL,
            ctx.secrets.SHIPLOGIC_API_KEY,
            requestBody
        );
        console.log('Shiplogic API response:', JSON.stringify(apiResponse, null, 2));

        // Process and return the rates
        const rates = apiResponse.rates || [];

        // Sort rates by price (lowest first)
        rates.sort((a: any, b: any) => a.rate - b.rate);

        // Get the cheapest rate
        const cheapestRate = rates[0];
        if (!cheapestRate) {
            throw new Error('No delivery rates available');
        }

        console.log(`Selected cheapest rate: ${cheapestRate.service_level.name} at ZAR ${cheapestRate.rate}`);

        // Update the quote with the cheapest delivery option
        const chargedWeightKg = Number(cheapestRate.charged_weight)
        const chargedWeightInGrams = Number.isFinite(chargedWeightKg) ? Math.round(chargedWeightKg * 1000) : null
        await models.quote.update({ id: quote.id }, {
            deliveryService: cheapestRate.service_level.name,
            totalDeliveryFees: cheapestRate.rate_excluding_vat * DELIVERY_MARKUP,
            chargedWeightInGrams: chargedWeightInGrams ?? undefined,
            deliveryRawJson: apiResponse
        });

        // Calculate total weight and volume for summary
        const totalWeightKg = parcels.reduce((sum, parcel) => sum + parcel.submitted_weight_kg, 0);
        const totalVolumeCm3 = parcels.reduce((sum, parcel) =>
            sum + (parcel.submitted_length_cm * parcel.submitted_width_cm * parcel.submitted_height_cm), 0);

        return {
            quoteId: quote.id,
            quoteNumber: quote.number,
            totalParcels: parcels.length,
            totalWeightKg: totalWeightKg,
            totalVolumeCm3: totalVolumeCm3,
            productWeightKg: totalProductWeightKg,
            equipmentBoxWeightKg: totalWeightKg - totalProductWeightKg,
            productDetails: productDetails,
            collectionAddress: COLLECTION_ADDRESS,
            deliveryAddress: deliveryAddressObject,
            selectedDeliveryService: cheapestRate.service_level.name,
            selectedDeliveryFees: cheapestRate.rate,
            availableRates: mapRates(rates),
            rawApiResponse: apiResponse
        };

    } catch (error) {
        console.error('Error calling Shiplogic API:', error);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to calculate delivery rates: ${message}`);
    }
});
