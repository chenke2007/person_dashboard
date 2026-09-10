import {
  RADAR_FOCUS_LABELS,
  RADAR_FOCUSES,
  RADAR_LEARNING_LABELS,
  RADAR_LEARNING_STATES,
  RADAR_LIST_LABELS,
  RADAR_LISTS,
  RADAR_PERIOD_LABELS,
  RADAR_PERIODS,
  RADAR_STATE_LABELS,
  RADAR_STATES,
} from "../../lib/ai-radar-model.js";

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
        <label>
          学习
          <select name="learning" onChange={(event) => onChangeFilter({ learning: event.target.value })} value={filter.learning}>
            {RADAR_LEARNING_STATES.map((learning) => (
              <option key={learning} value={learning}>{RADAR_LEARNING_LABELS[learning]}</option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}