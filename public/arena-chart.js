/* global document */
export function sharePercent(share) {
  if (!share || !/^\d{1,30}$/.test(share.n) || !/^[1-9]\d{0,29}$/.test(share.d))
    return null;
  const n = BigInt(share.n),
    d = BigInt(share.d);
  return n <= d ? (100 * Number(n)) / Number(d) : null;
}

export function chartPoints(items) {
  return items.map((item, index) => ({
    ...item,
    yes: sharePercent(item.share),
    x:
      items.length === 1
        ? 349
        : 46 + (index * 606) / Math.max(1, items.length - 1),
  }));
}

export function createRoundChart(root, onSelect) {
  root.querySelector(".arena-chart").setAttribute("role", "group");
  const series = root.querySelector("[data-chart-series]");
  const ticks = root.querySelector("[data-chart-ticks]");
  const empty = root.querySelector("[data-chart-empty]");
  const markers = root.querySelector("[data-arena-markers]");
  const svg = (name, attributes = {}, text) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes))
      node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let revision;
  return {
    clear(message = "Sign in to see settled rounds and participate.") {
      revision = undefined;
      series.replaceChildren();
      ticks.replaceChildren();
      markers.replaceChildren();
      empty.hidden = false;
      empty.textContent = message;
    },
    render(data, selectedId) {
      const nextRevision = `${data.revision}:${selectedId}`;
      if (nextRevision === revision) return;
      revision = nextRevision;
      const points = chartPoints(data.items);
      series.replaceChildren();
      ticks.replaceChildren();
      markers.replaceChildren();
      empty.hidden = points.some((p) => p.yes !== null);
      empty.textContent = "Results will appear as rounds settle.";
      for (const side of ["yes", "no"]) {
        // Empty rounds interrupt a line: they never create a fictitious 50% point.
        const groups = [[]];
        for (const point of points) {
          if (point.yes === null) {
            groups.push([]);
            continue;
          }
          const value = side === "yes" ? point.yes : 100 - point.yes;
          groups.at(-1).push({ ...point, y: 284 - value * 2.5 });
        }
        for (const group of groups.filter((g) => g.length > 1)) {
          const path = group
            .map(
              (p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`,
            )
            .join(" ");
          series.append(
            svg("path", {
              d: `${path} L${group.at(-1).x},284 L${group[0].x},284 Z`,
              fill: `url(#arena-${side}-fill)`,
            }),
          );
          series.append(
            svg("path", {
              d: path,
              class: `arena-chart-line ${side}`,
              fill: "none",
            }),
          );
        }
      }
      const stride = Math.max(1, Math.ceil(points.length / 8));
      for (const [index, point] of points.entries()) {
        if (index % stride === 0 || index === points.length - 1)
          ticks.append(
            svg(
              "text",
              { x: point.x, y: 314, "text-anchor": "middle" },
              `R${point.number}`,
            ),
          );
        if (point.yes === null) continue;
        const group = svg("g", {
          role: "button",
          tabindex: "0",
          "aria-label": `Round ${point.number}: YES ${point.yes.toFixed(1)}%, NO ${(100 - point.yes).toFixed(1)}%`,
          class: `arena-chart-point${point.id === selectedId ? " is-selected" : ""}`,
          "data-chart-round": point.id,
        });
        group.append(
          svg("line", {
            x1: point.x,
            x2: point.x,
            y1: 34,
            y2: 284,
            class: "arena-chart-crosshair",
          }),
        );
        group.append(
          svg("circle", {
            cx: point.x,
            cy: 284 - point.yes * 2.5,
            r: 4,
            class: "yes",
          }),
        );
        group.append(
          svg("circle", {
            cx: point.x,
            cy: 284 - (100 - point.yes) * 2.5,
            r: 4,
            class: "no",
          }),
        );
        group.append(
          svg("rect", {
            x: point.x - 10,
            y: 30,
            width: 20,
            height: 260,
            fill: "transparent",
          }),
        );
        group.append(
          svg(
            "title",
            {},
            `Round ${point.number} · YES ${point.yes.toFixed(2)}% · ${new Date(point.settledAt).toLocaleString()}`,
          ),
        );
        group.addEventListener("click", () => onSelect(point));
        group.addEventListener("keydown", (event) => {
          if (["Enter", " "].includes(event.key)) {
            event.preventDefault();
            onSelect(point);
          }
        });
        series.append(group);
      }
      const last = points.findLast((p) => p.yes !== null);
      if (last)
        for (const [side, value] of [
          ["yes", last.yes],
          ["no", 100 - last.yes],
        ]) {
          const y = Math.max(30, Math.min(266, 284 - value * 2.5 - 13));
          series.append(
            svg("rect", {
              x: 662,
              y,
              width: 55,
              height: 27,
              rx: 6,
              class: `arena-chart-badge ${side}`,
            }),
          );
          series.append(
            svg(
              "text",
              {
                x: 689,
                y: y + 18,
                "text-anchor": "middle",
                class: "arena-chart-badge-text",
              },
              `${value.toFixed(0)}%`,
            ),
          );
        }
      for (const point of points.slice(-8)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "arena-round-marker";
        button.textContent = `Round ${point.number}`;
        button.setAttribute(
          "aria-label",
          `Inspect settled round ${point.number}`,
        );
        button.setAttribute("aria-pressed", String(point.id === selectedId));
        button.addEventListener("click", () => onSelect(point));
        markers.append(button);
      }
    },
  };
}
