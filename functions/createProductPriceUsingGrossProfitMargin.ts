import {
  CreateProductPriceUsingGrossProfitMargin,
  models,
  ProductPrice,
} from "@teamkeel/sdk";
import { recalculateProductPrices } from "./internal/recalculateProductPrices";

export default CreateProductPriceUsingGrossProfitMargin({
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
      if (cf?.channelId == values.channel.id && cf.flatFee) {
        channelCost += cf.flatFee;
      }
    }

    const totalCost = product.costPrice + product.freightIn;
    const grossProfit =
      ((totalCost + channelCost) / 100) * values.grossProfitMargin;
    const retailPriceExVat = totalCost + channelCost + grossProfit;
    const retailPrice = (retailPriceExVat / 100) * 15 + retailPriceExVat;

    // const percentageFees = await models.productPercentageFee.findMany({ where: {productId: product.id}  });
    // for (const f of percentageFees) {
    //     const cf = await models.channelPercentageFee.findOne({ id: f.feeId  });
    //     channelCost += (values.retailPrice / 100 * cf!.percentageFee);
    // }

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
      grossProfitMargin: values.grossProfitMargin,
      totalCost: totalCost,
      channelCost: channelCost,
      grossProfit: grossProfit,
      retailPrice: retailPrice,
      isNormalSalesPrice: values.isNormalSalesPrice,
    };
  },
  async afterWrite(ctx, inputs, data) {
    await recalculateProductPrices({ productId: data.productId });
  },
});
