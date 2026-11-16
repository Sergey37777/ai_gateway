import type { Heading } from "./outline";

interface Props {
  headings: Heading[];
  activeId: string | null;
  onSelect: (heading: Heading) => void;
}

/** Оглавление по заголовкам h1–h4: клик — прокрутка к разделу. */
export function DocumentOutline({ headings, activeId, onSelect }: Props) {
  const shown = headings.filter((h) => h.depth <= 4);
  const top = Math.min(...shown.map((h) => h.depth));
  return (
    <nav className="doc-outline" aria-label="Оглавление">
      <p className="doc-outline-title">Оглавление</p>
      <ul>
        {shown.map((heading, index) => (
          <li
            key={`${heading.id}-${String(index)}`}
            style={{ paddingLeft: `${String((heading.depth - top) * 12)}px` }}
          >
            <button
              type="button"
              className="doc-outline-item"
              aria-current={heading.id === activeId ? "location" : undefined}
              onClick={() => {
                onSelect(heading);
              }}
            >
              {heading.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
