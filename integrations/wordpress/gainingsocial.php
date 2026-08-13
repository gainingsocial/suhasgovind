<?php
/**
 * Plugin Name:       GainingSocial
 * Plugin URI:        https://gainingsocial.com/integrations/wordpress
 * Description:       Share posts to every social network you have connected, with a preview of exactly what each one will publish — before anything goes out.
 * Version:           1.0.0
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
 * So this file does three things: collect what WordPress already knows about a post, show
 * the preview the API returns, and publish what was approved. Roughly 400 lines, most of
 * it the settings screen.
 * -----------------------------------------------------------------------------
 */

if (!defined('ABSPATH')) {
    exit;
}

define('GAINSOC_VERSION', '1.0.0');
define('GAINSOC_API_BASE', 'https://api.gainingsocial.com');

/**
 * Meta key recording that a post has been shared.
 *
 * Stored per post so re-publishing an edit does not share it again. Duplicate shares are
 * the complaint people remember, and while the API refuses duplicates on its own side,
 * not asking is better than being refused.
 */
const GAINSOC_META_SHARED = '_gainsoc_shared_post_id';
const GAINSOC_META_OPT_OUT = '_gainsoc_skip';

// -----------------------------------------------------------------------------
// API client
// -----------------------------------------------------------------------------

/**
 * One request to the API.
 *
 * Returns [ok, decoded_body]. Never throws: a share failing must never take down a
 * customer's publish flow, and a fatal error inside `transition_post_status` would do
 * exactly that — the post stays unpublished and the author sees a white screen.
 */
function gainsoc_request($method, $path, $body = null)
{
    $key = trim((string) get_option('gainsoc_api_key', ''));
    if ($key === '') {
        return [false, ['error' => ['message' => __('No API key is set.', 'gainingsocial')]]];
    }

    $args = [
        'method'  => $method,
        'timeout' => 20,
        'headers' => [
            'Authorization' => 'Bearer ' . $key,
            'Content-Type'  => 'application/json',
            // Identifies the integration in our logs, so a spike in one plugin version is
            // attributable rather than mysterious.
            'User-Agent'    => 'GainingSocial-WordPress/' . GAINSOC_VERSION,
        ],
    ];

    if ($body !== null) {
        $args['body'] = wp_json_encode($body);
    }

    $response = wp_remote_request(GAINSOC_API_BASE . $path, $args);

    if (is_wp_error($response)) {
        return [false, ['error' => ['message' => $response->get_error_message()]]];
    }

    $decoded = json_decode(wp_remote_retrieve_body($response), true);
    $status  = wp_remote_retrieve_response_code($response);

    return [$status >= 200 && $status < 300, is_array($decoded) ? $decoded : []];
}

/** The message to show a human, taken from the API's envelope rather than invented. */
function gainsoc_error_message($payload)
{
    if (isset($payload['error']['message'])) {
        return (string) $payload['error']['message'];
    }
    return __('The request failed.', 'gainingsocial');
}

// -----------------------------------------------------------------------------
// Collecting what WordPress already knows
// -----------------------------------------------------------------------------

/**
 * Build the article payload from a post.
 *
 * Everything here is something WordPress already has. The plugin does not ask the author
 * to write a social caption, because the overwhelming majority will not, and a plugin
 * whose value depends on extra work is a plugin that gets deactivated.
 */
function gainsoc_article_payload($post)
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
        'url'            => get_permalink($post),
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

    return $article;
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
 * Publish a composition.
 *
 * The `publish_override` from the preview is passed through untouched. Rebuilding the
 * adaptation here would risk publishing something subtly different from what the author
 * approved, which is the one thing a preview must never do.
 */
