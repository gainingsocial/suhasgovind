# Social memory

**The decision this explains:** when the system is allowed to claim it has learned
something.

Plan Phase 10 asks for the loop to close — plan, generate, preflight, publish, observe,
normalize, evaluate, update memory, recommend. Every step before *evaluate* already
existed. This document is about the two that did not, and specifically about the one design
question they raise, which is not technical.

---

## The temptation

Analytics are already collected and normalized. Joining them to `post_type` and
`published_at` is half a day's work, and the result is a page that says *video works better
for you* and *Tuesdays are your best day*. It demos well. Every competitor has one.

It is also, for most customers most of the time, false. A profile with eleven published
posts has maybe three videos. Two did well. The page now says video outperforms by 2.4×,
with the confidence of a measurement and the evidential weight of a coin landing heads
twice.

The failure is not that the number is wrong — it is computed correctly. The failure is that
nothing in the presentation distinguishes it from the same number computed over four hundred
posts, so a customer cannot tell which one to act on. A product that cannot make that
distinction is worse than one that says nothing, because acting on noise costs real
attention and real posts.

---

## Three rules, and what each one prevents

### 1. Nothing below five samples is emitted

Not greyed out, not flagged low-confidence, not returned with a caveat: absent.

`MIN_SAMPLE_SIZE` is a floor rather than a statistical claim. Five is not enough for
significance and does not pretend to be — it is the point below which the number is so
obviously noise that showing it at all is a kind of lying. Above it, the sample size travels
with every observation and every recommendation, in the API response and in the sentence
itself: *"over 42 posts"*.

**Prevents:** a brand-new customer being told, authoritatively, what works for them.

### 2. Nothing is compared across networks

The baseline for a LinkedIn observation is that profile's own LinkedIn mean. Not a global
mean, not an industry figure, not a pooled average across every network they publish to.

A video on TikTok and a video on LinkedIn share a word. Their engagement rates differ by
more than an order of magnitude for reasons that have nothing to do with the content, so a
pooled baseline makes every TikTok observation look spectacular and every LinkedIn one look
broken.

**Prevents:** advice that is really a statement about which platforms have higher baseline
engagement, dressed up as a statement about the customer's content.

### 3. Rates and counts are never mixed

Engagement rate — engagements over impressions — is the better measure, because it separates
*this post was good* from *this post was shown to more people*. It needs impressions on
every sample in the group.

Several providers do not report impressions for every post. Where one is missing, the whole
group falls back to raw engagement counts and records `metric: "engagements"` so the reader
knows. The alternative — averaging a rate against a count — produces a number that describes
neither.

**Prevents:** a mean of 0.04 and 12,000 being presented as though it means something.

---

## Why confidence is not a p-value

`confidence` is derived from sample size alone: low under 10, medium under 30, high above.

A significance test would look more rigorous and be less honest. Engagement is not normally
distributed; one post that got picked up dominates any sample small enough for a customer
to have. A p-value computed on this data lends a precision the data does not have, and the
precision is what people act on.

Sample size is a claim that can be defended. It is the only one made, and it is reported
next to the number rather than in place of it.

---

## Why learning is explicit

`POST /v1/memory/learn` is called, not triggered.

Recomputing scans a profile's published posts and their latest analytics snapshot. That does
not belong in the path of a request somebody is waiting on (Rule 10), and it should not be a
cost that arrives by surprise. A cron can call it nightly; a customer with ten thousand
posts can call it weekly. Both are the customer's decision to make.

It is safe to run twice, because the result is a function of the data and the write replaces
rather than appends.

### Delete-then-insert, not upsert

A bucket that no longer clears the minimum sample size — because posts aged out of the
window — has to *disappear*. An upsert would leave the last computed row in place
indefinitely, quietly stale, describing a window that no longer exists.

### Posts under 48 hours old do not count

Most networks are still delivering a post a day in, and several report impressions on a lag
of their own — `provider_data_as_of` exists precisely because the numbers we hold trail
reality.

Counting a post published this morning drags every recent bucket down, and produces the
confident, wrong conclusion that whatever the customer just started doing is not working.

---

## What is deliberately missing

Plan Phase 10 lists topic performance, hook performance and negative-response patterns.
None are implemented.

All three need an extraction step, which needs a model provider, which is not configured
(see [operations](../OPERATIONS.md)). The alternative — inferring a topic from keyword
matching, or sentiment from a word list — would be a guess presented as a measurement, which
is the one thing this whole document is about not doing (Rule 14).

They are absent rather than approximated. When a model provider exists they become
additional dimensions in `computeObservations`, and nothing above that function changes.

---

## The two kinds of memory

| | Brand memory | Performance memory |
| --- | --- | --- |
| Origin | Asserted by the customer | Derived from analytics |
| Edited | Yes, directly | Never — rebuilt |
| Survives a recompute | Yes | No, by design |
| Deleted | Hard delete | Replaced wholesale |

They are separate tables and separate endpoints because they answer to different authorities.
A brand that has said it will not claim *the fastest* does not get overruled because a post
making that claim performed well. Performance memory observes; brand memory instructs. Where
they disagree, brand memory wins, and it wins as a check on generated drafts rather than as
an instruction in a prompt — a prompt is a request, a check is a guarantee.

Brand memory is a hard delete for the same reason. Somebody telling us to forget a
competitor means it, and a soft-deleted row that a generation step could still read would
make the instruction a suggestion.
