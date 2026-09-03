import { useEffect, useReducer, useRef } from "react";
import {
  confirmWorkspaceRebind,
  confirmWorkspaceRestore,
  exportWorkspaceBackup,
  loadWorkspaceRebindCandidates,
  previewWorkspaceRebind,
  previewWorkspaceRestore,
} from "../../lib/workspace-api.js";

const EXCLUDED_DATA_NOTICE = "凭据、缓存、绝对路径和 Vault 正文不会进入恢复内容。";

const initialSection = Object.freeze({
  status: "idle",
  message: null,
});

export const initialWorkspaceDataState = Object.freeze({
  export: initialSection,
  restore: {
    ...initialSection,
    fileName: "",
    inputIdentity: null,
    requestGeneration: 0,
    token: null,
    preview: null,
    confirmationEnabled: false,
  },
  rebind: {
    ...initialSection,
    candidates: [],
    candidatesLoading: false,
    workspaceId: "",
    requestGeneration: 0,
    token: null,
    preview: null,
    confirmationEnabled: false,
  },
});

function safeRestorePreview(preview) {
  const providers = Array.isArray(preview?.providers)
    ? preview.providers
      .filter((provider) => (
        typeof provider?.id === "string" &&
        Number.isInteger(provider?.version) &&
        Number.isInteger(provider?.count)
      ))
      .map(({ id, version, count }) => ({ id, version, count }))
    : [];
  return { providers, warnings: [EXCLUDED_DATA_NOTICE] };
}

function safeCandidate(item) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(item?.workspaceId || "")) return null;
  const label = typeof item.label === "string" &&
    item.label.length <= 120 &&
    !/[\\/]/.test(item.label) &&
    !/^[A-Za-z]:/.test(item.label)
    ? item.label
    : "已保存工作区";
  return {
    workspaceId: item.workspaceId,
    label,
    isCurrent: item.isCurrent === true,
  };
}

function safeWorkspaceMessage(error, operation) {
  const messages = {
    LOCAL_API_UNAVAILABLE: "此功能仅在本地工作台中可用。",
    VAULT_READ_ONLY: "当前为只读接入，不能执行此操作。",
    WORKSPACE_BACKUP_TOO_LARGE: "备份文件超过容量限制。",
    WORKSPACE_BACKUP_CORRUPT: "备份文件格式或版本无效。",
    WORKSPACE_BACKUP_CHECKSUM_INVALID: "备份校验失败，文件可能已经改变。",
    WORKSPACE_BACKUP_PROVIDER_UNKNOWN: "备份包含当前版本无法识别的状态。",
    WORKSPACE_BACKUP_PROVIDER_VERSION_UNSUPPORTED: "备份中的状态版本不受支持。",
    WORKSPACE_BACKUP_PROVIDER_MISSING: "备份缺少当前工作区所需的状态。",
    WORKSPACE_BACKUP_SENSITIVE_DATA: "备份包含不允许恢复的敏感数据。",
    WORKSPACE_BACKUP_ABSOLUTE_PATH: "备份包含不允许恢复的路径信息。",
    WORKSPACE_BACKUP_VAULT_BODY: "备份包含不允许恢复的 Vault 正文。",
    WORKSPACE_RESTORE_PREVIEW_INVALID: "恢复预览已失效，请重新选择备份文件。",
    WORKSPACE_RESTORE_PREVIEW_EXPIRED: "恢复预览已过期，请重新预览。",
    WORKSPACE_REBIND_UNAVAILABLE: "当前工作区不支持重新绑定。",
    WORKSPACE_ALREADY_BOUND: "所选工作区已经绑定到当前 Vault。",
    WORKSPACE_NOT_FOUND: "所选工作区已不存在，请刷新后重试。",
    WORKSPACE_REBIND_PREVIEW_INVALID: "重新绑定预览已失效，请重新选择工作区。",
    WORKSPACE_REBIND_PREVIEW_EXPIRED: "重新绑定预览已过期，请重新预览。",
    WORKSPACE_REBIND_CONFLICT: "当前 Vault 已属于另一个既有工作区。",
  };
  if (messages[error?.code]) return messages[error.code];
  return operation === "export"
    ? "导出工作台备份失败，请稍后重试。"
    : operation === "restore"
      ? "恢复操作暂时无法完成，请重新预览后再试。"
      : "重新绑定暂时无法完成，请稍后重试。";
}

