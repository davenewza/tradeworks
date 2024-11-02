import {
  DeleteProductPrice,
  DeleteProductPriceHooks,
  models,
} from "@teamkeel/sdk";
import { recalculateProductPrices } from "./internal/recalculateProductPrices";

// To learn more about what you can do with hooks, visit https://docs.keel.so/functions
const hooks: DeleteProductPriceHooks = {};

export default DeleteProductPrice({
  async beforeWrite(ctx, inputs, record) {
    if (record.isNormalSalesPrice) {
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
  },
  async afterWrite(ctx, inputs, data) {
    await recalculateProductPrices({ productId: data.productId });
  },
});