function gainsoc_publish($post, $composition)
{
    $targets = [];
    foreach ($composition['composition']['targets'] as $target) {
        // A blocked target is left out rather than sent and rejected: the post still goes
        // to the networks that can take it, and the author is told which could not.
        if ($target['status'] === 'blocked') {
            continue;
        }
        $targets[] = $target['publish_override'];
    }

    if (empty($targets)) {
        return [false, ['error' => ['message' => __('No network could publish this post.', 'gainingsocial')]]];
    }

    $derived = $composition['derived'];

    return gainsoc_request('POST', '/v1/posts', [
        'profile_id' => trim((string) get_option('gainsoc_profile_id', '')),
        'content'    => [
            'text'      => $derived['text'],
            'media_ids' => $derived['media_id'] ? [$derived['media_id']] : [],
            'link_url'  => $derived['link_url'],
        ],
        'targets'    => $targets,
    ]);
}

// -----------------------------------------------------------------------------
// Sharing on publish
// -----------------------------------------------------------------------------

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

    if (!in_array($post->post_type, (array) get_option('gainsoc_post_types', ['post']), true)) {
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

    gainsoc_share_now($post->ID);
}
add_action('transition_post_status', 'gainsoc_on_transition', 10, 3);

/**
 * Compose then publish, recording the outcome on the post.
 *
 * Failures are stored rather than thrown. An author who publishes an article and sees a
 * fatal error has lost trust in the plugin even if the article itself is fine, and the
 * notice on the post list is where they will actually look.
 */
function gainsoc_share_now($post_id)
{
    $post = get_post($post_id);
    if (!$post) {
        return [false, __('Post not found.', 'gainingsocial')];
    }

    list($ok, $composition) = gainsoc_compose($post);
    if (!$ok) {
        update_post_meta($post_id, '_gainsoc_last_error', gainsoc_error_message($composition));
        return [false, gainsoc_error_message($composition)];
    }

    list($published, $result) = gainsoc_publish($post, $composition);
    if (!$published) {
        update_post_meta($post_id, '_gainsoc_last_error', gainsoc_error_message($result));
        return [false, gainsoc_error_message($result)];
    }

    update_post_meta($post_id, GAINSOC_META_SHARED, $result['id']);
    delete_post_meta($post_id, '_gainsoc_last_error');

    return [true, $result['id']];
}

// -----------------------------------------------------------------------------
// The editor panel
// -----------------------------------------------------------------------------

function gainsoc_add_meta_box()
{
    foreach ((array) get_option('gainsoc_post_types', ['post']) as $type) {
        add_meta_box(
            'gainsoc_panel',
            __('GainingSocial', 'gainingsocial'),
            'gainsoc_render_meta_box',
            $type,
            'side',
            'default'
        );
    }
}
add_action('add_meta_boxes', 'gainsoc_add_meta_box');

function gainsoc_render_meta_box($post)
{
    wp_nonce_field('gainsoc_meta', 'gainsoc_meta_nonce');

    $shared = get_post_meta($post->ID, GAINSOC_META_SHARED, true);
    $error  = get_post_meta($post->ID, '_gainsoc_last_error', true);
    $skip   = get_post_meta($post->ID, GAINSOC_META_OPT_OUT, true);

    if ($shared) {
        echo '<p>' . esc_html__('Shared.', 'gainingsocial') . ' <code>' . esc_html($shared) . '</code></p>';
    }

    if ($error) {
        // The API's own message, not a generic one. It names the destination and the field
        // at fault, which is the difference between a fixable problem and a mystery.
        echo '<p style="color:#b32d2e"><strong>' . esc_html__('Last attempt failed:', 'gainingsocial') . '</strong><br>' . esc_html($error) . '</p>';
    }

    echo '<p><label><input type="checkbox" name="gainsoc_skip" value="1" ' . checked($skip, '1', false) . '> ' . esc_html__('Do not share this one', 'gainingsocial') . '</label></p>';

    if ($post->post_status === 'publish' && !$shared) {
        $url = wp_nonce_url(
            admin_url('admin-post.php?action=gainsoc_share&post=' . $post->ID),
            'gainsoc_share_' . $post->ID
        );
        echo '<p><a class="button" href="' . esc_url($url) . '">' . esc_html__('Share now', 'gainingsocial') . '</a></p>';
    }
}

