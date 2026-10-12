import { requireSuccess } from "./policy.mjs";

const required = process.argv.slice(2);
if (!required.length) throw new Error("No required checks specified");
requireSuccess(JSON.parse(process.env.CHECK_RESULTS ?? "{}"), required);
console.log("All required checks succeeded.");
