import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
          text: 'hsl(var(--destructive-text))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
          text: 'hsl(var(--warning-text))',
        },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        highlight: {
          DEFAULT: 'hsl(var(--highlight))',
          foreground: 'hsl(var(--highlight-foreground))',
        },
        link: 'hsl(var(--link))',
      },
      // Radius scale 8 / 12 / 16 px off --radius (0.75rem).
      borderRadius: {
        xl: 'calc(var(--radius) + 4px)',
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 4px)',
        sm: 'calc(var(--radius) - 6px)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      // Type scale (docs/05-web/typography-and-motion.md). Fluid clamp() for display/h1/h2.
      fontSize: {
        display: [
          'clamp(2.25rem, 1.6rem + 2.6vw, 3.75rem)',
          { lineHeight: '1.1', letterSpacing: '-0.025em', fontWeight: '700' },
        ],
        h1: [
          'clamp(1.875rem, 1.6rem + 1.1vw, 2.25rem)',
          { lineHeight: '1.2', letterSpacing: '-0.02em', fontWeight: '600' },
        ],
        h2: [
          'clamp(1.5rem, 1.35rem + 0.6vw, 1.875rem)',
          { lineHeight: '1.25', letterSpacing: '-0.015em', fontWeight: '600' },
        ],
        h3: ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.01em', fontWeight: '600' }],
        h4: ['1.125rem', { lineHeight: '1.625rem', letterSpacing: '-0.005em', fontWeight: '600' }],
        h5: ['1rem', { lineHeight: '1.5rem', letterSpacing: '0', fontWeight: '600' }],
        h6: ['0.875rem', { lineHeight: '1.25rem', letterSpacing: '0', fontWeight: '600' }],
        'body-lg': ['1rem', { lineHeight: '1.625rem', letterSpacing: '0' }],
        body: ['0.875rem', { lineHeight: '1.375rem', letterSpacing: '0' }],
        small: ['0.8125rem', { lineHeight: '1.25rem', letterSpacing: '0' }],
        caption: ['0.75rem', { lineHeight: '1rem', letterSpacing: '0.005em' }],
        overline: ['0.75rem', { lineHeight: '1rem', letterSpacing: '0.08em', fontWeight: '600' }],
      },
      // Semantic layout sizes on top of Tailwind's 4px spacing scale.
      spacing: {
        header: 'var(--header-height)',
        sidebar: 'var(--sidebar-width)',
        'sidebar-collapsed': 'var(--sidebar-width-collapsed)',
      },
      maxWidth: {
        measure: 'var(--measure)',
        content: 'var(--content-max)',
      },
      transitionDuration: {
        DEFAULT: '150ms',
        instant: 'var(--duration-instant)',
        fast: 'var(--duration-fast)',
        base: 'var(--duration-base)',
        slow: 'var(--duration-slow)',
      },
      transitionTimingFunction: {
        DEFAULT: 'var(--ease-out)',
        out: 'var(--ease-out)',
        standard: 'var(--ease-standard)',
        in: 'var(--ease-in)',
      },
      keyframes: {
        'toast-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'live-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        'fade-in': { from: { opacity: '0' } },
        'fade-out': { to: { opacity: '0' } },
        'enter-up': { from: { opacity: '0', transform: 'translateY(4px) scale(0.98)' } },
        'exit-down': { to: { opacity: '0', transform: 'translateY(4px) scale(0.98)' } },
        'page-in': { from: { opacity: '0', transform: 'translateY(8px)' } },
      },
      animation: {
        'toast-in': 'toast-in 200ms var(--ease-out)',
        'live-pulse': 'live-pulse 1.6s ease-in-out infinite',
        'fade-in': 'fade-in var(--duration-fast) var(--ease-out) both',
        'fade-out': 'fade-out var(--duration-instant) var(--ease-in) both',
        'enter-up': 'enter-up var(--duration-fast) var(--ease-out) both',
        'exit-down': 'exit-down var(--duration-instant) var(--ease-in) both',
        'page-in': 'page-in var(--duration-base) var(--ease-out) both',
      },
    },
  },
  plugins: [animate],
} satisfies Config;
