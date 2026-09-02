const DEFAULT_BRAND = "个人 AI";
const DEFAULT_TITLE = "个人 AI 工作台";

function normalized(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveWorkbenchBrand(env = {}) {
  return normalized(env.VITE_WORKBENCH_BRAND) || DEFAULT_BRAND;
}

export function resolveWorkbenchTitle(env = {}) {
  return normalized(env.VITE_WORKBENCH_TITLE)
    || normalized(env.VITE_WORKBENCH_BRAND)
    || DEFAULT_TITLE;
}

const runtimeEnv = import.meta.env ?? {};

export const workbenchBrand = resolveWorkbenchBrand(runtimeEnv);
export const workbenchTitle = resolveWorkbenchTitle(runtimeEnv);
