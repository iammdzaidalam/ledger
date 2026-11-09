import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtBytes } from "../src/bytes.js";
import { report } from "../src/report.js";

test("kb", () => assert.equal(fmtBytes(2048), "2.0 KB"));
test("report", () => assert.equal(report([{ name: "a", size: 10 }]), "a: 10.0 B"));
