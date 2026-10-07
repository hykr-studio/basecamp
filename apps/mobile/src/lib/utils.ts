import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Class names joined, later Tailwind classes winning over earlier ones (shadcn's cn). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
