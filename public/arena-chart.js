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

export function nearestRound(points, x) {
  if (!Number.isFinite(x) || !points.length) return null;
  return points.reduce((nearest, point) =>
    Math.abs(point.x - x) < Math.abs(nearest.x - x) ? point : nearest,
  );
}

export function roundProgress(opensAt, closesAt, now = Date.now()) {
  const opens = new Date(opensAt).getTime(),
    closes = new Date(closesAt).getTime();
  if (!Number.isFinite(opens) || !Number.isFinite(closes) || closes <= opens)
    return { percent: 0, seconds: 0 };
  return {
    percent: Math.max(
      0,
      Math.min(100, ((closes - now) / (closes - opens)) * 100),
    ),
    seconds: Math.max(0, Math.ceil((closes - now) / 1000)),
  };
}

export function createRoundChart(root, onSelect, onInspect = () => {}) {
  const canvas = root.querySelector(".arena-chart");
  canvas.setAttribute("role", "group");
  const series = root.querySelector("[data-chart-series]");
  const ticks = root.querySelector("[data-chart-ticks]");
  const empty = root.querySelector("[data-chart-empty]");
  const cursor = root.querySelector("[data-chart-cursor]");
  const tooltip = root.querySelector("[data-chart-tooltip]");
  const svg = (name, attributes = {}, text) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes))
      node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let revision,
    points = [],
    inspected;
  function inspect(point) {
    inspected = point?.id;
    cursor.replaceChildren();
    tooltip.hidden = !point;
    for (const group of series.querySelectorAll("[data-chart-round]"))
      group.classList.toggle(
        "is-inspected",
        group.dataset.chartRound === point?.id,
      );
    if (!point) {
      onInspect(null);
      return;
    }
    cursor.append(
      svg("line", {
        x1: point.x,
        x2: point.x,
        y1: 34,
        y2: 284,
        class: "arena-chart-hover-line",
      }),
    );
    for (const value of point.yes === null ? [] : [point.yes, 100 - point.yes])
      cursor.append(
        svg("circle", {
          cx: point.x,
          cy: 284 - value * 2.5,
          r: 6,
          class: "arena-chart-hover-dot",
        }),
      );
    const badgeX = Math.max(153, Math.min(545, point.x));
    cursor.append(
      svg("path", {
        d: `M${point.x},292 l5,6 -5,6 -5,-6 Z`,
        class: "arena-chart-argument-symbol",
      }),
    );
    cursor.append(
      svg("rect", {
        x: badgeX - 145,
        y: 321,
        width: 290,
        height: 27,
        rx: 5,
        class: "arena-chart-axis-badge",
      }),
    );
    const label = point.argumentLabel || "Argument not labeled";
    cursor.append(
      svg(
        "text",
        {
          x: badgeX,
          y: 339,
          "text-anchor": "middle",
          class: "arena-chart-axis-label",
        },
        `◆ R${point.number} · ${label.length > 27 ? label.slice(0, 26) + "…" : label}`,
      ),
    );
    const title = document.createElement("strong"),
      argument = document.createElement("span"),
      rates = document.createElement("span"),
      offer = document.createElement("span");
    title.textContent = `Round ${point.number}`;
    argument.textContent = label;
    rates.textContent =
      point.yes === null
        ? "No locked endorsements"
        : `YES ${point.yes.toFixed(2)}% · NO ${(100 - point.yes).toFixed(2)}%`;
    const price = sharePercent(point.offer);
    offer.textContent = `Offered p: ${price === null ? "—" : price.toFixed(2) + "¢"}`;
    tooltip.replaceChildren(title, argument, rates, offer);
    tooltip.style.left = `${Math.max(2, Math.min(58, (point.x / 720) * 100 - 15))}%`;
    onInspect(point);
  }
  function fromPointer(event) {
    const transform = canvas.getScreenCTM();
    if (!transform || !points.length) return null;
    const coordinate = canvas.createSVGPoint();
    coordinate.x = event.clientX;
    coordinate.y = event.clientY;
    const position = coordinate.matrixTransform(transform.inverse());
    if (
      position.x < 36 ||
      position.x > 662 ||
      position.y < 24 ||
      position.y > 350
    )
      return null;
    return nearestRound(points, position.x);
  }
  canvas.addEventListener("pointermove", (event) =>
    inspect(fromPointer(event)),
  );
  canvas.addEventListener("pointerleave", () => inspect(null));
  canvas.addEventListener("click", (event) => {
    const point = fromPointer(event);
    if (point) {
      inspect(point);
      onSelect(point);
    }
  });
  canvas.addEventListener("focusout", (event) => {
    if (!canvas.contains(event.relatedTarget)) inspect(null);
  });
  return {
    clear(message = "Sign in to see settled rounds and participate.") {
      revision = undefined;
      series.replaceChildren();
      ticks.replaceChildren();
      cursor.replaceChildren();
      tooltip.hidden = true;
      points = [];
      inspected = undefined;
      empty.hidden = false;
      empty.textContent = message;
    },
    render(data, selectedId) {
      const nextRevision = `${data.revision}:${selectedId}`;
      if (nextRevision === revision) return;
      revision = nextRevision;
      const oldInspection = inspected;
      points = chartPoints(data.items);
      series.replaceChildren();
      ticks.replaceChildren();
      cursor.replaceChildren();
      tooltip.hidden = true;
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
        const group = svg("g", {
          role: "button",
          tabindex:
            point.id === selectedId ||
            (!points.some((p) => p.id === selectedId) &&
              index === points.length - 1)
              ? "0"
              : "-1",
          "aria-label": `Round ${point.number}: ${point.argumentLabel || "Argument not labeled"}. ${point.yes === null ? "No endorsements" : `YES ${point.yes.toFixed(2)}%, NO ${(100 - point.yes).toFixed(2)}%`}. Offered price ${sharePercent(point.offer) === null ? "unavailable" : sharePercent(point.offer).toFixed(2) + " cents"}.`,
          class: `arena-chart-point${point.id === selectedId ? " is-selected" : ""}`,
          "data-chart-round": point.id,
        });
        if (point.yes !== null) {
          for (const [side, value] of [
            ["yes", point.yes],
            ["no", 100 - point.yes],
          ])
            group.append(
              svg("circle", {
                cx: point.x,
                cy: 284 - value * 2.5,
                r: 4,
                class: side,
              }),
            );
        }
        group.append(
          svg("path", {
            d: `M${point.x},294 l4,5 -4,5 -4,-5 Z`,
            class: "arena-chart-argument-symbol",
          }),
        );
        group.append(
          svg("rect", {
            x: point.x - 6,
            y: 30,
            width: 12,
            height: 280,
            fill: "transparent",
          }),
        );
        group.append(
          svg(
            "title",
            {},
            `Round ${point.number} · ${point.argumentLabel || "Argument not labeled"} · ${new Date(point.settledAt).toLocaleString()}`,
          ),
        );
        group.addEventListener("focus", () => inspect(point));
        group.addEventListener("keydown", (event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? points.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        points.length - 1,
                        index + (event.key === "ArrowLeft" ? -1 : 1),
                      ),
                    );
            series
              .querySelector(`[data-chart-round="${points[next].id}"]`)
              ?.focus();
          }
          if (event.key === "Escape") inspect(null);
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
      if (oldInspection) inspect(points.find((p) => p.id === oldInspection));
    },
  };
}
