import { createProjectRepository } from "../../server/projects/project-repository.mjs";
import { createWorkspaceBackup } from "../../server/workspace-state/workspace-backup.mjs";
let release;
process.on("message", async (message) => {
  if (message.type === "release") { release?.(); return; }
  if (message.type !== "start") return;
  const pause = (phase) => new Promise((resolve) => { release = resolve; process.send({ phase }); });
  const repository = createProjectRepository({
    directory: message.directory,
    resolveDocument: async (id) => { await pause("reading"); return { id, path: id, kind: "wiki" }; },
  });
  process.send({ phase: "started" });
  try {
    if (message.action === "link") await repository.addTaskLink({ taskId: message.taskId, documentId: "wiki/synthetic.md" });
    if (message.action === "rename") await repository.updateProject(message.projectId, { name: "Synthetic concurrent writer" });
    if (message.action === "move") await repository.moveTask(message.input);
    if (message.action === "restore") {
      const transaction = await repository.stageImport(message.state);
      await pause("staged");
      try {
        await transaction.commit();
        if (message.rollback) await transaction.rollback();
        await pause("committed");
      } finally { await transaction.cleanup(); }
    }
    if (message.action === "backup-failure") {
      const later = {
        id: "later", schemaVersion: 1, exportState: async () => ({ version: 1 }), validateImport: async (value) => value,
        replaceState: async () => {},
        async stageImport() { return { async commit() { throw new Error("synthetic failure"); }, async rollback() {}, async cleanup() {} }; },
      };
      const backup = createWorkspaceBackup({ providers: [repository, later], secret: Buffer.alloc(32, 7) });
      const source = createWorkspaceBackup({ providers: [{ ...repository, exportState: async () => message.state }, later], secret: Buffer.alloc(32, 7) });
      const preview = await backup.previewImport(await source.exportBundle());
      await backup.confirmImport(preview.token);
    }
    process.send({ phase: "done" });
  } catch (error) { process.send({ phase: "error", code: error.code, message: error.message }); }
});
process.send({ phase: "ready" });
