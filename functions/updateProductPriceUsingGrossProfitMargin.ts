import {
  UpdateProductPriceUsingGrossProfitMargin,
  models,
} from "@teamkeel/sdk";
import { recalculateProductPrices } from "./internal/recalculateProductPrices";

export default UpdateProductPriceUsingGrossProfitMargin({
  async beforeWrite(ctx, inputs, values, record) {
    if (inputs.values.isNormalSalesPrice) {
      const prices = await models.productPrice.findMany({
        where: { productId: record.productId },
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
    return values;
  },
  async afterWrite(ctx, inputs, data) {
    await recalculateProductPrices({ productId: data.productId });
  },
});
