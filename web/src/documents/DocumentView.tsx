import type { Element, ElementContent } from "hast";
import { toString } from "hast-util-to-string";
import "katex/dist/katex.min.css";
import { memo, type MouseEvent, type Ref } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type UrlTransform,
} from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";
import type { DocumentFormat } from "../api/types";
import { CodeBlock } from "../chat/Markdown";
import { MermaidBlock } from "./MermaidBlock";
import { rehypeSourcePositions } from "./sourcePositions";
import "./documents.css";

interface Props {
  text: string;
  format: DocumentFormat;
  /** Переход по якорной ссылке `#id` внутри документа. */
  onAnchor?: (id: string) => void;
  ref?: Ref<HTMLDivElement>;
}

const defaultAttributes = defaultSchema.attributes ?? {};

/** Схема GitHub + классы математики и подсветки, data-src-* для выделения, data: в картинках. */
const SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultAttributes,
    "*": [...(defaultAttributes["*"] ?? []), "dataSrcStart", "dataSrcEnd"],
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
  protocols: { ...defaultSchema.protocols, src: ["http", "https", "data"] },
};

const REMARK: PluggableList = [remarkGfm, [remarkMath, { singleDollarTextMath: true }]];
// санитайзер — до KaTeX и подсветки, иначе он вырежет их разметку
const REHYPE: PluggableList = [
  rehypeSourcePositions,
  rehypeRaw,
  [rehypeSanitize, SCHEMA],
  [rehypeKatex, { throwOnError: false, strict: false }],
  [rehypeHighlight, { plainText: ["mermaid"] }],
  rehypeSlug,
];

const EXTERNAL = /^(https?:|mailto:)/i;
const INLINE_IMAGE = /^(https?:|data:image\/)/i;

/** Безопасные ссылки react-markdown + встроенные картинки `data:image/…` (только в `src`). */
const urlTransform: UrlTransform = (url, key) =>
  key === "src" && /^data:image\//i.test(url) ? url : defaultUrlTransform(url);

function codeChild(node: Element | undefined): Element | null {
  const child: ElementContent | undefined = node?.children[0];
  return child?.type === "element" && child.tagName === "code" ? child : null;
}

function language(code: Element | null): string | null {
  const classes = code?.properties["className"];
  if (!Array.isArray(classes)) return null;
  const found = classes.map(String).find((c) => c.startsWith("language-"));
  return found === undefined ? null : found.slice("language-".length);
}

function scrollToAnchor(root: HTMLElement | null, id: string): boolean {
  if (root === null) return false;
  // сноски GFM получают префикс user-content- от санитайзера
  const target =
    root.querySelector(`[id="${CSS.escape(id)}"]`) ??
    root.querySelector(`[id="${CSS.escape(`user-content-${id}`)}"]`);
  if (target === null) return false;
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

function components(onAnchor: ((id: string) => void) | undefined): Components {
  return {
    pre: ({ node, ...props }) => {
      const code = codeChild(node);
      const lang = language(code);
      if (lang === "mermaid" && code !== null) return <MermaidBlock code={toString(code)} />;
      if (lang === "math") return <pre {...props} />;
      return (
        <div className="doc-code">
          {lang !== null && <span className="doc-code-lang">{lang}</span>}
          <CodeBlock {...props} />
        </div>
      );
    },
    a: ({ node: _node, href, children, ...props }) => {
      if (href === undefined || href === "") return <span>{children}</span>;
      if (href.startsWith("#")) {
        const id = decodeURIComponent(href.slice(1));
        return (
          <a
            {...props}
            href={href}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              // хэш адреса — маршрут UI: якорь обрабатывается внутри превью
              event.preventDefault();
              const root = event.currentTarget.closest<HTMLElement>(".doc-preview");
              if (scrollToAnchor(root, id)) onAnchor?.(id);
            }}
          >
            {children}
          </a>
        );
      }
      if (EXTERNAL.test(href)) {
        return (
          <a {...props} href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      }
      return (
        <span className="doc-link-missing" title="Файл не загружен">
          {children}
        </span>
      );
    },
    img: ({ node: _node, src, alt, ...props }) => {
      if (typeof src === "string" && INLINE_IMAGE.test(src)) {
        return <img {...props} src={src} alt={alt ?? ""} loading="lazy" />;
      }
      return (
        <span className="doc-image-missing" title="Картинка рядом с документом не загружена">
          🖼 {alt === undefined || alt === "" ? "картинка" : alt}
        </span>
      );
    },
  };
}

/** Превью документа: GFM, безопасный HTML, KaTeX, Mermaid, подсветка, якоря заголовков. */
export const DocumentView = memo(function DocumentView({ text, format, onAnchor, ref }: Props) {
  if (format === "text") {
    return (
      <div className="doc-preview" ref={ref}>
        <pre className="doc-plain">{text}</pre>
      </div>
    );
  }
  return (
    <div className="doc-preview" ref={ref}>
      <div className="doc-body">
        <ReactMarkdown
          remarkPlugins={REMARK}
          rehypePlugins={REHYPE}
          components={components(onAnchor)}
          urlTransform={urlTransform}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
});
