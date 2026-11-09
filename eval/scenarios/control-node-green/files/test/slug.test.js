import { test } from "node:test";
import assert from "node:assert/strict";
import { slug } from "../src/slug.js";

test("basic", () => assert.equal(slug(" Hello World "), "hello-world"));
test("symbols", () => assert.equal(slug("a&b"), "a-b"));
