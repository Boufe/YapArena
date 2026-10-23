import { html, type SafeHtml } from "../html.ts";

const style = html`<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#f5f6f8;font:16px/1.5 system-ui,sans-serif}
  main{max-width:28rem;padding:2rem}a{color:#9fd3ff}
</style>`;

function page(title: string, body: SafeHtml, refresh?: string) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${refresh ? html`<meta http-equiv="refresh" content="${`0;url=${refresh}`}">` : ""}
<title>${title} · YAP Arena</title>
${style}
</head>
<body><main>${body}</main></body>
</html>`.toString();
}

// The provider's redirect to the callback is cross-site, so a browser would
// withhold the SameSite=Strict session cookie on an immediate HTTP redirect.
// This same-site hop sends it on arrival.
export function renderSignInContinue(returnPath: string) {
  return page(
    "Signing you in",
    html`<h1>You're signed in</h1><p><a href="${returnPath}">Continue to YAP Arena</a></p>`,
    returnPath,
  );
}

export function renderSignInProblem(input: {
  title: string;
  message: string;
  retry?: string;
  back: string;
}) {
  return page(
    input.title,
    html`<h1>${input.title}</h1><p role="alert">${input.message}</p>
<p>${input.retry ? html`<a href="${input.retry}">Try again</a> · ` : ""}<a href="${input.back}">Back to YAP Arena</a></p>`,
  );
}
