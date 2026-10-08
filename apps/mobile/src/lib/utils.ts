import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge told about global.css's own scale. Without it, `text-small` (a size) and
 * `text-primary` (a colour) look like the same kind of class, so one silently drops the other.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['title', 'heading', 'body', 'small'],
      radius: ['card', 'control'],
      font: ['heading', 'title'],
    },
  },
});

/** Class names joined, later Tailwind classes winning over earlier ones (shadcn's cn). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
