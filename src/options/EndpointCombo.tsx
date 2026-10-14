import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { placeComboList } from "./combo-placement";
import {
  ENDPOINT_PRESETS,
  type EndpointPreset,
} from "./endpoint-presets";

/**
 * 可手输、也可从常见服务商里点选的接口地址框。
 * 点选时把整条预设交出去，调用方可以连同接口格式一起改。
 */
export function EndpointCombo(props: {
  value: string;
  onValueChange: (value: string) => void;
  onPreset: (preset: EndpointPreset) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const query = props.value.trim().toLowerCase();
  const options = showAll
    ? ENDPOINT_PRESETS
    : ENDPOINT_PRESETS.filter(
        (preset) =>
          preset.name.toLowerCase().includes(query) ||
          preset.endpoint.toLowerCase().includes(query),
      );

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

  function choose(preset: EndpointPreset): void {
    props.onPreset(preset);
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
      setActiveIndex((index) => Math.min(index + 1, Math.max(options.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter" && open && options[activeIndex] !== undefined) {
      event.preventDefault();
      const preset = options[activeIndex];
      if (preset !== undefined) {
        choose(preset);
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
        placeholder="https://api.openai.com/v1"
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
        aria-label="选择常见接口地址"
        onClick={() => {
          setShowAll(true);
          setActiveIndex(0);
          setOpen((current) => !current);
        }}
      />
      {open ? (
        <ul className="combo-list" id={listId} role="listbox" ref={listRef}>
          {options.length === 0 ? (
            <li className="combo-empty">没有匹配的服务商，可以继续手输</li>
          ) : (
            options.map((preset, index) => (
              <li key={preset.endpoint} role="presentation">
                <button
                  className={index === activeIndex ? "combo-option on" : "combo-option"}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(preset)}
                >
                  <span>{preset.name}</span>
                  <span className="combo-hint">{preset.endpoint}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
