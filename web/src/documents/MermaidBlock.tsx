import { useEffect, useState } from "react";

type State =
  { kind: "loading" } | { kind: "ready"; svg: string } | { kind: "error"; message: string };

// диаграмма перерисовывается только при смене кода или темы
const cache = new Map<string, string>();
let counter = 0;

function dark(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

async function renderDiagram(code: string, theme: "dark" | "default"): Promise<string> {
  const key = `${theme}\n${code}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  // mermaid (~1 МБ) грузится только при первой диаграмме
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
  counter += 1;
  const { svg } = await mermaid.render(`doc-mermaid-${String(counter)}`, code);
  cache.set(key, svg);
  return svg;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Блок ```mermaid: SVG диаграммы; ошибка синтаксиса — код и сообщение, документ рендерится. */
export function MermaidBlock({ code }: { code: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    renderDiagram(code, dark() ? "dark" : "default").then(
      (svg) => {
        if (!cancelled) setState({ kind: "ready", svg });
      },
      (error: unknown) => {
        if (!cancelled) setState({ kind: "error", message: errorText(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (state.kind === "ready") {
    // SVG от mermaid с securityLevel "strict" (очищен DOMPurify внутри mermaid)
    return <div className="doc-mermaid" dangerouslySetInnerHTML={{ __html: state.svg }} />;
  }
  return (
    <div className={state.kind === "error" ? "doc-mermaid doc-mermaid-error" : "doc-mermaid"}>
      <pre className="doc-mermaid-code">
        <code>{code}</code>
      </pre>
      {state.kind === "error" && (
        <p className="doc-error" role="status">
          Диаграмма не нарисована: {state.message}
        </p>
      )}
    </div>
  );
}