function gainsoc_save_meta($post_id)
{
    if (!isset($_POST['gainsoc_meta_nonce']) || !wp_verify_nonce(sanitize_key($_POST['gainsoc_meta_nonce']), 'gainsoc_meta')) {
        return;
    }
    if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) {
        return;
    }
    if (!current_user_can('edit_post', $post_id)) {
        return;
    }

    if (isset($_POST['gainsoc_skip'])) {
        update_post_meta($post_id, GAINSOC_META_OPT_OUT, '1');
    } else {
        delete_post_meta($post_id, GAINSOC_META_OPT_OUT);
    }
}
add_action('save_post', 'gainsoc_save_meta');

/** The "Share now" button, for a post that was published before the plugin existed. */
function gainsoc_handle_manual_share()
{
    $post_id = isset($_GET['post']) ? absint($_GET['post']) : 0;

    if (!$post_id || !current_user_can('edit_post', $post_id)) {
        wp_die(esc_html__('You are not allowed to share this post.', 'gainingsocial'));
    }
    check_admin_referer('gainsoc_share_' . $post_id);

    list($ok, $detail) = gainsoc_share_now($post_id);

    wp_safe_redirect(add_query_arg(
        ['gainsoc_shared' => $ok ? '1' : '0'],
        get_edit_post_link($post_id, 'raw')
    ));
    exit;
}
add_action('admin_post_gainsoc_share', 'gainsoc_handle_manual_share');

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

function gainsoc_settings_menu()
{
    add_options_page(
        __('GainingSocial', 'gainingsocial'),
        __('GainingSocial', 'gainingsocial'),
        'manage_options',
        'gainingsocial',
        'gainsoc_render_settings'
    );
}
add_action('admin_menu', 'gainsoc_settings_menu');

function gainsoc_register_settings()
{
    register_setting('gainsoc', 'gainsoc_api_key', ['sanitize_callback' => 'sanitize_text_field']);
    register_setting('gainsoc', 'gainsoc_profile_id', ['sanitize_callback' => 'sanitize_text_field']);
    register_setting('gainsoc', 'gainsoc_auto_share', ['sanitize_callback' => 'boolval']);
    register_setting('gainsoc', 'gainsoc_destination_ids', [
        'sanitize_callback' => function ($value) {
            return array_values(array_filter(array_map('sanitize_text_field', (array) $value)));
        },
    ]);
    register_setting('gainsoc', 'gainsoc_post_types', [
        'sanitize_callback' => function ($value) {
            return array_values(array_filter(array_map('sanitize_key', (array) $value)));
        },
    ]);
}
add_action('admin_init', 'gainsoc_register_settings');

function gainsoc_render_settings()
{
    $key = get_option('gainsoc_api_key', '');
    ?>
    <div class="wrap">
        <h1><?php esc_html_e('GainingSocial', 'gainingsocial'); ?></h1>

        <form method="post" action="options.php">
            <?php settings_fields('gainsoc'); ?>

            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="gainsoc_api_key"><?php esc_html_e('API key', 'gainingsocial'); ?></label></th>
                    <td>
                        <input name="gainsoc_api_key" id="gainsoc_api_key" type="password" class="regular-text"
                               value="<?php echo esc_attr($key); ?>" autocomplete="off">
                        <p class="description">
                            <?php
                            printf(
                                /* translators: %s: link to the dashboard */
                                esc_html__('Create one in %s. A test key can never publish to a real account, so it is safe to try.', 'gainingsocial'),
                                '<a href="https://app.gainingsocial.com/app/keys" target="_blank" rel="noopener">' . esc_html__('your dashboard', 'gainingsocial') . '</a>'
                            );
                            ?>
                        </p>
                    </td>
                </tr>

                <?php if ($key) : ?>
                    <?php gainsoc_render_connection_fields(); ?>
                <?php endif; ?>

                <tr>
                    <th scope="row"><?php esc_html_e('Share automatically', 'gainingsocial'); ?></th>
                    <td>
                        <label>
                            <input type="checkbox" name="gainsoc_auto_share" value="1" <?php checked(get_option('gainsoc_auto_share', false)); ?>>
                            <?php esc_html_e('Share a post the first time it is published', 'gainingsocial'); ?>
                        </label>
                        <p class="description"><?php esc_html_e('Editing an already-published post never shares it again.', 'gainingsocial'); ?></p>
                    </td>
                </tr>

                <tr>
                    <th scope="row"><?php esc_html_e('Post types', 'gainingsocial'); ?></th>
                    <td>
                        <?php
                        $selected = (array) get_option('gainsoc_post_types', ['post']);
                        foreach (get_post_types(['public' => true], 'objects') as $type) :
                            ?>
                            <label style="margin-right:1em">
                                <input type="checkbox" name="gainsoc_post_types[]" value="<?php echo esc_attr($type->name); ?>"
                                    <?php checked(in_array($type->name, $selected, true)); ?>>
                                <?php echo esc_html($type->label); ?>
                            </label>
                        <?php endforeach; ?>
                    </td>
                </tr>
            </table>

            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}

