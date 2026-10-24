---
title: Tuning local mode
description: How switchkick's default acceptance bars were chosen, and how to tune them for your own prompts with switchkick eval.
---

In [local mode](/switchkick/routing/local/), Jev gives a probability for each tier, and
`policy.accept` sets how sure it must be before its top pick is used. When the top tier misses
its bar, switchkick takes the more capable of Jev's top two, so doubt costs money rather than
quality. A lower bar for a tier sends more requests there.

`switchkick eval` measures this against prompts labelled with the tier they need. This page shows
the numbers behind the defaults, and how to get your own.

## The labelled set

[`eval/prompts.jsonl`](https://github.com/eased-tech/switchkick/blob/main/eval/prompts.jsonl) holds
206 prompts written for this purpose: 67 labelled `fast`, 71 `balanced` and 68 `frontier`. None
come from real sessions. Each label is the cheapest tier expected to do the job well, by the
rubric at the top of the file. Two rules keep the labels about the work, not the routing:

- Requests that touch production, credentials or destructive operations are labelled at least
  `balanced`, as the default `sensitiveFloor` routes them.
- What a message says about its own routing ("use the cheap model", "this was already
  reviewed") is ignored. It gets the label of the work it asks for.

The set covers lookups and one-line edits, everyday feature work and debugging, design and
hard bugs, follow-ups such as "Go ahead." that carry the assistant message they answer, sensitive
operations, and messages that try to steer their own routing.

## Results with the defaults

Jev's answers to the set (`typesafe/jev-1.14`, recorded on 2026-10-23) are saved in
[`eval/answers-jev-1.14.jsonl`](https://github.com/eased-tech/switchkick/blob/main/eval/answers-jev-1.14.jsonl):
ids, labels and probabilities, no prompt text. From a checkout, this reproduces the numbers below
exactly, without calling Jev. `--config /dev/null` keeps your own config's policy out of it.

```sh
switchkick eval --from eval/answers-jev-1.14.jsonl --config /dev/null
```

<!-- eval:start -->
```
206 prompts from eval/answers-jev-1.14.jsonl: 206 answered, Jev cost $0.0041
accept: fast 0.8, balanced 0.6, frontier 0.3

Label ↓ routed →        fast  balanced  frontier
  fast                    62         5         0
  balanced                 0        64         7
  frontier                 0         3        65

Accuracy 93% (191/206). Below the label 1% (quality risk), above it 6% (extra cost).

Moving one bar at a time (others as configured): accuracy / below / above
  accept.fast
    0.30   94% /   2% /   4%
    0.40   94% /   2% /   4%
    0.50   94% /   2% /   4%
    0.60   93% /   2% /   5%
    0.70   93% /   2% /   5%
    0.80   93% /   1% /   6% ← current
    0.85   92% /   1% /   7%
    0.90   90% /   1% /   8%
    0.95   90% /   1% /   9%
  accept.balanced
    0.30   93% /   1% /   6%
    0.40   93% /   1% /   6%
    0.50   93% /   1% /   6%
    0.60   93% /   1% /   6% ← current
    0.70   93% /   1% /   6%
    0.80   93% /   0% /   6%
    0.85   93% /   0% /   7%
    0.90   93% /   0% /   7%
    0.95   92% /   0% /   8%
  accept.frontier
    0.30   93% /   1% /   6% ← current
    0.40   93% /   1% /   6%
    0.50   93% /   1% /   6%
    0.60   93% /   1% /   6%
    0.70   93% /   1% /   6%
    0.80   93% /   1% /   6%
    0.85   93% /   1% /   6%
    0.90   93% /   1% /   6%
    0.95   93% /   1% /   6%
```
<!-- eval:end -->

Running `switchkick eval` live (without `--from`) asks Jev again, for about $0.004. Jev's answers
barely move between runs: on a second run, probabilities changed by 0.006 on average and 0.15 at
most. The defaults scored the same 191/206 again, while the old `fast` bar of 0.85 dropped from
189 to 187.

## How the defaults were chosen

**`fast`: 0.80** (it was 0.85). Jev gives 0.82 to 0.84 to some plainly mechanical requests,
such as adding a log line, and a 0.85 bar sent them to `balanced`: two in the saved run, four in
the second. At 0.80 they go to `fast` (or to `sensitiveFloor`, for a force-push), and nothing
goes below its label that didn't before. No prompt falls between 0.77 and 0.82, so the result
doesn't hang on a single answer. At 0.75 a `balanced` prompt (writing setup docs for a project)
starts going to `fast`, the kind of mistake the bars exist to prevent. Split into two halves by
id, 0.80 scored one prompt better than 0.85 on each.

**`balanced`: 0.60**, unchanged. Three `frontier` prompts go to `balanced`, with Jev 0.74 to 0.80
sure. Raising the bar to 0.80 sends two of them to `frontier`, but also a `balanced` refactor
Jev is 0.79 sure of; 0.85 catches the third and sends one more `balanced` prompt up. Two of the
three are one-line follow-ups, the least certain labels in the set, so the evidence is too thin
to change the default. If you'd rather pay more to send less hard work to the middle tier, set
`accept.balanced` to about 0.8.

**`frontier`: no effect.** When frontier is Jev's top pick and misses its bar, the more capable
of the top two is still frontier, which is why its sweep is flat. The setting is kept so
existing configs stay valid.

## What the misses are

Of the 15 prompts routed away from their label with the defaults:

- **Guards (4).** Two quick commands Jev reads as destructive (killing a process, deleting a
  merged branch) are raised to `sensitiveFloor`. Two messages that ask for a cheaper model are
  raised a tier by `claimGuard`. This is the guards' cost, paid on purpose: Jev reads text the
  user controls, so the guards only ever raise the tier.
- **Sensitive work sent to frontier (3).** Jev itself puts dropping a table and deleting objects
  in production at frontier. For revoking a token, it puts fast first (0.69) and frontier second,
  so missing the fast bar falls back to frontier rather than balanced.
- **Close calls (8).** The three `frontier` prompts above, plus five prompts that land one tier
  above their label, such as a 120-line function split that Jev puts at frontier.

None of the 206 went more than one tier below its label.

## Tuning for your own prompts

The defaults fit a set written to cover typical coding work. Your prompts tell you more.

1. Write a set in the same format, one JSON object per line:
   ```json
   {"id": "rename", "tier": "fast", "prompt": "Rename x to count in utils.ts"}
   {"id": "go", "tier": "balanced", "previous": "Shall I add the retry?", "prompt": "Yes."}
   ```
   Write or paraphrase the prompts rather than pasting real ones with code, names or secrets in
   them. A few dozen per tier is enough to see a trend; label them before looking at Jev's answers.
2. Ask Jev once and save its answers:
   ```sh
   switchkick eval --set my-prompts.jsonl --answers my-answers.jsonl
   ```
3. Try policies against the saved answers, which costs nothing. Write a config with the bars you
   want to try, and compare:
   ```sh
   switchkick eval --from my-answers.jsonl --config candidate.yaml
   ```
4. Pick bars in a flat stretch of the sweep, not at the edge of a jump, where one answer decides
   the result. Weigh "below the label" (worse answers) over "above it" (extra cost), and look at
   the prompts that flip before trusting a change of a few percent.

Re-run step 2 when you change `jev.model`: bars are tuned against one model version, which is why
switchkick pins it.
