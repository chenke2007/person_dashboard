import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLearningVaultCatalog } from "../server/learning/learning-vault-catalog.mjs";

async function fixture(t, { configVaults = [] } = {}) {
  const stableTempRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(stableTempRoot, "workbench-vault-catalog-"));
  const vaultRoot = path.join(root, "current-vault");
  await mkdir(vaultRoot, { recursive: true });
  // A synthetic home-shaped directory: the masked paths must never reveal it.
  const syntheticHome = path.join(root, "users", "alice", "Obsidian");
  await mkdir(syntheticHome, { recursive: true });
  const configRoots = configVaults.map((entry) => {
    const target = path.join(syntheticHome, entry.dir ?? "home-vault");
    return { ...entry, root: target };
  });
  const configPath = path.join(root, "vaults.local.json");
  await writeFile(configPath, `${JSON.stringify({ version: 1, vaults: configRoots.map(({ name, root }) => ({ ...(name ? { name } : {}), root })) }, null, 2)}\n`, "utf8");
  t.after(() => rm(root, { recursive: true, force: true }));
  const fingerprintOf = (target) => createHash("sha256").update(path.resolve(target).toLowerCase()).digest("hex");
  return { root, vaultRoot, configPath, syntheticHome, fingerprintOf, configRoots };
}

function fingerprint(fingerprintOf, target) {
  return fingerprintOf(target);
}

test("lists only safe candidates: stable fingerprints, masked paths, never the home segment", async (t) => {
  const { vaultRoot, configPath, syntheticHome, fingerprintOf, configRoots } = await fixture(t, {
    configVaults: [
      { name: "本人知识库", dir: "work-vault" },
      { dir: "reading-vault" },
    ],
  });
  await mkdir(configRoots[0].root, { recursive: true });
  await mkdir(configRoots[1].root, { recursive: true });

  const catalog = createLearningVaultCatalog({ vaultRoot, configPath, fingerprintOf });
  const { candidates, warnings } = await catalog.listCandidates();

  assert.deepEqual(warnings, []);
  assert.equal(candidates.length, 3);

  const current = candidates.find((item) => item.isCurrent);
  assert.ok(current, "the current vault must always be a candidate");
  assert.equal(current.vaultId, fingerprint(fingerprintOf, vaultRoot));
  assert.equal(current.displayName, "current-vault");
  assert.equal(current.source, "current");
  assert.equal(current.maskedPath, "…/current-vault");

  const named = candidates.find((item) => item.displayName === "本人知识库");
  assert.ok(named);
  assert.equal(named.vaultId, fingerprint(fingerprintOf, configRoots[0].root));
  assert.equal(named.source, "config");
  assert.equal(named.maskedPath, "…/work-vault");

  const unnamed = candidates.find((item) => item.displayName === "reading-vault");
  assert.ok(unnamed);
  assert.equal(unnamed.vaultId, fingerprint(fingerprintOf, configRoots[1].root));

  // Privacy boundary: no candidate payload may expose the synthetic home or any
  // absolute root; "…/name" basenames keep the home layout hidden.
  const serialized = JSON.stringify(candidates);
  assert.ok(!serialized.includes("alice"), "user identity must never be exposed");
  assert.ok(!serialized.includes("Obsidian"), "vault parent folders must never be exposed");
  assert.ok(!serialized.includes(syntheticHome), "absolute roots must never be exposed");
  for (const candidate of candidates) {
    assert.match(candidate.maskedPath, /^…\/[^/\\]+$/);
    assert.ok(!Object.hasOwn(candidate, "root"), "list payload must not carry a server-side root");
  }
});

test("resolveTarget resolves the vault root server-side by fingerprint and returns null for unknown ids", async (t) => {
  const { vaultRoot, configPath, configRoots, fingerprintOf } = await fixture(t, { configVaults: [{ name: "Extra", dir: "extra-vault" }] });
  await mkdir(configRoots[0].root, { recursive: true });

  const catalog = createLearningVaultCatalog({ vaultRoot, configPath, fingerprintOf });

  const current = await catalog.resolveTarget(fingerprint(fingerprintOf, vaultRoot));
  assert.ok(current);
  assert.equal(current.vaultId, fingerprint(fingerprintOf, vaultRoot));
  assert.equal(current.root, vaultRoot);
  assert.equal(current.isCurrent, true);

  const extra = await catalog.resolveTarget(fingerprint(fingerprintOf, configRoots[0].root));
  assert.ok(extra);
  assert.equal(extra.root, configRoots[0].root);
  assert.equal(extra.displayName, "Extra");
  assert.equal(extra.isCurrent, false);

  assert.equal(await catalog.resolveTarget("f".repeat(64)), null);
  assert.equal(await catalog.resolveTarget("not-a-fingerprint"), null);
});

test("config entries with relative or empty roots are skipped with warnings and never resolve", async (t) => {
  const { vaultRoot, configPath } = await fixture(t);
  await writeFile(configPath, `${JSON.stringify({ version: 1, vaults: [{ name: "Relative", root: "some/relative/path" }, { root: "" }] }, null, 2)}\n`, "utf8");

  const catalog = createLearningVaultCatalog({ vaultRoot, configPath });
  const { candidates, warnings } = await catalog.listCandidates();

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].isCurrent, true);
  assert.ok(warnings.length >= 2, "every invalid config entry must produce a warning");
});

test("an invalid config file shape is a hard error carrying a stable code", async (t) => {
  const { vaultRoot, configPath } = await fixture(t);
  await writeFile(configPath, `${JSON.stringify({ version: 99, vaults: [] })}\n`, "utf8");
  const catalog = createLearningVaultCatalog({ vaultRoot, configPath });
  await assert.rejects(() => catalog.listCandidates(), (error) => {
    assert.equal(error.code, "VAULT_TARGET_CONFIG_INVALID");
    return true;
  });
});

test("a config entry pointing at the current vault is deduplicated as isCurrent", async (t) => {
  const { vaultRoot, configPath, fingerprintOf } = await fixture(t);
  await writeFile(configPath, `${JSON.stringify({ version: 1, vaults: [{ name: "Current Again", root: vaultRoot }] }, null, 2)}\n`, "utf8");

  const catalog = createLearningVaultCatalog({ vaultRoot, configPath, fingerprintOf });
  const { candidates } = await catalog.listCandidates();
  // The current vault is always listed once; a config entry for the same root
  // must not create a duplicate or change its identity.
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].isCurrent, true);
  assert.equal(candidates[0].displayName, "current-vault");
});

test("the writable flag reflects the probe result for every candidate", async (t) => {
  const { vaultRoot, configPath, configRoots, fingerprintOf } = await fixture(t, { configVaults: [{ dir: "read-only-vault" }] });
  await mkdir(configRoots[0].root, { recursive: true });
  const probeWritable = async (root) => root !== configRoots[0].root;

  const catalog = createLearningVaultCatalog({ vaultRoot, configPath, fingerprintOf, probeWritable });
  const { candidates } = await catalog.listCandidates();

  const writable = candidates.find((item) => item.isCurrent);
  const readonly = candidates.find((item) => item.displayName === "read-only-vault");
  assert.equal(writable.writable, true);
  assert.equal(readonly.writable, false);
});

test("a missing config file is treated as an empty config, never an error", async (t) => {
  const { vaultRoot, configPath } = await fixture(t);
  await (await import("node:fs/promises")).rm(configPath, { force: true });
  const catalog = createLearningVaultCatalog({ vaultRoot, configPath });
  const { candidates, warnings } = await catalog.listCandidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].isCurrent, true);
  assert.deepEqual(warnings, []);
});