<?php
/**
 * Everything the site owner sees: the menu, settings, the editor panel and bulk actions.
 *
 * @package gainingsocial
 */

if (!defined('ABSPATH')) {
    exit;
}

// -----------------------------------------------------------------------------
// The editor panel
// -----------------------------------------------------------------------------

function gainsoc_add_meta_box()
{
    foreach (gainsoc_enabled_post_types() as $type) {
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

    $shared   = get_post_meta($post->ID, GAINSOC_META_SHARED, true);
    $error    = get_post_meta($post->ID, GAINSOC_META_ERROR, true);
    $skip     = get_post_meta($post->ID, GAINSOC_META_OPT_OUT, true);
    $reshares = (int) get_post_meta($post->ID, GAINSOC_META_RESHARES, true);
    $last     = (int) get_post_meta($post->ID, GAINSOC_META_LAST_SHARE, true);

    if (!gainsoc_is_configured()) {
        printf(
            '<p>%s</p>',
            sprintf(
                /* translators: %s: link to the settings screen */
                esc_html__('Finish setup in %s before sharing.', 'gainingsocial'),
                '<a href="' . esc_url(admin_url('admin.php?page=gainingsocial')) . '">' . esc_html__('GainingSocial settings', 'gainingsocial') . '</a>'
            )
        );
        return;
    }

    if ($shared) {
        echo '<p>' . esc_html__('Shared.', 'gainingsocial') . ' <code>' . esc_html($shared) . '</code></p>';
    }

    if ($last) {
        printf(
            '<p class="description">%s</p>',
            esc_html(sprintf(
                /* translators: %s: human-readable time difference, e.g. "3 days" */
                __('Last shared %s ago.', 'gainingsocial'),
                human_time_diff($last, time())
            ))
        );
    }

    if ($reshares > 1) {
        printf(
            '<p class="description">%s</p>',
            esc_html(sprintf(
                /* translators: %d: number of times the post has been shared */
                _n('Shared %d time.', 'Shared %d times.', $reshares, 'gainingsocial'),
                $reshares
            ))
        );
    }

    if ($error) {
        // The API's own message, not a generic one. It names the destination and the field
        // at fault, which is the difference between a fixable problem and a mystery.
        echo '<p style="color:#b32d2e"><strong>' . esc_html__('Last attempt failed:', 'gainingsocial') . '</strong><br>' . esc_html($error) . '</p>';
    }

    echo '<p><label><input type="checkbox" name="gainsoc_skip" value="1" ' . checked($skip, '1', false) . '> ' . esc_html__('Never share this one', 'gainingsocial') . '</label></p>';

    if ($post->post_status === 'publish') {
        $action = $shared ? 'gainsoc_reshare' : 'gainsoc_share';
        $label  = $shared ? __('Share again', 'gainingsocial') : __('Share now', 'gainingsocial');

        $url = wp_nonce_url(
            admin_url('admin-post.php?action=' . $action . '&post=' . $post->ID),
            'gainsoc_share_' . $post->ID
        );
        echo '<p><a class="button" href="' . esc_url($url) . '">' . esc_html($label) . '</a></p>';
    }
}

function gainsoc_save_meta($post_id)
{
    if (!isset($_POST['gainsoc_meta_nonce']) || !wp_verify_nonce(sanitize_key(wp_unslash($_POST['gainsoc_meta_nonce'])), 'gainsoc_meta')) {
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

/**
 * The "Share now" and "Share again" buttons.
 *
 * Runs the share inline rather than queueing it, and that is the right trade here: the
 * person clicked a button and is watching, so they should see the outcome — including the
 * API's error message — rather than a page that says "queued" and reveals the failure
 * somewhere else minutes later.
 */
function gainsoc_handle_manual_share()
{
    $post_id = isset($_GET['post']) ? absint($_GET['post']) : 0;

    if (!$post_id || !current_user_can('edit_post', $post_id)) {
        wp_die(esc_html__('You are not allowed to share this post.', 'gainingsocial'));
    }
    check_admin_referer('gainsoc_share_' . $post_id);

    $reshare = isset($_GET['action']) && sanitize_key(wp_unslash($_GET['action'])) === 'gainsoc_reshare';

    list($ok) = $reshare ? gainsoc_reshare_now($post_id) : gainsoc_share_now($post_id);

    wp_safe_redirect(add_query_arg(
        ['gainsoc_shared' => $ok ? '1' : '0'],
        get_edit_post_link($post_id, 'raw')
    ));
    exit;
}
add_action('admin_post_gainsoc_share', 'gainsoc_handle_manual_share');
add_action('admin_post_gainsoc_reshare', 'gainsoc_handle_manual_share');

// -----------------------------------------------------------------------------
// Bulk sharing from the post list
// -----------------------------------------------------------------------------

/**
 * A bulk action on the posts screen.
 *
 * The back catalogue is the reason someone installs this on an existing site, and without
 * a bulk action their only route is opening several hundred posts one at a time. These go
 * through the queue rather than running inline — fifty posts times two API calls inside
 * one admin request is a guaranteed timeout.
 */
function gainsoc_register_bulk_actions($actions)
{
    $actions['gainsoc_bulk_share'] = __('Share with GainingSocial', 'gainingsocial');
    return $actions;
}

function gainsoc_handle_bulk_action($redirect, $doaction, $post_ids)
{
    if ($doaction !== 'gainsoc_bulk_share') {
        return $redirect;
    }

    $queued = 0;
    foreach ($post_ids as $index => $post_id) {
        if (!current_user_can('edit_post', $post_id)) {
            continue;
        }

        // Staggered by a minute each. Sending them all at once would hand the networks a
        // burst that looks exactly like spam, and rate limiting one account for a day is a
        // worse outcome than the catalogue taking an hour to go out.
        gainsoc_queue_share($post_id, $index * MINUTE_IN_SECONDS);
        $queued++;
    }

    return add_query_arg('gainsoc_queued', $queued, $redirect);
}

function gainsoc_bulk_action_notice()
{
    if (!isset($_GET['gainsoc_queued'])) {
        return;
    }

    $count = absint($_GET['gainsoc_queued']);
    printf(
        '<div class="notice notice-success is-dismissible"><p>%s</p></div>',
        esc_html(sprintf(
            /* translators: %d: number of posts queued */
            _n('%d post queued for sharing.', '%d posts queued for sharing.', $count, 'gainingsocial'),
            $count
        ))
    );
}

function gainsoc_register_list_hooks()
{
    foreach (gainsoc_enabled_post_types() as $type) {
        add_filter("bulk_actions-edit-{$type}", 'gainsoc_register_bulk_actions');
        add_filter("handle_bulk_actions-edit-{$type}", 'gainsoc_handle_bulk_action', 10, 3);
    }
    add_action('admin_notices', 'gainsoc_bulk_action_notice');
}
add_action('admin_init', 'gainsoc_register_list_hooks');

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

/**
 * A top-level menu rather than a page buried under Settings.
 *
 * This is a thing people use weekly — checking what went out, re-sharing something — not a
 * thing they configure once. Under Settings it is three clicks away and forgotten.
 */
function gainsoc_settings_menu()
{
    add_menu_page(
        __('GainingSocial', 'gainingsocial'),
        __('GainingSocial', 'gainingsocial'),
        'manage_options',
        'gainingsocial',
        'gainsoc_render_settings',
        'dashicons-share',
        30
    );
}
add_action('admin_menu', 'gainsoc_settings_menu');

function gainsoc_register_settings()
{
    $text = ['sanitize_callback' => 'sanitize_text_field'];
    $bool = ['sanitize_callback' => 'boolval'];
    $int  = ['sanitize_callback' => 'absint'];

    register_setting('gainsoc', 'gainsoc_api_key', $text);
    register_setting('gainsoc', 'gainsoc_profile_id', $text);
    register_setting('gainsoc', 'gainsoc_auto_share', $bool);
    register_setting('gainsoc', 'gainsoc_share_delay', $int);

    register_setting('gainsoc', 'gainsoc_utm_enabled', $bool);
    register_setting('gainsoc', 'gainsoc_utm_campaign', $text);

    register_setting('gainsoc', 'gainsoc_evergreen_enabled', $bool);
    register_setting('gainsoc', 'gainsoc_evergreen_min_age_days', $int);
    register_setting('gainsoc', 'gainsoc_evergreen_interval_days', $int);
    register_setting('gainsoc', 'gainsoc_evergreen_gap_hours', $int);
    register_setting('gainsoc', 'gainsoc_evergreen_per_run', $int);

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
    register_setting('gainsoc', 'gainsoc_evergreen_categories', [
        'sanitize_callback' => function ($value) {
            return array_values(array_filter(array_map('absint', (array) $value)));
        },
    ]);
}
add_action('admin_init', 'gainsoc_register_settings');

/** A checkbox row, since the settings screen has a dozen of them. */
function gainsoc_checkbox_row($label, $option, $description = '')
{
    ?>
    <tr>
        <th scope="row"><?php echo esc_html($label); ?></th>
        <td>
            <label>
                <input type="checkbox" name="<?php echo esc_attr($option); ?>" value="1"
                    <?php checked(get_option($option, false), true); ?>>
                <?php echo esc_html($description); ?>
            </label>
        </td>
    </tr>
    <?php
}

/** A small number input, for the day and hour settings. */
function gainsoc_number_row($label, $option, $default, $description = '')
{
    ?>
    <tr>
        <th scope="row"><label for="<?php echo esc_attr($option); ?>"><?php echo esc_html($label); ?></label></th>
        <td>
            <input type="number" min="0" class="small-text" id="<?php echo esc_attr($option); ?>"
                   name="<?php echo esc_attr($option); ?>"
                   value="<?php echo esc_attr((string) get_option($option, $default)); ?>">
            <?php if ($description) : ?>
                <p class="description"><?php echo esc_html($description); ?></p>
            <?php endif; ?>
        </td>
    </tr>
    <?php
}

function gainsoc_render_settings()
{
    $key = get_option('gainsoc_api_key', '');
    ?>
    <div class="wrap">
        <h1><?php esc_html_e('GainingSocial', 'gainingsocial'); ?></h1>

        <form method="post" action="options.php">
            <?php settings_fields('gainsoc'); ?>

            <h2><?php esc_html_e('Connection', 'gainingsocial'); ?></h2>
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
                                '<a href="https://gainingsocial.com/app/keys" target="_blank" rel="noopener">' . esc_html__('your dashboard', 'gainingsocial') . '</a>'
                            );
                            ?>
                        </p>
                    </td>
                </tr>

                <?php if ($key) : ?>
                    <?php gainsoc_render_connection_fields(); ?>
                <?php endif; ?>
            </table>

            <?php if ($key) : ?>
                <h2><?php esc_html_e('Sharing', 'gainingsocial'); ?></h2>
                <table class="form-table" role="presentation">
                    <?php
                    gainsoc_checkbox_row(
                        __('On publish', 'gainingsocial'),
                        'gainsoc_auto_share',
                        __('Share a post automatically when it is first published', 'gainingsocial')
                    );

                    gainsoc_number_row(
                        __('Wait before sharing', 'gainingsocial'),
                        'gainsoc_share_delay',
                        0,
                        __('Minutes. A short delay gives you time to catch a typo before it has gone out everywhere.', 'gainingsocial')
                    );
                    ?>
                </table>

                <h2><?php esc_html_e('Link tracking', 'gainingsocial'); ?></h2>
                <table class="form-table" role="presentation">
                    <?php
                    gainsoc_checkbox_row(
                        __('Tag shared links', 'gainingsocial'),
                        'gainsoc_utm_enabled',
                        __('Add campaign parameters so this traffic is attributable in analytics', 'gainingsocial')
                    );
                    ?>
                    <tr>
                        <th scope="row"><label for="gainsoc_utm_campaign"><?php esc_html_e('Campaign name', 'gainingsocial'); ?></label></th>
                        <td>
                            <input type="text" class="regular-text" id="gainsoc_utm_campaign" name="gainsoc_utm_campaign"
                                   value="<?php echo esc_attr((string) get_option('gainsoc_utm_campaign', 'gainingsocial')); ?>">
                            <p class="description"><?php esc_html_e('The network name is used as the source, so each one is a separate row in your reports.', 'gainingsocial'); ?></p>
                        </td>
                    </tr>
                </table>

                <h2><?php esc_html_e('Re-share older posts', 'gainingsocial'); ?></h2>
                <p class="description">
                    <?php esc_html_e('Most of a post\'s potential audience never sees it on the day it goes out. This brings the archive back into circulation, slowly.', 'gainingsocial'); ?>
                </p>
                <table class="form-table" role="presentation">
                    <?php
                    gainsoc_checkbox_row(
                        __('Enabled', 'gainingsocial'),
                        'gainsoc_evergreen_enabled',
                        __('Re-share older posts automatically', 'gainingsocial')
                    );

                    gainsoc_number_row(
                        __('Only posts older than', 'gainingsocial'),
                        'gainsoc_evergreen_min_age_days',
                        30,
                        __('Days.', 'gainingsocial')
                    );

                    gainsoc_number_row(
                        __('Do not repeat a post within', 'gainingsocial'),
                        'gainsoc_evergreen_interval_days',
                        90,
                        __('Days.', 'gainingsocial')
                    );

                    gainsoc_number_row(
                        __('Wait between re-shares', 'gainingsocial'),
                        'gainsoc_evergreen_gap_hours',
                        24,
                        __('Hours. This is the pace of the whole feature, not per post.', 'gainingsocial')
                    );

                    gainsoc_number_row(
                        __('Posts each time', 'gainingsocial'),
                        'gainsoc_evergreen_per_run',
                        1,
                        __('Keep this low. A burst of old posts reads as spam.', 'gainingsocial')
                    );
                    ?>
                </table>

                <h2><?php esc_html_e('Content types', 'gainingsocial'); ?></h2>
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><?php esc_html_e('Share these', 'gainingsocial'); ?></th>
                        <td>
                            <?php
                            $enabled = gainsoc_enabled_post_types();
                            foreach (get_post_types(['public' => true], 'objects') as $type) {
                                if ($type->name === 'attachment') {
                                    continue;
                                }
                                printf(
                                    '<label style="display:block"><input type="checkbox" name="gainsoc_post_types[]" value="%s" %s> %s</label>',
                                    esc_attr($type->name),
                                    checked(in_array($type->name, $enabled, true), true, false),
                                    esc_html($type->labels->name)
                                );
                            }
                            ?>
                        </td>
                    </tr>
                </table>
            <?php endif; ?>

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
