import { clsx } from 'clsx';

const SIZES = { sm: 'size-8 text-xs', md: 'size-9 text-sm', lg: 'size-24 text-2xl' } as const;

function initials(name: string | undefined | null): string {
  return (name ?? '')
    .split(' ')
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/** Profile photo, or the person's initials when no photo is set. */
export function Avatar({ name, src, size = 'md', className }: { name?: string | null; src?: string | null; size?: keyof typeof SIZES; className?: string }) {
  return src ? (
    <img src={src} alt={name ? `${name}'s photo` : 'Profile photo'} className={clsx('shrink-0 rounded-full object-cover ring-2 ring-white', SIZES[size], className)} />
  ) : (
    <span aria-hidden className={clsx('flex shrink-0 items-center justify-center rounded-full bg-brand-800 font-bold text-white', SIZES[size], className)}>
      {initials(name)}
    </span>
  );
}
