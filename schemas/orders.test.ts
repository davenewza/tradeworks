import { models, resetDatabase, actions } from "@teamkeel/testing";
import { test, expect, beforeEach } from "vitest";

beforeEach(resetDatabase);

test("model api - create 2", async () => {
  const created = await models.supplier.create({
    name: "test one",
  });

  expect(created.name).toBe("test one!!");
});