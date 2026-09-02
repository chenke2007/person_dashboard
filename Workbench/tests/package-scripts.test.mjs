import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("build script is cross-platform and startup has one documented entry", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.build, "node scripts/build-workbench.mjs");
  assert.equal(pkg.scripts.dev, "vite");
  const source = await readFile(new URL("../scripts/build-workbench.mjs", import.meta.url), "utf8");
  assert.match(source, /VITE_WORKBENCH_HOSTED/);
  assert.doesNotMatch(source, /shell:\s*true/);
});
