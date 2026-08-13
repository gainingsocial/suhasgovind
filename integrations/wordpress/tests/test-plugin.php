<?php
/**
 * Plugin tests, run without WordPress.
 *
 *   php integrations/wordpress/tests/test-plugin.php
 *
 * ## Why stubs rather than a WordPress test suite
 *
 * The parts of this plugin that are worth testing are the parts that do not touch
 * WordPress: how a permalink becomes a tracked URL, and how an idempotency key advances
 * across re-shares. Both are pure string logic, both have a wrong answer that is silent —
 * a broken tracking URL still publishes, and a stuck idempotency key still returns 200 —
 * and neither needs a database to exercise.
 *
 * So WordPress is stubbed to the handful of functions those paths call. This runs in
 * milliseconds on any PHP, which means it runs in CI on every push rather than only where
 * somebody has installed a WordPress test harness.
 *
 * The API-calling paths are deliberately not covered here; they are exercised against the
 * real API by the integration suite.
 */

// -----------------------------------------------------------------------------
// WordPress stubs
// -----------------------------------------------------------------------------

define('ABSPATH', __DIR__);
define('MINUTE_IN_SECONDS', 60);
define('HOUR_IN_SECONDS', 3600);
define('DAY_IN_SECONDS', 86400);

$GLOBALS['gainsoc_options'] = [];

function get_option($name, $default = false)
{
    return array_key_exists($name, $GLOBALS['gainsoc_options'])
        ? $GLOBALS['gainsoc_options'][$name]
        : $default;
}

function update_option($name, $value, $autoload = true)
{
    $GLOBALS['gainsoc_options'][$name] = $value;
    return true;
}

function get_site_url()
{
    return 'https://example.com';
}

function sanitize_key($key)
{
    return preg_replace('/[^a-z0-9_\-]/', '', strtolower((string) $key));
}

function sanitize_text_field($str)
{
    return trim(strip_tags((string) $str));
}

function esc_url_raw($url)
{
    return $url;
}

/**
 * A faithful-enough `add_query_arg`.
 *
 * Only the array form is stubbed, because that is the only form the plugin uses. It
 * preserves existing parameters, which is the behaviour the tracked-URL test depends on.
 */
function add_query_arg($args, $url)
{
    $parts = parse_url($url);
    $query = [];

    if (isset($parts['query'])) {
        parse_str($parts['query'], $query);
    }

    foreach ($args as $key => $value) {
        $query[$key] = $value;
    }

    $rebuilt = $parts['scheme'] . '://' . $parts['host'];
    if (isset($parts['path'])) {
        $rebuilt .= $parts['path'];
    }

    return $rebuilt . '?' . http_build_query($query);
}

function apply_filters($hook, $value)
{
    return $value;
}

function __($text, $domain = null)
{
    return $text;
}

// The post fixture the payload builder reads.
$GLOBALS['gainsoc_permalink'] = 'https://example.com/hello-world/';

function get_permalink($post)
{
    return $GLOBALS['gainsoc_permalink'];
}

require_once __DIR__ . '/../includes/content.php';
require_once __DIR__ . '/../includes/share.php';

// -----------------------------------------------------------------------------
// A minimal assertion harness
// -----------------------------------------------------------------------------

$GLOBALS['gainsoc_failures'] = 0;
$GLOBALS['gainsoc_ran'] = 0;

function check($label, $actual, $expected)
{
    $GLOBALS['gainsoc_ran']++;

    if ($actual === $expected) {
        echo "  ok    {$label}\n";
        return;
    }

    $GLOBALS['gainsoc_failures']++;
    echo "  FAIL  {$label}\n";
    echo "        expected: " . var_export($expected, true) . "\n";
    echo "        actual:   " . var_export($actual, true) . "\n";
}

function reset_options()
{
    $GLOBALS['gainsoc_options'] = [];
    $GLOBALS['gainsoc_permalink'] = 'https://example.com/hello-world/';
}

// -----------------------------------------------------------------------------
// Tracked URLs
// -----------------------------------------------------------------------------

echo "Tracked URLs\n";

reset_options();
check(
    'the permalink is untouched when tracking is off',
    gainsoc_tracked_url(null, 'linkedin'),
    'https://example.com/hello-world/'
);

