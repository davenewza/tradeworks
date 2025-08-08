import { actions, models, resetDatabase } from "@teamkeel/testing";
import { test, expect, beforeEach } from "vitest";

beforeEach(resetDatabase);

test("basic test", async () => {
  const created = await models.brand.create({ name: "Test" });
  expect(created.name).toBe("Tes1");
});