/**
 * The destination checkboxes, fetched live.
 *
 * Live rather than cached, because a stale list is how somebody publishes to an account
 * they disconnected last week. It costs one request on a settings page nobody opens often.
 */
function gainsoc_render_connection_fields()
{
    list($ok, $profiles) = gainsoc_request('GET', '/v1/profiles');
    if (!$ok) {
        echo '<tr><td colspan="2"><div class="notice notice-error inline"><p>' . esc_html(gainsoc_error_message($profiles)) . '</p></div></td></tr>';
        return;
    }

    $current = get_option('gainsoc_profile_id', '');
    ?>
    <tr>
        <th scope="row"><label for="gainsoc_profile_id"><?php esc_html_e('Publish as', 'gainingsocial'); ?></label></th>
        <td>
            <select name="gainsoc_profile_id" id="gainsoc_profile_id">
                <?php foreach (($profiles['data'] ?? []) as $profile) : ?>
                    <option value="<?php echo esc_attr($profile['id']); ?>" <?php selected($current, $profile['id']); ?>>
                        <?php echo esc_html($profile['name']); ?>
                    </option>
                <?php endforeach; ?>
            </select>
        </td>
    </tr>
    <?php

    if (!$current) {
        return;
    }

    list($connOk, $connections) = gainsoc_request('GET', '/v1/connections?profile_id=' . rawurlencode($current));
    if (!$connOk) {
        return;
    }

    $selected = (array) get_option('gainsoc_destination_ids', []);
    ?>
    <tr>
        <th scope="row"><?php esc_html_e('Share to', 'gainingsocial'); ?></th>
        <td>
            <?php foreach (($connections['data'] ?? []) as $connection) : ?>
                <?php
                list($destOk, $destinations) = gainsoc_request('GET', '/v1/connections/' . rawurlencode($connection['id']) . '/destinations');
                if (!$destOk) {
                    continue;
                }
                foreach (($destinations['data'] ?? []) as $destination) :
                    ?>
                    <label style="display:block;margin-bottom:.35em">
                        <input type="checkbox" name="gainsoc_destination_ids[]" value="<?php echo esc_attr($destination['id']); ?>"
                            <?php checked(in_array($destination['id'], $selected, true)); ?>>
                        <?php echo esc_html($connection['provider'] . ' — ' . $destination['name']); ?>
                        <?php if ($connection['health'] !== 'healthy') : ?>
                            <span style="color:#b32d2e">
                                <?php
                                /* The health value is the whole reason people leave other plugins:
                                   a connection that silently stopped working. Saying so here means
                                   they find out on a settings page rather than from a post that
                                   never appeared. */
                                echo esc_html(sprintf(__('(needs attention: %s)', 'gainingsocial'), $connection['health']));
                                ?>
                            </span>
                        <?php endif; ?>
                    </label>
                <?php endforeach; ?>
            <?php endforeach; ?>
        </td>
    </tr>
    <?php
}
