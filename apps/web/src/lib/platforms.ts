/**
 * The public platform catalogue.
 *
 * One list, shared by the home page and `/platforms`. When these were two lists they
 * drifted: the home page claimed a count the platforms page contradicted, which is the
 * kind of small inconsistency a developer notices and reads as carelessness.
 *
 * `status` describes the *platform's permission*, never the code. Every adapter here is
 * written and tested; what differs is whether the network has granted access yet.
 */

export type PlatformStatus = 'available' | 'awaiting-approval' | 'planned';

export interface Platform {
  /** Matches the provider slug used by the API and by `PLATFORM_MARKS`. */
  id: string;
  name: string;
  status: PlatformStatus;
  /** What the destination is on this network — the thing you actually publish to. */
  publishesTo: string;
  approval: string;
  cost: 'Free' | 'Paid';
  notes: string;
}

export const PLATFORMS: readonly Platform[] = [
  {
    id: 'bluesky',
    name: 'Bluesky',
    status: 'available',
    publishesTo: 'Your account feed',
    approval: 'None',
    cost: 'Free',
    notes:
      'No developer portal and no review queue. You create an app password in Bluesky’s settings and start publishing. That is why it is the first network supported.',
  },
  {
    id: 'telegram',
    name: 'Telegram',
    status: 'awaiting-approval',
    publishesTo: 'Channels and groups',
    approval: 'None — bot token only',
    cost: 'Free',
    notes:
      'A bot token from @BotFather is the whole setup. Publishes to channels and groups rather than a public feed.',
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    status: 'awaiting-approval',
    publishesTo: 'Personal profiles and company pages',
    approval: 'Two tiers, several weeks',
    cost: 'Free',
    notes:
      'Requires a registered legal organisation and a business email; personal addresses do not pass vetting. Development access comes first, then a Standard tier review with a screen recording.',
  },
  {
    id: 'facebook',
    name: 'Facebook Pages',
    status: 'awaiting-approval',
    publishesTo: 'Pages you manage',
    approval: '4–6 weeks',
    cost: 'Free',
    notes:
      'Needs Meta Business Verification and app review with a screencast. One Meta app covers Facebook, Instagram and Threads.',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    status: 'awaiting-approval',
    publishesTo: 'Feed posts, carousels and Reels',
    approval: '4–6 weeks',
    cost: 'Free',
    notes:
      'Requires a Business or Creator account linked to a Facebook Page. Personal accounts cannot publish through any API.',
  },
  {
    id: 'threads',
    name: 'Threads',
    status: 'awaiting-approval',
    publishesTo: 'Your Threads profile',
    approval: '4–6 weeks',
    cost: 'Free',
    notes: 'Shares the Meta app and its review with Facebook and Instagram.',
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    status: 'awaiting-approval',
    publishesTo: 'Videos and photo posts',
    approval: '2–4 week audit',
    cost: 'Free',
    notes:
      'The Content Posting API needs an audit separate from developer signup. Until it passes, TikTok forces every post made through the API to be visible only to its creator.',
  },
  {
    id: 'youtube',
    name: 'YouTube',
    status: 'awaiting-approval',
    publishesTo: 'Videos and Shorts',
    approval: 'Compliance audit',
    cost: 'Free',
    notes:
      'Uploads from unaudited projects are restricted to private visibility until the audit passes.',
  },
  {
    id: 'pinterest',
    name: 'Pinterest',
    status: 'planned',
    publishesTo: 'Pins on a board',
    approval: 'Standard app review',
    cost: 'Free',
    notes: 'Publishes Pins to boards, so a board is the destination rather than the account.',
  },
  {
    id: 'x',
    name: 'X',
    status: 'planned',
    publishesTo: 'Posts and threads',
    approval: 'Immediate, on a paid tier',
    cost: 'Paid',
    notes: 'The only major network that charges for the ability to publish.',
  },
  {
    id: 'discord',
    name: 'Discord',
    status: 'planned',
    publishesTo: 'Server channels',
    approval: 'None — bot token',
    cost: 'Free',
    notes: 'Posts to channels through a bot. The lightest setup of any platform here.',
  },
  {
    id: 'google-business-profile',
    name: 'Google Business Profile',
    status: 'planned',
    publishesTo: 'Local posts on a listing',
    approval: 'Google Cloud project and access request',
    cost: 'Free',
    notes: 'Publishes updates to a business listing rather than a social feed.',
  },
];

export const PLATFORM_COUNT = PLATFORMS.length;

export const STATUS_LABEL: Record<PlatformStatus, string> = {
  available: 'Available now',
  'awaiting-approval': 'Built, awaiting approval',
  planned: 'Planned',
};

export const STATUS_TONE: Record<PlatformStatus, string> = {
  available: 'bg-ok-100 text-ok-600',
  'awaiting-approval': 'bg-warn-100 text-warn-600',
  planned: 'bg-[var(--surface-sunken)] text-[var(--text-muted)]',
};
