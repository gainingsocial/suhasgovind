import { FanOutDiagram } from '@/components/diagrams';
import { FeaturePage } from '@/components/feature-page';
import { pageSeo } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'Publish to multiple social networks with one API call',
  description:
    'How cross-platform publishing works: one post, many destinations, each validated against ' +
    'its own rules before anything goes live. Per-destination overrides, media handling and ' +
    'partial success explained.',
  path: '/features/publishing',
});

export default function PublishingPage() {
  return (
    <FeaturePage
      breadcrumb={{ name: 'Publishing', path: '/features/publishing' }}
      heading="Publish to multiple social networks with one API call"
      lead="One post, many destinations. Each network receives a version it will accept, and each reports its own outcome rather than hiding behind a single verdict."
      diagram={<FanOutDiagram />}
      body={[
        {
          heading: 'One logical post, many publish targets',
          paragraphs: [
            'A post is not the same thing as a tweet or a LinkedIn update. It is what you intend to say, plus the list of places you intend to say it. Each of those places becomes a separate publish target with its own lifecycle — its own status, its own retry schedule, its own error if something goes wrong.',
            'This matters because networks fail independently. A post that reached Bluesky and LinkedIn but was rejected by Instagram for an image aspect ratio is not a failed post, and it is not a successful one either. It is partly published, and the API says exactly that, with the Instagram target carrying the specific reason.',
            'Collapsing that into one status is the most common design mistake in this category. It makes the most important question — which destinations actually worked — unanswerable without going and looking at each network by hand.',
          ],
        },
        {
          heading: 'Per-destination overrides',
          paragraphs: [
            'The same words rarely suit every audience. You can override the text, the media or the link for any single destination while leaving the rest untouched, so a LinkedIn version can be more formal than the Bluesky one without composing the post twice.',
            'Overrides replace rather than merge. An override of an empty media list means "publish this one without images" — which is what you asked for, and what a merging implementation would quietly ignore.',
          ],
        },
        {
          heading: 'Native options where a network offers something unique',
          paragraphs: [
            'A unified API that only exposes the lowest common denominator forces you back to raw platform calls the moment you need something specific. Every adapter therefore accepts a namespaced options object for platform-native features, validated by the adapter that owns that platform.',
            'The unified surface covers the common case; the escape hatch covers the rest. Neither one leaks platform-specific behaviour into the core.',
          ],
        },
        {
          heading: 'Media that is checked before it is sent',
          paragraphs: [
            'Uploads go straight to storage rather than through the API, so a large video never has to fit inside a request. Once uploaded, the file is inspected — real dimensions, real duration, real format — and only the inspected values are used for validation.',
            'That distinction matters. Validating against what a client claimed about a file, rather than what the file actually is, approves posts the platform then rejects.',
          ],
        },
      ]}
      steps={[
        {
          name: 'Upload any media',
          text: 'Request an upload URL, send the file directly to storage, then confirm. The file is inspected automatically and becomes available once its real dimensions and format are known.',
        },
        {
          name: 'Check the post with preflight',
          text: 'Send the exact post you intend to publish. Each destination is validated against its own rules and returns a verdict, the field at fault, and a suggested fix. Nothing is published.',
        },
        {
          name: 'Publish',
          text: 'One call with an idempotency key. The API accepts the post and returns immediately — reliable delivery never depends on your process staying alive.',
        },
        {
          name: 'Watch each destination',
          text: 'Poll the post or subscribe to a webhook. Every destination reports independently as it succeeds, retries or fails.',
        },
      ]}
      faqs={[
        {
          question: 'Can I post different text to each social network?',
          answer:
            'Yes. Set the shared text once, then override it for any individual destination. Overrides replace the canonical value rather than merging with it, so an empty override genuinely means empty.',
        },
        {
          question: 'What happens if one network rejects my post?',
          answer:
            'The other destinations still publish. The post is marked partly published, and the failing destination carries a specific error explaining what to change. Nothing is rolled back — a post that reached three audiences should stay reached.',
        },
        {
          question: 'How do I attach images or video?',
          answer:
            'Request an upload URL, send the file directly to storage, then confirm the upload. The file is inspected for its real dimensions, duration and format, and those inspected values are what validation uses.',
        },
        {
          question: 'Does the API wait until the post is live?',
          answer:
            'No. It accepts the post and returns straight away with a status you can watch. Making reliable publication depend on an open HTTP connection means a network hiccup on your side can lose a post entirely.',
        },
        {
          question: 'Can I use platform-specific features?',
          answer:
            'Yes, through a namespaced options object per platform. The unified fields cover what every network has in common, and the native options cover anything a specific platform offers beyond that.',
        },
      ]}
      related={[
        { href: '/features/reliability', label: 'How duplicate posts are prevented' },
        { href: '/features/scheduling', label: 'Scheduling posts for later' },
        { href: '/platforms', label: 'Which networks are supported' },
      ]}
    />
  );
}
