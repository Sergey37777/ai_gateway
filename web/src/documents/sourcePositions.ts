/** rehype-плагин: блочным элементам — смещения в исходнике (`data-src-start` / `data-src-end`). */

import type { Element, Root, RootContent } from "hast";

const BLOCKS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "pre",
  "table",
  "tr",
  "hr",
  "ul",
  "ol",
  "dl",
  "div",
  "details",
]);

function mark(node: Root | RootContent): void {
  if (node.type !== "element" && node.type !== "root") return;
  if (node.type === "element") annotate(node);
  for (const child of node.children) mark(child);
}

function annotate(element: Element): void {
  const start = element.position?.start.offset;
  const end = element.position?.end.offset;
  if (!BLOCKS.has(element.tagName) || start === undefined || end === undefined) return;
  element.properties["dataSrcStart"] = String(start);
  element.properties["dataSrcEnd"] = String(end);
}

/** До `rehype-raw`: позиции есть только у узлов из Markdown. */
export function rehypeSourcePositions() {
  return (tree: Root) => {
    mark(tree);
  };
}
