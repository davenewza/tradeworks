import { Seed, models, permissions } from '@teamkeel/sdk';

// To learn more about what you can do with custom functions, visit https://docs.keel.so/functions
export default Seed(async (ctx, inputs) => {
    permissions.allow();
    const brand = await models.brand.create({name: "Robotico"});
    const supplier = await models.supplier.create({name: "Kuongshun"});
    const product = await models.product.create({
        name: "Ultimate UNO R3 Starter Kit", 
        costPrice: 575, freightIn: 75, sku: "RL-AE086", brandId: brand.id, 
        supplierId: supplier.id});
    const channel = await models.channel.create({name: "Takealot"});
    const channelFlatFee = await models.channelFlatFee.create({name: "Fulfillment fee (small)", channelId: channel.id, flatFee: 32});
    const channelPercFee = await models.channelPercentageFee.create({name: "Success fee (electronics)", channelId: channel.id, percentageFee: 6});

});