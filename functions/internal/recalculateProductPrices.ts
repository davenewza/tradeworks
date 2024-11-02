import { models, ProductPrice } from "@teamkeel/sdk";

export async function recalculateProductPrices({ productId }) {
  const prices = await models.productPrice.findMany({
    where: { productId: productId },
  });
  let nsp: ProductPrice | null = null;

  for (const p of prices) {
    if (p.isNormalSalesPrice) {
      nsp = p;
    }
  }

  if (nsp) {
    for (const p of prices) {
      const discount = Math.round(
        ((nsp?.retailPrice - p.retailPrice) / nsp?.retailPrice) * 100
      );
      await models.productPrice.update(
        { id: p.id },
        {
          discountFromNormalSalesPrice: discount,
          isNormalSalesPrice: p == nsp,
        }
      );
    }
  } else {
    for (const p of prices) {
      await models.productPrice.update(
        { id: p.id },
        {
          discountFromNormalSalesPrice: 0,
          isNormalSalesPrice: false,
        }
      );
    }
  }
}
