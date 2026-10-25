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
      },
      transitionDuration: {
        DEFAULT: '150ms',
        fast: 'var(--duration-fast)',
        base: 'var(--duration-base)',
      },
      transitionTimingFunction: {
        DEFAULT: 'var(--ease-out)',
        out: 'var(--ease-out)',
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
      },
      animation: {
        'toast-in': 'toast-in 200ms var(--ease-out)',
        'live-pulse': 'live-pulse 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [animate],
} satisfies Config;
