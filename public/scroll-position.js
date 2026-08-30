export function restoreScrollTop(viewer, savedTop) {
  const max = Math.max(0, viewer.scrollHeight - viewer.clientHeight);
  viewer.scrollTop = Math.min(Math.max(0, savedTop), max);
}