reset_options();
update_option('gainsoc_utm_enabled', true);
check(
    'the network becomes the source, so networks are distinguishable in a report',
    gainsoc_tracked_url(null, 'linkedin'),
    'https://example.com/hello-world/?utm_source=linkedin&utm_medium=social&utm_campaign=gainingsocial'
);

reset_options();
update_option('gainsoc_utm_enabled', true);
check(
    'a share with no named network still gets a usable source',
    gainsoc_tracked_url(null, null),
    'https://example.com/hello-world/?utm_source=social&utm_medium=social&utm_campaign=gainingsocial'
);

reset_options();
update_option('gainsoc_utm_enabled', true);
update_option('gainsoc_utm_campaign', 'spring launch');
// Encoded exactly once. The first version of this called `rawurlencode` on the campaign
// before handing it to `add_query_arg`, which encodes values itself — the result was
// `spring%2520launch`, a permanently wrong row in every analytics report.
check(
    'a campaign name with a space is encoded once, not twice',
    gainsoc_tracked_url(null, 'x'),
    'https://example.com/hello-world/?utm_source=x&utm_medium=social&utm_campaign=spring+launch'
);

reset_options();
update_option('gainsoc_utm_enabled', true);
update_option('gainsoc_utm_campaign', '   ');
check(
    'a blank campaign falls back rather than emitting utm_campaign=',
    gainsoc_tracked_url(null, 'x'),
    'https://example.com/hello-world/?utm_source=x&utm_medium=social&utm_campaign=gainingsocial'
);

// The case that motivated using `add_query_arg` instead of string concatenation: a site
// with plain permalinks, where appending "?utm_source=..." by hand loses the post ID.
reset_options();
update_option('gainsoc_utm_enabled', true);
$GLOBALS['gainsoc_permalink'] = 'https://example.com/?p=12';
check(
    'an unpretty permalink keeps its existing query parameters',
    gainsoc_tracked_url(null, 'bluesky'),
    'https://example.com/?p=12&utm_source=bluesky&utm_medium=social&utm_campaign=gainingsocial'
);

// -----------------------------------------------------------------------------
// Destinations
// -----------------------------------------------------------------------------

echo "\nDestinations\n";

reset_options();
check('no destinations configured yields no targets', gainsoc_selected_targets(), []);

reset_options();
update_option('gainsoc_destination_ids', ['dst_1', '', 'dst_2']);
check(
    'blank destination IDs are dropped rather than sent',
    gainsoc_selected_targets(),
    [['destination_id' => 'dst_1'], ['destination_id' => 'dst_2']]
);

// -----------------------------------------------------------------------------
// Idempotency keys
// -----------------------------------------------------------------------------

echo "\nIdempotency keys\n";

$first = gainsoc_idempotency_key(42, 0);

check(
    'the same post and attempt produce the same key, so a retried cron run replays',
    gainsoc_idempotency_key(42, 0),
    $first
);

$second = gainsoc_idempotency_key(42, 1);

// This is the one that matters for evergreen. A re-share is byte-identical content, so a
// key derived from the payload would collide and the API would replay the original
// response instead of publishing again — the feature would silently do nothing.
if ($second === $first) {
    $GLOBALS['gainsoc_failures']++;
    echo "  FAIL  a re-share must not reuse the first share's key\n";
} else {
    echo "  ok    a re-share gets a distinct key, so it publishes rather than replaying\n";
}
$GLOBALS['gainsoc_ran']++;

if (gainsoc_idempotency_key(43, 0) === $first) {
    $GLOBALS['gainsoc_failures']++;
    echo "  FAIL  two different posts must not share a key\n";
} else {
    echo "  ok    two different posts get different keys\n";
}
$GLOBALS['gainsoc_ran']++;

check(
    'the key stays within the API\'s 8-255 character bound',
    strlen($first) >= 8 && strlen($first) <= 255,
    true
);

// -----------------------------------------------------------------------------

echo "\n";
if ($GLOBALS['gainsoc_failures'] > 0) {
    echo "{$GLOBALS['gainsoc_failures']} of {$GLOBALS['gainsoc_ran']} checks failed\n";
    exit(1);
}
echo "all {$GLOBALS['gainsoc_ran']} checks passed\n";
exit(0);
