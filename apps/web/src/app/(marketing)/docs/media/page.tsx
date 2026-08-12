import { GuidePage } from '@/components/guide-page';
import { pageSeo } from '@/lib/seo';

export const metadata = pageSeo({
  title: 'Media uploads — images and video across every network',
  description:
    'Upload images and video once and publish them everywhere: signed direct-to-storage ' +
    'uploads, server-side probing, alt text, per-platform size and duration limits, and how ' +
    'to check a file will be accepted before you publish.',
  path: '/docs/media',
});

/**
 * Media guide.
 *
 * The per-platform limits table is the reason this page earns links — it is the thing
 * every developer building a cross-posting feature has to assemble by hand from six sets
 * of platform documentation.
 */

const BODY = [
  {
    heading: 'Upload once, publish anywhere',
    paragraphs: [
      'Media is uploaded to your project, not to a post. One file can be attached to any number of posts across any number of networks, and it is only transferred once.',
      'The bytes never pass through the API. You request an upload, receive a short-lived signed URL, PUT the file straight to storage, then confirm. Routing large files through an API server is how upload endpoints become the slowest and least reliable part of a product.',
    ],
    code: `# 1. Ask for somewhere to put it.
curl -X POST https://api.gainingsocial.com/v1/media/uploads \\
  -H "Authorization: Bearer sk_live_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"filename":"launch.jpg","content_type":"image/jpeg","bytes":184320,
       "alt_text":"The new dashboard, showing five connected networks"}'

# 2. Send the bytes to the signed URL. No API key on this request.
curl -X PUT "$UPLOAD_URL" \\
  -H "Content-Type: image/jpeg" \\
  --data-binary @launch.jpg

# 3. Confirm.
curl -X POST https://api.gainingsocial.com/v1/media/uploads/med_.../complete \\
  -H "Authorization: Bearer sk_live_your_key"`,
  },
  {
    heading: 'Files are inspected, not taken on trust',
    paragraphs: [
      'On completion the file is probed server-side for its real format, dimensions and duration. Validation uses those values, never what the client declared.',
      'This matters more than it sounds. A file named .mp4 that is actually a QuickTime container will be accepted by some networks and rejected by others, and a client that reports its own metadata gets that wrong constantly. Probing means a post is validated against the file that exists.',
      'A file stays in a processing state until probing finishes. Attaching one too early returns MEDIA_NOT_READY, which is retryable — wait for the media.ready webhook rather than polling.',
    ],
  },
  {
    heading: 'Check before you publish',
    paragraphs: [
      'Media preflight answers whether these files are publishable to these destinations, before a post exists. It is free of side effects and safe to call as often as you like.',
      'This is where a cross-posting feature stops being guesswork. The same image is fine on X and too large for a Business Profile listing; the same video is fine on YouTube and too long for TikTok. Ask, rather than encoding six sets of platform rules that change without notice.',
    ],
    code: `curl -X POST https://api.gainingsocial.com/v1/media/preflight \\
  -H "Authorization: Bearer sk_live_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"media_ids":["med_..."],"destination_ids":["dst_x","dst_tiktok"]}'

# Per media item, per destination: valid, plus a finding with a machine-readable
# agent_action such as create_media_variant or trim_video_duration.`,
  },
  {
    heading: 'Limits differ by network, and they differ a lot',
    paragraphs: [
      'These are the constraints the adapters validate against. They are also available from the API per destination, which is the version to rely on — a published table is a snapshot, and platforms change these.',
      'Ask GET /v1/destinations/{id}/capabilities for the account you are actually publishing to. Effective capabilities are narrowed by granted permissions and account type, so the answer for one connected account is not the answer for another on the same network.',
    ],
    code: `Network           Media  Max image  Video                Text
X                 4      5 MB       512 MB, up to 140s   280
LinkedIn          20     —          mp4                  3,000
Facebook Page     10     —          mp4                  63,206
Instagram         10     —          3-900s               2,200
Threads           20     —          mp4                  500
TikTok            10     —          up to 600s           2,200
YouTube           1      —          256 GB, up to 900s   5,000 (description)
Pinterest         5      20 MB      2 GB, 4-900s         800
Bluesky           4      2 MB       —                    300
Telegram          10     —          mp4                  4,096 (1,024 w/ media)
Discord           10     10 MB      10 MB                2,000
Google Business   1      5 MB       —                    1,500

A dash means the adapter declares no limit of its own and defers to the
platform. Ask the destination for the authoritative answer.`,
  },
  {
    heading: 'Alt text',
    paragraphs: [
      'Supply alt text on upload and it is sent wherever the network supports it. Where a network caps it shorter than you wrote, it is truncated rather than dropped, and preflight warns rather than failing — a post without complete alt text is better than no post.',
      'Where a network has no alt text field at all, it is simply not sent. Nothing fails and nothing is silently mangled.',
    ],
  },
  {
    heading: 'Media already on the web',
    paragraphs: [
      'A file already hosted publicly can be registered by URL instead of uploaded. It is fetched, probed and treated identically from then on.',
      'The URL must be public HTTPS and must not resolve to a private network. A URL pointing at an internal address is refused with MEDIA_URL_NOT_ALLOWED, and redirects are re-checked at every hop — a public URL that redirects to 169.254.169.254 is exactly the attack this prevents.',
    ],
    code: `curl -X POST https://api.gainingsocial.com/v1/media/external \\
  -H "Authorization: Bearer sk_live_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://cdn.example.com/launch.jpg","alt_text":"The new dashboard"}'`,
  },
];

