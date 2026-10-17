# 0007 — A4 adjusted FTM with Yap Coins

Accepted for implementation by the founder's October 15, 2026 execution prompt.
The source is `/Users/felixboucher/Downloads/yaparena_a4_codex_implementation_prompt.md`;
its provenance is the October 14 median-FTM prompt and subsequent simulator discussion.
No executable external simulator was available for parity verification.

A4 uses one account endorsement, one binding YES-scale limit and an integer quantity per
round; unweighted side medians determine a shared random offer distribution. Every accepting
order executes in full if an accepting opposite side exists. All locked endorsements,
including nonexecution, determine the round's unweighted settlement share. The center is
the counterparty and explicitly funds its exposure. See [exact rules](../a4-mechanism.md).

For A4, this supersedes the PRD's historical money-weighted baseline/movement, paired issuance,
order matching, clipped curve and draw refunds. A 50% share is ordinary settlement. It does
not select an event winner, rankings or sponsor rewards, and does not implement an ongoing
market. Unrelated product decisions and all real-fund release gates remain in force.

Yap Coins cannot be bought, redeemed, withdrawn or converted. Bot identities are synthetic,
disclosed, isolated from human adoption metrics, and never represented as wallet accounts.
Future fiat/crypto adapters require separately reviewed implementations and activation.

Conditional honesty arguments assume homogeneous signals, nonpivotal influence, risk neutrality,
fixed quantity, no fees, adequate funding and no collusion. They establish no general honesty,
uniqueness, Sybil/coalition resistance or repeated-game equilibrium claim. Exploration does
not establish a theorem; finite deviations must recompute medians and settlement.
