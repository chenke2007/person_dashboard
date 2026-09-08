import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { AiRadarCard } from "../components/ai-radar/AiRadarCard";
import { AiRadarFilters } from "../components/ai-radar/AiRadarFilters";
import { AiRadarStatus } from "../components/ai-radar/AiRadarStatus";
import { RADAR_FOCUSES, RADAR_LISTS, RADAR_PERIODS, RADAR_STATES, projectRadarDashboard } from "../lib/ai-radar-model.js";
import {
  addRadarPreference,
  collectRadar,
  loadRadar,
  loadRadarPreferences,
  loadRadarStatus,
  resetRadarPreferences,
  revertRadarPreference,
  setRadarDecision,
  updateRadarSchedule,
} from "../lib/ai-radar-api.js";
import "../components/ai-radar/ai-radar.css";

export function radarFilterFromSearch(params) {
  const get = (key, choices, fallback) => {
    const value = params.get(key);
    return choices.includes(value) ? value : fallback;
  };
  return {
    period: get("period", RADAR_PERIODS, "day"),
    list: get("list", RADAR_LISTS, "rising"),
    state: get("state", RADAR_STATES, "all"),
    focus: get("focus", RADAR_FOCUSES, "all"),
  };
}

export function radarFilterToSearch(filter = {}) {
  const params = new URLSearchParams();
  for (const [key, fallback] of Object.entries({ period: "day", list: "rising", state: "all", focus: "all" })) {
    const value = filter[key] ?? fallback;
    if (value !== fallback) params.set(key, value);
  }
  return params;
}

// Loads the server dashboard per period/state/focus and delivers to `onChange`
// only the outcome of the newest request, so a slow older response can never
// overwrite a newer filter's result.
export function createRadarDashboardLoader(loadDashboard, onChange) {
  let sequence = 0;
  return Object.freeze({
    load(filter) {
      sequence += 1;
      const current = sequence;
      return Promise.resolve(loadDashboard(filter)).then(
        (value) => {
          if (current !== sequence) return null;
          onChange(value);
          return value;
        },
        (error) => {
          if (current === sequence) onChange(null, error);
          return Promise.reject(error);
        },
      );
    },
  });
}

const KIND_LABELS = { topic: "主题", language: "语言", repository: "仓库" };

