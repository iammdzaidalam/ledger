import assert from "node:assert/strict";
import { test } from "node:test";
import { titleCase } from "../src/text.js";

test("titleCase capitalizes every word", () => {
	assert.equal(titleCase("hello big world"), "Hello Big World");
});

test("titleCase keeps a single word", () => {
	assert.equal(titleCase("ledger"), "Ledger");
});
