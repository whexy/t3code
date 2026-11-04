---
name: verify-thread-usage
description: Check that a thread's Session usage row still counts every token once, charges it to the right model, prices it correctly, and shows the right lines. Use when changing apps/server/src/usage/threadUsage.ts, apps/web/src/components/chat/threadUsageLines.ts, the ThreadUsage or TurnTokenUsage contracts, a provider's turn usage normalizer (ClaudeTurnTokenUsage, CodexTurnTokenUsage), or usage pricing, aliases and overrides.
---

# Verify thread usage

The Session usage row in thread details adds up a thread's provider turns per model and prices them. Two pure functions decide everything the row says:

- `summarizeThreadUsage` in `apps/server/src/usage/threadUsage.ts` turns a thread's provider turns into one row per model with tokens, cost and an incomplete-turn count.
- `threadUsageView` in `apps/web/src/components/chat/threadUsageLines.ts` decides whether the row is hidden, shown as one line, or shown as model lines plus a total.

A thread can switch harness mid-way (Claude, then Codex), turns can be partial or unreported, Claude reports subagent and compaction work only as a lump on the root turn, and models can be aliased, overridden or unpriced. Example-based tests cover a few of those combinations. This check runs the real functions on every combination up to a bound.

## Run it

From the repo root (add the repo's tools to PATH if `vp` is missing):

```sh
export PATH=$PWD/node_modules/.bin:$PATH
(cd apps/server && vp test run src/usage/threadUsage.verify.test.ts) && (cd apps/web && vp test run --project unit src/components/chat/threadUsageLines.verify.test.ts)
```

It takes about 4 seconds. Both must pass.

## What it proves

Server, `apps/server/src/usage/threadUsage.verify.test.ts`. Every sequence of 0 to 5 turns drawn from 14 turn kinds (579,195 sequences), and every reordering of every sequence of up to 4 turns. The turn kinds cover complete, partial and unavailable turns; no model, a Claude model, a Codex model, an aliased model, an unpriced model, two unpriced models with identical counts, and two models in one turn; subagent and compaction usage, including an empty one; a local command turn; input below cache reads plus writes; absent counters; whitespace around a model id; and a turn with no usage at all. Prices come from a fixed rate table built with the real `parseRateTable`, plus a price override and an alias. An oracle written in the test, sharing no code with `threadUsage.ts`, states the expected answer.

- **Conservation.** Every row holds exactly its turns' uncached input, cache reads, cache writes, output, reasoning and subagent tokens, and the total is their sum. Harm prevented: billing cache tokens twice, or dropping subagent and compaction spend.
- **Attribution.** Each turn lands in the row of its one reported model after aliasing; a turn with no model or several models lands in the unknown-model row. A Claude-then-Codex thread keeps both rows. Harm prevented: one harness's spend shown under another's name, or a switched-harness thread losing half its usage.
- **Cost.** Each priced row costs its tokens at its model's rates, with subagent and compaction tokens at the uncached input and output rates and custom price overrides taking precedence. Unpriced and unknown rows cost 0 and say they are unpriced. The thread cost is the sum of rows. Harm prevented: a wrong dollar figure that looks exact.
- **Status.** The result is empty (the row hides) exactly when no turn reported a token, and the incomplete-turn count equals the turns whose usage is partial or unavailable. Local command turns contribute only their subagent and compaction tokens. Harm prevented: an empty row on threads with no data, or a total that hides that turns were missing.
- **Order.** Rows come out in the same order for every ordering of the turns: by cost, then tokens, then model id, with the unknown-model row last. Harm prevented: rows jumping around between refreshes.

Web, `apps/web/src/components/chat/threadUsageLines.verify.test.ts`. Every ordered selection of 0 to 5 rows from five row kinds (priced, unpriced, unknown model, with subagent usage), each with two incomplete counts and two pricing states, against both a server that supports the row and one that does not (2,610 inputs).

- **Hidden.** No row on a server without the `threadUsage` capability, before data arrives, or when there are no model rows. Harm prevented: an empty or misleading row on older hosts.
- **One model, one line.** A thread that used a single model shows exactly one line that carries the thread totals; no separate total line. This is the maintainers' explicit content rule.
- **Several models, lines plus total.** Each model gets its own line in server order, followed by exactly one total line equal to the sums. The total says it is priced only when every model is priced. Harm prevented: a total that disagrees with its lines, or a complete-looking cost that leaves out unpriced models.

## What it does not cover

- How providers fill `turnTokenUsage`: `normalizeClaudeTurnTokenUsage` (`apps/server/src/provider/ClaudeTurnTokenUsage.ts`) and the Codex path (`apps/server/src/provider/CodexTurnTokenUsage.ts`). The check assumes their contract: input includes cache reads and writes; Claude subagent turns carry no usage of their own and their work arrives in the root turn's `otherUsage`; Codex leaves `otherUsage` empty. If a normalizer changes that, this check still passes and the row can double count. Re-read the normalizer when you touch it.
- Which turns reach the function. Fork exclusion and harness switching depend on the projection query reading provider turns by the thread's own `thread_id` (`ProjectionStoreV2.getThreadRecords`); that query is not checked here.
- Speed tiers. Fast, priority and ultrafast turns are priced at the standard rate, because `turnTokenUsage` does not record speed.
- Rendering, the request path (`UsageService.readThreadUsage`, `server.getThreadUsage` in `ws.ts`), refreshing, and the rate table download.
- Sequences longer than 5 turns and reorderings beyond 4 turns. Every property is a per-turn sum or a sort, so longer threads exercise no new branch, but that argument is not machine-checked.

## When it fails

The failure names the property, the observed and expected values, and the turn sequence in plain words, for example `attribution: rows ["opus-internal"], expected ["claude-opus-5-5"]` with `turns: aliased model with subagent usage`.

- If the product change was not meant to change that behavior, it is a real bug. Fix the product code, not the check.
- If the change is intended (for example, a decision to bill local command turns, or to put the unknown-model row first), update the oracle in the test so it states the new rule, update the property sentence in this skill, and get the maintainer to agree to the new rule.
- If the failure comes from the test's own setup (a rate constant in `RATES` that no longer matches the rate document it mirrors, or a new contract field the turn kinds do not set), it is a modelling error. Fix the test, then rerun every mutation below to prove the check can still fail.
- Never loosen a comparison or delete a turn kind to make a failure go away.

When you add a field to `TurnTokenUsage` or `ThreadUsage`, add a turn kind or row kind that exercises it, and extend the oracle.

## Proving the check can still fail

Mutations confirmed caught at the sync commit, each a one-line break of the real product file: cache tokens left inside uncached input; subagent tokens dropped from the total; local command counters counted; aliases ignored; a two-model turn charged to its first model; subagent tokens left unpriced; price overrides ignored; unavailable turns not counted as incomplete; an empty result instead of hiding; zero-token turns creating rows; no model-id tiebreak (also caught by the reordering test alone); the unknown-model row not forced last; showing the row on a server without the capability; showing it with no rows; a total line for a single model; a total priced when only some rows are; and total tokens taken from one line. After changing the oracle or turn kinds, break the product code one of these ways by hand, confirm the check fails, and undo it.

## Coverage record

| Check                                                          | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/usage/threadUsage.verify.test.ts`             | `apps/server/src/usage/threadUsage.ts`: `summarizeThreadUsage`, `turnModel`, `turnTotals`, `addTotals`, `addOther`, `otherTokens`, `rowTokens`, `priceRow`; through them `priceUsage` and `createOverrideRateTable` in `apps/server/src/usage/usagePricing.ts`; the `ThreadUsage`, `ThreadModelUsage` and `ThreadOtherUsage` shapes in `packages/contracts/src/usage.ts`; the `TurnTokenUsage` shape in `packages/contracts/src/providerRuntime.ts` |
| `apps/web/src/components/chat/threadUsageLines.verify.test.ts` | `apps/web/src/components/chat/threadUsageLines.ts`: `threadUsageView`, `modelLine`, `modelTokens`                                                                                                                                                                                                                                                                                                                                                   |

Sync commit: the commit that added this skill, confirmed on 2026-11-04. Rebase merges rewrite hashes, so find it by history rather than by a pinned hash:

```sh
SYNC=$(git log --diff-filter=A --format=%H -1 -- .agents/skills/verify-thread-usage/SKILL.md)
```

To see whether the check needs another look, diff the covered files against the sync commit:

```sh
git diff "$SYNC" -- apps/server/src/usage/threadUsage.ts apps/server/src/usage/usagePricing.ts apps/web/src/components/chat/threadUsageLines.ts packages/contracts/src/usage.ts packages/contracts/src/providerRuntime.ts
```

Move the sync commit forward only after you have read those changes, confirmed that the turn kinds, the oracle and the property sentences still describe the code at the new commit, and run the check green. To move it, replace this section's lookup with the full hash of that commit as it exists on `self-hosted-nightly`.