const FAQS = [
  {
    question: 'Do I need to upload the same image once per network?',
    answer:
      'No. Upload it once to your project and attach it to as many posts and networks as you like. Each network receives it in whatever way that platform requires — some pull it from a URL, some need a multi-step chunked upload — but that is handled for you.',
  },
  {
    question: 'Why is my media rejected as not ready?',
    answer:
      'Probing has not finished. Files are inspected server-side for their real format, dimensions and duration after upload, and cannot be attached to a post until that completes. MEDIA_NOT_READY is retryable; the media.ready webhook tells you the moment it is done.',
  },
  {
    question: 'What image size works everywhere?',
    answer:
      'A JPEG under 2 MB with both edges at least 250 pixels is accepted by every network currently supported. Bluesky has the tightest size ceiling at roughly 2 MB and Google Business Profile imposes the 250-pixel minimum, so those two are the binding constraints. For anything larger, run media preflight against the specific destinations rather than guessing.',
  },
  {
    question: 'Can I post a video to every network at once?',
    answer:
      'To most, but the limits differ sharply — X caps video at 140 seconds, TikTok at 600, and Instagram and Pinterest at 900. Pinterest and Instagram also impose minimums, of four and three seconds. Preflight reports which destinations will accept a given file before you publish, and a failure on one does not hold up the others.',
  },
  {
    question: 'Why was my media URL refused?',
    answer:
      'External media must be a public HTTPS URL that does not resolve to a private network address. URLs pointing at internal ranges, localhost or cloud metadata endpoints are refused, and redirects are re-checked at every hop rather than only at the first request.',
  },
  {
    question: 'Is alt text sent to every network?',
    answer:
      'Wherever the network supports it. Where a platform caps it shorter than you supplied, it is truncated and preflight warns; where a platform has no alt text field, it is not sent and nothing fails. Losing the tail of a description is better than losing the post.',
  },
];

export default function MediaGuidePage() {
  return (
    <GuidePage
      breadcrumb={{ name: 'Media', path: '/docs/media' }}
      heading="Media uploads"
      lead="Upload an image or video once and publish it to every network — with the bytes going straight to storage, real metadata read from the file itself, and per-platform limits you can ask about instead of memorise."
      body={BODY}
      faqs={FAQS}
      related={[
        { href: '/docs/quickstart', label: 'Publish your first post' },
        { href: '/platforms', label: 'Supported networks' },
        { href: '/docs', label: 'API documentation' },
      ]}
    />
  );
}
