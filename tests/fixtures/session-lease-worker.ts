import { SessionActivity } from "../../src/storage/session-activity.js";
const [directory, id] = process.argv.slice(2);
if (!directory || !id) throw new Error("Fixture parameters required");
const release = await new SessionActivity(directory).acquire(id);
process.stdout.write("ready\n");
process.stdin.once("data", () => { void release().then(() => process.exit(0)).catch(() => process.exit(1)); });
