import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectRepository } from "../server/projects/project-repository.mjs";
import { createWorkspaceBackup } from "../server/workspace-state/workspace-backup.mjs";

test("shared validation rejects relationally invalid imports before preview or disk mutation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synthetic-integrity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = createProjectRepository({ directory, resolveDocument: async (id) => ({ id, path: id, kind: "wiki" }) });
  const first = await repository.createProject({ key: "AA", name: "Synthetic first" });
  const second = await repository.createProject({ key: "BB", name: "Synthetic second" });
  const task = await repository.createTask({ projectId: first.project.id, title: "Synthetic task" });
  const another = await repository.createTask({ projectId: first.project.id, title: "Synthetic second task" });
  const label = await repository.createLabel({ name: "Synthetic", color: "blue" });
  await repository.setTaskLabels({ taskId: task.task.id, labelIds: [label.label.id] });
  await repository.addTaskLink({ taskId: task.task.id, documentId: "wiki/missing.md" });
  await repository.archiveTask(another.task.id);
  const original = await repository.exportState();
  const bytes = await readFile(path.join(directory, "projects.json"));
  const backup = createWorkspaceBackup({ secret: Buffer.alloc(32, 7), providers: [repository] });
  const mutations = {
    "duplicate project id": (s) => { s.projects[1].id = s.projects[0].id; },
    "duplicate project key": (s) => { s.projects[1].key = s.projects[0].key; },
    "duplicate column id": (s) => { s.columns[1].id = s.columns[0].id; },
    "duplicate task id": (s) => { s.tasks[1].id = s.tasks[0].id; },
    "duplicate label id": (s) => { s.labels.push(s.labels[0]); },
    "duplicate link id": (s) => { s.taskLinks.push(s.taskLinks[0]); },
    "duplicate activity id": (s) => { s.activities.push(s.activities[0]); },
    "orphan column": (s) => { s.columns[0].projectId = randomUUID(); },
    "orphan task": (s) => { s.tasks[0].projectId = randomUUID(); },
    "orphan task column": (s) => { s.tasks[0].columnId = randomUUID(); },
    "foreign task column": (s) => { s.tasks[0].columnId = second.columns[0].id; },
    "duplicate task number including archive": (s) => { s.tasks[1].number = s.tasks[0].number; },
    "insufficient next number": (s) => { s.projects[0].lastTaskNumber = 0; },
    "orphan task label": (s) => { s.taskLabels[0].taskId = randomUUID(); },
    "orphan label": (s) => { s.taskLabels[0].labelId = randomUUID(); },
    "duplicate label association": (s) => { s.taskLabels.push(s.taskLabels[0]); },
    "orphan link": (s) => { s.taskLinks[0].taskId = randomUUID(); },
    "duplicate document association": (s) => { s.taskLinks.push({ ...s.taskLinks[0], id: randomUUID() }); },
    "orphan activity project": (s) => { s.activities[0].projectId = randomUUID(); },
    "orphan activity task": (s) => { s.activities[0].taskId = randomUUID(); },
    "foreign activity task": (s) => { s.activities[0].projectId = second.project.id; s.activities[0].taskId = task.task.id; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const invalid = structuredClone(original);
      mutate(invalid);
      const source = createWorkspaceBackup({ secret: Buffer.alloc(32, 7), providers: [{ id: "projects", schemaVersion: 1, exportState: async () => invalid, validateImport: async (v) => v, replaceState: async () => {} }] });
      await assert.rejects(backup.previewImport(await source.exportBundle()), { code: "WORKSPACE_BACKUP_PROVIDER_INVALID" });
      assert.deepEqual(await readFile(path.join(directory, "projects.json")), bytes);
      await writeFile(path.join(directory, "projects.json"), JSON.stringify(invalid));
      await assert.rejects(repository.exportState(), { code: "PROJECT_STORAGE_CORRUPT" });
      await writeFile(path.join(directory, "projects.json"), bytes);
    });
  }
  const reopened = createProjectRepository({ directory });
  assert.deepEqual(await reopened.validateImport(original), original);
  assert.equal((await reopened.getProject(first.project.id)).taskLinks[0].missing, true);
});
