<?php
/**
 * The API client. One function, deliberately.
 *
 * @package gainingsocial
 */

if (!defined('ABSPATH')) {
    exit;
}

/**
 * One request to the API.
 *
 * Returns [ok, decoded_body]. Never throws: a share failing must never take down a
 * customer's publish flow, and a fatal error inside `transition_post_status` would do
 * exactly that — the post stays unpublished and the author sees a white screen.
 */
function gainsoc_request($method, $path, $body = null, $idempotency_key = null)
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

    // `POST /v1/posts` *requires* this header and rejects the request without it. The
    // caller supplies it rather than this function deriving one, and the distinction
    // matters: the key has to be stable across retries of one share attempt, so a cron
    // run that times out and runs again replays instead of double-posting, yet different
    // between a first share and a later re-share of the same article — which is byte-for-
    // byte identical content. A key hashed from the payload would satisfy the first
    // requirement and quietly break the second, replaying the original response and
    // never publishing the re-share at all.
    if ($idempotency_key !== null) {
        $args['headers']['Idempotency-Key'] = $idempotency_key;
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

/**
 * Whether the plugin is configured well enough to share anything.
 *
 * Checked before the settings screen offers destinations and before the editor panel
 * offers a button, so the failure is visible where it can be fixed rather than at publish
 * time when the author is thinking about something else.
 */
function gainsoc_is_configured()
{
    return trim((string) get_option('gainsoc_api_key', '')) !== ''
        && trim((string) get_option('gainsoc_profile_id', '')) !== ''
        && !empty((array) get_option('gainsoc_destination_ids', []));
}
