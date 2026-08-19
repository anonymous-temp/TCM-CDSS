import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseCustomerId } = await jiti.import("../src/lib/customer-id.ts");

export async function migrateInventoryToCustomer({ source, root, customerId }) {
  const validCustomerId = parseCustomerId(customerId);
  if (!validCustomerId) throw new Error("invalid customer id");
  const sourcePath = resolve(source);
  const rootPath = resolve(root);
  const content = await readFile(sourcePath, "utf8");
  JSON.parse(content);
  const customerHash = createHash("sha256").update(validCustomerId).digest("hex").slice(0, 32);
  const target = join(rootPath, `${customerHash}.json`);
  await mkdir(dirname(target), { recursive: true });
  try {
    await readFile(target, "utf8");
    throw new Error("target already exists");
  } catch (error) {
    if (error instanceof Error && error.message === "target already exists") throw error;
  }
  const backup = `${sourcePath}.pre-tenant-backup`;
  await copyFile(sourcePath, backup, constants.COPYFILE_EXCL);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await rename(temporary, target);
  return { source: sourcePath, backup, target, customerHash };
}

function argsOf(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error("arguments must use --name value pairs");
    result[key.slice(2)] = value;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = argsOf(process.argv.slice(2));
    if (!args.source || !args.root || !args["customer-id"]) {
      throw new Error("--source, --root and --customer-id are required");
    }
    const result = await migrateInventoryToCustomer({
      source: args.source,
      root: args.root,
      customerId: args["customer-id"],
    });
    process.stdout.write(`${JSON.stringify({ ok: true, target: result.target, backup: result.backup })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
