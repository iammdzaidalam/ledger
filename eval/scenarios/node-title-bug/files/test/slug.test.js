import assert from "node:assert/strict";
import { test } from "node:test";
import { slug } from "../src/text.js";

test("slug joins words with dashes", () => {
	assert.equal(slug("  Hello World "), "hello-world");
});
