import { useEffect, useState } from "react";
import { copyText } from "./copyText";

interface Props {
  text: string;
  label?: string;
}

export function CopyButton({ text, label = "Копировать" }: Props) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => {
      setCopied(false);
    }, 1500);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copied]);

  return (
    <button
      type="button"
      className="button-secondary"
      onClick={() => {
        void copyText(text).then(() => {
          setCopied(true);
        });
      }}
    >
      {copied ? "Скопировано" : label}
    </button>
  );
}
