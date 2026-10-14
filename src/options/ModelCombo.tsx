import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { placeComboList } from "./combo-placement";

/** 模型名可手输，也可从本次拉到的目录里点选。目录为空时仍能输入。 */
export function ModelCombo(props: {
  value: string;
  options: readonly string[];
  onValueChange: (value: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const query = props.value.trim().toLowerCase();
  const options = showAll
    ? props.options
    : props.options.filter((model) => model.toLowerCase().includes(query));

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
  }, [open, options.length]);

  function choose(model: string): void {
    props.onValueChange(model);
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
        setShowAll(true);
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      setActiveIndex((index) =>
        Math.min(index + 1, Math.max(options.length - 1, 0)),
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter" && open && options[activeIndex] !== undefined) {
      event.preventDefault();
      const model = options[activeIndex];
      if (model !== undefined) {
        choose(model);
      }
    }
  }

  return (
    <div className="combo" ref={rootRef}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder="gpt-4o-mini / glm-4-flash …"
        value={props.value}
        onChange={(event) => {
          props.onValueChange(event.target.value);
          setShowAll(false);
          setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
      />
      <button
        className="combo-toggle"
        type="button"
        aria-label="选择已获取的模型"
        onClick={() => {
          setShowAll(true);
          setActiveIndex(0);
          setOpen((current) => !current);
        }}
      />
      {open ? (
        <ul className="combo-list" id={listId} role="listbox" ref={listRef}>
          {options.length === 0 ? (
            <li className="combo-empty">
              {props.options.length === 0
                ? "先获取模型列表，或直接输入模型名"
                : "没有匹配的模型，可以继续手输"}
            </li>
          ) : (
            options.map((model, index) => (
              <li key={model} role="presentation">
                <button
                  className={
                    index === activeIndex ? "combo-option on" : "combo-option"
                  }
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(model)}
                >
                  <span>{model}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
