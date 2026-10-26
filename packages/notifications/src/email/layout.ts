import { escapeHtml, safeUrl } from './escape.js';
import type { EmailMessages } from './strings.js';
import { emailTheme as t } from './theme.js';

/**
 * Email-client-safe building blocks: table layout, inline styles, no external CSS/JS, no remote images,
 * no tracking pixels. The only <style> block holds the light-scheme fallback and mobile tweaks; every
 * colour is also inlined so clients that strip <style> still render the dark theme.
 *
 * Block helpers return already-escaped HTML. Pass user data ONLY as plain strings to these helpers; they
 * escape it. Never concatenate raw user input into the HTML they return.
 */
export type Html = { readonly __html: string };
const html = (s: string): Html => ({ __html: s });

export function paragraph(text: string, opts: { muted?: boolean; small?: boolean } = {}): Html {
  const color = opts.muted ? t.muted : t.text;
  const size = opts.small ? 13 : 16;
  return html(
    `<p class="${opts.muted ? 'mo-muted' : 'mo-text'}" style="margin:0 0 16px;color:${color};font-size:${size}px;line-height:1.6;">${escapeHtml(text).replace(/\n/g, '<br>')}</p>`,
  );
}

export function heading(text: string, level: 1 | 2 = 2): Html {
  const size = level === 1 ? 22 : 17;
  return html(
    `<h${level} class="mo-text" style="margin:0 0 12px;color:${t.text};font-size:${size}px;line-height:1.3;font-weight:600;">${escapeHtml(text)}</h${level}>`,
  );
}

/** Bulletproof button: a cerulean-filled table cell with a padded link (works in Outlook without VML images). */
export function button(url: string, label: string): Html {
  const href = escapeHtml(safeUrl(url));
  return html(
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td align="center" bgcolor="${t.primaryFill}" style="border-radius:8px;background-color:${t.primaryFill};">` +
      `<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;min-height:44px;line-height:44px;padding:0 24px;font-size:16px;font-weight:600;color:${t.onPrimary};text-decoration:none;border-radius:8px;mso-line-height-rule:exactly;">${escapeHtml(label)}</a>` +
      `</td></tr></table>`,
  );
}

export function linkFallback(url: string, m: EmailMessages): Html {
  const safe = safeUrl(url);
  return html(
    `<p class="mo-muted" style="margin:0 0 16px;color:${t.muted};font-size:13px;line-height:1.5;">${escapeHtml(m.buttonFallback)}<br>` +
      `<a class="mo-link" href="${escapeHtml(safe)}" style="color:${t.link};text-decoration:underline;word-break:break-all;">${escapeHtml(safe)}</a></p>`,
  );
}

/** A bordered panel of plain-text lines (task details, summary). */
export function panel(lines: string[], accent: 'primary' | 'destructive' = 'primary'): Html {
  const bar = accent === 'destructive' ? t.destructive : t.primaryFill;
  const body = lines
    .map(
      (l) =>
        `<p class="mo-text" style="margin:0 0 6px;color:${t.text};font-size:15px;line-height:1.5;">${escapeHtml(l).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
  return html(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr>` +
      `<td width="4" bgcolor="${bar}" style="background-color:${bar};width:4px;border-radius:4px 0 0 4px;"></td>` +
      `<td class="mo-surface" bgcolor="${t.surface}" style="background-color:${t.surface};padding:14px 16px;border:1px solid ${t.border};border-left:0;border-radius:0 8px 8px 0;">${body}</td>` +
      `</tr></table>`,
  );
}

export function bulletList(items: string[]): Html {
  if (items.length === 0) return html('');
  const li = items
    .map(
      (i) =>
        `<li class="mo-text" style="margin:0 0 8px;color:${t.text};font-size:15px;line-height:1.5;">${escapeHtml(i)}</li>`,
    )
    .join('');
  return html(`<ul style="margin:0 0 20px;padding:0 0 0 20px;">${li}</ul>`);
}

export const join = (...parts: (Html | false | '' | 0 | undefined | null)[]): Html =>
  html(
    parts
      .filter((p): p is Html => !!p)
      .map((p) => p.__html)
      .join(''),
  );

