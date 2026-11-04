import type { UiConfig } from "./api/types";

/** Общие свойства экранов: конфиг шлюза и признак несохранённых данных (для beforeunload). */
export interface ScreenProps {
  config: UiConfig;
  onDirtyChange: (dirty: boolean) => void;
}
