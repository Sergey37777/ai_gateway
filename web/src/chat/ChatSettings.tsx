import type { ReasoningEffort } from "./request";
import { parseMaxTokens, parseTemperature, type SettingsDraft } from "./settings";

interface Props {
  value: SettingsDraft;
  onChange: (value: SettingsDraft) => void;
}

const EFFORTS: { value: ReasoningEffort | ""; label: string }[] = [
  { value: "", label: "по умолчанию" },
  { value: "none", label: "выключить (none)" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
];

export function ChatSettings({ value, onChange }: Props) {
  const temperatureInvalid =
    value.temperature.trim() !== "" && parseTemperature(value.temperature) === null;
  const maxTokensInvalid =
    value.maxTokens.trim() !== "" && parseMaxTokens(value.maxTokens) === null;
  return (
    <details className="chat-settings">
      <summary>Настройки</summary>
      <div className="stack">
        <div className="field">
          <label htmlFor="chat-system">Системный промпт</label>
          <textarea
            id="chat-system"
            rows={3}
            value={value.systemPrompt}
            onChange={(event) => {
              onChange({ ...value, systemPrompt: event.target.value });
            }}
          />
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="chat-temperature">Температура</label>
            <input
              id="chat-temperature"
              inputMode="decimal"
              placeholder="0–2, по умолчанию"
              aria-invalid={temperatureInvalid}
              value={value.temperature}
              onChange={(event) => {
                onChange({ ...value, temperature: event.target.value });
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="chat-max-tokens">Макс. токенов</label>
            <input
              id="chat-max-tokens"
              inputMode="numeric"
              placeholder="по умолчанию"
              aria-invalid={maxTokensInvalid}
              value={value.maxTokens}
              onChange={(event) => {
                onChange({ ...value, maxTokens: event.target.value });
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="chat-reasoning">Рассуждения</label>
            <select
              id="chat-reasoning"
              value={value.reasoningEffort}
              onChange={(event) => {
                const effort = EFFORTS.find((e) => e.value === event.target.value)?.value ?? "";
                onChange({ ...value, reasoningEffort: effort });
              }}
            >
              {EFFORTS.map((e) => (
                <option key={e.value} value={e.value}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </details>
  );
}
