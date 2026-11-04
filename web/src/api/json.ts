/** Разбор JSON без `any`: значения проверяются через type guard. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
