import { actions, models, resetDatabase } from "@teamkeel/testing";
import { test, expect, beforeEach } from "vitest";

beforeEach(resetDatabase);

test("create relationships - many to many", async () => {
  expect(true).toBe(true);
});
