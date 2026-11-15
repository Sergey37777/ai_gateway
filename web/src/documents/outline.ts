/** Разбор Markdown (mdast) и оглавление: заголовки с id, как их ставит `rehype-slug`. */

import GithubSlugger from "github-slugger";
import type { Heading as MdHeading, Root } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface Heading {
  depth: number;
  text: string;
  id: string;
  /** Смещения строки заголовка в исходнике. */
  start: number;
  end: number;
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
let cached: { text: string; root: Root } | null = null;

/** mdast документа; последний результат кешируется (оглавление и контекст разбирают одно и то же). */
export function parseMarkdown(text: string): Root {
  if (cached?.text === text) return cached.root;
  const root = parser.parse(text);
  cached = { text, root };
  return root;
}

export function outline(text: string): Heading[] {
  const slugger = new GithubSlugger();
  const headings: Heading[] = [];
  for (const node of parseMarkdown(text).children) {
    if (node.type !== "heading") continue;
    const heading: MdHeading = node;
    const label = toString(heading);
    headings.push({
      depth: heading.depth,
      text: label,
      id: slugger.slug(label),
      start: heading.position?.start.offset ?? 0,
      end: heading.position?.end.offset ?? 0,
    });
  }
  return headings;
}
