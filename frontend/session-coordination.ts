import { sessionStore } from "./lib/session.js";

// This classic script loads before every other page script and creates the
// page's session store, so its account-change listeners run first and other
// tabs' account changes reach this page. Sign-in is a full-page navigation
// through Auth0 (Decision 0009), so no fetch issues a session cookie. See
// lib/session.ts for revocation and the shared /api/auth/me read.
sessionStore();
