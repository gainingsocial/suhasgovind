<?php
/**
 * Plugin Name:       GainingSocial
 * Plugin URI:        https://gainingsocial.com/integrations/wordpress
 * Description:       Share posts to every social network you have connected, with a preview of exactly what each one will publish — before anything goes out. Re-shares your best older posts on a schedule, and tracks every click.
 * Version:           1.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            GainingSocial
 * Author URI:        https://gainingsocial.com
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       gainingsocial
 *
 * -----------------------------------------------------------------------------
 * This plugin contains no social-platform logic, and that is the design.
 *
 * Every character limit, aspect ratio, hashtag rule and approval quirk lives in the API
 * and is exercised by the same code path the browser extension, the site-builder apps and
 * the agent tool use. A plugin that knew LinkedIn's limit would be wrong the week LinkedIn
 * changed it, and every site running an old version would stay wrong until each one
 * updated — which is the failure mode of every auto-poster in this category.
 *
 * So this plugin collects what WordPress already knows about a post, shows the preview the
 * API returns, and publishes what was approved.
 * -----------------------------------------------------------------------------
 */

if (!defined('ABSPATH')) {
    exit;
}

define('GAINSOC_VERSION', '1.1.0');
define('GAINSOC_API_BASE', 'https://api.gainingsocial.com');
define('GAINSOC_DIR', plugin_dir_path(__FILE__));

/**
 * Post meta.
 *
 * `SHARED` records the API post ID, which is what makes re-publishing an edit safe: a post
 * that already has one is never shared again. Duplicate shares are the complaint people
 * remember, and while the API refuses duplicates on its own side, not asking is better
 * than being refused.
 */
const GAINSOC_META_SHARED     = '_gainsoc_shared_post_id';
const GAINSOC_META_OPT_OUT    = '_gainsoc_skip';
const GAINSOC_META_ERROR      = '_gainsoc_last_error';
const GAINSOC_META_SHARED_AT  = '_gainsoc_shared_at';
const GAINSOC_META_RESHARES   = '_gainsoc_reshare_count';
const GAINSOC_META_LAST_SHARE = '_gainsoc_last_shared_at';

/** Cron hooks. Named constants because they are referenced from four files. */
const GAINSOC_CRON_SHARE     = 'gainsoc_share_event';
const GAINSOC_CRON_EVERGREEN = 'gainsoc_evergreen_event';

require_once GAINSOC_DIR . 'includes/api.php';
require_once GAINSOC_DIR . 'includes/content.php';
require_once GAINSOC_DIR . 'includes/share.php';
require_once GAINSOC_DIR . 'includes/cron.php';
require_once GAINSOC_DIR . 'includes/admin.php';

/**
 * Share when a post first becomes public.
 *
 * `transition_post_status` rather than `publish_post` or `save_post`, because it is the
 * only hook that distinguishes *becoming* published from being edited while published.
 * Blog2Social's most-reported bug is exactly this: sharing again on every save.
 */
function gainsoc_on_transition($new_status, $old_status, $post)
{
    if ($new_status !== 'publish' || $old_status === 'publish') {
        return;
    }

    if (!in_array($post->post_type, gainsoc_enabled_post_types(), true)) {
        return;
    }

    if (get_post_meta($post->ID, GAINSOC_META_OPT_OUT, true)) {
        return;
    }

    if (!get_option('gainsoc_auto_share', false)) {
        return;
    }

    // Already shared: a scheduled post that transitions future → publish must not share
    // twice if anything re-runs the transition.
    if (get_post_meta($post->ID, GAINSOC_META_SHARED, true)) {
        return;
    }

    // Queued, never shared inline.
    //
    // Sharing here would put two API round trips — compose, then publish — inside the
    // request that is saving the post, adding up to 40 seconds to a publish click and
    // risking a gateway timeout that loses the editor's work. Every serious auto-poster
    // gets this wrong at least once; the symptom is "publishing got really slow".
    gainsoc_queue_share($post->ID, gainsoc_share_delay_seconds());
}
add_action('transition_post_status', 'gainsoc_on_transition', 10, 3);

/** The post types the site owner opted in. Defaults to posts only. */
function gainsoc_enabled_post_types()
{
    $types = (array) get_option('gainsoc_post_types', ['post']);
    return array_values(array_filter(array_map('sanitize_key', $types)));
}

/**
 * How long to wait before sharing a newly published post, in seconds.
 *
 * Zero means "as soon as cron next runs", which is normally within a minute. A deliberate
 * delay is useful for a different reason than throttling: it gives the author a window to
 * spot a typo and un-publish before the post has been broadcast to every network, which
 * is the one mistake that cannot be taken back.
 */
function gainsoc_share_delay_seconds()
{
    return max(0, (int) get_option('gainsoc_share_delay', 0)) * MINUTE_IN_SECONDS;
}

/**
 * Activation.
 *
 * Registers the recurring evergreen sweep. Scheduling on activation rather than on every
 * load means the schedule survives, and there is exactly one of it — repeatedly calling
 * `wp_schedule_event` without this guard is how plugins end up firing a job twelve times
 * an hour.
 */
function gainsoc_activate()
{
    if (!wp_next_scheduled(GAINSOC_CRON_EVERGREEN)) {
        wp_schedule_event(time() + HOUR_IN_SECONDS, 'hourly', GAINSOC_CRON_EVERGREEN);
    }
}
register_activation_hook(__FILE__, 'gainsoc_activate');

/**
 * Deactivation.
 *
 * Clears the schedule. A plugin that leaves cron events behind keeps waking a site up to
 * run code that is no longer loaded, which surfaces as a mysterious recurring error in the
 * log long after anyone remembers installing it.
 */
function gainsoc_deactivate()
{
    wp_clear_scheduled_hook(GAINSOC_CRON_EVERGREEN);
    wp_clear_scheduled_hook(GAINSOC_CRON_SHARE);
}
register_deactivation_hook(__FILE__, 'gainsoc_deactivate');

/** Translations. */
function gainsoc_load_textdomain()
{
    load_plugin_textdomain('gainingsocial', false, dirname(plugin_basename(__FILE__)) . '/languages');
}
add_action('init', 'gainsoc_load_textdomain');
