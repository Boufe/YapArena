/* global document, window */
export function createChartStatement(root) {
  const heading = root.querySelector("#arena-chart-title"),
    original = heading.textContent,
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const span = (text, className) => {
    const node = document.createElement("span");
    node.className = className;
    node.textContent = text;
    return node;
  };
  const reserve = span("", "arena-statement-reserve");
  reserve.setAttribute("aria-hidden", "true");
  let current = span(original, "arena-statement-layer"),
    signature;
  current.dataset.chartStatement = "";
  heading.classList.add("arena-statement-heading");
  heading.replaceChildren(reserve, current);
  function settle() {
    for (const layer of heading.querySelectorAll(".arena-statement-layer")) {
      for (const animation of layer.getAnimations()) animation.cancel();
      if (layer !== current) layer.remove();
    }
  }
  reduced.addEventListener("change", () => {
    if (reduced.matches) settle();
  });
  function reserveLabels(items) {
    const labels = [
      ...new Set([
        original,
        ...items.map((p) => `“${p.argumentLabel || "Argument not labeled"}”`),
      ]),
    ];
    const next = JSON.stringify(labels);
    if (next === signature) return;
    signature = next;
    reserve.replaceChildren(...labels.map((label) => span(label, "")));
  }
  reserveLabels([]);
  return {
    reserveLabels,
    show(point) {
      const text = point
        ? `“${point.argumentLabel || "Argument not labeled"}”`
        : original;
      if (current.textContent === text) return;
      for (const layer of heading.querySelectorAll(".arena-statement-layer")) {
        if (layer === current) continue;
        for (const animation of layer.getAnimations()) animation.cancel();
        layer.remove();
      }
      const previous = current;
      const style = window.getComputedStyle(previous);
      const from = { opacity: style.opacity, transform: style.transform };
      for (const animation of previous.getAnimations()) animation.cancel();
      delete previous.dataset.chartStatement;
      previous.setAttribute("aria-hidden", "true");
      current = span(text, "arena-statement-layer");
      current.dataset.chartStatement = "";
      heading.append(current);
      if (reduced.matches) {
        previous.remove();
        return;
      }
      previous
        .animate([from, { opacity: 0, transform: "translateY(-8px)" }], {
          duration: 180,
          easing: "ease-out",
        })
        .finished.then(() => previous.remove())
        .catch(() => previous.remove());
      current
        .animate(
          [
            { opacity: 0, transform: "translateY(10px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 280, easing: "cubic-bezier(.22,1,.36,1)" },
        )
        .finished.catch(() => null);
    },
    clear() {
      settle();
      current.textContent = original;
      reserveLabels([]);
    },
  };
}
