import { fmtBytes } from "./bytes.js";

export const report = (files) => files.map((f) => `${f.name}: ${fmtBytes(f.size)}`).join("\n");
