# Smart Media Auto-Fit

Plan §63E, and the concrete expression of two product principles:

- **P16** — users should not have to memorize platform specifications
- **P17** — auto-fix before asking the user to fix

Preflight answers one question per media item per destination: *can this be published as it
is, and if not, what would we have to do to it — and are we allowed to do that without
asking?*

## The rule everything else follows from

> Never silently make an editorial change.

Technical transcoding that preserves the content may be automatic. Removing content,
changing words, inserting generated pixels, altering playback speed or muting audio may
not — not even when it would make the post succeed.

A post that publishes with the subject cropped out is worse than a post that does not
publish. The first is a mistake the customer has to discover, apologise for and delete; the
second is a question they answer in five seconds.

## Decision classes

| Decision                 | Meaning                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `PASS`                   | Already compliant. Publish the bytes untouched.               |
| `SAFE_AUTOFIX`           | Cannot change what the media is *of*. Applied automatically.  |
| `REVIEW_AUTOFIX`         | We can do it; a reasonable person might object. Offered.      |
| `USER_DECISION_REQUIRED` | Several valid answers exist; only the author can choose.      |
| `UNSUPPORTED`            | No transform makes this publishable here.                     |

A plan's decision is the worst of its parts.

### Where the line sits

| Situation                              | Decision                 | Why                                                        |
| -------------------------------------- | ------------------------ | ---------------------------------------------------------- |
| HEIC on a JPEG-only platform            | `SAFE_AUTOFIX`           | Every pixel survives a container change                     |
| 20 MB file, 8 MB limit                  | `SAFE_AUTOFIX`           | Fidelity changes; content does not                          |
| 1080×1000 → 1:1 (7% loss)               | `SAFE_AUTOFIX`           | Nobody would notice                                         |
| 1920×1080 → 1:1 (44% loss)              | `REVIEW_AUTOFIX`         | Decides what the picture is *of*                            |
| 3-minute video, 60-second limit         | `USER_DECISION_REQUIRED` | The point of a clip is often at the end                     |
| 6 photos, 1-item platform               | `USER_DECISION_REQUIRED` | Which ones is the author's call                             |
| 1-second video, 3-second minimum        | `UNSUPPORTED`            | Padding with black frames is inventing content              |
| A format nothing can decode             | `UNSUPPORTED`            | Promising a conversion we cannot perform is worse than "no" |

The crop threshold is 12% of frame area — roughly the difference between 16:9 and 3:2, a
gap a photographer would not notice. Past it, a crop starts choosing which people at the
edge of a group photo get published.

Asking about a 2% crop would be worse than not asking. Train people to click through
confirmations and they will click through the one that mattered.

## Ordering

Format → duration → aspect ratio → file size.

Size is last because a crop and a format change already shrink the file. Planning
compression first would over-compress, and quality lost to a redundant pass does not come
back.

## Aspect-ratio matching has a tolerance

1% relative, and it earns its keep: 1080×1349 is Instagram's own documented 4:5 portrait,
but 1080/1349 is 0.8006, not 0.8. A strict equality check would "fix" the platform's own
recommended dimensions.

1% is also far narrower than the gap between any two ratios a platform offers — 4:5 and 1:1
differ by 25% — so it cannot mistake one for another.

The nearest supported ratio is chosen by *relative* distance. An absolute comparison is
dominated by the wide end of the range: 16:9 (1.78) and 9:16 (0.5625) sit 1.22 apart while
4:5 (0.8) and 1:1 sit 0.2 apart, so a portrait image would be judged closer to square than
a landscape one is to 16:9 — and would be cropped while the landscape was left alone.

Crops are always centred and **never scale up**. Upscaling to reach a ratio is a mild form
of inventing pixels.

## Effective, not generic

Plans are built from the destination's **cached effective capability** (plan §17), falling
back to the adapter's generic capability only when none has been resolved.

The difference is load-bearing. An unaudited TikTok client and a Business Instagram account
accept different things, and planning against the generic document would promise a fix the
destination then rejects.

Neither path makes a network call — generic capability is code, effective capability was
cached at connect time — because plan §18 forbids preflight from making one.

## Variant caching

Every plan carries a `variantKey` covering the source media and the transform parameters,
and **nothing about the destination**.

That is the point: Instagram and Facebook both wanting a 1:1 JPEG under 5 MB get one
transcode between them. Keying by destination would transcode the same file twice and cache
two identical results (plan §33).

Parameters are serialized with sorted keys, so two identical parameter objects cannot
produce two keys.

## What preflight reports

```jsonc
"media_fit": {
  "decision": "REVIEW_AUTOFIX",
  "items": [
    {
      "media_id": "med_...",
      "decision": "REVIEW_AUTOFIX",
      "transforms": [
        {
          "kind": "crop",
          "decision": "REVIEW_AUTOFIX",
          "reason": "This platform needs 1:1. A centred crop would lose 44% of the frame — review it, or supply a focal point.",
          "parameters": { "targetRatio": "1:1", "crop": { … }, "lossFraction": 0.4375, "alternative": "pad" }
        }
      ],
      "blocked_reason": null
    }
  ],
  "findings": []
}
```

Only `UNSUPPORTED` fails preflight. Everything else is publishable — automatically, or after
somebody chooses — and failing on those would make preflight refuse the posts this feature
exists to rescue. A crop awaiting review surfaces as a **warning**, so a caller happy with
the default is not blocked.

Warnings are named by the transform that needs consent, not by a generic code. An agent
reading `MEDIA_RATIO_UNSUPPORTED` knows to supply a focal point;
`MEDIA_DURATION_UNSUPPORTED` tells it to pick a segment. One shared code would flatten two
different actions into a shrug.

## The planner plans; it does not transform

`@gs/domain/media` is pure. It never fetches, decodes or writes bytes.

Deciding what a platform requires is *knowledge*, and knowledge belongs where it can be
unit-tested exhaustively against every documented limit — not inside a transcoding service
where each assertion costs a subprocess. The media service (plan §32) executes these plans;
it does not re-derive them.

`DECODABLE_SOURCE_TYPES` is the honest boundary between the two: an allow-list of what the
pipeline can actually open. A format absent from it is refused with an instruction, because
promising a conversion and discovering at transcode time that nothing can read the file
reports the problem after the author has been told the post is fine (Rule 14).

## Related

- Plan §63E, §33, §32, §17, §18
- [ADR-008 — unified plus native](../adr/ADR-008-unified-plus-native.md)
