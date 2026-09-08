import { useCallback, useEffect, useRef, useState } from "react";
import { loadRadar } from "../../lib/ai-radar-api.js";
import { projectRadarDashboard } from "../../lib/ai-radar-model.js";

export const OVERVIEW_MAX_PICKS = 3;

// Pure projection: picks up to OVERVIEW_MAX_PICKS day/relevant recommendations in
// server order and exposes the unread count and last data timestamp. Reuses the
// card projection so the overview never invents entries the server did not send.
export function projectRadarOverview(dashboard) {
  const view = projectRadarDashboard(dashboard, { period: "day", list: "relevant", state: "all", focus: "all" });
  const cards = view.cards.slice(0, OVERVIEW_MAX_PICKS);
  return {
    cards,
    cardCount: cards.length,
    unreadCount: typeof dashboard?.counts?.unread === "number" ? dashboard.counts.unread : null,
    updatedAt: dashboard?.freshness?.lastSuccessAt ?? dashboard?.freshness?.asOf ?? null,
    updatedAtRaw: dashboard?.freshness?.lastSuccessAt ?? dashboard?.freshness?.asOf ?? null,
    stale: dashboard?.freshness?.stale === true,
    empty: cards.length === 0,
  };
}

function formatUpdatedAt(iso) {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return String(iso).slice(0, 16).replace("T", " ");
  }
}

// Presentational overview panel. The data is supplied by the parent (or the hook)
// so tests can render it statically while the page wires a live fetch.
export function AiRadarOverview({
  model,
  loading,
  error,
  refreshError,
  onRetry,
  onOpenRadar,
}) {
  const cards = model?.cards ?? [];
  const updated = formatUpdatedAt(model?.updatedAtRaw ?? model?.updatedAt);
  const showStale = Boolean(model?.stale) || Boolean(refreshError);
  return (
    <section className="panel overview-radar" aria-label="AI 雷达总览">
      <div className="panel__head">
        <div>
          <span className="eyebrow">AI RADAR</span>
          <h2 className="panel__title" style={{ marginTop: 8 }}>AI 雷达</h2>
        </div>
        <button
          className="graph-filter"
          onClick={onOpenRadar}
          type="button"
        >
          查看完整雷达
        </button>
      </div>

      {error && !model ? (
        <div className="radar-message radar-message--error" role="alert">
          <p>雷达数据加载失败：{error}。</p>
          {onRetry ? <button onClick={onRetry} type="button">重试</button> : null}
        </div>
      ) : null}
      {!error && loading && !model ? (
        <div className="radar-message">雷达数据加载中…</div>
      ) : null}
      {refreshError ? (
        <div className="radar-message radar-message--error" role="alert">
          <p>雷达刷新失败：{refreshError}，正在显示上次成功数据。</p>
          {onRetry ? <button onClick={onRetry} type="button">重试</button> : null}
        </div>
      ) : null}
      {showStale && !error ? (
        <p className="radar-status__stale" role="status">雷达数据可能不是最新。</p>
      ) : null}

      {model && model.empty && !error ? (
        <div className="collection-empty">本地雷达尚未积累推荐。</div>
      ) : null}

      {cards.length ? (
        <ul className="overview-radar__list">
          {cards.map((card) => {
            const delta = typeof card.observedStarDelta === "number" ? card.observedStarDelta : null;
            return (
              <li className="overview-radar__item" key={card.repositoryId}>
                <a href={card.htmlUrl} rel="noopener noreferrer" target="_blank">
                  {card.fullName}
                </a>
                <span className="overview-radar__meta">{card.stars ?? "—"}★</span>
                <span className="overview-radar__meta">
                  {delta === null ? "积累中" : delta > 0 ? `+${delta}` : delta}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {model ? (
        <div className="overview-radar__foot">
          {updated ? <span>更新于 {updated}</span> : null}
          {typeof model.unreadCount === "number" && model.unreadCount > 0 ? (
            <span>{model.unreadCount} 条未处理</span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// Self-loading overview used by the overview page. Loads the day/relevant radar
// dashboard on mount and on visibility so a slow or failing radar request cannot
// block any other overview module; failures keep the last good picks.
export function useRadarOverview() {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const dashboardRef = useRef(null);

  const apply = useCallback((value, err) => {
    if (err) {
      if (dashboardRef.current) {
        // Refresh failure with retained data: keep old picks, mark error + stale.
        setRefreshError(err?.message ?? "雷达数据读取失败");
      } else {
        // First load failure with no data: fatal error, never claim kept data.
        setError(err?.message ?? "雷达数据读取失败");
      }
      setLoading(false);
      return;
    }
    dashboardRef.current = value;
    setDashboard(value);
    setError(null);
    setRefreshError(null);
    setLoading(false);
  }, []);

  const load = useCallback(() => {
    loadRadar({ period: "day", state: "all", focus: "all" })
      .then((value) => apply(value, null))
      .catch((loadError) => apply(null, loadError));
  }, [apply]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    load();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const retry = useCallback(() => { setLoading(true); load(); }, [load]);
  const model = dashboard ? projectRadarOverview(dashboard) : null;
  return { model, loading, error, refreshError, retry };
}
