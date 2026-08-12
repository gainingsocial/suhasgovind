# `gs` — the GainingSocial CLI

Publish, validate and inspect from a terminal or a CI pipeline. Built on
[`@gs/sdk`](../sdk-js/README.md), so it inherits the same retry and idempotency behaviour.

```bash
gs auth login --key sk_test_...
gs preflight --profile pro_1 --text "Hello" --destination dst_1
gs post --profile pro_1 --text "Hello" --destination dst_1,dst_2
gs logs pst_...
```

## Signing in

The key is verified before it is stored, so a bad paste fails at `login` rather than on the
next command. It is written to `~/.gainingsocial/config.json` with mode 0600.

`GS_API_KEY` in the environment always wins over the stored key — that is what CI should
use. `gs auth whoami` reports which source it took, because a stale `GS_API_KEY` shadowing
the file is the usual explanation for "why is it publishing to the wrong account".

```bash
gs auth whoami
# Project      prj_...
# Environment  test
# Scopes       posts:write, profiles:read
# Key from GS_API_KEY
```

The environment line is coloured: `live` is red. Publishing to a real audience when you
meant to test is not recoverable, so it is worth the second's glance.

## Preflight is the point

`gs preflight` takes the same input as `gs post`, performs no side effects, and exits
non-zero when the content cannot publish. That makes it usable as a CI gate.

```bash
gs preflight --file post.json || exit 1
```

Human output names the destination, the code and the machine-readable next step:

```
ok       linkedin  dst_abc
blocked  x         dst_def
      TEXT_TOO_LONG Text is 402 characters; this destination allows 280.
      → shorten_text
```

`gs post` runs preflight first by default. Publishing is the one irreversible act here, so
skipping the check is the deliberate flag (`--skip-preflight`), not the default.

## Composing

Two ways, and the file form is the one to use for anything with per-destination overrides:

```bash
# Inline, for the simple case.
gs post --profile pro_1 --text "Shipping today." --destination dst_1,dst_2

# From a file, or from stdin with `-`.
gs post --file post.json
cat post.json | gs post --file -
```

Nothing is published when the command returns. It reports a queued post and tells you how
to watch it:

```
Queued pst_...  queued
Publishing happens in the background. Watch it with: gs logs pst_...
```

## Inspecting what happened

`gs logs <post_id>` is the first thing to reach for when a post did not land. It shows every
state change and provider attempt in order — which network, on which try, after how long,
and with what error.

```bash
gs post get pst_...      # each target, its status, attempt count and URL
gs post list --status failed
gs post retry pst_... ptg_...   # retry one target rather than the whole post
```

## Scripting

`--json` prints the raw API response, unreformatted, so field names match the documentation
exactly.

```bash
gs post list --status failed --json | jq -r '.data[].id'
```

Three exit codes, so a pipeline can tell them apart:

| Code | Meaning |
| --- | --- |
| 0 | Succeeded. For `preflight`, the content is publishable. |
| 1 | The operation failed, or preflight found a blocking problem. |
| 2 | The command was invoked wrongly — unknown command, missing flag. |

Human output goes to stdout and diagnostics to stderr, so `gs post list --json > out.json`
produces a clean file even when a warning is printed. Colour is disabled automatically when
stdout is not a terminal, and by `NO_COLOR`.

## Capabilities

Ask what a network or a specific connected account can do, rather than guessing:

```bash
gs platforms list
gs platforms capabilities tiktok     # generic — what the platform can do
gs platforms capabilities dst_...    # effective — what THIS account can do
```

The effective form is the one that matters before publishing. It is narrowed by granted
scopes, account type and platform approval state, and every capability that is off explains
why.

## Environment

| Variable | Effect |
| --- | --- |
| `GS_API_KEY` | Takes precedence over the stored key. |
| `GS_BASE_URL` | Point at a different deployment. Honoured by every command, including `auth login`. |
| `NO_COLOR` | Disable colour. |
