import assert from "node:assert/strict";
import test from "node:test";

const brandingModule = await import("../src/lib/branding.js").catch((error) => error);

test("Workbench branding keeps a public default and accepts a trimmed local override", () => {
  assert.equal(typeof brandingModule.resolveWorkbenchBrand, "function");
  assert.equal(brandingModule.resolveWorkbenchBrand({}), "个人 AI");
  assert.equal(
    brandingModule.resolveWorkbenchBrand({ VITE_WORKBENCH_BRAND: "  Demo · AI Dashboard  " }),
    "Demo · AI Dashboard",
  );
  assert.equal(
    brandingModule.resolveWorkbenchBrand({ VITE_WORKBENCH_BRAND: "   " }),
    "个人 AI",
  );
});

test("Workbench title follows a custom brand without changing the public default title", () => {
  assert.equal(typeof brandingModule.resolveWorkbenchTitle, "function");
  assert.equal(brandingModule.resolveWorkbenchTitle({}), "个人 AI 工作台");
  assert.equal(
    brandingModule.resolveWorkbenchTitle({ VITE_WORKBENCH_BRAND: "Demo · AI Dashboard" }),
    "Demo · AI Dashboard",
  );
});
