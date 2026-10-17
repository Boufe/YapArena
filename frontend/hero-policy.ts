export function previewAutoplayAllowed({
  reducedMotion,
  saveData,
  effectiveType,
}: {
  reducedMotion: boolean;
  saveData?: boolean;
  effectiveType?: string;
}) {
  return (
    !reducedMotion &&
    !saveData &&
    !(["slow-2g", "2g"] as readonly (string | undefined)[]).includes(
      effectiveType,
    )
  );
}

// Keep one eligible preview until it leaves view, or the viewer deliberately
// selects another. Stable selection avoids reconnecting while merely scrolling.
export function selectPreview<T extends { eligible(): boolean }>(
  previews: T[],
  current?: T,
  preferred?: T,
) {
  if (preferred?.eligible()) return preferred;
  if (current?.eligible()) return current;
  return previews.find((preview) => preview.eligible());
}

export function createHoverIntent({
  open,
  schedule = setTimeout,
  cancel = clearTimeout,
  delay = 2600,
}: {
  open: () => void;
  schedule?: (callback: () => void, delay: number) => number;
  cancel?: (timer: number) => void;
  delay?: number;
}) {
  let timer: number | undefined;
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
