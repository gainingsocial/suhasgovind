<?php
/**
 * Background work: the share queue, and the evergreen sweep.
 *
 * @package gainingsocial
 */

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Queue a post to be shared.
 *
 * `wp_schedule_single_event` refuses a duplicate of the same hook and arguments within ten
 * minutes, which gives a free guard against a post being queued twice by two near-
 * simultaneous saves. The idempotency key covers the rest.
 */
function gainsoc_queue_share($post_id, $delay = 0)
{
    wp_schedule_single_event(time() + (int) $delay, GAINSOC_CRON_SHARE, [(int) $post_id]);
}

/** The queued share, run by cron rather than inside somebody's publish request. */
function gainsoc_run_queued_share($post_id)
{
    $post = get_post((int) $post_id);

    // Re-checked at run time, not trusted from when it was queued. A post can be
    // unpublished, deleted or opted out in the window between the two, and sharing it
    // anyway would broadcast something the author has already retracted.
    if (!$post || $post->post_status !== 'publish') {
        return;
    }

    if (get_post_meta($post->ID, GAINSOC_META_OPT_OUT, true)) {
        return;
    }

    if (get_post_meta($post->ID, GAINSOC_META_SHARED, true)) {
        return;
    }

    gainsoc_share_now($post->ID);
}
add_action(GAINSOC_CRON_SHARE, 'gainsoc_run_queued_share', 10, 1);

// -----------------------------------------------------------------------------
// Evergreen re-sharing
// -----------------------------------------------------------------------------

/**
 * Re-share older posts that are still worth reading.
 *
 * The reason this feature exists: for most sites the traffic a post gets on the day it is
 * published is a small fraction of what it could get, and the archive is dead weight
 * nobody sees again. Re-sharing it is the highest-return thing a small publisher can
 * automate, and it is the entire premise of the most-installed plugin in this category.
 *
 * Runs hourly and shares at most a handful, deliberately. A sweep that posts the whole
 * archive at once reads as spam to both the networks and the audience, and getting an
 * account rate-limited is a worse outcome than sharing slowly.
 */
function gainsoc_run_evergreen()
{
    if (!get_option('gainsoc_evergreen_enabled', false) || !gainsoc_is_configured()) {
        return;
    }

    // A floor on how often *any* evergreen share goes out, independent of how many posts
    // are eligible. Without it, a site with a large archive would share every hour.
    $gap_hours = max(1, (int) get_option('gainsoc_evergreen_gap_hours', 24));
    $last      = (int) get_option('gainsoc_evergreen_last_run', 0);

    if ($last && (time() - $last) < ($gap_hours * HOUR_IN_SECONDS)) {
        return;
    }

    $posts = gainsoc_evergreen_candidates((int) get_option('gainsoc_evergreen_per_run', 1));

    if (empty($posts)) {
        return;
    }

    foreach ($posts as $post_id) {
        gainsoc_share_now($post_id);
    }

    update_option('gainsoc_evergreen_last_run', time(), false);
}
add_action(GAINSOC_CRON_EVERGREEN, 'gainsoc_run_evergreen');

/**
 * Posts eligible for an evergreen re-share.
 *
 * Eligibility is conservative on purpose — the failure mode here is re-sharing something
 * dated, wrong, or already shared last week, and every one of those costs more trust than
 * the extra share earns.
 */
function gainsoc_evergreen_candidates($limit)
{
    $min_age  = max(1, (int) get_option('gainsoc_evergreen_min_age_days', 30));
    $interval = max(1, (int) get_option('gainsoc_evergreen_interval_days', 90));

    $cutoff = time() - ($interval * DAY_IN_SECONDS);

    $args = [
        'post_type'           => gainsoc_enabled_post_types(),
        'post_status'         => 'publish',
        'posts_per_page'      => max(1, (int) $limit),
        // Random rather than oldest-first, so the sweep does not walk the archive in order
        // and re-share the same handful of ancient posts forever.
        'orderby'             => 'rand',
        'ignore_sticky_posts' => true,
        'no_found_rows'       => true,
        'fields'              => 'ids',
        'date_query'          => [
            ['before' => $min_age . ' days ago'],
        ],
        'meta_query'          => [
            'relation' => 'AND',
            [
                'key'     => GAINSOC_META_OPT_OUT,
                'compare' => 'NOT EXISTS',
            ],
            [
                'relation' => 'OR',
                [
                    'key'     => GAINSOC_META_LAST_SHARE,
                    'compare' => 'NOT EXISTS',
                ],
                [
                    'key'     => GAINSOC_META_LAST_SHARE,
                    'value'   => $cutoff,
                    'compare' => '<',
                    'type'    => 'NUMERIC',
                ],
            ],
        ],
    ];

    $categories = (array) get_option('gainsoc_evergreen_categories', []);
    $categories = array_values(array_filter(array_map('absint', $categories)));
    if (!empty($categories)) {
        $args['category__in'] = $categories;
    }

    $query = new WP_Query($args);

    return array_map('absint', $query->posts);
}

/**
 * Share a post again, on demand.
 *
 * A thin alias, and intentionally so: the "already shared" guard lives in the callers that
 * need it — the publish transition and the queue worker — rather than in `share_now`
 * itself. That is what lets a deliberate re-share go straight through without having to
 * delete the record of the first one, which is the history the admin screen reads.
 */
function gainsoc_reshare_now($post_id)
{
    return gainsoc_share_now($post_id);
}
