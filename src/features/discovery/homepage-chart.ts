import type { HomeIdea } from "./homepage-model.ts";
import { html, type SafeHtml } from "../../platform/html.ts";
export type HomeMetric = "endorsement" | "price";
export type HomeRange = "1D" | "1W" | "1M";
export const formatValue = (
  value: number | null,
  metric: HomeMetric = "endorsement",
) =>
  value === null
    ? "—"
    : metric === "price"
      ? value.toFixed(2)
      : Math.round(value) + "%";
export function chartSeries(
  m: HomeIdea,
  metric: HomeMetric,
  range: HomeRange,
): number[] {
  if (m.activity)
    return historyRows(m, metric, range).map((r) =>
      metric === "price"
        ? Number(r.offer!.n) / Number(r.offer!.d)
        : (Number(r.share!.n) * 100) / Number(r.share!.d),
    );
  if (!m.reference || m.price === null) return [];
  if (metric === "price")
    return [
      0.31,
      0.38,
      0.28,
      0.42,
      0.34,
      0.46,
      0.31,
      0.39,
      0.26,
      0.35,
      0.42,
      0.3,
      0.38,
      0.27,
      0.4,
      m.price,
    ].map((v, i) =>
      i === 15 || range === "1D"
        ? v
        : Math.min(
            0.8,
            v + (range === "1W" ? 0.06 * Math.sin(i) : 0.1 * Math.cos(i)),
          ),
    );
  return m.points.map((v, i) =>
    range === "1D"
      ? v
      : Math.max(
          0,
          Math.min(
            100,
            v + ((range === "1W" ? 4 : 7) * Math.sin(i * 0.75) * (15 - i)) / 15,
          ),
        ),
  );
}
export function historyRows(m: HomeIdea, metric: HomeMetric, range: HomeRange) {
  const rows = m.activity?.items ?? [];
  const end = Date.parse(rows.at(-1)?.settledAt ?? "");
  const span = (range === "1D" ? 1 : range === "1W" ? 7 : 30) * 86400000;
  return rows.filter(
    (r) =>
      Date.parse(r.settledAt) >= end - span &&
      (metric === "price" ? r.offer : r.share),
  );
}
export function interpolate(points: number[], fraction: number): number | null {
  if (!points.length) return null;
  if (points.length === 1) return points[0]!;
  const at = Math.max(0, Math.min(1, fraction)) * (points.length - 1);
  const i = Math.min(points.length - 2, Math.floor(at));
  return points[i]! + (points[i + 1]! - points[i]!) * (at - i);
}
export function chartGeometry(
  m: HomeIdea,
  metric: HomeMetric,
  range: HomeRange,
  width = 800,
  detail = false,
) {
  const w = Math.max(190, width),
    h = detail ? 290 : 165;
  const left = 8,
    right = 48,
    top = 24,
    bottom = 28;
  const points = chartSeries(m, metric, range);
  const rows = historyRows(m, metric, range),
    times = rows.map((r) => Date.parse(r.settledAt));
  const first = times[0] ?? 0,
    last = times.at(-1) ?? 1,
    span = Math.max(1, last - first);
  const factor = metric === "price" ? 100 : 1,
    margin = metric === "price" ? 0.06 : 3;
  const lo = points.length
    ? Math.floor((Math.min(...points) - margin) * factor) / factor
    : 0;
  const hi = points.length
    ? Math.ceil((Math.max(...points) + margin) * factor) / factor
    : metric === "price"
      ? 1
      : 100;
  const x = (i: number) =>
    left +
    (m.activity
      ? ((times[i] ?? first) - first) / span
      : i / Math.max(1, points.length - 1)) *
      (w - left - right);
  const valueAt = (fraction: number) => {
    if (!times.length) return interpolate(points, fraction);
    const at = first + Math.max(0, Math.min(1, fraction)) * span;
    if (at <= first) return points[0]!;
    if (at >= last) return points.at(-1)!;
    const next = times.findIndex((t) => t >= at);
    if (next <= 0) return next === 0 ? points[0]! : points.at(-1)!;
    const part =
      (at - times[next - 1]!) / Math.max(1, times[next]! - times[next - 1]!);
    return points[next - 1]! + (points[next]! - points[next - 1]!) * part;
  };
  const y = (value: number) =>
    top + ((hi - value) / (hi - lo)) * (h - top - bottom);
  const markup: SafeHtml[] = [
    html`<title>${points.length ? "Sample" : "Unavailable"} ${metric === "price" ? "YES execution prices, in Yap Coins" : "participant endorsement, in percent"}</title>`,
  ];
  for (const v of [lo, (lo + hi) / 2, hi])
    markup.push(
      html`<line x1="${left}" y1="${y(v)}" x2="${w - right + 2}" y2="${y(v)}" stroke="var(--ya-line)"/><text x="${w - right + 9}" y="${y(v) + 3}">${metric === "price" ? v.toFixed(2) : Math.round(v) + "%"}</text>`,
    );
  if (points.length) {
    const path = points
      .map((v, i) => (i ? "L" : "M") + x(i) + "," + y(v))
      .join(" ");
    const clip = detail ? "ya-detail-chart-clip" : "ya-chart-clip";
    // The clip rectangle hides the line to the right of the pointer while scrubbing.
    markup.push(
      html`<clipPath id="${clip}"><rect data-chart-clip x="0" y="0" width="${w}" height="${h}"/></clipPath><path class="ya-linepath" pathLength="1" d="${path}" clip-path="url(#${clip})"/>`,
    );
    const labels =
      range === "1D"
        ? ["00:00", "08:00", "16:00", "Now"]
        : range === "1W"
          ? ["Oct 9", "Oct 11", "Oct 14", "Oct 16"]
          : ["Sep 16", "Sep 26", "Oct 6", "Oct 16"];
    [0, 1, 2, 3]
      .map((i) => Math.round((i * (points.length - 1)) / 3))
      .forEach((i, j) => {
        if (m.activity)
          labels[j] = new Date(times[i]!).toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "UTC",
          });
        markup.push(
          html`<text x="${x(i)}" y="${h - 4}" text-anchor="${j === 0 ? "start" : j === 3 ? "end" : "middle"}">${labels[j]}</text>`,
        );
      });
    markup.push(
      html`<g class="ya-endpoint" aria-hidden="true"><circle class="ya-endpoint-pulse" cx="${x(points.length - 1)}" cy="${y(points.at(-1)!)}" r="3.5" fill="var(--ya-chart)"/><circle cx="${x(points.length - 1)}" cy="${y(points.at(-1)!)}" r="3.5" fill="var(--ya-chart)"/></g><g class="ya-hover-group" aria-hidden="true"><text data-chart-hover-date y="12" text-anchor="middle"></text><circle data-chart-hover-halo r="9" fill="var(--ya-chart)" opacity=".18"/><circle data-chart-hover-marker r="4.5" fill="var(--ya-chart)" stroke="var(--ya-panel)" stroke-width="2"/></g><rect data-chart-hit x="${left}" y="0" width="${w - left - right}" height="${h}" fill="transparent"/>`,
    );
  } else
    markup.push(
      html`<text x="${(w - right) / 2}" y="${h / 2}" text-anchor="middle">History unavailable</text>`,
    );
  return {
    w,
    h,
    left,
    right,
    top,
    bottom,
    points,
    x,
    y,
    markup: html`${markup}`,
    rows,
    times,
    valueAt,
  };
}
