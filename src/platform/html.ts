// Auto-escaping HTML templates shared by the server renderers and the browser
// bundles. This is the only place that escapes HTML: build markup with
// html`...` so every interpolated value is escaped unless it is already
// SafeHtml. The module must stay free of Node and DOM APIs.

const entities = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
} as const;

const escapeText = (text: string) =>
  text.replace(/[&<>"']/g, (character) => entities[character as "&"]);

/** Markup that is safe to insert as-is. Create it with `html` or `raw`. */
class SafeHtml {
  readonly #markup: string;
  constructor(markup: string) {
    this.#markup = markup;
  }
  toString(): string {
    return this.#markup;
  }
}
export type { SafeHtml };

/**
 * A value accepted inside html`...`. Strings and numbers are escaped, arrays
 * are concatenated, and null, undefined and false render as "" so that
 * `${condition && html`...`}` works. `true` is deliberately not accepted:
 * write an attribute value as `${String(flag)}`.
 */
export type HtmlValue =
  | SafeHtml
  | string
  | number
  | bigint
  | false
  | null
  | undefined
  | readonly HtmlValue[];

function render(value: HtmlValue): string {
  if (value instanceof SafeHtml) return value.toString();
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeText(String(value));
}

export function html(
  strings: TemplateStringsArray,
  ...values: HtmlValue[]
): SafeHtml {
  let markup = strings[0]!;
  values.forEach((value, index) => {
    markup += render(value) + strings[index + 1]!;
  });
  return new SafeHtml(markup);
}

/**
 * Marks a trusted fragment, such as a static inline SVG icon, as SafeHtml
 * without escaping. Never pass user, API or database text. Each call site
 * states why its markup is safe.
 */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}
