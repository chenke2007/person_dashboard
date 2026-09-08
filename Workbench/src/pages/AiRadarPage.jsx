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
  describeRadarCollectResult,
  loadRadar,
  loadRadarCapabilities,
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
// overwrite a newer filter's result. The filter that produced each value is
// passed back so callers can bind a view to the exact query that generated it.
export function createRadarDashboardLoader(loadDashboard, onChange) {
  let sequence = 0;
  return Object.freeze({
    load(filter) {
      sequence += 1;
      const current = sequence;
      return Promise.resolve(loadDashboard(filter)).then(
        (value) => {
          if (current !== sequence) return null;
          onChange(value, undefined, filter);
          return value;
        },
        (error) => {
          if (current === sequence) onChange(null, error, filter);
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
  refreshError,
  capabilitiesError,
  statusError,
  preferencesError,
  status,
  schedule,
  preferences,
  readOnly,
  busy,
  actionErrors,
  collectFeedback,
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
      {capabilitiesError ? (
        <div className="radar-message radar-message--error" role="alert">
          <p>无法确认雷达权限：{capabilitiesError}。已停用修改操作以保安全。</p>
          {actions?.onRetryCapabilities ? (
            <button onClick={() => actions.onRetryCapabilities()} type="button">重试</button>
          ) : null}
        </div>
      ) : null}
      <AiRadarStatus
        actionErrors={actionErrors}
        actions={actions}
        busy={busy}
        collectFeedback={collectFeedback}
        onRetryStatus={actions?.onRetryAux}
        readOnly={readOnly}
        schedule={schedule}
        stale={stale}
        status={status}
        statusError={statusError}
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
      {refreshError ? (
        <div className="radar-message radar-message--error" role="alert">
          <p>榜单刷新失败：{refreshError}，正在显示上次成功数据。</p>
          {actions?.onRetry ? (
            <button onClick={() => actions.onRetry()} type="button">重试</button>
          ) : null}
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
          {preferencesError ? (
            <div className="radar-message radar-message--error" role="alert">
              <p>推荐偏好读取失败：{preferencesError}，正在显示上次成功数据。</p>
              {actions?.onRetryAux ? (
                <button onClick={() => actions.onRetryAux()} type="button">重试</button>
              ) : null}
            </div>
          ) : preferences?.length ? (
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
  const [radarCapabilities, setRadarCapabilities] = useState(null);
  const [capabilitiesError, setCapabilitiesError] = useState(null);
  // Radar mutation capability comes from the server (collect/schedule), which is
  // independent of Vault read-only. While capabilities are pending or failed, the
  // page stays conservative (read-only) — a failed/pending capability request must
  // never fall back to writable. The server remains the arbiter.
  const radarReadOnly = radarCapabilities ? radarCapabilities.collect !== true : true;
  const loadCaps = useCallback(() => {
    loadRadarCapabilities()
      .then((body) => { setRadarCapabilities(body?.capabilities ?? null); setCapabilitiesError(null); })
      .catch((error) => setCapabilitiesError(error?.message ?? "无法读取雷达权限信息"));
  }, []);
  useEffect(() => { void loadCaps(); }, [loadCaps]);
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = useMemo(() => radarFilterFromSearch(searchParams), [searchParams]);
  const [dashboard, setDashboard] = useState(null);
  const [dashboardError, setDashboardError] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [preferences, setPreferences] = useState([]);
  const [preferencesError, setPreferencesError] = useState(null);
  const [busy, setBusy] = useState({ collect: false, save: false, decision: null, lessLike: null, revert: null, reset: false });
  const [actionErrors, setActionErrors] = useState({ collect: null, save: null, decision: {}, lessLike: {}, revert: {}, reset: null });
  const [collectFeedback, setCollectFeedback] = useState(null);
  const filterRef = useRef(filter);
  useEffect(() => { filterRef.current = filter; }, [filter]);
  const loaderRef = useRef(null);
  const [dashboardQuery, setDashboardQuery] = useState(null);
  const dashboardQueryRef = useRef(null);

  const applyDashboard = useCallback((value, error, query) => {
    const q = query ?? null;
    if (error) {
      // A failed query whose data we never displayed (initial load with no
      // cache, or a different filter than the board on screen) is a fatal
      // error. A failed *refresh of the currently displayed filter* must keep
      // the last good board and only surface a refresh error + stale marker.
      const current = dashboardQueryRef.current;
      const matchesCurrent = Boolean(current) && current.period === q?.period && current.state === q?.state && current.focus === q?.focus;
      if (matchesCurrent) {
        setRefreshError(error.message);
        setLoading(false);
        return;
      }
      setDashboard(null);
      setDashboardQuery(null);
      dashboardQueryRef.current = null;
      setDashboardError(error.message);
      setRefreshError(null);
      setLoading(false);
      return;
    }
    setDashboard(value);
    setDashboardQuery(q);
    dashboardQueryRef.current = q;
    setDashboardError(null);
    setRefreshError(null);
    setLoading(false);
  }, []);

  const reloadFor = useCallback((query) => {
    const loader = loaderRef.current ??= createRadarDashboardLoader(loadRadar, applyDashboard);
    setLoading(true);
    return loader.load({ period: query.period, state: query.state, focus: query.focus }).catch(() => {});
  }, [applyDashboard]);

  // Reflect filter changes from the URL (period/state/focus each require a re-query).
  useEffect(() => {
    void reloadFor({ period: filter.period, state: filter.state, focus: filter.focus });
  }, [reloadFor, filter.period, filter.state, filter.focus]);

  const refreshExtras = useCallback(() => Promise.all([
    loadRadarStatus()
      .then((body) => { setStatus(body); setStatusError(null); })
      .catch((error) => setStatusError(error?.message ?? "状态读取失败")),
    loadRadarPreferences()
      .then((body) => { setPreferences(body); setPreferencesError(null); })
      .catch((error) => setPreferencesError(error?.message ?? "偏好读取失败")),
  ]), []);
  useEffect(() => { void refreshExtras(); }, [refreshExtras]);

  // Refreshes the *current* filter (never the one captured when an action
  // started) and waits for the actual reload to settle before resolving.
  const refreshAfter = useCallback(async () => {
    const query = filterRef.current;
    await Promise.all([reloadFor(query), refreshExtras()]);
  }, [reloadFor, refreshExtras]);

  const retry = useCallback(() => reloadFor(filterRef.current), [reloadFor]);

  // Bind the view to the exact query that produced the dashboard, so a pending
  // filter change never shows the previous period's data under the new one.
  const dashboardMatches =
    Boolean(dashboardQuery) &&
    dashboardQuery.period === filter.period &&
    dashboardQuery.state === filter.state &&
    dashboardQuery.focus === filter.focus;
  const currentDashboard = dashboardMatches ? dashboard : null;
  const view = useMemo(
    () => (currentDashboard ? projectRadarDashboard(currentDashboard, { period: filter.period, list: filter.list, state: filter.state, focus: filter.focus }) : null),
    [currentDashboard, filter],
  );
  const stale = currentDashboard?.freshness?.stale === true || Boolean(refreshError);
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
    setCollectFeedback(null);
    try {
      const result = await collectRadar();
      const outcome = describeRadarCollectResult(result);
      if (outcome.level === "success" || outcome.level === "partial") {
        setCollectFeedback({ level: outcome.level, message: outcome.message });
      } else {
        setActionErrors((e) => ({ ...e, collect: outcome.message }));
      }
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
    onRetry: retry,
    onRetryCapabilities: loadCaps,
    onRetryAux: refreshExtras,
  }), [onCollect, onDecide, onLessLike, onRevertPreference, onResetPreferences, onUpdateSchedule, retry, loadCaps, refreshExtras]);

  return (
    <AiRadarView
      actionErrors={actionErrors}
      actions={actions}
      busy={busy}
      capabilitiesError={capabilitiesError}
      collectFeedback={collectFeedback}
      error={dashboardError}
      filter={filter}
      loading={loading}
      onChangeFilter={onChangeFilter}
      preferences={preferences}
      preferencesError={preferencesError}
      readOnly={radarReadOnly}
      refreshError={refreshError}
      schedule={schedule}
      stale={stale}
      status={status}
      statusError={statusError}
      view={view}
    />
  );
}