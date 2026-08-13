<?php
/**
 * Composing and publishing. The part that talks to the API about a specific post.
 *
 * @package gainingsocial
 */

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Compose an article, returning what each network would publish.
 *
 * One call. The plugin does not register the image, derive a summary, count characters or
 * check aspect ratios — the API does all of it, identically for every integration.
 */
function gainsoc_compose($post)
{
    $profile = trim((string) get_option('gainsoc_profile_id', ''));
    $targets = gainsoc_selected_targets();

    if ($profile === '' || empty($targets)) {
        return [false, ['error' => ['message' => __('Choose a profile and at least one destination in GainingSocial settings.', 'gainingsocial')]]];
    }

    return gainsoc_request('POST', '/v1/articles/compose', [
        'profile_id' => $profile,
        'article'    => gainsoc_article_payload($post),
        'targets'    => $targets,
        'mode'       => 'optimize',
    ]);
}

/**
 * The idempotency key for one share attempt.
 *
 * Stable for a given (site, post, attempt), so a cron job that runs twice — which
 * WordPress cron does, cheerfully, whenever two visitors arrive at once — replays the
 * first response instead of publishing a second copy. Distinct across attempts, so an
 * evergreen re-share of byte-identical content is a new publish rather than a replay.
 *
 * The site URL is hashed in because one API key can serve a staging clone and a production
 * site, and both have a post with ID 42.
 */
function gainsoc_idempotency_key($post_id, $attempt)
{
    return 'wp_' . substr(md5(get_site_url()), 0, 12) . '_' . (int) $post_id . '_' . (int) $attempt;
}

/**
 * Publish a composition.
 *
 * The `publish_override` from the preview is passed through untouched. Rebuilding the
 * adaptation here would risk publishing something subtly different from what the author
 * approved, which is the one thing a preview must never do.
 */
function gainsoc_publish($post, $composition, $attempt, $publish_at = null)
{
    $targets = [];
    $blocked = [];

    foreach ($composition['composition']['targets'] as $target) {
        // A blocked target is left out rather than sent and rejected: the post still goes
        // to the networks that can take it, and the author is told which could not.
        if ($target['status'] === 'blocked') {
            $blocked[] = isset($target['destination_id']) ? $target['destination_id'] : '';
            continue;
        }
        $targets[] = $target['publish_override'];
    }

    if (empty($targets)) {
        return [false, ['error' => ['message' => __('No network could publish this post.', 'gainingsocial')]]];
    }

    $derived = $composition['derived'];

    $body = [
        'profile_id' => trim((string) get_option('gainsoc_profile_id', '')),
        'content'    => [
            'text'      => $derived['text'],
            'media_ids' => $derived['media_id'] ? [$derived['media_id']] : [],
            'link_url'  => $derived['link_url'],
        ],
        'targets'    => $targets,
    ];

    // Scheduling is the API's job, not wp-cron's. Handing it `publish_at` means the post
    // goes out on time even if the site gets no traffic to trigger cron, which is exactly
    // the situation a small site is in at 8am on a Sunday.
    if ($publish_at) {
        $body['publish_at'] = $publish_at;
    }

    return gainsoc_request('POST', '/v1/posts', $body, gainsoc_idempotency_key($post->ID, $attempt));
}

/**
 * Compose then publish, recording the outcome on the post.
 *
 * Failures are stored rather than thrown. An author who publishes an article and sees a
 * fatal error has lost trust in the plugin even if the article itself is fine, and the
 * notice on the post list is where they will actually look.
 */
function gainsoc_share_now($post_id, $publish_at = null)
{
    $post = get_post($post_id);
    if (!$post) {
        return [false, __('Post not found.', 'gainingsocial')];
    }

    // The attempt number doubles as the re-share counter, which is what makes the
    // idempotency key advance.
    $attempt = (int) get_post_meta($post_id, GAINSOC_META_RESHARES, true);

    list($ok, $composition) = gainsoc_compose($post);
    if (!$ok) {
        update_post_meta($post_id, GAINSOC_META_ERROR, gainsoc_error_message($composition));
        return [false, gainsoc_error_message($composition)];
    }

    list($published, $result) = gainsoc_publish($post, $composition, $attempt, $publish_at);
    if (!$published) {
        update_post_meta($post_id, GAINSOC_META_ERROR, gainsoc_error_message($result));
        return [false, gainsoc_error_message($result)];
    }

    update_post_meta($post_id, GAINSOC_META_SHARED, $result['id']);
    update_post_meta($post_id, GAINSOC_META_LAST_SHARE, time());
    update_post_meta($post_id, GAINSOC_META_RESHARES, $attempt + 1);

    if (!get_post_meta($post_id, GAINSOC_META_SHARED_AT, true)) {
        update_post_meta($post_id, GAINSOC_META_SHARED_AT, time());
    }

    delete_post_meta($post_id, GAINSOC_META_ERROR);

    /** Fires after a post has been handed to the API. */
    do_action('gainsoc_shared', $post_id, $result['id'], $attempt);

    return [true, $result['id']];
}