export function workspaceDataReducer(state, action) {
  switch (action.type) {
    case "export-pending":
      return { ...state, export: { status: "pending", message: "正在生成备份…" } };
    case "export-succeeded":
      return { ...state, export: { status: "success", message: "工作台备份已导出。" } };
    case "export-failed":
      return { ...state, export: { status: "error", message: action.message } };
    case "restore-selected":
      return {
        ...state,
        restore: {
          ...initialSection,
          fileName: action.name || "",
          inputIdentity: action.inputIdentity ?? null,
          requestGeneration: action.requestGeneration ?? state.restore.requestGeneration + 1,
          token: null,
          preview: null,
          confirmationEnabled: false,
        },
      };
    case "restore-pending":
      if (
        state.restore.inputIdentity !== action.inputIdentity ||
        state.restore.requestGeneration !== action.requestGeneration
      ) return state;
      return { ...state, restore: { ...state.restore, status: "pending", message: "正在校验备份…" } };
    case "restore-previewed": {
      if (
        state.restore.inputIdentity !== action.inputIdentity ||
        state.restore.requestGeneration !== action.requestGeneration
      ) return state;
      const canConfirm = action.preview?.requiresConfirmation === true && typeof action.preview?.token === "string";
      return {
        ...state,
        restore: {
          ...state.restore,
          status: "success",
          message: "备份已通过预览校验，请确认恢复。",
          token: canConfirm ? action.preview.token : null,
          preview: safeRestorePreview(action.preview),
          confirmationEnabled: canConfirm,
        },
      };
    }
    case "restore-failed":
      if (
        state.restore.inputIdentity !== action.inputIdentity ||
        state.restore.requestGeneration !== action.requestGeneration
      ) return state;
      return {
        ...state,
        restore: {
          ...state.restore,
          status: "error",
          message: action.message,
          token: null,
          preview: null,
          confirmationEnabled: false,
        },
      };
    case "restore-confirmation-failed":
      if (
        state.restore.inputIdentity !== action.inputIdentity ||
        state.restore.requestGeneration !== action.requestGeneration
      ) return state;
      return {
        ...state,
        restore: {
          ...state.restore,
          status: "error",
          message: action.message,
          token: null,
          preview: null,
          confirmationEnabled: false,
        },
      };
    case "restore-confirming":
      return { ...state, restore: { ...state.restore, status: "pending", message: "正在恢复工作区…" } };
    case "restore-confirmed":
      return {
        ...state,
        restore: {
          ...state.restore,
          status: "success",
          message: "工作区状态已恢复。",
          token: null,
          confirmationEnabled: false,
        },
      };
    case "rebind-candidates-pending":
      return { ...state, rebind: { ...state.rebind, candidatesLoading: true } };
    case "rebind-candidates-loaded":
      return { ...state, rebind: { ...state.rebind, candidatesLoading: false, candidates: action.candidates } };
    case "rebind-candidates-failed":
      return { ...state, rebind: { ...state.rebind, candidatesLoading: false, status: "error", message: action.message } };
    case "rebind-selected":
      return {
        ...state,
        rebind: {
          ...state.rebind,
          status: "idle",
          message: null,
          workspaceId: action.workspaceId || "",
          requestGeneration: action.requestGeneration ?? state.rebind.requestGeneration + 1,
          token: null,
          preview: null,
          confirmationEnabled: false,
        },
      };
    case "rebind-pending":
      if (state.rebind.workspaceId !== action.workspaceId) return state;
      return {
        ...state,
        rebind: {
          ...state.rebind,
          requestGeneration: action.requestGeneration,
          status: "pending",
          message: "正在生成重新绑定预览…",
        },
      };
    case "rebind-previewed": {
      if (
        state.rebind.workspaceId !== action.workspaceId ||
        state.rebind.requestGeneration !== action.requestGeneration
      ) return state;
      const canConfirm = action.preview?.requiresConfirmation === true && typeof action.preview?.token === "string";
      return {
        ...state,
        rebind: {
          ...state.rebind,
          status: "success",
          message: "重新绑定预览已生成，请确认后执行。",
          token: canConfirm ? action.preview.token : null,
          preview: canConfirm ? { requiresConfirmation: true } : null,
          confirmationEnabled: canConfirm,
        },
      };
    }
    case "rebind-failed":
      if (
        state.rebind.workspaceId !== action.workspaceId ||
        state.rebind.requestGeneration !== action.requestGeneration
      ) return state;
      return {
        ...state,
        rebind: {
          ...state.rebind,
          status: "error",
          message: action.message,
          token: null,
          preview: null,
          confirmationEnabled: false,
        },
      };
    case "rebind-confirmation-failed":
      if (
        state.rebind.workspaceId !== action.workspaceId ||
        state.rebind.requestGeneration !== action.requestGeneration
      ) return state;
      return {
        ...state,
        rebind: {
          ...state.rebind,
          status: "error",
          message: action.message,
          token: null,
          preview: null,
          confirmationEnabled: false,
        },
      };
    case "rebind-confirming":
      return { ...state, rebind: { ...state.rebind, status: "pending", message: "正在重新绑定本地工作区…" } };
    case "rebind-confirmed":
      return {
        ...state,
        rebind: {
          ...state.rebind,
          status: "success",
          message: "本地工作区已重新绑定。",
          token: null,
          preview: null,
          confirmationEnabled: false,
        },
      };
    default:
      return state;
  }
}

