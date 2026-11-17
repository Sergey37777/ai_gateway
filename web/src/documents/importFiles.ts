/**
 * Загрузка выбранных файлов в документы (этап 6.1): обычные файлы и архивы. Документы создаются
 * по одному — порядок ошибок совпадает с порядком файлов, ход виден в `onProgress`.
 */

import { userMessage } from "../api/errors";
import type { ApiDocument } from "../api/types";
import { extractArchive, isArchiveName, MAX_ARCHIVE_MB, titlesFromPaths } from "./archive";
import { documentsLabel, filesLabel } from "./format";
import { isSupportedName, prepareBytes, prepareFile, type Prepared } from "./upload";

const MB = 1024 * 1024;

type Body = Omit<Extract<Prepared, { ok: true }>, "ok">;

export interface UploadError {
  name: string;
  message: string;
}

export interface ImportOptions {
  maxMb: number;
  create: (body: Body) => Promise<ApiDocument>;
  onProgress: (done: number, total: number) => void;
}

export interface ImportResult {
  /** Последний созданный документ — его открывает экран. */
  last: ApiDocument | null;
  errors: UploadError[];
  /** Итог по архивам: «Из архива docs.zip: 12 документов, пропущено 3 файла». */
  notes: string[];
}

interface Job {
  name: string;
  archive: string | null;
  prepare: () => Promise<Prepared> | Prepared;
}

interface ArchiveSummary {
  name: string;
  skipped: number;
  created: number;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

async function archiveJobs(
  file: File,
  maxMb: number,
  errors: UploadError[],
): Promise<{ jobs: Job[]; summary: ArchiveSummary } | null> {
  if (file.size > MAX_ARCHIVE_MB * MB) {
    errors.push({ name: file.name, message: `Архив больше ${String(MAX_ARCHIVE_MB)} МБ` });
    return null;
  }
  const extracted = extractArchive(new Uint8Array(await file.arrayBuffer()), {
    accept: isSupportedName,
    // размер текста проверит prepareBytes: у PDF/DOCX свой лимит, больше лимита документа
    maxEntryBytes: MAX_ARCHIVE_MB * MB,
  });
  if (!extracted.ok) {
    errors.push({ name: file.name, message: extracted.message });
    return null;
  }
  for (const path of extracted.oversized) {
    errors.push({
      name: `${file.name} › ${path}`,
      message: `Файл больше ${String(MAX_ARCHIVE_MB)} МБ`,
    });
  }
  if (extracted.entries.length === 0 && extracted.oversized.length === 0) {
    errors.push({
      name: file.name,
      message: "В архиве нет файлов .md, .markdown, .txt, .pdf или .docx",
    });
    return null;
  }
  const titles = titlesFromPaths(extracted.entries.map((entry) => entry.path));
  const jobs = extracted.entries.map((entry, index) => ({
    name: `${file.name} › ${entry.path}`,
    archive: file.name,
    prepare: () => prepareBytes(basename(entry.path), entry.data, maxMb, titles[index]),
  }));
  return { jobs, summary: { name: file.name, skipped: extracted.skipped.length, created: 0 } };
}

export async function importFiles(files: File[], options: ImportOptions): Promise<ImportResult> {
  const errors: UploadError[] = [];
  const jobs: Job[] = [];
  const archives = new Map<string, ArchiveSummary>();
  for (const file of files) {
    if (!isArchiveName(file.name)) {
      jobs.push({
        name: file.name,
        archive: null,
        prepare: () => prepareFile(file, options.maxMb),
      });
      continue;
    }
    // архивы по одному: распаковка синхронная, память — под один архив за раз
    // oxlint-disable-next-line no-await-in-loop
    const result = await archiveJobs(file, options.maxMb, errors);
    if (result === null) continue;
    jobs.push(...result.jobs);
    archives.set(file.name, result.summary);
  }

  let last: ApiDocument | null = null;
  options.onProgress(0, jobs.length);
  for (const [index, job] of jobs.entries()) {
    // по одному: порядок ошибок совпадает с порядком файлов
    // oxlint-disable-next-line no-await-in-loop
    const prepared = await job.prepare();
    if (!prepared.ok) {
      errors.push({ name: job.name, message: prepared.message });
    } else {
      try {
        const { ok: _ok, ...body } = prepared;
        // oxlint-disable-next-line no-await-in-loop
        last = await options.create(body);
        const summary = job.archive === null ? undefined : archives.get(job.archive);
        if (summary !== undefined) summary.created += 1;
      } catch (error) {
        errors.push({ name: job.name, message: userMessage(error) });
      }
    }
    options.onProgress(index + 1, jobs.length);
  }

  const notes = [...archives.values()].map(
    (summary) =>
      `Из архива ${summary.name}: ${documentsLabel(summary.created)}` +
      (summary.skipped > 0 ? `, пропущено ${filesLabel(summary.skipped)} других типов` : ""),
  );
  return { last, errors, notes };
}
