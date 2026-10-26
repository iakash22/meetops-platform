/**
 * Shared auth-page classes (tokens only; see docs/05-web/auth-pages.md).
 * - Links use the `link` token (#3AB0E0) and the `ring` focus token, with a 44px hit area.
 * - Inputs are 44px tall with 16px text (no iOS zoom) and a cerulean focus glow.
 */
export const authLinkClass =
  'inline-flex min-h-11 items-center rounded-sm font-medium text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

export const authInputClass =
  'h-11 text-base md:text-base focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/20 focus-visible:shadow-[0_0_24px_-6px_hsl(var(--primary))]';

export const authButtonClass = 'h-11 w-full text-base';

/**
 * Inline error text on the dark card: `--destructive-text` (#F87171) is 6.65:1 on #141416 (AA).
 * `--destructive` (#EF4444, 4.89:1) stays for borders and icons.
 */
export const authErrorTextClass = 'text-destructive-text';
