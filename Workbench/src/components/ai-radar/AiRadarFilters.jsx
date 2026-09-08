import { RADAR_PERIODS, RADAR_LISTS, RADAR_STATES, RADAR_FOCUSES } from "../../lib/ai-radar-model.js";

export const RADAR_PERIOD_LABELS = Object.freeze({ day: "今日", week: "每周", month: "每月" });
export const RADAR_LIST_LABELS = Object.freeze({ rising: "快速上升", established: "长期热门", relevant: "与你相关" });
export const RADAR_STATE_LABELS = Object.freeze({
  all: "全部",
  unread: "未处理",
  saved: "收藏",
  summarized: "已摘要",
  queued: "学习队列",
  learning: "学习中",
  completed: "已完成",
  ignored: "已忽略",
});
export const RADAR_FOCUS_LABELS = Object.freeze({
  all: "全部",
  agent: "AI Agent",
  "ai-coding": "AI 编程",
  "rag-knowledge": "RAG/知识库",
  "ai-productivity": "AI 应用与生产力",
});

function TabBar({ label, options, labels, value, onChange }) {
  return (
    <div className="radar-tabs" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          aria-pressed={value === option}
          className={value === option ? "radar-tabs__tab radar-tabs__tab--active" : "radar-tabs__tab"}
          key={option}
          onClick={() => onChange(option)}
          type="button"
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}

export function AiRadarFilters({ filter, onChangeFilter }) {
  return (
    <section className="radar-filters" aria-label="雷达筛选">
      <TabBar label="周期" labels={RADAR_PERIOD_LABELS} onChange={(period) => onChangeFilter({ period })} options={RADAR_PERIODS} value={filter.period} />
      <TabBar label="榜单" labels={RADAR_LIST_LABELS} onChange={(list) => onChangeFilter({ list })} options={RADAR_LISTS} value={filter.list} />
      <div className="radar-filters__selects">
        <label>
          状态
          <select onChange={(event) => onChangeFilter({ state: event.target.value })} value={filter.state}>
            {RADAR_STATES.map((state) => (
              <option key={state} value={state}>{RADAR_STATE_LABELS[state]}</option>
            ))}
          </select>
        </label>
        <label>
          方向
          <select onChange={(event) => onChangeFilter({ focus: event.target.value })} value={filter.focus}>
            {RADAR_FOCUSES.map((focus) => (
              <option key={focus} value={focus}>{RADAR_FOCUS_LABELS[focus]}</option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}