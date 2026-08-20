import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("servers select an automatic or explicit default and honor PI_SHIP_SERVER", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-ship-inventory-"));
  const previousHome = process.env.HOME;
  const previousServer = process.env.PI_SHIP_SERVER;
  process.env.HOME = home;
  delete process.env.PI_SHIP_SERVER;

  try {
    const { impliedServer, listServers, removeServer, resolveServer, savedServer, saveServer } = await import("../src/inventory.js");

    assert.equal(await saveServer("first", { target: "one.example" }), true);
    assert.equal(await impliedServer(), "first");
    assert.deepEqual(await resolveServer(), { target: "one.example", certificate: undefined });

    assert.equal(await saveServer("second", { target: "two.example" }), false);
    assert.equal(await impliedServer(), "first");

    assert.equal(await saveServer("second", { target: "two.example" }, true), true);
    assert.equal(await impliedServer(), "second");
    assert.deepEqual(
      JSON.parse(await readFile(join(home, ".config", "pi-ship", "config.json"), "utf8")),
      { defaultServer: "second" },
    );

    process.env.PI_SHIP_SERVER = "first";
    assert.equal(await impliedServer(), "first");
    assert.deepEqual(await resolveServer(), { target: "one.example", certificate: undefined });
    assert.deepEqual(await resolveServer("second"), { target: "two.example", certificate: undefined });
    assert.deepEqual(await savedServer("second"), { target: "two.example" });
    assert.deepEqual(await listServers(), [
      { name: "first", target: "one.example", isDefault: false },
      { name: "second", target: "two.example", isDefault: true },
    ]);

    assert.deepEqual(await removeServer("second"), { target: "two.example" });
    assert.equal(await impliedServer(), "first");
    assert.deepEqual(await listServers(), [
      { name: "first", target: "one.example", isDefault: true },
    ]);
    assert.equal(await removeServer("missing"), undefined);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousServer === undefined) delete process.env.PI_SHIP_SERVER;
    else process.env.PI_SHIP_SERVER = previousServer;
    await rm(home, { recursive: true, force: true });
  }
});
