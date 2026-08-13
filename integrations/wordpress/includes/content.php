<?php
/**
 * Turning a WordPress post into the article payload the API composes from.
 *
 * @package gainingsocial
 */

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Build the article payload from a post.
 *
 * Everything here is something WordPress already has. The plugin does not ask the author
 * to write a social caption, because the overwhelming majority will not, and a plugin
 * whose value depends on extra work is a plugin that gets deactivated.
 */
function gainsoc_article_payload($post, $network = null)
{
    $tags = [];
    foreach (wp_get_post_terms($post->ID, ['post_tag', 'category'], ['fields' => 'names']) as $term) {
        $tags[] = $term;
    }

    // The excerpt only if the author actually wrote one. `get_the_excerpt()` fabricates one
    // from the body when it is empty, and the API derives a better summary itself than a
    // hard 55-word cut with an ellipsis.
    $excerpt = has_excerpt($post) ? get_the_excerpt($post) : null;

    $article = [
        'title'          => get_the_title($post),
        'url'            => gainsoc_tracked_url($post, $network),
        'content'        => $post->post_content,
        'content_format' => 'html',
        'tags'           => array_values(array_slice($tags, 0, 10)),
        'published_at'   => get_post_time('c', true, $post),
    ];

    if ($excerpt) {
        $article['excerpt'] = $excerpt;
    }

    $thumbnail = get_the_post_thumbnail_url($post, 'full');
    if ($thumbnail) {
        $article['featured_image_url'] = $thumbnail;
        $alt = get_post_meta(get_post_thumbnail_id($post), '_wp_attachment_image_alt', true);
        if ($alt) {
            $article['featured_image_alt'] = $alt;
        }
    }

    /**
     * Filter the article payload before it is composed.
     *
     * The extension point that keeps this plugin out of the way of sites with unusual
     * content models — a custom field holding the real summary, a canonical URL that is
     * not the permalink. Without it those sites fork the plugin, and a forked plugin never
     * gets the next update.
     */
    return apply_filters('gainsoc_article_payload', $article, $post, $network);
}

/**
 * The post's permalink, with campaign parameters when the site owner wants them.
 *
 * Attribution is the single most-requested thing from people running a business site: a
 * share is worth nothing they can point at unless the traffic it produces shows up in
 * analytics as having come from that share. Every established plugin in this category
 * offers it, and doing it here rather than asking the author to paste tagged links by hand
 * is most of the value.
 *
 * The medium is fixed at `social`; the source is the network, so LinkedIn and Bluesky are
 * distinguishable in a report rather than collapsed into one row.
 */
function gainsoc_tracked_url($post, $network = null)
{
    $url = get_permalink($post);

    if (!get_option('gainsoc_utm_enabled', false)) {
        return $url;
    }

    $campaign = trim((string) get_option('gainsoc_utm_campaign', 'gainingsocial'));
    if ($campaign === '') {
        $campaign = 'gainingsocial';
    }

    // Values go in raw. `add_query_arg` encodes them itself, so pre-encoding here would
    // double it and a campaign named "spring launch" would arrive in analytics as
    // "spring%20launch" — a separate, permanently wrong row in every report.
    $params = [
        'utm_source'   => $network ? sanitize_key($network) : 'social',
        'utm_medium'   => 'social',
        'utm_campaign' => $campaign,
    ];

    // `add_query_arg` preserves any parameters the permalink already carries, which
    // matters on sites whose permalinks are not pretty — appending "?utm_source=..." by
    // hand to "/?p=12" produces a URL that silently loses the post ID.
    return add_query_arg($params, $url);
}

/** The destinations the site owner chose on the settings screen. */
function gainsoc_selected_targets()
{
    $ids = (array) get_option('gainsoc_destination_ids', []);
    $targets = [];
    foreach ($ids as $id) {
        if (is_string($id) && $id !== '') {
            $targets[] = ['destination_id' => $id];
        }
    }
    return $targets;
}
