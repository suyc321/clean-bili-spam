/**
 * 设置页入口：挂载 React 根节点并渲染 OptionsApp。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OptionsApp } from "./OptionsApp";
import "./options.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("找不到设置页根节点。");
}

createRoot(root).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
);
