# Combined release gate before the final recovery changes

The repository-wide browser release command exited **0** against application,
browser, test, operational and migration sources at
`69dc7c92b7f5d3686eb93b518243c18a8a1d62a2`. HEAD advanced to
`94904463be372a0d838b783ad55016fefaa8b16e` during the run through an
evidence-only commit; the tested sources and generated assets remained frozen.
The [command output](output.log) and [step results](result.json) record the run.

```sh
LC_ALL=C LANG=C DATABASE_TEST_MODE=host \
BROWSER_ARTIFACT_DIR=/private/tmp/yaparena-email-final-browser-release \
npm run verify:browser
```

The full runtime-backed `npm run check` passed **726/726 tests**, with zero
failures or skips and coverage of **95.10% lines, 91.78% branches and 95.32%
functions**. The required 90% thresholds were unchanged. Fresh installation and
upgrade each passed 144 account/security/financial PostgreSQL tests, 17 A4
PostgreSQL tests and five dedicated treasury tests, plus privilege inventory
and browser-role denial checks.

The browser gate also passed repeated A4 execution/no-trade journeys, arena and
shared-history integration, homepage interactions/responsive accessibility and
Live/replay preview handoff. Its database instances were disposable and isolated.
Browser records and media were synthetic; no hosted identity, retained account,
provider balance or real financial liability was changed.

This is an intermediate acceptance boundary. The subsequently approved
lost-email replacement and return-to-action improvements require a new combined
run. These results do not establish genuine hosted authentication, screen-reader
speech, physical-device acceptance or live financial eligibility.
