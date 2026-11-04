import { useRef, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { copyText } from "../components/copyText";

function CodeBlock(props: ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <button
        type="button"
        className="button-secondary code-copy"
        onClick={() => {
          void copyText(ref.current?.textContent ?? "").then(() => {
            setCopied(true);
            window.setTimeout(() => {
              setCopied(false);
            }, 1500);
          });
        }}
      >
        {copied ? "Скопировано" : "Копировать"}
      </button>
      <pre ref={ref} {...props} />
    </div>
  );
}

const COMPONENTS: Components = {
  pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

/** Markdown ответа модели; сырой HTML не рендерится (нет rehype-raw). */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