/** Inline SVG-free text wordmark: no remote images, renders everywhere. */
function wordmark(m: EmailMessages): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td width="12" height="12" bgcolor="${t.primaryFill}" style="width:12px;height:12px;background-color:${t.primaryFill};border-radius:3px;font-size:0;line-height:0;">&nbsp;</td>` +
    `<td class="mo-text" style="padding-left:10px;color:${t.text};font-size:18px;font-weight:700;letter-spacing:0.2px;">${escapeHtml(m.brand)}</td>` +
    `</tr></table>`
  );
}

export interface LayoutOptions {
  lang: string;
  subject: string;
  preheader: string;
  body: Html;
  m: EmailMessages;
  /** Required for non-auth (product) mail; omitted for auth/security mail which can't be unsubscribed. */
  preferencesUrl?: string | undefined;
  unsubscribeUrl?: string | undefined;
}

const lightCss =
  `@media (prefers-color-scheme: light){` +
  `.mo-bg{background-color:${t.light.background}!important}` +
  `.mo-surface{background-color:${t.light.surface}!important;border-color:${t.light.border}!important}` +
  `.mo-text{color:${t.light.text}!important}` +
  `.mo-muted{color:${t.light.muted}!important}` +
  `.mo-link{color:${t.light.link}!important}}` +
  `[data-ogsc] .mo-text{color:${t.light.text}!important}` +
  `@media only screen and (max-width:620px){.mo-container{width:100%!important}.mo-pad{padding:24px 20px!important}}`;

export function layout(o: LayoutOptions): string {
  const { m } = o;
  const footerLinks: string[] = [];
  if (o.preferencesUrl) {
    footerLinks.push(
      `<a class="mo-link" href="${escapeHtml(safeUrl(o.preferencesUrl))}" style="color:${t.link};text-decoration:underline;">${escapeHtml(m.managePreferences)}</a>`,
    );
  }
  if (o.unsubscribeUrl) {
    footerLinks.push(
      `<a class="mo-link" href="${escapeHtml(safeUrl(o.unsubscribeUrl))}" style="color:${t.link};text-decoration:underline;">${escapeHtml(m.unsubscribe)}</a>`,
    );
  }
  const footerNote = o.preferencesUrl ? m.footerProduct : m.footerAuth;
  // Pad the preheader so clients don't pull body text into the inbox preview.
  const preheaderPad = '&#847;&zwnj;&nbsp;'.repeat(40);
  return (
    `<!doctype html><html lang="${escapeHtml(o.lang)}" xmlns="http://www.w3.org/1999/xhtml"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="X-UA-Compatible" content="IE=edge">` +
    `<meta name="color-scheme" content="dark light"><meta name="supported-color-schemes" content="dark light">` +
    `<meta name="x-apple-disable-message-reformatting">` +
    `<title>${escapeHtml(o.subject)}</title><style>${lightCss}</style></head>` +
    `<body class="mo-bg" style="margin:0;padding:0;background-color:${t.background};-webkit-text-size-adjust:100%;">` +
    `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${t.background};">${escapeHtml(o.preheader)}${preheaderPad}</div>` +
    `<table role="presentation" class="mo-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${t.background}" style="background-color:${t.background};">` +
    `<tr><td align="center" style="padding:32px 12px;">` +
    `<table role="presentation" class="mo-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;font-family:${t.fontStack};">` +
    `<tr><td style="padding:0 8px 20px;">${wordmark(m)}</td></tr>` +
    `<tr><td class="mo-surface mo-pad" bgcolor="${t.surface}" style="background-color:${t.surface};border:1px solid ${t.border};border-top:3px solid ${t.primaryFill};border-radius:12px;padding:32px;">${o.body.__html}</td></tr>` +
    `<tr><td style="padding:20px 8px 0;">` +
    `<p class="mo-muted" style="margin:0 0 8px;color:${t.muted};font-size:12px;line-height:1.5;">${escapeHtml(footerNote)}</p>` +
    (footerLinks.length
      ? `<p class="mo-muted" style="margin:0 0 8px;color:${t.muted};font-size:12px;line-height:1.5;">${footerLinks.join(' &middot; ')}</p>`
      : '') +
    `<p class="mo-muted" style="margin:0;color:${t.muted};font-size:12px;">&copy; ${escapeHtml(m.brand)}</p>` +
    `</td></tr></table></td></tr></table></body></html>`
  );
}

/** Plain-text twin of `layout`. */
export function textLayout(o: {
  m: EmailMessages;
  lines: (string | false | 0 | undefined | null)[];
  preferencesUrl?: string | undefined;
  unsubscribeUrl?: string | undefined;
}): string {
  const body = o.lines.filter((l): l is string => typeof l === 'string').join('\n\n');
  const footer = [o.preferencesUrl ? o.m.footerProduct : o.m.footerAuth];
  if (o.preferencesUrl) footer.push(`${o.m.managePreferences}: ${safeUrl(o.preferencesUrl)}`);
  if (o.unsubscribeUrl) footer.push(`${o.m.unsubscribe}: ${safeUrl(o.unsubscribeUrl)}`);
  return `${o.m.brand}\n\n${body}\n\n--\n${footer.join('\n')}\n`;
}
