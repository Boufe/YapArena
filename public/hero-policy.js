export function previewAutoplayAllowed({
  reducedMotion,
  saveData,
  effectiveType,
}) {
  return (
    !reducedMotion && !saveData && !["slow-2g", "2g"].includes(effectiveType)
  );
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
