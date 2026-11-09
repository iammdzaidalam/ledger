import { test } from "node:test";

test("waits for the server", async () => {
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
});
