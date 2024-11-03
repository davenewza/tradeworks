import { Seed, models, permissions } from "@teamkeel/sdk";

// To learn more about what you can do with custom functions, visit https://docs.keel.so/functions
export default Seed(async (ctx, inputs) => {
  permissions.allow();
  const brand = await models.brand.create({ name: "Robotico" });
  const supplier = await models.supplier.create({ name: "Kuongshun" });
  const product = await models.product.create({
    name: "Ultimate UNO R3 Starter Kit",
    costPrice: 575,
    freightIn: 75,
    sku: "RL-AE086",
    brandId: brand.id,
    supplierId: supplier.id,
  });

  const tal = await models.channel.create({ name: "Takealot" });
  await models.channelFee.create({
    name: "Fulfillment fee (small)",
    channelId: tal.id,
    flatFee: 42,
  });
  await models.channelFee.create({
    name: "Success fee (electronics)",
    channelId: tal.id,
    percFee: 6,
  });

  const website = await models.channel.create({ name: "Website" });
  await models.channelFee.create({
    name: "PayFast commission",
    channelId: website.id,
    percFee: 3,
  });

  const oneDayOnly = await models.channel.create({ name: "OneDayOnly" });
  await models.channelFee.create({
    name: "Standard 10% offer",
    channelId: website.id,
    percFee: 10,
  });
});
