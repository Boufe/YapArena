import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../platform/transaction.ts";
import { accountOperationTermsDigest } from "../../platform/auth/account-operations.ts";
import {
  assertActiveSession,
  lockAccount,
  SessionUnavailableError,
} from "../../platform/auth/sessions.ts";
import { atomicAmount, CoinOperationError } from "./external-operations.ts";
import { coinJournalReference, postCoinJournal } from "./ledger.ts";
import {
  planCashSourceRestoration,
  type StakeFunding,
  type WithdrawalSourceReservation,
} from "./grant-accounting.ts";
import {
  appendSandboxBookEvent,
  assertSandboxRail,
  ensureSandboxBuckets,
  lockSandboxBook,
  type PreparedCoinApproval,
  type SandboxContext,
  type SandboxRail,
  type SandboxRequest,
} from "./sandbox-repository.ts";

export interface RecoveryCostQuote {
  amount: string;
  network: string;
  expiresAt: string;
  description: string;
}
export type ReportOutcome =
  | "evidence_required"
  | "no_error"
  | "erroneous_credit"
  | "operator_shortfall"
  | "operator_cost"
  | "recovery_quote";
export interface SandboxErrorReport {
  id: string;
  userId: string;
  requestId: string;
  rail: SandboxRail;
  reference: string;
  termsDigest: string;
  message: string;
  createdAt: Date;
}
export interface SandboxReportEvent {
  id: string;
  sequence: string;
  reportId: string;
  userId: string;
  kind: "review" | "recovery_consent" | "correction_authorized" | "compensated";
  reference: string;
  termsDigest: string;
  terms: Record<string, unknown>;
  createdAt: Date;
}
export interface PublicSandboxReport {
  id: string;
  requestId: string;
  rail: SandboxRail;
  description: string;
  createdAt: Date;
  events: {
    id: string;
    kind: "review" | "recovery_consent" | "compensated";
    createdAt: Date;
    outcome?: ReportOutcome;
    publicNote?: string;
    quote?: RecoveryCostQuote;
    quoteId?: string;
    amount?: string;
  }[];
}
const reportColumns = `id,user_id AS "userId",request_id AS "requestId",rail,reference,terms_digest AS "termsDigest",message,created_at AS "createdAt"`;
const eventColumns = `id,sequence::text,report_id AS "reportId",user_id AS "userId",kind,reference,terms_digest AS "termsDigest",terms,created_at AS "createdAt"`;
const requestColumns = `id,user_id AS "userId",kind,reference,terms_digest AS "termsDigest",terms,status,expires_at AS "expiresAt",created_at AS "createdAt"`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function fail(message: string, status = 409): never {
  throw new CoinOperationError(message, status);
}
function id(value: string) {
  if (!uuid.test(value)) fail("report resource is unavailable", 404);
  return value;
}
function text(value: string, maximum = 2000) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    value.includes("\0")
  )
    fail("report text is required and must fit its length limit", 400);
  return value.trim();
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function reference(userId: string, operation: string, key: string) {
  return coinJournalReference({
    environment: "sandbox",
    accountId: userId,
    operation,
    idempotencyKey: key,
  });
}
function reportReference(
  userId: string,
  operation: string,
  reportId: string,
  key: string,
) {
  if (typeof key !== "string" || !key || key.length > 200)
    fail("Idempotency-Key is required and must fit its length limit", 400);
  return reference(userId, operation, digest([reportId, key]));
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function network(rail: SandboxRail) {
  return rail === "simulation" ? "simulation:usdc" : "base-sepolia:84532";
}
function quote(value: unknown, rail: SandboxRail): RecoveryCostQuote {
  if (
    !object(value) ||
    typeof value.amount !== "string" ||
    typeof value.network !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.description !== "string"
  )
    fail("recovery cost quote is incomplete", 400);
  atomicAmount(value.amount, true);
  const expiresAt = new Date(value.expiresAt);
  if (
    value.network !== network(rail) ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.toISOString() !== value.expiresAt
  )
    fail("recovery quote network or expiry is invalid", 400);
  return {
    amount: value.amount,
    network: value.network,
    expiresAt: value.expiresAt,
    description: text(value.description, 500),
  };
}
async function latestReview(client: PoolClient, reportId: string) {
  return (
    await client.query<SandboxReportEvent>(
      `SELECT ${eventColumns} FROM coin_sandbox_report_events WHERE report_id=$1 AND kind='review' ORDER BY coin_sandbox_report_events.sequence DESC LIMIT 1`,
      [reportId],
    )
  ).rows[0];
}
async function ownedRequest(client: PoolClient, report: SandboxErrorReport) {
  const request = (
    await client.query<SandboxRequest>(
      `SELECT ${requestColumns} FROM coin_sandbox_requests WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [report.requestId, report.userId],
    )
  ).rows[0];
  if (
    !request ||
    request.terms.rail !== report.rail ||
    !["funding", "withdrawal"].includes(request.kind)
  )
    fail("original deposit or payout is unavailable", 404);
  return request;
}
async function event(
  client: PoolClient,
  input: {
    report: SandboxErrorReport;
    kind: SandboxReportEvent["kind"];
    key: string;
    terms: Record<string, unknown>;
    sessionId?: string;
    generation?: string;
    cashJournalId?: string;
  },
) {
  const ref = reportReference(
      input.report.userId,
      `report.${input.kind}`,
      input.report.id,
      input.key,
    ),
    hash = digest(input.terms),
    existing = (
      await client.query<SandboxReportEvent>(
        `SELECT ${eventColumns} FROM coin_sandbox_report_events WHERE reference=$1`,
        [ref],
      )
    ).rows[0];
  if (existing) {
    if (existing.reportId !== input.report.id || existing.termsDigest !== hash)
      fail("report event idempotency conflict");
    return { created: false, event: existing };
  }
  if (input.kind === "recovery_consent") {
    const consent = (
      await client.query<SandboxReportEvent>(
        `SELECT ${eventColumns} FROM coin_sandbox_report_events WHERE report_id=$1 AND kind='recovery_consent' AND terms->>'quoteId'=$2`,
        [input.report.id, input.terms.quoteId],
      )
    ).rows[0];
    if (consent) {
      if (consent.termsDigest !== hash) fail("recovery consent terms conflict");
      return { created: false, event: consent };
    }
  }
  const created = (
    await client.query<SandboxReportEvent>(
      `INSERT INTO coin_sandbox_report_events(id,report_id,user_id,kind,reference,terms_digest,terms,session_id,auth_generation,cash_journal_id)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING ${eventColumns}`,
      [
        randomUUID(),
        input.report.id,
        input.report.userId,
        input.kind,
        ref,
        hash,
        JSON.stringify(input.terms),
        input.sessionId ?? null,
        input.generation ?? null,
        input.cashJournalId ?? null,
      ],
    )
  ).rows[0]!;
  return { created: true, event: created };
}
function consentTerms(report: SandboxErrorReport, review: SandboxReportEvent) {
  const cost = quote(review.terms.quote, report.rail);
  return {
    accountId: report.userId,
    requestId: report.requestId,
    reportId: report.id,
    quoteId: review.id,
    quoteDigest: review.termsDigest,
    environment: "sandbox",
    rail: report.rail,
    asset: "USDC",
    precision: "6",
    amount: cost.amount,
    network: cost.network,
    expiresAt: cost.expiresAt,
    authorization: "consent_only_no_charge",
  };
}
async function activeQuote(
  client: PoolClient,
  report: SandboxErrorReport,
  quoteId: string,
) {
  const review = await latestReview(client, report.id);
  if (
    !review ||
    review.id !== quoteId ||
    review.terms.outcome !== "recovery_quote"
  )
    fail("recovery quote is superseded or unavailable");
  const terms = consentTerms(report, review);
  if (
    !(
      await client.query<{ active: boolean }>(
        "SELECT $1::timestamptz>clock_timestamp() AS active",
        [terms.expiresAt],
      )
    ).rows[0]?.active
  )
    fail("recovery quote expired", 410);
  return { review, terms };
}
async function assertContext(client: PoolClient, context: SandboxContext) {
  const session = await assertActiveSession(
    client,
    context.userId,
    context.sessionTokenHash,
  );
  if (
    context.expectedSessionId !== undefined &&
    session.id !== context.expectedSessionId
  )
    fail("account context changed; refresh and review again");
  return session;
}
async function transaction<T>(
  database: Pool,
  rail: SandboxRail,
  userId: string,
  context: SandboxContext | undefined,
  work: (client: PoolClient) => Promise<T>,
) {
  return withTransaction(database, async (client) => {
    if (context) {
      if (!(await lockAccount(client, userId)))
        throw new SessionUnavailableError("account unavailable");
      await assertContext(client, context);
    } else {
      if (
        (await client.query<{ role: string }>("SELECT current_user AS role"))
          .rows[0]?.role !== "yaparena_owner"
      )
        fail("report review requires its separate owner process", 403);
      if (
        !(
          await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [
            userId,
          ])
        ).rowCount
      )
        fail("account unavailable", 404);
    }
    await assertSandboxRail(client, rail);
    const result = await work(client);
    if (context) await assertContext(client, context);
    return result;
  });
}
// Reports are immutable. Every caller already holds the account ordering lock;
// no row UPDATE privilege or mutable positive-authorization cache is needed.
async function reportUnderAccountLock(
  client: PoolClient,
  userId: string,
  reportId: string,
) {
  const report = (
    await client.query<SandboxErrorReport>(
      `SELECT ${reportColumns} FROM coin_sandbox_reports WHERE id=$1 AND user_id=$2`,
      [id(reportId), userId],
    )
  ).rows[0];
  if (!report) fail("report is unavailable", 404);
  return report;
}
async function history(
  client: PoolClient,
  report: SandboxErrorReport,
): Promise<PublicSandboxReport> {
  const stored = (
    await client.query<SandboxReportEvent>(
      `SELECT ${eventColumns} FROM coin_sandbox_report_events WHERE report_id=$1 ORDER BY coin_sandbox_report_events.sequence DESC LIMIT 100`,
      [report.id],
    )
  ).rows.reverse();
  const events: PublicSandboxReport["events"] = [];
  for (const entry of stored) {
    if (entry.kind === "review") {
      const outcome = entry.terms.outcome;
      if (
        outcome !== "evidence_required" &&
        outcome !== "no_error" &&
        outcome !== "erroneous_credit" &&
        outcome !== "operator_shortfall" &&
        outcome !== "operator_cost" &&
        outcome !== "recovery_quote"
      )
        fail("report outcome is unavailable", 503);
      events.push({
        id: entry.id,
        kind: "review",
        createdAt: entry.createdAt,
        outcome,
        ...(typeof entry.terms.publicNote === "string"
          ? { publicNote: entry.terms.publicNote }
          : {}),
        ...(outcome === "recovery_quote"
          ? { quoteId: entry.id, quote: quote(entry.terms.quote, report.rail) }
          : {}),
      });
    } else if (entry.kind === "recovery_consent")
      events.push({
        id: entry.id,
        kind: entry.kind,
        createdAt: entry.createdAt,
        quoteId:
          typeof entry.terms.quoteId === "string"
            ? entry.terms.quoteId
            : undefined,
      });
    else if (entry.kind === "compensated")
      events.push({
        id: entry.id,
        kind: entry.kind,
        createdAt: entry.createdAt,
        amount:
          typeof entry.terms.amount === "string"
            ? entry.terms.amount
            : undefined,
      });
  }
  return {
    id: report.id,
    requestId: report.requestId,
    rail: report.rail,
    description: report.message,
    createdAt: report.createdAt,
    events,
  };
}
export function createSandboxErrorReports(database: Pool, rail: SandboxRail) {
  return Object.freeze({
    async submit(
      context: SandboxContext,
      input: { requestId: string; message: string; idempotencyKey: string },
    ) {
      const message = text(input.message),
        requestId = id(input.requestId),
        ref = reference(context.userId, "report.submit", input.idempotencyKey),
        hash = digest({ requestId, message, rail });
      return transaction(
        database,
        rail,
        context.userId,
        context,
        async (client) => {
          const previous = (
            await client.query<SandboxErrorReport>(
              `SELECT ${reportColumns} FROM coin_sandbox_reports WHERE reference=$1`,
              [ref],
            )
          ).rows[0];
          if (previous) {
            if (previous.termsDigest !== hash)
              fail("report idempotency conflict");
            return { created: false, report: await history(client, previous) };
          }
          const report: SandboxErrorReport = {
            id: randomUUID(),
            userId: context.userId,
            requestId,
            rail,
            reference: ref,
            termsDigest: hash,
            message,
            createdAt: new Date(),
          };
          await ownedRequest(client, report);
          const inserted = (
            await client.query<SandboxErrorReport>(
              `INSERT INTO coin_sandbox_reports(id,user_id,request_id,rail,reference,terms_digest,message) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${reportColumns}`,
              [report.id, report.userId, requestId, rail, ref, hash, message],
            )
          ).rows[0]!;
          return { created: true, report: await history(client, inserted) };
        },
      );
    },
    async list(context: SandboxContext) {
      return transaction(
        database,
        rail,
        context.userId,
        context,
        async (client) => {
          const reports = (
            await client.query<SandboxErrorReport>(
              `SELECT ${reportColumns} FROM coin_sandbox_reports WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 50`,
              [context.userId],
            )
          ).rows;
          const result = [];
          for (const report of reports)
            result.push(await history(client, report));
          return result;
        },
      );
    },
    async get(context: SandboxContext, reportId: string) {
      return transaction(
        database,
        rail,
        context.userId,
        context,
        async (client) => {
          const report = await reportUnderAccountLock(
            client,
            context.userId,
            reportId,
          );
          if (report.rail !== rail) fail("report rail conflicts");
          return history(client, report);
        },
      );
    },
    async getConsentTerms(
      context: SandboxContext,
      input: { reportId: string; quoteId: string },
    ) {
      return transaction(
        database,
        rail,
        context.userId,
        context,
        async (client) => {
          const report = await reportUnderAccountLock(
            client,
            context.userId,
            input.reportId,
          );
          if (report.rail !== rail) fail("report rail conflicts");
          const current = await activeQuote(client, report, id(input.quoteId));
          return {
            terms: current.terms,
            quote: quote(current.review.terms.quote, rail),
          };
        },
      );
    },
    async consent(
      context: SandboxContext,
      input: {
        reportId: string;
        quoteId: string;
        idempotencyKey: string;
        approval: PreparedCoinApproval;
      },
    ) {
      input.approval.assertContext(context.userId, context.sessionTokenHash);
      return transaction(database, rail, context.userId, context, (client) =>
        input.approval.consume(client, async () => {
          const report = await reportUnderAccountLock(
              client,
              context.userId,
              input.reportId,
            ),
            current = await activeQuote(client, report, id(input.quoteId));
          if (
            report.rail !== rail ||
            input.approval.purpose !== "recovery.cost.consent" ||
            input.approval.termsDigest !==
              accountOperationTermsDigest(current.terms)
          )
            fail(
              "approval does not authorize this exact recovery consent",
              403,
            );
          const session = await assertContext(client, context),
            account = (
              await client.query<{ generation: string }>(
                "SELECT auth_generation AS generation FROM users WHERE id=$1",
                [context.userId],
              )
            ).rows[0]!,
            saved = await event(client, {
              report,
              kind: "recovery_consent",
              key: input.idempotencyKey,
              terms: {
                quoteId: current.review.id,
                quoteDigest: current.review.termsDigest,
                consent: current.terms,
              },
              sessionId: session.id,
              generation: account.generation,
            });
          await activeQuote(client, report, current.review.id);
          return {
            ...saved,
            authorizesCharge: false,
            authorizesExternalRecovery: false,
          };
        }),
      );
    },
  });
}
export function createSandboxErrorReportOperator(
  database: Pool,
  rail: SandboxRail,
) {
  async function locate(reportId: string) {
    const report = (
      await database.query<SandboxErrorReport>(
        `SELECT ${reportColumns} FROM coin_sandbox_reports WHERE id=$1`,
        [id(reportId)],
      )
    ).rows[0];
    if (!report) fail("report unavailable", 404);
    return report;
  }
  return Object.freeze({
    async review(input: {
      reportId: string;
      idempotencyKey: string;
      outcome: ReportOutcome;
      note: string;
      publicNote?: string;
      evidenceDigest: string;
      amount?: string;
      quote?: RecoveryCostQuote;
    }) {
      if (
        ![
          "evidence_required",
          "no_error",
          "erroneous_credit",
          "operator_shortfall",
          "operator_cost",
          "recovery_quote",
        ].includes(input.outcome) ||
        !/^[a-f0-9]{64}$/.test(input.evidenceDigest)
      )
        fail("review outcome and evidence digest are required", 400);
      const initial = await locate(input.reportId),
        note = text(input.note),
        publicNote =
          input.publicNote !== undefined
            ? text(input.publicNote, 500)
            : undefined,
        cost =
          input.outcome === "recovery_quote"
            ? quote(input.quote, rail)
            : undefined;
      if (
        input.outcome === "operator_shortfall" ||
        input.outcome === "operator_cost"
      )
        atomicAmount(input.amount ?? "");
      else if (input.amount !== undefined)
        fail("only operator compensation review can approve an amount", 400);
      if (input.outcome !== "recovery_quote" && input.quote !== undefined)
        fail("only recovery review can include a cost quote", 400);
      return transaction(
        database,
        rail,
        initial.userId,
        undefined,
        async (client) => {
          const report = await reportUnderAccountLock(
              client,
              initial.userId,
              initial.id,
            ),
            original = await ownedRequest(client, report);
          if (report.rail !== rail) fail("report rail conflicts");
          if (
            input.outcome === "erroneous_credit" &&
            (original.kind !== "funding" || original.status !== "completed")
          )
            fail("erroneous-credit review requires completed original funding");
          if (
            cost &&
            !(
              await client.query<{ active: boolean }>(
                "SELECT $1::timestamptz>clock_timestamp() AS active",
                [cost.expiresAt],
              )
            ).rows[0]?.active
          )
            fail("recovery quote must have a future expiry", 400);
          return event(client, {
            report,
            kind: "review",
            key: input.idempotencyKey,
            terms: {
              outcome: input.outcome,
              note,
              ...(publicNote ? { publicNote } : {}),
              evidenceDigest: input.evidenceDigest,
              ...(input.amount ? { amount: input.amount } : {}),
              ...(cost ? { quote: cost } : {}),
              requestId: report.requestId,
              rail,
            },
          });
        },
      );
    },
    async compensate(input: {
      reportId: string;
      reviewId: string;
      amount: string;
      idempotencyKey: string;
    }) {
      const initial = await locate(input.reportId);
      id(input.reviewId);
      atomicAmount(input.amount);
      return transaction(
        database,
        rail,
        initial.userId,
        undefined,
        async (client) => {
          const report = await reportUnderAccountLock(
              client,
              initial.userId,
              initial.id,
            ),
            original = await ownedRequest(client, report),
            review = await latestReview(client, report.id);
          if (
            report.rail !== rail ||
            !review ||
            review.id !== input.reviewId ||
            !["operator_shortfall", "operator_cost"].includes(
              String(review.terms.outcome),
            ) ||
            typeof review.terms.amount !== "string" ||
            typeof review.terms.evidenceDigest !== "string"
          )
            fail("evidence-reviewed operator compensation is required", 403);
          const ref = reportReference(
              report.userId,
              "report.compensated",
              report.id,
              input.idempotencyKey,
            ),
            terms = {
              originalRequestId: original.id,
              reviewId: review.id,
              amount: input.amount,
              rail,
            },
            hash = digest(terms),
            existing = (
              await client.query<SandboxReportEvent>(
                `SELECT ${eventColumns} FROM coin_sandbox_report_events WHERE reference=$1`,
                [ref],
              )
            ).rows[0];
          if (existing) {
            if (existing.termsDigest !== hash)
              fail("compensation idempotency conflict");
            return { created: false, event: existing };
          }
          if (original.status !== "completed")
            fail(
              "compensation requires a completed original funding or payout",
            );
          const snapshot = await lockSandboxBook(client, report.userId);
          let basis: StakeFunding;
          if (original.kind === "funding") {
            const amount = original.terms.amount!;
            atomicAmount(amount);
            const source = snapshot.book.purchased.find(
              (s) => s.id === original.id && s.kind === "purchased_principal",
            );
            if (
              !source ||
              BigInt(source.balance) + BigInt(input.amount) > BigInt(amount)
            )
              fail(
                "restoration exceeds the missing original purchase principal",
              );
            if (
              (
                await client.query(
                  `SELECT 1 FROM coin_sandbox_requests q JOIN coin_sandbox_events e ON e.request_id=q.id
              WHERE q.user_id=$1 AND q.kind IN ('withdrawal','stake') AND q.status IN ('reserved','review','approved','pending','uncertain')
                AND e.kind IN ('withdrawal.reserved','debate.reserved')
                AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(e.metadata->'reservation'->'sources',e.metadata->'funding'->'sources','[]'::jsonb)) s
                  WHERE s->>'id'=$2 AND s->>'kind'='purchased_principal') LIMIT 1`,
                  [report.userId, original.id],
                )
              ).rowCount
            )
              fail(
                "reconcile outstanding original purchase reservations before source restoration",
              );
            basis = {
              scope: snapshot.book.scope,
              amount,
              sources: [
                {
                  id: original.id,
                  kind: "purchased_principal",
                  purchaseId: original.id,
                  principal: amount,
                  profit: "0",
                  amount,
                },
              ],
            };
          } else {
            const row = (
              await client.query<{ reservation: WithdrawalSourceReservation }>(
                "SELECT metadata->'reservation' AS reservation FROM coin_sandbox_events WHERE request_id=$1 AND user_id=$2 AND kind='withdrawal.reserved' ORDER BY sequence LIMIT 1",
                [original.id, report.userId],
              )
            ).rows[0];
            if (
              !row ||
              row.reservation.operation !== "withdrawal" ||
              row.reservation.amount !== original.terms.gross
            )
              fail("original payout source receipt is unavailable", 503);
            basis = row.reservation;
          }
          const prior: Record<string, string> = Object.fromEntries(
            basis.sources.map((s) => [s.id, "0"]),
          );
          let reviewedAmount = 0n;
          const entries = (
            await client.query<{
              sources: unknown;
              reviewId: string;
              amount: string;
            }>(
              "SELECT metadata->'restoredSources' AS sources,metadata->>'reviewId' AS \"reviewId\",metadata->>'amount' AS amount FROM coin_sandbox_events WHERE user_id=$1 AND request_id=$2 AND kind='correction.compensated' ORDER BY sequence",
              [report.userId, original.id],
            )
          ).rows;
          for (const entry of entries) {
            if (!Array.isArray(entry.sources))
              fail("original compensation history is unavailable", 503);
            for (const source of entry.sources) {
              if (
                !object(source) ||
                typeof source.id !== "string" ||
                typeof source.amount !== "string" ||
                !Object.hasOwn(prior, source.id)
              )
                fail("original compensation source history conflicts", 503);
              prior[source.id] = String(
                BigInt(prior[source.id]!) + atomicAmount(source.amount),
              );
            }
            if (entry.reviewId === review.id)
              reviewedAmount += atomicAmount(entry.amount);
          }
          if (
            reviewedAmount + BigInt(input.amount) >
            atomicAmount(review.terms.amount)
          )
            fail("compensation exceeds its evidence-reviewed amount");
          const planned = planCashSourceRestoration(
              snapshot.book,
              basis,
              input.amount,
              prior,
            ),
            buckets = await ensureSandboxBuckets(client, report.userId),
            journal = await postCoinJournal(client, {
              id: randomUUID(),
              environment: "sandbox",
              asset: "USDC",
              operation: "payout",
              reference: reportReference(
                report.userId,
                "report.compensation.cash",
                report.id,
                input.idempotencyKey,
              ),
              postings: [
                {
                  accountId: buckets.system.correction_available,
                  amount: String(-BigInt(input.amount)),
                },
                { accountId: buckets.cashAvailable, amount: input.amount },
              ],
            }),
            bookEvent = await appendSandboxBookEvent(client, {
              userId: report.userId,
              snapshot,
              book: planned.book,
              kind: "correction.compensated",
              reference: ref,
              termsDigest: hash,
              requestId: original.id,
              cashJournalId: journal.id,
              metadata: {
                ...terms,
                reportId: report.id,
                restoredSources: planned.restored,
                cumulativeRestored: planned.cumulativeRestored,
                actorRole: "yaparena_owner",
                notRealMoney: rail === "simulation",
              },
            });
          // Event terms remain bounded regardless of a large original source lot
          // population; exact allocations live in the referenced immutable book event.
          const saved = await event(client, {
            report,
            kind: "compensated",
            key: input.idempotencyKey,
            terms,
            cashJournalId: journal.id,
          });
          return { ...saved, bookEventId: bookEvent.id };
        },
      );
    },
    async prepareCorrection(input: {
      reportId: string;
      reviewId: string;
      requestId: string;
      action: "correct" | "retry";
      idempotencyKey: string;
    }) {
      const report = await locate(input.reportId);
      id(input.reviewId);
      id(input.requestId);
      return {
        userId: report.userId,
        id: input.reviewId,
        async validate(client: PoolClient, originalFundingRequestId: string) {
          if (
            (
              await client.query<{ role: string }>(
                "SELECT current_user AS role",
              )
            ).rows[0]?.role !== "yaparena_owner"
          )
            fail("correction review requires its separate owner process", 403);
          const stored = await reportUnderAccountLock(
              client,
              report.userId,
              report.id,
            ),
            review = await latestReview(client, stored.id);
          if (
            stored.rail !== rail ||
            stored.requestId !== input.requestId ||
            stored.requestId !== originalFundingRequestId ||
            !review ||
            review.id !== input.reviewId ||
            review.terms.outcome !== "erroneous_credit" ||
            typeof review.terms.evidenceDigest !== "string"
          )
            fail(
              "correction review does not authorize this original funding",
              403,
            );
          await event(client, {
            report: stored,
            kind: "correction_authorized",
            key: input.idempotencyKey,
            terms: {
              reviewId: review.id,
              originalRequestId: originalFundingRequestId,
              action: input.action,
              rail,
            },
          });
        },
      };
    },
  });
}
