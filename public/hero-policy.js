export function previewAutoplayAllowed({
  reducedMotion,
  saveData,
  effectiveType,
}) {
  return (
    !reducedMotion && !saveData && !["slow-2g", "2g"].includes(effectiveType)
  );
}

// Keep one eligible preview until it leaves view, or the viewer deliberately
// selects another. Stable selection avoids reconnecting while merely scrolling.
export function selectPreview(previews, current, preferred) {
  if (preferred?.eligible()) return preferred;
  if (current?.eligible()) return current;
  return previews.find((preview) => preview.eligible());
}

export function createHoverIntent({
  open,
  schedule = setTimeout,
  cancel = clearTimeout,
  delay = 2600,
}) {
  let timer;
  const stop = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  return {
    start() {
      stop();
      timer = schedule(() => {
        timer = undefined;
        open();
      }, delay);
    },
    stop,
  };
}
