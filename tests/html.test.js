import assert from "node:assert/strict";
import { it } from "node:test";
import { html, raw } from "../dist/platform/html.js";

it("escapes every interpolated string and number", () => {
  const text = `<script>alert("x")</script> & 'quoted'`;
  assert.equal(
    String(html`<p title="${text}">${text}</p>`),
    '<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;</p>',
  );
  assert.equal(String(html`${"&amp;"}`), "&amp;amp;");
  assert.equal(String(html`${0} ${1.5} ${10n}`), "0 1.5 10");
});

it("keeps template text and SafeHtml values as written", () => {
  const icon = html`<svg aria-hidden="true"><path d="M1 1"/></svg>`;
  assert.equal(
    String(html`<b>a & b</b>${icon}`),
    '<b>a & b</b><svg aria-hidden="true"><path d="M1 1"/></svg>',
  );
  assert.equal(String(html`${raw("<i>trusted</i>")}`), "<i>trusted</i>");
  assert.equal(String(html``), "");
});

it("joins arrays and renders null, undefined and false as nothing", () => {
  const items = ["<a>", html`<b>`, ["<c>", html`<d>`], 2];
  assert.equal(String(html`${items}`), "&lt;a&gt;<b>&lt;c&gt;<d>2");
  assert.equal(String(html`[${null}${undefined}${false}${[]}]`), "[]");
  assert.equal(String(html`${String(false)}`), "false");
});

it("never treats a string or a look-alike object as markup", () => {
  const lookAlike = { toString: () => "<b>" };
  assert.equal(String(html`${String(lookAlike)}`), "&lt;b&gt;");
  assert.equal(String(html`${raw("<b>")}`), "<b>");
  assert.equal(`${html`<b>`}`, "<b>");
});