function Status({ section }) {
  if (!section.message) return null;
  return <p className={`workspace-data__status workspace-data__status--${section.status}`} role={section.status === "error" ? "alert" : "status"} aria-live="polite">{section.message}</p>;
}

export function openRestoreFilePicker(input) {
  if (!input) return false;
  input.value = "";
  input.click();
  return true;
}

function downloadBackup(bundle) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = "workbench-backup.json";
  anchor.click();
  URL.revokeObjectURL(href);
}

export function WorkspaceDataPanel({ available = false, capabilities = {} }) {
  const [state, dispatch] = useReducer(workspaceDataReducer, initialWorkspaceDataState);
  const restoreFileInput = useRef(null);
  const restorePreviewGeneration = useRef(0);
  const rebindPreviewGeneration = useRef(0);

  useEffect(() => {
    if (!available || capabilities.list !== true) return undefined;
    let cancelled = false;
    dispatch({ type: "rebind-candidates-pending" });
    loadWorkspaceRebindCandidates()
      .then((response) => {
        if (cancelled) return;
        const candidates = (Array.isArray(response?.items) ? response.items : [])
          .map(safeCandidate)
          .filter(Boolean);
        dispatch({ type: "rebind-candidates-loaded", candidates });
      })
      .catch((error) => {
        if (!cancelled) dispatch({ type: "rebind-candidates-failed", message: safeWorkspaceMessage(error, "rebind") });
      });
    return () => { cancelled = true; };
  }, [available, capabilities.list]);

  if (!available || !["export", "list", "restore", "rebind"].some((key) => capabilities[key] === true)) return null;

  const exportBackup = async () => {
    if (capabilities.export !== true) return;
    dispatch({ type: "export-pending" });
    try {
      downloadBackup(await exportWorkspaceBackup());
      dispatch({ type: "export-succeeded" });
    } catch (error) {
      dispatch({ type: "export-failed", message: safeWorkspaceMessage(error, "export") });
    }
  };

  const selectRestoreBundle = async (event) => {
    if (capabilities.restore !== true) return;
    const file = event.target.files?.[0];
    const requestGeneration = ++restorePreviewGeneration.current;
    const inputIdentity = file ? `${file.name}\u0000${file.size}\u0000${file.lastModified}` : "";
    dispatch({ type: "restore-selected", name: file?.name || "", inputIdentity, requestGeneration });
    if (!file) return;
    dispatch({ type: "restore-pending", inputIdentity, requestGeneration });
    try {
      const bundle = JSON.parse(await file.text());
      dispatch({
        type: "restore-previewed",
        inputIdentity,
        requestGeneration,
        preview: await previewWorkspaceRestore(bundle),
      });
    } catch (error) {
      dispatch({
        type: "restore-failed",
        inputIdentity,
        requestGeneration,
        message: safeWorkspaceMessage(error, "restore"),
      });
    }
  };

  const confirmRestore = async () => {
    if (capabilities.restore !== true || !state.restore.confirmationEnabled || !state.restore.token) return;
    const { inputIdentity, requestGeneration, token } = state.restore;
    dispatch({ type: "restore-confirming" });
    try {
      await confirmWorkspaceRestore(token);
      dispatch({ type: "restore-confirmed" });
    } catch (error) {
      dispatch({
        type: "restore-confirmation-failed",
        inputIdentity,
        requestGeneration,
        message: safeWorkspaceMessage(error, "restore"),
      });
    }
  };

  const previewRebind = async () => {
    if (capabilities.rebind !== true || !state.rebind.workspaceId) return;
    const workspaceId = state.rebind.workspaceId;
    const requestGeneration = ++rebindPreviewGeneration.current;
    dispatch({ type: "rebind-pending", workspaceId, requestGeneration });
    try {
      dispatch({
        type: "rebind-previewed",
        workspaceId,
        requestGeneration,
        preview: await previewWorkspaceRebind(workspaceId),
      });
    } catch (error) {
      dispatch({
        type: "rebind-failed",
        workspaceId,
        requestGeneration,
        message: safeWorkspaceMessage(error, "rebind"),
      });
    }
  };

  const confirmRebind = async () => {
    if (capabilities.rebind !== true || !state.rebind.confirmationEnabled || !state.rebind.token) return;
    const { workspaceId, requestGeneration, token } = state.rebind;
    dispatch({ type: "rebind-confirming" });
    try {
      await confirmWorkspaceRebind(token);
      dispatch({ type: "rebind-confirmed" });
    } catch (error) {
      dispatch({
        type: "rebind-confirmation-failed",
        workspaceId,
        requestGeneration,
        message: safeWorkspaceMessage(error, "rebind"),
      });
    }
  };

  return (
    <section className="panel workspace-data" aria-labelledby="workspace-data-title">
      <div className="panel__head"><h2 className="panel__title" id="workspace-data-title">工作区备份与恢复</h2></div>
      <p className="workspace-data__hint">仅用于本地工作台状态；不会导出凭据、缓存、绝对路径或 Vault 正文。</p>

      {capabilities.export === true ? <div className="workspace-data__section">
        <h3>导出</h3>
        <button className="graph-filter" type="button" onClick={exportBackup} disabled={state.export.status === "pending"}>{state.export.status === "pending" ? "正在导出…" : "导出工作台备份"}</button>
        <Status section={state.export} />
      </div> : null}

      {capabilities.restore === true ? <div className="workspace-data__section">
        <h3>恢复</h3>
        <p className="workspace-data__hint">{EXCLUDED_DATA_NOTICE}</p>
        <label className="workspace-data__file-label" htmlFor="workspace-restore-file">选择备份文件</label>
        <input ref={restoreFileInput} id="workspace-restore-file" type="file" accept="application/json,.json" onChange={selectRestoreBundle} />
        {state.restore.fileName ? <p className="workspace-data__selection">已选择：{state.restore.fileName}</p> : null}
        <button className="graph-filter" type="button" onClick={() => openRestoreFilePicker(restoreFileInput.current)} disabled={state.restore.status === "pending"}>{state.restore.status === "pending" ? "正在预览…" : "预览恢复"}</button>
        {state.restore.preview ? <div className="workspace-data__preview" aria-label="恢复预览"><p>状态提供方：</p><ul>{state.restore.preview.providers.map((provider) => <li key={provider.id}>{provider.id} · v{provider.version} · {provider.count} 条记录</li>)}</ul><p>提示：</p><ul>{state.restore.preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}
        <button className="graph-filter workspace-data__confirm" type="button" onClick={confirmRestore} disabled={!state.restore.confirmationEnabled || state.restore.status === "pending"}>确认恢复</button>
        <Status section={state.restore} />
      </div> : null}

      {capabilities.list === true ? <div className="workspace-data__section">
        <h3>重新绑定</h3>
        <label className="workspace-data__file-label" htmlFor="workspace-rebind-candidate">选择已保存的工作区</label>
        <select id="workspace-rebind-candidate" value={state.rebind.workspaceId} onChange={(event) => dispatch({ type: "rebind-selected", workspaceId: event.target.value, requestGeneration: ++rebindPreviewGeneration.current })} disabled={state.rebind.candidatesLoading}>
          <option value="">{state.rebind.candidatesLoading ? "正在读取可用工作区…" : "请选择工作区"}</option>
          {state.rebind.candidates.map((candidate) => <option key={candidate.workspaceId} value={candidate.workspaceId}>{candidate.label}{candidate.isCurrent ? "（当前）" : ""}</option>)}
        </select>
        {capabilities.rebind === true ? <><button className="graph-filter" type="button" onClick={previewRebind} disabled={!state.rebind.workspaceId || state.rebind.status === "pending"}>预览重新绑定</button>
        {state.rebind.preview ? <p className="workspace-data__preview">预览已完成。确认后，当前 Vault 将关联到所选工作区。</p> : null}
        <button className="graph-filter workspace-data__confirm" type="button" onClick={confirmRebind} disabled={!state.rebind.confirmationEnabled || state.rebind.status === "pending"}>重新绑定本地工作区</button></> : null}
        <Status section={state.rebind} />
      </div> : null}
    </section>
  );
}
