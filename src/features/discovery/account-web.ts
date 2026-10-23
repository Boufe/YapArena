import { html } from "../../platform/html.ts";

const icons = {
  person: html`<circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>`,
  shield: html`<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>`,
  wallet: html`<path d="M20 8V5H6a3 3 0 0 1 0-6h12v4M3 3v16a2 2 0 0 0 2 2h15V8H6a3 3 0 0 1-3-3" transform="translate(0 2) scale(.9)"/><path d="M21 12h-6v5h6M17 14.5h.01"/>`,
  spark: html`<path d="m12 2 2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7L12 2Z"/>`,
  activity: html`<path d="M3 12h4l3-8 4 16 3-8h4"/>`,
  arrow: html`<path d="M5 12h14m-6-6 6 6-6 6"/>`,
  check: html`<path d="m5 12 4 4L19 6"/>`,
};
const icon = (name: keyof typeof icons) =>
  html`<svg class="account-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;

export function accountMarkup(asset: (name: string) => string) {
  return html`<link rel="stylesheet" href="${asset("account-auth.css")}">
  <section class="container account-shell">
    <div class="account-status-row"><a class="account-back" data-auth-return href="/debates">← Back to the arena</a><p id="account-notice" role="status" aria-live="polite">Checking your account…</p></div>
    <div id="signed-out" hidden>
      <div class="auth-layout">
        <aside class="auth-story">
          <span class="eyebrow accent">IDEAS UNDER PRESSURE</span>
          <h1>Every idea<br>deserves <em>a voice.</em></h1>
          <p>Follow the ideas that move you.<br>Make your mark when you’re ready.</p>
          <div class="auth-arena-art" aria-hidden="true"><svg viewBox="0 0 440 300" fill="none"><ellipse cx="220" cy="150" rx="145" ry="93" transform="rotate(-28 220 150)"/><ellipse cx="220" cy="150" rx="145" ry="93" transform="rotate(28 220 150)"/><circle cx="220" cy="150" r="53"/><path d="m195 183 50-66"/><circle cx="100" cy="86" r="7"/><circle cx="345" cy="213" r="5"/><circle cx="220" cy="30" r="3"/></svg><span>YOUR NEXT PERSPECTIVE STARTS HERE</span></div>
          <div class="auth-benefits"><div>${icon("check")}<span>One email. No password.</span></div><div>${icon("person")}<span>A profile, whenever you’re ready.</span></div><div>${icon("spark")}<span>Always free to explore and watch.</span></div></div>
        </aside>
        <div class="auth-panel">
          <div class="auth-card account-sign-in" id="account-sign-in"><span class="eyebrow accent">LOG IN OR SIGN UP</span><h2>Join the arena</h2><p class="auth-description">Continue with Google or a one-time code sent to your email. There is no password to remember.</p><div class="auth-sign-in-actions"><a class="button" href="/api/auth/login?connection=google&amp;return=%2Faccount" data-sign-in="google">Continue with Google</a><a class="button-secondary" href="/api/auth/login?connection=email&amp;return=%2Faccount" data-sign-in="email">Continue with email</a></div><p class="form-note">Signing in never approves a financial transaction.</p></div>
        </div>
      </div>
    </div>
    <div id="signed-in" hidden>
      <div class="account-heading"><div class="account-identity"><span class="account-identity-icon">${icon("person")}</span><div><span class="eyebrow accent">YOUR CORNER OF THE ARENA</span><h1>Your account.</h1><h2 id="account-name">Your account</h2></div></div><button class="button-secondary" id="sign-out" type="button">Sign out →</button></div>
      <nav class="account-section-nav" aria-label="Account sections"><a href="#profile-settings">${icon("person")}Profile</a><a href="#account-security">${icon("shield")}Security</a><a href="#account-wallet">${icon("wallet")}Yap Coins</a><a href="#account-activity">${icon("activity")}Activity</a></nav>
      <div class="account-columns">
        <div class="account-main-stack">
          <section id="profile-settings" class="information-card account-card"><div class="account-card-heading"><span class="account-section-icon">${icon("person")}</span><div><span class="eyebrow">HOW YOU SHOW UP</span><h2>Your profile</h2></div><span class="account-optional">Optional</span></div><p id="profile-state" class="account-section-note"></p>
            <form id="profile-form" class="stack-form account-profile-form"><div class="account-form-row"><label>Handle<input name="handle" placeholder="your-handle" maxlength="40" minlength="3" pattern="[a-z0-9][a-z0-9-]{2,39}" required></label><label>Display name<input name="displayName" placeholder="What should we call you?" maxlength="80" required></label></div><label>Bio<textarea name="bio" placeholder="A little about you and the ideas you care about." maxlength="500" rows="3"></textarea></label><label>Visibility<select name="publicationState"><option value="draft">Private draft</option><option value="published">Public</option></select></label><div class="account-form-footer"><p class="form-note">Your handle is permanent. You decide when to publish.</p><button class="button" type="submit">Save profile ↗</button></div></form>
          </section>
          <section id="account-security" class="information-card account-card"><div class="account-card-heading"><span class="account-section-icon">${icon("shield")}</span><div><span class="eyebrow">ACCESS &amp; RECOVERY</span><h2>Account security</h2></div></div><div class="account-auth-methods"><h3>Sign-in methods</h3><ul id="sign-in-methods" class="account-list"></ul><p class="form-note">Google and email-code sign-in with the same address lead to this account after you confirm the email code.</p></div><div class="account-session-controls"><h3>Active sessions</h3><p>Signing out only ends the session on that device. Sign out any session you don’t recognize.</p></div></section>
        </div>
        <div class="account-side">
          <section id="account-wallet" class="information-card account-card account-coin-card"><div class="account-card-heading"><span class="account-coin-symbol" aria-hidden="true">Y</span><div><span class="eyebrow">PLATFORM CURRENCY</span><h2>Your Yap Coins</h2></div><span class="account-preview-label">Preview</span></div><section id="account-wallet-progress" class="wallet-money-summary" aria-label="Withdrawal balance and grant progress" hidden></section><dl class="account-balances"><div><dt>Available</dt><dd data-funds="available">—</dd></div><div><dt>Reserved</dt><dd data-funds="reserved">—</dd></div><div><dt>Pending</dt><dd data-funds="pending">—</dd></div><div><dt>Promotional</dt><dd data-funds="promotional">—</dd></div></dl><div class="account-coin-note"><span>100 YC = 1 USDC</span><p>Purchases and withdrawals are not yet available. Grant principal stays spend-only.</p></div></section>
          <section class="information-card account-card"><div class="account-card-heading"><span class="account-section-icon">${icon("spark")}</span><div><span class="eyebrow">YOUR PERSPECTIVE</span><h2>Following</h2></div></div><ul id="follow-list" class="account-list"></ul><p class="form-note">Follow people and topics from their public pages.</p></section>
          <section class="information-card account-card"><div class="account-card-heading"><div><span class="eyebrow">STAY IN THE LOOP</span><h2>Notifications</h2></div></div><ul id="account-notifications" class="account-list"></ul></section>
          <section id="account-activity" class="information-card account-card"><div class="account-card-heading"><span class="account-section-icon">${icon("activity")}</span><div><span class="eyebrow">AROUND THE ARENA</span><h2>Recent activity</h2></div></div><ul id="activity-list" class="account-list"></ul><a class="account-text-link" href="/account/moderation">My reports and appeals ${icon("arrow")}</a></section>
        </div>
      </div>
    </div>
  </section>
  <script defer src="${asset("account.js")}"></script><script type="module" src="${asset("account-session-list.js")}"></script><script type="module" src="${asset("account-coins.js")}"></script>`;
}
