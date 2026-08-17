import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ServerConnection {
  target: string;
  certificate?: string;
}

type Inventory = Record<string, ServerConnection>;

const inventoryPath = join(homedir(), ".config", "pi-ship", "servers.json");

async function readInventory(): Promise<Inventory> {
  try {
    return JSON.parse(await readFile(inventoryPath, "utf8")) as Inventory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function saveServer(name: string, connection: ServerConnection): Promise<void> {
  const inventory = await readInventory();
  inventory[name] = connection;
  await mkdir(dirname(inventoryPath), { recursive: true });
  const temporary = `${inventoryPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, inventoryPath);
}

export async function resolveServer(nameOrTarget: string, certificate?: string): Promise<ServerConnection> {
  const inventory = await readInventory();
  const saved = inventory[nameOrTarget];
  return {
    target: saved?.target ?? nameOrTarget,
    certificate: certificate ?? saved?.certificate,
  };
}
