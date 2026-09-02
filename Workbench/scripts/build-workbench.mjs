process.env.VITE_WORKBENCH_HOSTED = "true";
const { build } = await import("vite");
await build();
await import("./prepare-sites-build.mjs");
