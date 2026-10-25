import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge the custom type-scale tokens (tailwind.config.ts → fontSize) so that e.g.
// `text-h1` and `text-foreground` are not treated as conflicting colour classes.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'display',
            'h1',
            'h2',
            'h3',
            'h4',
            'h5',
            'h6',
            'body-lg',
            'body',
            'small',
            'caption',
            'overline',
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
