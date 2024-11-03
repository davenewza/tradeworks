import {
  CreateProductPriceUsingRetailPrice,
  models,
  ProductPrice,
  useDatabase,
} from "@teamkeel/sdk";
import { recalculateProductPrices } from "./internal/recalculateProductPrices";

export default CreateProductPriceUsingRetailPrice({
  async beforeWrite(ctx, inputs, values) {
    const product = await models.product.findOne({ id: values.product.id });
    if (!product) {
      return {
        name: "validation error",
        message: "product not found",
      };
    }

    let channelCost = 0;
    const flatFees = await models.productFee.findMany({
      where: { productId: product.id },
    });
    for (const f of flatFees) {
      const cf = await models.channelFee.findOne({ id: f.feeId });
      if (cf?.channelId == values.channel.id) {
        if (cf.flatFee) {
          channelCost += cf.flatFee;
        }
        if (cf.percFee) {
          channelCost += Math.round((values.retailPrice / 100) * cf.percFee);
        }
      }
    }

    const retailPriceExVat = Math.round((values.retailPrice / 115) * 100);

    const p = await useDatabase()
      .selectFrom("product")
      .selectAll()
      .where("id", "=", inputs.product.id)
      .executeTakeFirst();
    console.log(p);

    const totalCost = product.costPrice + product.freightIn;
    const grossProfit = retailPriceExVat - (totalCost + channelCost);
    const grossProfitMargin = Math.round(
      (grossProfit / (totalCost + channelCost)) * 100
    );

    if (values.isNormalSalesPrice) {
      const prices = await models.productPrice.findMany({
        where: { productId: product.id },
      });
      for (const p of prices) {
        await models.productPrice.update(
          { id: p.id },
          {
            isNormalSalesPrice: false,
          }
        );
      }
    }

    return {
      channelId: values.channel.id,
      description: values.description,
      productId: values.product.id,
      grossProfitMargin: grossProfitMargin,
      totalCost: totalCost,
      channelCost: channelCost,
      grossProfit: grossProfit,
      retailPrice: values.retailPrice,
      isNormalSalesPrice: values.isNormalSalesPrice,
    };
  },
  async afterWrite(ctx, inputs, data) {
    await recalculateProductPrices({ productId: data.productId });
  },
});
