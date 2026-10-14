/**
 * Popup 弹窗入口：挂载 React 根节点并渲染 PopupApp。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PopupApp } from "./PopupApp";
import "./popup.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("找不到弹窗根节点。");
}

createRoot(root).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
);
