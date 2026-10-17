/* global document, requestAnimationFrame, cancelAnimationFrame */
import { formatValue } from "../src/features/discovery/homepage-chart.ts";
import { changeText } from "../src/features/discovery/homepage-view.ts";
export function bindHomepageChart({
  root,
  svg,
  m,
  metric,
  range,
  c,
  activate,
  deactivate,
  pin,
}) {
  const detail = svg.id === "ya-detail-chart",
    prefix = detail ? "#ya-detail-" : "#ya-";
  const valueEl = root.querySelector(prefix + "value"),
    labelEl = root.querySelector(
      detail ? "#ya-detail-label" : "#ya-metric-label",
    ),
    changeEl = root.querySelector(prefix + "change");
  const tooltip = root.querySelector("#ya-chart-tooltip"),
    guide = svg.querySelector("[data-chart-hover-guide]"),
    marker = svg.querySelector("[data-chart-hover-marker]"),
    halo = svg.querySelector("[data-chart-hover-halo]");
  const lifecycle = new AbortController(),
    signal = lifecycle.signal;
  let frame = 0,
    pinned = false,
    pendingX = 0,
    active = false;
  function latest() {
    valueEl.textContent = formatValue(
      metric === "price" ? m.price : m.pct,
      metric,
    );
    labelEl.textContent = m.activity
      ? metric === "price"
        ? "Shared YES offer · synthetic simulation"
        : "Synthetic bots + shared participants · settled round"
      : m.reference
        ? metric === "price"
          ? "Last executed YES price · completed round"
          : "Participant endorsement · latest closed round"
        : metric === "price"
          ? "Topic execution price history unavailable"
          : "Topic endorsement history unavailable";
    changeEl.textContent =
      m.reference || m.activity
        ? metric === "price"
          ? "YC / YES contract"
          : changeText(m, true)
        : "";
    changeEl.classList.toggle("down", metric !== "price" && (m.delta ?? 0) < 0);
  }
  function reset() {
    cancelAnimationFrame(frame);
    frame = 0;
    pinned = false;
    pin(false);
    svg.classList.remove("is-scrubbing");
    if (active) {
      tooltip.classList.remove("is-visible");
      tooltip.setAttribute("aria-hidden", "true");
      active = false;
      deactivate(reset);
    }
    latest();
  }
  let keyboard = svg.nextElementSibling;
  if (!keyboard || !keyboard.classList.contains("ya-scrub-control")) {
    keyboard = document.createElement("label");
    keyboard.className = "ya-scrub-control";
    keyboard.innerHTML = `<span>Explore chart history</span><input type="range" min="0" max="1000" step="10" value="1000" aria-label="Explore ${detail ? "expanded idea" : "trending idea"} chart history">`;
    svg.insertAdjacentElement("afterend", keyboard);
  }
  const slider = keyboard.querySelector("input");
  slider.disabled = !c.points.length;
  svg.setAttribute(
    "aria-label",
    `${m.reference ? "Sample" : m.activity ? "Synthetic" : "Unavailable"} ${metric === "price" ? "YES offered price history in Yap Coins" : "endorsement history across completed rounds"}. ${c.points.length ? "Move across the chart to inspect history." : "No topic-level history is available."}`,
  );
  function show(px) {
    if (!c.points.length) return;
    activate(reset);
    active = true;
    const chartX = Math.max(c.left, Math.min(c.w - c.right, px)),
      fraction = (chartX - c.left) / (c.w - c.right - c.left),
      value = c.valueAt(fraction),
      chartY = c.y(value);
    const end = c.times.at(-1) ?? Date.UTC(2026, 9, 16, 23, 59),
      span = c.times.length
        ? Math.max(1, end - c.times[0])
        : (range === "1D" ? 1 : range === "1W" ? 7 : 30) * 86400000,
      date = new Date(end - span + fraction * span);
    const stamp =
      date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }) +
      " · " +
      date.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      });
    guide.setAttribute("x1", chartX);
    guide.setAttribute("x2", chartX);
    [marker, halo].forEach((node) => {
      node.setAttribute("cx", chartX);
      node.setAttribute("cy", chartY);
    });
    svg.classList.add("is-scrubbing");
    valueEl.textContent = formatValue(value, metric);
    labelEl.textContent =
      stamp +
      " · " +
      (metric === "price"
        ? m.activity
          ? "Shared YES offer"
          : "YES execution price"
        : "Endorsement");
    const delta = value - c.points[0];
    changeEl.textContent =
      metric === "price"
        ? "YC / YES contract"
        : (delta >= 0 ? "↗ " : "↘ ") + Math.abs(delta).toFixed(1) + " pp";
    changeEl.classList.toggle("down", metric !== "price" && delta < 0);
    tooltip.querySelector("span").textContent = stamp;
    tooltip.querySelector("strong").textContent =
      formatValue(value, metric) +
      (metric === "price" ? " YC" : " endorsement");
    tooltip.classList.add("is-visible");
    tooltip.setAttribute("aria-hidden", "false");
    const rect = svg.getBoundingClientRect(),
      base = root.getBoundingClientRect(),
      tip = tooltip.getBoundingClientRect(),
      sx = rect.left - base.left + (chartX * rect.width) / c.w,
      sy = rect.top - base.top + (chartY * rect.height) / c.h;
    tooltip.style.left =
      Math.max(8, Math.min(base.width - tip.width - 8, sx - tip.width / 2)) +
      "px";
    tooltip.style.top = Math.max(8, sy - tip.height - 17) + "px";
    slider.value = String(Math.round(fraction * 1000));
    slider.setAttribute(
      "aria-valuetext",
      stamp +
        ", " +
        formatValue(value, metric) +
        (metric === "price" ? " Yap Coins" : " endorsement"),
    );
  }
  function request(event) {
    if (!c.points.length) return;
    const rect = svg.getBoundingClientRect();
    pendingX = ((event.clientX - rect.left) * c.w) / rect.width;
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        show(pendingX);
      });
  }
  svg.addEventListener(
    "pointermove",
    (e) => {
      if (!pinned || e.pointerType === "touch") request(e);
    },
    { signal },
  );
  svg.addEventListener(
    "pointerleave",
    () => {
      if (!pinned) reset();
    },
    { signal },
  );
  svg.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType === "touch") {
        pinned = !pinned;
        pin(pinned);
        if (pinned) request(e);
        else reset();
      }
    },
    { signal },
  );
  svg.addEventListener("pointercancel", reset, { signal });
  slider.addEventListener(
    "input",
    () =>
      show(c.left + (Number(slider.value) / 1000) * (c.w - c.left - c.right)),
    { signal },
  );
  slider.addEventListener(
    "focus",
    () =>
      show(c.left + (Number(slider.value) / 1000) * (c.w - c.left - c.right)),
    { signal },
  );
  slider.addEventListener("blur", reset, { signal });
  slider.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") {
        reset();
        slider.blur();
      }
    },
    { signal },
  );
  latest();
  return {
    destroy() {
      lifecycle.abort();
      reset();
    },
  };
}
