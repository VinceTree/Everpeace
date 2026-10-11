import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { digest, verifyPackage } from "../release/policy.mjs";
import { verifySupplyChain } from "./policy.mjs";

const directory = path.resolve(process.argv[2]);
const receipt = JSON.parse(readFileSync(path.join(directory, "receipt.json"), "utf8"));
verifyPackage(receipt, path.join(directory, receipt.filename), process.env.CANDIDATE_SHA, process.env.PACKAGE_SHA256);
const files = Object.fromEntries(readdirSync(directory).filter((name) => name !== "supply-chain.json" && name !== receipt.filename).map((file) => [file, digest(path.join(directory, file))]));
writeFileSync(path.join(directory, "supply-chain.json"), JSON.stringify({ schema: 1, commit: receipt.commit, packageSha256: receipt.sha256, files, coverageLimitations: "Native compiled internal dependencies are not fully identifiable. Native packages, patch and binary digests are in receipt.json/native-provenance.json." }, null, 2) + "\n");
verifySupplyChain(directory, receipt.commit, receipt.sha256);
