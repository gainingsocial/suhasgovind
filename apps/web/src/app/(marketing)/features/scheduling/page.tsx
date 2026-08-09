import { SchedulingDiagram } from '@/components/diagrams';
import { FeaturePage } from '@/components/feature-page';
import { pageSeo } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'Schedule social media posts through an API',
  description:
    'How scheduled publishing works, why timezones are the usual source of bugs, and the ' +
    'background safety net that stops a scheduled post silently never going out.',
  path: '/features/scheduling',
});

export default function SchedulingPage() {
  return (
    <FeaturePage
      breadcrumb={{ name: 'Scheduling', path: '/features/scheduling' }}
      heading="Schedule social media posts through an API"
      lead="Send a publish time and the post goes out then. The interesting part is not the scheduling — it is what happens when something in the chain fails, because that failure is silent by nature."
      diagram={<SchedulingDiagram />}
      body={[
        {
          heading: 'The failure nobody notices',
          paragraphs: [
            'Scheduling is easy to build and easy to get subtly wrong. A post is stored with a future time, a delayed job is created, and everything looks correct. Then the job is lost — a platform incident, a deployment at the wrong moment, a queue that caps how far ahead a message may be delayed — and the post simply never publishes.',
            'There is no error. Nothing goes red. The post sits in the database looking scheduled forever, and the first anyone knows is a customer asking why their announcement never appeared. That is the worst failure a publishing product can have, because it is invisible until it is embarrassing.',
            'A background check runs every minute looking for anything overdue and picks it back up. That is not an optimisation — it is the thing that makes the word "scheduled" mean anything at all.',
          ],
        },
        {
          heading: 'Timezones are stored in one form and shown in another',
          paragraphs: [
            'Every timestamp is stored and transmitted in UTC. Every timestamp shown to a person is rendered in their own timezone. Mixing those two is the single most common source of "it published at the wrong time" bugs.',
            'Each profile also carries its own timezone, so an agency scheduling for clients in different countries schedules in each client’s local time rather than doing arithmetic in their head.',
          ],
        },
        {
          heading: 'Validation happens twice',
          paragraphs: [
            'A post scheduled for next month is validated when you create it and again shortly before it publishes. Both checks are necessary. The first catches problems while you are still watching; the second catches everything that changed in the weeks since.',
            'Connections expire. Access gets revoked. A destination is deleted. A post that was perfectly valid when scheduled can be unpublishable by the time its moment arrives, and finding that out at publish time is what lets the system tell you rather than fail quietly.',
          ],
        },
      ]}
      steps={[
        {
          name: 'Send a publish time',
          text: 'Include a future timestamp with the post. It is accepted immediately and marked scheduled rather than queued.',
        },
        {
          name: 'It waits, and is watched',
          text: 'A background check runs every minute looking for anything whose time has come, including work that would otherwise have been lost.',
        },
        {
          name: 'It is revalidated',
          text: 'Connection health and content are checked again before publishing, because weeks may have passed since the post was created.',
        },
        {
          name: 'It publishes',
          text: 'Each destination publishes independently and reports its own outcome, exactly as an immediate post does.',
        },
      ]}
      faqs={[
        {
          question: 'How far in advance can I schedule a post?',
          answer:
            'Up to a year. The background check means the delay is not limited by how far ahead a queue can hold a message, which is what usually caps scheduling windows in other systems.',
        },
        {
          question: 'What timezone are scheduled times in?',
          answer:
            'The API accepts and returns UTC timestamps. Each profile also carries its own timezone, and the dashboard displays every time in the reader’s local timezone, so nobody has to do the conversion themselves.',
        },
        {
          question: 'What if the account is disconnected before the post publishes?',
          answer:
            'The post is revalidated shortly before publishing. If the connection has expired or been revoked in the meantime, that destination reports a clear reconnect error instead of failing obscurely, and the other destinations still publish.',
        },
        {
          question: 'Can I cancel or reschedule a post?',
          answer:
            'Yes. A scheduled post can be cancelled at any point before it starts publishing. Destinations already in flight are deliberately left alone — a call may already be with the platform, and marking it cancelled would claim an outcome nobody controls.',
        },
        {
          question: 'What happens if your system is down at the scheduled time?',
          answer:
            'The post publishes when the system recovers. The background check looks for anything overdue rather than anything due right now, so a gap in availability delays a post rather than losing it.',
        },
      ]}
      related={[
        { href: '/features/reliability', label: 'How duplicate posts are prevented' },
        { href: '/features/publishing', label: 'How publishing works' },
      ]}
    />
  );
}
