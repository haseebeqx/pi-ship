import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ServerConnection {
  target: string;
  certificate?: string;
}

type Inventory = Record<string, ServerConnection>;

interface InventoryConfig {
  defaultServer?: string;
}

const inventoryDirectory = join(homedir(), ".config", "pi-ship");
const inventoryPath = join(inventoryDirectory, "servers.json");
const configPath = join(inventoryDirectory, "config.json");

async function readInventory(): Promise<Inventory> {
  try {
    return JSON.parse(await readFile(inventoryPath, "utf8")) as Inventory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function readConfig(): Promise<InventoryConfig> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as InventoryConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** Save a server and make it the default when requested or when no valid default exists. */
export async function saveServer(
  name: string,
  connection: ServerConnection,
  makeDefault = false,
): Promise<boolean> {
  const inventory = await readInventory();
  const config = await readConfig();
  const hasDefault = Boolean(config.defaultServer && inventory[config.defaultServer]);
  inventory[name] = connection;
  await writeJson(inventoryPath, inventory);

  if (makeDefault || !hasDefault) {
    await writeJson(configPath, { ...config, defaultServer: name });
    return true;
  }
  return false;
}

/** Return the environment-selected server, then the saved default server. */
export async function impliedServer(): Promise<string | undefined> {
  if (process.env.PI_SHIP_SERVER) return process.env.PI_SHIP_SERVER;
  const [inventory, config] = await Promise.all([readInventory(), readConfig()]);
  return config.defaultServer && inventory[config.defaultServer] ? config.defaultServer : undefined;
}

export async function resolveServer(nameOrTarget?: string, certificate?: string): Promise<ServerConnection> {
  const selected = nameOrTarget || await impliedServer();
  if (!selected) {
    throw new Error("No server specified and no default server is configured");
  }
  const inventory = await readInventory();
  const saved = inventory[selected];
  return {
    target: saved?.target ?? selected,
    certificate: certificate ?? saved?.certificate,
  };
}
