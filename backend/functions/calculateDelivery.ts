import { CalculateDelivery, models } from '@teamkeel/sdk';

const COLLECTION_ADDRESS = {
    type: "business",
    company: "Tradeworks",
    street_address: "65 Oak Street",
    local_area: "Somerset West",
    city: "Somerset West",
    zone: "Western Cape",
    country: "ZA",
    code: "7130"
};

export default CalculateDelivery(async (ctx, inputs) => {
    const quote = await models.quote.findOne({ id: inputs.id });

    if (!quote) {
        throw new Error('Quote not found');
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

    // Calculate total number of equipment boxes
    const totalEquipmentBoxes = quoteEquipmentBoxes.reduce((sum, qeb) => sum + qeb.quantity, 0);
    console.log(`Total equipment boxes: ${totalEquipmentBoxes}`);

    // Calculate product weight per equipment box
    const productWeightPerBox = totalProductWeightKg / totalEquipmentBoxes;
    console.log(`Product weight per equipment box: ${productWeightPerBox}kg`);

    // Convert equipment boxes to parcels for the API
    const parcels: any[] = [];

    for (const quoteEquipmentBox of quoteEquipmentBoxes) {
        // Get the equipment box details
        const equipmentBox = await models.equipmentBox.findOne({ 
            id: quoteEquipmentBox.equipmentBoxId 
        });

        if (!equipmentBox) {
            console.warn(`Equipment box not found: ${quoteEquipmentBox.equipmentBoxId}`);
            continue;
        }

        // Create a parcel for each equipment box (quantity times)
        for (let i = 0; i < quoteEquipmentBox.quantity; i++) {
            const equipmentBoxWeightKg = Number(equipmentBox.weightInGrams) / 1000;
            const totalParcelWeightKg = equipmentBoxWeightKg + productWeightPerBox;
            
            parcels.push({
                submitted_length_cm: Number(equipmentBox.lengthInCm),
                submitted_width_cm: Number(equipmentBox.widthInCm),
                submitted_height_cm: Number(equipmentBox.heightInCm),
                submitted_weight_kg: totalParcelWeightKg // Equipment box weight + distributed product weight
            });
        }

        console.log(`Added ${quoteEquipmentBox.quantity} parcels for equipment box: ${equipmentBox.name} (${equipmentBox.lengthInCm}x${equipmentBox.widthInCm}x${equipmentBox.heightInCm}cm, equipment box: ${equipmentBox.weightInGrams}g, total weight per parcel: ${(Number(equipmentBox.weightInGrams) / 1000 + productWeightPerBox).toFixed(2)}kg)`);
    }

    if (parcels.length === 0) {
        throw new Error('No valid parcels could be created from equipment boxes');
    }

    console.log(`Total parcels to ship: ${parcels.length}`);

    const deliveryAddressObject = {
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
        const response = await fetch(ctx.env.SHIPLOGIC_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${ctx.secrets.SHIPLOGIC_API_KEY}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Shiplogic API error:', response.status, errorText);
            throw new Error(`Shiplogic API error: ${response.status} - ${errorText}`);
        }

        const apiResponse = await response.json();
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
            totalDeliveryFees: cheapestRate.rate_excluding_vat * 1.1,
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
            availableRates: rates.map((rate: any) => ({
                serviceLevel: {
                    code: rate.service_level.code,
                    name: rate.service_level.name,
                    description: rate.service_level.description,
                    deliveryDateFrom: rate.service_level.delivery_date_from,
                    deliveryDateTo: rate.service_level.delivery_date_to,
                    collectionDate: rate.service_level.collection_date,
                    collectionCutOffTime: rate.service_level.collection_cut_off_time
                },
                pricing: {
                    rate: rate.rate * 1.1,
                    rateExcludingVat: rate.rate_excluding_vat * 1.1,
                    vat: rate.base_rate.vat * 1.1,
                    vatPercentage: rate.base_rate.vat_percentage * 1.1
                },
                weights: {
                    chargedWeight: rate.charged_weight,
                    actualWeight: rate.actual_weight,
                    volumetricWeight: rate.volumetric_weight
                }
            })),
            rawApiResponse: apiResponse
        };

    } catch (error) {
        console.error('Error calling Shiplogic API:', error);
        throw new Error(`Failed to calculate delivery rates: ${error.message}`);
    }
});