export function AiRadarView({
  filter,
  onChangeFilter,
  view,
  loading,
  error,
  stale,
  status,
  schedule,
  preferences,
  readOnly,
  busy,
  actionErrors,
  actions,
}) {
  const cards = view && !view.empty && Array.isArray(view.cards) ? view.cards : [];
  return (
    <section className="radar-page page-shell">
      <PageHeader
        eyebrow="AI RADAR"
        title="AI 雷达"
        description="发现值得关注的 AI 项目，用本地观测与现有命令形成可解释的日、周、月榜单。"
      />
      <AiRadarStatus
        actionErrors={actionErrors}
        actions={actions}
        busy={busy}
        readOnly={readOnly}
        schedule={schedule}
        stale={stale}
        status={status}
      />
      <AiRadarFilters filter={filter} onChangeFilter={onChangeFilter} />
      {error ? (
        <div className="radar-message radar-message--error" role="alert">
          <p>AI 雷达加载失败：{error}</p>
          {actions?.onRetry ? (
            <button onClick={() => actions.onRetry()} type="button">重试</button>
          ) : null}
        </div>
      ) : null}
      {!error && loading && !view ? (
        <div className="radar-message">正在读取雷达数据…</div>
      ) : null}
      {!error && view?.empty ? (
        <div className="radar-empty">
          <h2>当前筛选下暂无雷达记录</h2>
          <p>本地观测仍在积累时不会编造数据；可稍后查看，或调整周期、状态与方向筛选。</p>
        </div>
      ) : null}
      {!error && cards.length ? (
        <div className="radar-cards">
          {cards.map((card) => (
            <AiRadarCard
              actionErrors={actionErrors}
              busy={busy}
              card={card}
              key={card.repositoryId}
              onDecide={actions.onDecide}
              onLessLike={actions.onLessLike}
              readOnly={readOnly}
            />
          ))}
        </div>
      ) : null}
      {!error && !readOnly ? (
        <section aria-label="推荐偏好" className="radar-preferences">
          <header className="radar-preferences__head">
            <h2>推荐偏好</h2>
            {preferences?.length ? (
              <button disabled={busy?.reset} onClick={() => actions.onResetPreferences()} type="button">
                {busy?.reset ? "重置中…" : "重置全部"}
              </button>
            ) : null}
          </header>
          {actionErrors?.reset ? <p className="radar-card__error" role="alert">{actionErrors.reset}</p> : null}
          {preferences?.length ? (
            <ul className="radar-preferences__list">
              {preferences.map((preference) => {
                const kindLabel = KIND_LABELS[preference.kind] ?? preference.kind;
                const label = `${preference.direction === "less" ? "减少类似" : "偏好更多"}${kindLabel}：${preference.value}`;
                const revertBusy = busy?.revert instanceof Set && busy.revert.has(preference.id);
                const revertError = actionErrors?.revert?.[preference.id] ?? null;
                return (
                  <li key={preference.id}>
                    <span>{label}</span>
                    <button
                      aria-label={`撤销 ${label}`}
                      disabled={revertBusy}
                      onClick={() => actions.onRevertPreference(preference.id)}
                      type="button"
                    >
                      {revertBusy ? "撤销中…" : "撤销"}
                    </button>
                    {revertError ? <p className="radar-card__error" role="alert">{revertError}</p> : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="radar-preferences__empty">暂无偏好信号。</p>
          )}
        </section>
      ) : null}
    </section>
  );
}

export function AiRadarPage() {
  const radarReadOnly = import.meta.env.VITE_WORKBENCH_READ_ONLY === "true";
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = useMemo(() => radarFilterFromSearch(searchParams), [searchParams]);
  const [dashboard, setDashboard] = useState(null);
  const [dashboardError, setDashboardError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [preferences, setPreferences] = useState([]);
  const [busy, setBusy] = useState({ collect: false, save: false, decision: null, lessLike: null, revert: null, reset: false });
  const [actionErrors, setActionErrors] = useState({ collect: null, save: null, decision: {}, lessLike: {}, revert: {}, reset: null });
  const loaderRef = useRef(null);

  const queryKey = `${filter.period}|${filter.state}|${filter.focus}`;
  const reload = useCallback(() => {
    const loader = loaderRef.current ??= createRadarDashboardLoader(loadRadar, (value, error) => {
      setDashboard(value);
      setDashboardError(error ? error.message : null);
      setLoading(false);
    });
    setLoading(true);
    void loader.load({ period: filter.period, state: filter.state, focus: filter.focus }).catch(() => {});
  }, [filter.period, filter.state, filter.focus]);

  useEffect(() => { reload(); }, [reload]);

  const refreshExtras = useCallback(() => {
    void loadRadarStatus().then(setStatus).catch(() => {});
    void loadRadarPreferences().then(setPreferences).catch(() => {});
  }, []);
  useEffect(() => { refreshExtras(); }, [refreshExtras]);

  const refreshAfter = useCallback(async () => {
    reload();
    refreshExtras();
  }, [reload, refreshExtras]);

  const view = useMemo(
    () => (dashboard ? projectRadarDashboard(dashboard, { period: filter.period, list: filter.list, state: filter.state, focus: filter.focus }) : null),
    [dashboard, filter],
  );
  const stale = dashboard?.freshness?.stale === true;
  const schedule = dashboard?.schedule ?? null;

  const onChangeFilter = useCallback((patch) => {
    setSearchParams(radarFilterToSearch({ ...filter, ...patch }));
  }, [filter, setSearchParams]);

  const beginRepo = (key, id) => setBusy((b) => ({ ...b, [key]: new Set([...(b[key] ?? []), id]) }));
  const endRepo = (key, id) => setBusy((b) => {
    const next = new Set(b[key] ?? []);
    next.delete(id);
    return { ...b, [key]: next };
  });
  const failRepo = (key, id, message) => setActionErrors((e) => ({ ...e, [key]: { ...(e[key] ?? {}), [id]: message } }));
  const clearRepoError = (key, id) => setActionErrors((e) => ({ ...e, [key]: { ...(e[key] ?? {}), [id]: null } }));

  const onCollect = useCallback(async () => {
    setBusy((b) => ({ ...b, collect: true }));
    setActionErrors((e) => ({ ...e, collect: null }));
    try {
      await collectRadar();
      await refreshAfter();
    } catch (error) {
      setActionErrors((e) => ({ ...e, collect: error?.message ?? "采集失败，请重试。" }));
    } finally {
      setBusy((b) => ({ ...b, collect: false }));
    }
  }, [refreshAfter]);

  const onUpdateSchedule = useCallback(async (draft) => {
    setBusy((b) => ({ ...b, save: true }));
    setActionErrors((e) => ({ ...e, save: null }));
    try {
      await updateRadarSchedule(draft);
      await refreshAfter();
    } catch (error) {
      setActionErrors((e) => ({ ...e, save: error?.message ?? "保存设置失败，请检查后重试。" }));
    } finally {
      setBusy((b) => ({ ...b, save: false }));
    }
  }, [refreshAfter]);

  const onDecide = useCallback(async (repositoryId, decisionStatus) => {
    beginRepo("decision", repositoryId);
    clearRepoError("decision", repositoryId);
    try {
      await setRadarDecision(repositoryId, decisionStatus);
      await refreshAfter();
    } catch (error) {
      failRepo("decision", repositoryId, error?.message ?? "保存决策失败，请重试。");
    } finally {
      endRepo("decision", repositoryId);
    }
  }, [refreshAfter]);

  const onLessLike = useCallback(async (repositoryId) => {
    const card = view?.cards.find((item) => item.repositoryId === repositoryId);
    if (!card) return;
    const topic = Array.isArray(card.topics) && card.topics.length ? card.topics[0] : null;
    const value = topic ?? card.language;
    if (!value) return;
    beginRepo("lessLike", repositoryId);
    clearRepoError("lessLike", repositoryId);
    try {
      await addRadarPreference({ repositoryId: null, kind: topic ? "topic" : "language", value, direction: "less" });
      await refreshAfter();
    } catch (error) {
      failRepo("lessLike", repositoryId, error?.message ?? "偏好提交失败，请重试。");
    } finally {
      endRepo("lessLike", repositoryId);
    }
  }, [refreshAfter, view]);

  const onRevertPreference = useCallback(async (preferenceId) => {
    beginRepo("revert", preferenceId);
    clearRepoError("revert", preferenceId);
    try {
      await revertRadarPreference(preferenceId);
      await refreshAfter();
    } catch (error) {
      failRepo("revert", preferenceId, error?.message ?? "撤销偏好失败，请重试。");
    } finally {
      endRepo("revert", preferenceId);
    }
  }, [refreshAfter]);

  const onResetPreferences = useCallback(async () => {
    setBusy((b) => ({ ...b, reset: true }));
    setActionErrors((e) => ({ ...e, reset: null }));
    try {
      await resetRadarPreferences();
      await refreshAfter();
    } catch (error) {
      setActionErrors((e) => ({ ...e, reset: error?.message ?? "重置偏好失败，请重试。" }));
    } finally {
      setBusy((b) => ({ ...b, reset: false }));
    }
  }, [refreshAfter]);

  const actions = useMemo(() => ({
    onCollect,
    onDecide,
    onLessLike,
    onRevertPreference,
    onResetPreferences,
    onUpdateSchedule,
    onRetry: reload,
  }), [onCollect, onDecide, onLessLike, onRevertPreference, onResetPreferences, onUpdateSchedule, reload]);

  return (
    <AiRadarView
      actionErrors={actionErrors}
      actions={actions}
      busy={busy}
      error={dashboardError}
      filter={filter}
      loading={loading}
      onChangeFilter={onChangeFilter}
      preferences={preferences}
      readOnly={radarReadOnly}
      schedule={schedule}
      stale={stale}
      status={status}
      view={view}
    />
  );
}