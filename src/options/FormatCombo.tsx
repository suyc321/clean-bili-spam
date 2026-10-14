import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { AiApiFormat } from "../domain/types";
import { AI_FORMAT_LABELS } from "../ai/review-client";
import { placeComboList } from "./combo-placement";

const FORMAT_OPTIONS = Object.entries(AI_FORMAT_LABELS) as Array<
  [AiApiFormat, string]
>;

/** 接口格式只有固定几项，外观与接口地址、模型名称同一套下拉。 */
export function FormatCombo(props: {
  value: AiApiFormat;
  onValueChange: (value: AiApiFormat) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || rootRef.current === null || listRef.current === null) {
      return;
    }
    const root = rootRef.current;
    const list = listRef.current;
    function place(): void {
      placeComboList(root, list);
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  function choose(value: AiApiFormat): void {
    props.onValueChange(value);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      setActiveIndex((index) => Math.min(index + 1, FORMAT_OPTIONS.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      const option = FORMAT_OPTIONS[activeIndex];
      if (option !== undefined) {
        choose(option[0]);
      }
    }
  }

  return (
    <div className="combo" ref={rootRef}>
      <input
        type="text"
        readOnly
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={AI_FORMAT_LABELS[props.value]}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      <button
        className="combo-toggle"
        type="button"
        aria-label="选择接口格式"
        onClick={() => {
          setActiveIndex(0);
          setOpen((current) => !current);
        }}
      />
      {open ? (
        <ul className="combo-list" id={listId} role="listbox" ref={listRef}>
          {FORMAT_OPTIONS.map(([value, label], index) => (
            <li key={value} role="presentation">
              <button
                className={index === activeIndex ? "combo-option on" : "combo-option"}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(value)}
              >
                <span>{label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
