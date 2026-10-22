import assert from "node:assert/strict";
import { it } from "node:test";
import { ESLint } from "eslint";

// The lint guard in eslint.config.js keeps HTML escaping in
// src/platform/html.ts. Lint probe snippets as if they were product files.
const eslint = new ESLint({ cwd: new URL("..", import.meta.url).pathname });
const problems = async (code, filePath = "frontend/guard-probe.ts") => {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages
    .filter((message) => message.ruleId === "no-restricted-syntax")
    .map((message) => message.line);
};

it("rejects local escape helpers outside the html module", async () => {
  const code = [
    'const map = { "<": "&lt;", "&": "&amp;" };',
    "const escape = (value: string) => value;",
    "function escapeHtml(value: string) { return value; }",
    "const esc = (value: string) => value;",
    "export { map, escape, escapeHtml, esc };",
  ].join("\n");
  assert.deepEqual(await problems(code), [1, 1, 2, 3, 4]);
  assert.deepEqual(
    await problems(code, "src/features/guard-probe.ts"),
    [1, 1, 2, 3, 4],
  );
  assert.deepEqual(await problems(code, "src/platform/html.ts"), []);
});

it("rejects innerHTML built from interpolated template literals", async () => {
  const code = [
    "declare const el: HTMLElement;",
    "declare const text: string;",
    "declare const html: (s: TemplateStringsArray, ...v: string[]) => object;",
    "el.innerHTML = `<b>${text}</b>`;",
    'el.innerHTML = text ? `<b>${text}</b>` : "";',
    "el.outerHTML += `<i>${text}</i>`;",
    'el.innerHTML = "<b>" + text;',
    'el.insertAdjacentHTML("beforeend", `<b>${text}</b>`);',
    "el.innerHTML = html`<b>${text}</b>`.toString();",
    "el.innerHTML = `<b>static</b>`;",
    "el.textContent = `${text}`;",
    "export {};",
  ].join("\n");
  assert.deepEqual(await problems(code), [4, 5, 6, 7, 8]);
});
