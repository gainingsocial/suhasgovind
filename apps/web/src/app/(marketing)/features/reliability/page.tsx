import { EffectiveOnceDiagram } from '@/components/diagrams';
import { FeaturePage } from '@/components/feature-page';
import { pageSeo } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'How duplicate social media posts are prevented',
  description:
    'Duplicate posts happen when a network accepts a post but the confirmation is lost. Four ' +
    'layers of protection — idempotency keys, execution locks, content fingerprints and ' +
    'reconciliation before retry — explained in detail.',
  path: '/features/reliability',
});

export default function ReliabilityPage() {
  return (
    <FeaturePage
      breadcrumb={{ name: 'Reliability', path: '/features/reliability' }}
      heading="How duplicate social media posts are prevented"
      lead="A duplicate post cannot be undone. It is visible to your audience the moment it happens, and deleting it does not un-see it — which is why preventing one is worth four independent layers rather than a single retry counter."
      diagram={<EffectiveOnceDiagram />}
      body={[
        {
          heading: 'Why duplicate posts happen at all',
          paragraphs: [
            'Almost every duplicate comes from the same place: a request that timed out. Your system asked a social network to publish something, and no answer came back. The network may have published it and lost the reply, or it may never have received the request at all. From the outside those two situations look identical.',
            'A publishing system that retries on timeout will duplicate the post whenever the first case was true. A system that does not retry will silently lose the post whenever the second was. Neither default is acceptable, which is why guessing is the wrong approach entirely.',
            'Nobody can promise mathematically perfect exactly-once delivery across third-party APIs that do not themselves guarantee it. What can be promised is effectively-once publishing: prevention where possible, and verification instead of guessing where prevention is not.',
          ],
        },
        {
          heading: 'Layer one — idempotency keys',
          paragraphs: [
            'Every publish request carries a key you choose. If the same key arrives twice, the second request returns the original response rather than creating a second post. This covers the most common case by far: your own code retrying after a network blip, a queue redelivering a job, or a user double-clicking a button.',
            'The key is required rather than optional. A duplicate published post cannot be undone, so the API insists on being given something to deduplicate on rather than hoping the caller thought of it.',
          ],
        },
        {
          heading: 'Layer two — one publisher at a time, per destination',
          paragraphs: [
            'Behind the API, publishing runs on a queue, and queues deliver at least once by design. That means the same job can legitimately arrive twice. Receiving a job therefore does not grant the right to publish — winning an exclusive lock on that specific destination does.',
            'A second copy of the job finds the lock taken, does nothing, and exits. If the process holding a lock dies, the lock expires on its own and another picks the work up, so a crash never wedges a post permanently.',
          ],
        },
        {
          heading: 'Layer three — content fingerprints',
          paragraphs: [
            'Identical content sent to the same destination at roughly the same time is almost always a mistake rather than an intention. Each target carries a fingerprint of its resolved content, so an accidental repeat is caught before it reaches the platform.',
            'This is advisory, not a prohibition. Customers legitimately repost — a daily opening announcement is not a bug — so the check is time-bucketed and can be turned off explicitly per post.',
          ],
        },
        {
          heading: 'Layer four — check before retrying',
          paragraphs: [
            'When an outcome is genuinely ambiguous, the post is marked as unknown rather than failed, and no retry happens. Instead the system goes and looks at the connected account for the post it may have just created.',
            'If the post is there, it is adopted: the record is corrected and nothing is published again. If it is provably absent, retrying is safe and happens automatically. If neither can be established — because the platform only exposes a limited window of recent posts, for instance — it is held for a human rather than guessed at.',
            'Failing closed on uncertainty is deliberate. A person can always publish something deliberately; nobody can un-publish a duplicate.',
          ],
        },
      ]}
      steps={[
        {
          name: 'The request carries a key',
          text: 'A repeat with the same key returns the original result instead of publishing again.',
        },
        {
          name: 'The destination is locked',
          text: 'Only one worker may publish to a given destination at a time. A duplicated job finds the lock taken and exits without publishing.',
        },
        {
          name: 'The content is fingerprinted',
          text: 'An accidental repeat of identical content to the same place within a short window is caught before it reaches the platform.',
        },
        {
          name: 'An ambiguous outcome is verified, not retried',
          text: 'If a timeout leaves the result unknown, the account is checked for the post before anything else happens. Only a proven absence leads to a retry.',
        },
      ]}
      faqs={[
        {
          question: 'What is effectively-once publishing?',
          answer:
            'It is the honest version of exactly-once. Nobody can guarantee perfect exactly-once delivery across third-party APIs that do not offer it themselves. Effectively-once means duplicates are prevented where prevention is possible, and verified against the platform where it is not — rather than guessed at.',
        },
        {
          question: 'What happens if the social network times out?',
          answer:
            'The post is marked as having an unknown outcome and is not retried. The system then searches the connected account for the post. If it exists, that post is adopted. If it provably does not, the post is retried. If neither can be established, it waits for a human rather than risking a duplicate.',
        },
        {
          question: 'Can I deliberately post the same thing twice?',
          answer:
            'Yes. The duplicate-content check is advisory and can be disabled per post. It exists to catch accidents, not to stop a business from posting the same daily announcement every morning.',
        },
        {
          question: 'What if my own code retries a request?',
          answer:
            'Nothing is duplicated. Every publish request carries an idempotency key, and a repeat with the same key returns the original response rather than creating a second post.',
        },
        {
          question: 'What happens if a server crashes mid-publish?',
          answer:
            'The exclusive lock on that destination expires by itself, and a background check picks the work back up. The retry goes through the same verification path, so a post that actually made it through before the crash is found rather than duplicated.',
        },
      ]}
      related={[
        { href: '/features/publishing', label: 'How publishing works' },
        { href: '/features/scheduling', label: 'Scheduling posts for later' },
      ]}
    />
  );
}
