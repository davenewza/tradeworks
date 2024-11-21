import { UpdateProductPrices, models } from "@teamkeel/sdk";
import { recalculateProductPrices } from "../functions/internal/recalculateProductPrices";

// To learn more about events and subscribers, visit https://docs.keel.so/events
export default UpdateProductPrices(async (ctx, event) => {
  switch (event.eventName) {
    case "product.updated":
      if (
        event.target.data.costPrice != event.target.previousData.costPrice ||
        event.target.data.freightIn != event.target.previousData.freightIn
      ) {
        await recalculateProductPrices({ productId: event.target.id });
      }
      break;
      case  "ad_roas_target.created":
        await recalculateProductPrices({ productId: event.target.data.productId, channelId: event.target.data.channelId });
        break;
      case "ad_roas_target.updated":
        if (
          event.target.data.targetRoas != event.target.previousData.targetRoas
        ) {
          await recalculateProductPrices({ productId: event.target.data.productId, channelId: event.target.data.channelId });
        }
        break;
    case "channel_fee.updated":
      if (
        event.target.data.flatFee != event.target.previousData.flatFee ||
        event.target.data.percFee != event.target.previousData.percFee
      ) {
        const productFees = await models.productFee.findMany({
          where: { feeId: event.target.data.id },
        });
        for (const pf of productFees) {
          await recalculateProductPrices({
            productId: pf.productId,
            channelId: event.target.data.channelId,
          });
        }
      }
      break;
    case "product_fee.created":
      const channelFee = await models.channelFee.findOne({
        id: event.target.data.feeId,
      });
      await recalculateProductPrices({
        productId: event.target.data.productId,
        channelId: channelFee?.channelId,
      });

      break;
  }
});
