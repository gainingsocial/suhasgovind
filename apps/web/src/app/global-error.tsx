'use client';

/**
 * Last-resort boundary, for a failure in the root layout itself.
 *
 * Must render its own <html> and <body>: by the time this runs the layout that would
 * normally provide them has failed. It also cannot rely on the stylesheet, so the few
 * styles it needs are inline.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          display: 'grid',
          placeItems: 'center',
          minHeight: '100dvh',
          margin: 0,
          padding: '1.5rem',
          textAlign: 'center',
          background: '#f7f7f8',
          color: '#18191c',
        }}
      >
        <div>
          <h1 style={{ fontSize: '1.125rem', fontWeight: 600 }}>The dashboard failed to load</h1>
          <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: '#5c5f66' }}>
            Reload the page. If it keeps happening, the API may be unavailable.
          </p>
          {error.digest ? (
            <p style={{ marginTop: '0.75rem', fontFamily: 'monospace', fontSize: '0.75rem', color: '#8a8d94' }}>
              Reference: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
