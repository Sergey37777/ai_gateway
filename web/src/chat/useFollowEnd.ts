import { useEffect, useRef, type RefObject } from "react";

/** Ближе к низу, чем столько пикселей, — считаем, что пользователь «внизу» и следит за ответом. */
const FOLLOW_GAP = 80;

/** Ближайший предок с собственной прокруткой; иначе прокручивается страница. */
function scrollParent(element: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  const page = document.scrollingElement;
  return page instanceof HTMLElement ? page : document.documentElement;
}

function distanceToEnd(box: HTMLElement): number {
  return box.scrollHeight - box.scrollTop - box.clientHeight;
}

/**
 * Прокрутка за стримом: если пользователь у низа контейнера, после каждого рендера
 * контейнер докручивается до самого конца. Решение «следовать» обновляется только
 * по событиям прокрутки — рост ответа между ними его не сбрасывает, а ушедший читать
 * выше пользователь остаётся на месте.
 *
 * Докручивается именно контейнер, а не элемент списка: под списком бывает sticky-композер,
 * и `scrollIntoView` у конца списка откатывал страницу вверх на его высоту.
 */
export function useFollowEnd(anchor: RefObject<HTMLElement | null>): void {
  const box = useRef<HTMLElement | null>(null);
  const follow = useRef(false);

  useEffect(() => {
    const element = anchor.current;
    if (element === null) return;
    const container = scrollParent(element);
    box.current = container;
    const update = () => {
      follow.current = distanceToEnd(container) < FOLLOW_GAP;
    };
    update();
    // прокрутка страницы приходит на window, а не на documentElement
    const target: HTMLElement | Window =
      container === document.scrollingElement || container === document.documentElement
        ? window
        : container;
    target.addEventListener("scroll", update, { passive: true });
    return () => {
      target.removeEventListener("scroll", update);
      box.current = null;
    };
  }, [anchor]);

  useEffect(() => {
    const container = box.current;
    if (container !== null && follow.current) container.scrollTop = container.scrollHeight;
  });
}
