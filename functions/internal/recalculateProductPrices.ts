import { models, ProductPrice } from "@teamkeel/sdk";

export async function recalculateProductPrices({
  productId,
  channelId = null,
}: {
  productId: string;
  channelId?: string | null;
}) {
  const product = await models.product.findOne({ id: productId });
  if (!product) {
    return {
      name: "validation error",
      message: "product not found",
    };
  }

  const prices = await models.productPrice.findMany({
    where: { productId: product.id },
  });

  let nsp: ProductPrice | null = null;
  for (const price of prices) {
    if (price.isNormalSalesPrice) {
      nsp = price;
    }
  }

  for (const price of prices) {
    if (channelId && price?.channelId != channelId) {
      continue;
    }

    let channelCost = 0;
    const fees = await models.productFee.findMany({
      where: { productId: product.id },
    });
    for (const f of fees) {
      const cf = await models.channelFee.findOne({ id: f.feeId });

      if (cf?.channelId == price.channelId) {
        if (cf.flatFee) {
          channelCost += cf.flatFee;
        }
        if (cf.percFee) {
          channelCost += Math.round((price.retailPrice / 100) * cf.percFee);
        }
      }
    }

    let adSpend = 0;
    const roas = await models.adRoasTarget.findOne({
      productId: product.id,
      channelId: channelId!,
    });

    if (roas) {
      adSpend = Math.round(price.retailPrice / roas.targetRoas);
    }

    const retailPriceExVat = Math.round((price.retailPrice / 115) * 100);
    const totalCost = product.costPrice + product.freightIn;
    const grossProfit = retailPriceExVat - (totalCost + channelCost + adSpend);
    const grossProfitMargin = Math.round(
      (grossProfit / (totalCost + channelCost + adSpend)) * 100
    );

    let discount = 0;
    if (nsp && price != nsp) {
      discount = Math.round(
        ((nsp?.retailPrice - price.retailPrice) / nsp?.retailPrice) * 100
      );
    }

    await models.productPrice.update(
      { id: price.id },
      {
        grossProfitMargin: grossProfitMargin,
        totalCost: totalCost,
        adSpend: adSpend,
        channelCost: channelCost,
        grossProfit: grossProfit,
        retailPrice: price.retailPrice,
        discountFromNormalSalesPrice: discount,
      }
    );
  }
}
