/* global document, Option */
import { sharePercent } from "./arena-chart.js";

export const priceText = (percent) =>
  percent === null ? "—" : `${percent.toFixed(2)}¢`;

export function roundPrices(point) {
  const offer = sharePercent(point?.offer),
    a = sharePercent(point?.medianNo),
    b = sharePercent(point?.medianYes),
    share = sharePercent(point?.share);
  const ownLimit =
    typeof point?.ownLimit === "string" &&
    /^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/.test(point.ownLimit)
      ? 100 * Number(point.ownLimit)
      : null;
  return {
    offer,
    noOffer: offer === null ? null : 100 - offer,
    a,
    b,
    share,
    ownLimit,
    interval: a !== null && b !== null && a < b,
  };
}

export function createPriceInspector(root, onSelect) {
  const el = (name) => root.querySelector(`[data-price-${name}]`),
    select = el("round"),
    drawing = el("drawing");
  let points = [],
    signature;
  const node = (name, attributes, text) => {
    const result = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes))
      result.setAttribute(key, value);
    if (text !== undefined) result.textContent = text;
    return result;
  };
  function choose(index) {
    const point = points[index];
    if (point) onSelect(point);
  }
  select.addEventListener("change", () => choose(select.selectedIndex));
  el("previous").addEventListener("click", () =>
    choose(select.selectedIndex - 1),
  );
  el("next").addEventListener("click", () => choose(select.selectedIndex + 1));
  function show(point) {
    drawing.replaceChildren();
    const p = roundPrices(point);
    select.value = point?.id ?? "";
    el("previous").disabled = select.selectedIndex <= 0;
    el("next").disabled =
      select.selectedIndex < 0 || select.selectedIndex >= points.length - 1;
    el("context").textContent = point
      ? `Round ${point.number} · ${point.argumentLabel || "Argument not labeled"}${point.state ? ` · ${point.state}` : " · settled"}`
      : "Start or select a round to inspect its offered price.";
    el("yes").textContent = priceText(p.offer);
    el("no").textContent = priceText(p.noOffer);
    const x = (value) => 36 + value * 6.48;
    if (p.interval)
      drawing.append(
        node("line", {
          x1: x(p.a),
          x2: x(p.b),
          y1: 49,
          y2: 49,
          class: "arena-price-interval",
        }),
      );
    if (p.interval)
      drawing.append(
        node(
          "text",
          {
            x: Math.max(150, Math.min(570, x((p.a + p.b) / 2))),
            y: 90,
            "text-anchor": "middle",
          },
          `Median interval ${priceText(p.a)}–${priceText(p.b)}`,
        ),
      );
    for (const [value, label] of [
      [p.a, "Median NO floor"],
      [p.b, "Median YES ceiling"],
    ]) {
      if (value === null) continue;
      const marker = node("line", {
        x1: x(value),
        x2: x(value),
        y1: 38,
        y2: 60,
        class: "arena-price-median",
      });
      marker.append(node("title", {}, `${label}: ${priceText(value)}`));
      drawing.append(marker);
    }
    for (const [value, kind, label] of [
      [p.share, "share", "Final YES share"],
      [p.ownLimit, "limit", "Your YES-scale limit"],
      [p.offer, "offer", "Shared YES offer"],
    ]) {
      if (value === null) continue;
      const marker = node("line", {
        x1: x(value),
        x2: x(value),
        y1: kind === "limit" ? 15 : 29,
        y2: 75,
        class: `arena-price-${kind}`,
      });
      marker.append(
        node(
          "title",
          {},
          `${label}: ${kind === "share" ? value.toFixed(2) + "%" : priceText(value)}`,
        ),
      );
      drawing.append(marker);
      if (kind === "offer") {
        drawing.append(
          node("circle", {
            cx: x(value),
            cy: 49,
            r: 7,
            class: "arena-price-offer-dot",
          }),
        );
        drawing.append(
          node(
            "text",
            {
              x: Math.max(105, Math.min(615, x(value))),
              y: 17,
              "text-anchor": "middle",
              class: "arena-price-offer-label",
            },
            `p = ${priceText(value)}`,
          ),
        );
      }
    }
    const revealed = point && point.revealed !== false;
    const interval = p.interval
      ? `Median interval ${priceText(p.a)}–${priceText(p.b)}`
      : p.a !== null && p.b !== null
        ? `NO median ${priceText(p.a)} ≥ YES median ${priceText(p.b)} · no positive interval`
        : "Median interval unavailable · one side is missing";
    const description = !revealed
      ? "Medians and final endorsement rates remain sealed until final reveal."
      : `${interval}${point.branch ? ` · ${point.branch} offer` : ""}.${p.ownLimit !== null ? ` Your YES-scale limit ${priceText(p.ownLimit)}.` : ""}`;
    el("explanation").textContent = description;
    root.querySelector("#arena-price-scale-title").textContent =
      `${el("context").textContent}. Shared YES offer ${priceText(p.offer)}. ${description}${p.share !== null ? ` Final YES ${p.share.toFixed(2)}%, NO ${(100 - p.share).toFixed(2)}%.` : ""} Prices are hundredths of one Yap Coin.`;
  }
  return {
    show,
    clear() {
      points = [];
      signature = undefined;
      select.replaceChildren(new Option("No settled rounds", ""));
      select.disabled = true;
      show(null);
    },
    update(data, selectedId, pending = []) {
      points = [...data.items, ...pending];
      const next = JSON.stringify(
        points.map((p) => [p.id, p.number, p.argumentLabel, p.state]),
      );
      if (next !== signature) {
        signature = next;
        select.replaceChildren(
          ...points.map(
            (p) =>
              new Option(
                `R${p.number} · ${p.argumentLabel || "Unlabeled argument"}`,
                p.id,
              ),
          ),
        );
        if (!points.length) select.add(new Option("No settled rounds", ""));
      }
      select.disabled = !points.length;
      show(points.find((p) => p.id === selectedId) ?? points.at(-1));
    },
  };
}
