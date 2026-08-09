import Link from 'next/link';

export const metadata = { title: 'Not found' };

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
      <p className="font-mono text-sm text-[var(--text-subtle)]">404</p>
      <h1 className="mt-2 text-xl font-semibold tracking-tight">This page does not exist</h1>
      <p className="mt-1 max-w-sm text-sm text-[var(--text-subtle)]">
        The link may be out of date, or the resource may have been deleted.
      </p>
      <Link
        href="/"
        className="mt-5 inline-flex min-h-9 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white"
      >
        Back to overview
      </Link>
    </div>
  );
}
