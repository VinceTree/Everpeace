import { test } from "node:test";
test("Windows required test failure blocks publishing", () => {
  throw new Error("Intentional release gate acceptance failure");
});
