/** 下拉层跟着输入框，高度用视口里剩下的空间，避免被卡片裁掉。 */
export function placeComboList(root: HTMLElement, list: HTMLElement): void {
  const margin = 12;
  const rect = root.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - margin;
  const above = rect.top - margin;
  const upward = below < 220 && above > below;
  const space = Math.max(160, Math.floor(upward ? above : below));
  list.style.maxHeight = `${space}px`;
  if (upward) {
    list.style.top = "auto";
    list.style.bottom = "calc(100% + 4px)";
    return;
  }
  list.style.bottom = "auto";
  list.style.top = "calc(100% + 4px)";
}
