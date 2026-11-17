/** Подписи документов: размер в знаках и число вопросов (с русскими окончаниями). */

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const MILLIONS = new Intl.NumberFormat("ru", { maximumFractionDigits: 1 });

/** «999 знаков», «25 тыс. знаков», «1,3 млн знаков». */
export function formatChars(n: number): string {
  if (n >= 1_000_000) return `${MILLIONS.format(n / 1_000_000)} млн знаков`;
  if (n >= 1000) return `${String(Math.round(n / 1000))} тыс. знаков`;
  return `${String(n)} ${plural(n, "знак", "знака", "знаков")}`;
}

export function questionsLabel(n: number): string {
  return `${String(n)} ${plural(n, "вопрос", "вопроса", "вопросов")}`;
}

export function documentsLabel(n: number): string {
  return `${String(n)} ${plural(n, "документ", "документа", "документов")}`;
}

export function filesLabel(n: number): string {
  return `${String(n)} ${plural(n, "файл", "файла", "файлов")}`;
}
