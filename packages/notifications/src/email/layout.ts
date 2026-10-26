import { escapeHtml, safeUrl } from './escape.js';
import {
  BANNER_CID,
  BANNER_FALLBACK,
  BANNER_HEIGHT,
  BANNER_WIDTH,
  type BannerCategory,
} from './banner.js';
import { LOGO_CID } from './logo.js';
import type { EmailMessages } from './strings.js';
import { emailTheme as t } from './theme.js';

/**
 * Email-client-safe building blocks: table layout, inline styles, no external CSS/JS, no remote images,
 * no tracking pixels. The only image is the logo, sent as an inline CID attachment (see logo.ts). The only
 * <style> block holds the light-scheme fallback and mobile tweaks; every colour is also inlined so clients
 * that strip <style> still render the dark theme.
 *
 * Block helpers return already-escaped HTML. Pass user data ONLY as plain strings to these helpers; they
 * escape it. Never concatenate raw user input into the HTML they return.
 */
export type Html = { readonly __html: string };
const html = (s: string): Html => ({ __html: s });
const r = t.radius;
const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';
const nl2br = (s: string) => escapeHtml(s).replace(/\n/g, '<br>');

export function paragraph(text: string, opts: { muted?: boolean; small?: boolean } = {}): Html {
  const color = opts.muted ? t.muted : t.text;
  const size = opts.small ? 13 : 15;
  return html(
    `<p class="${opts.muted ? 'mo-muted' : 'mo-text'}" style="margin:0 0 16px;color:${color};font-size:${size}px;line-height:1.65;">${nl2br(text)}</p>`,
  );
}

/** Small uppercase label above the hero heading (type scale "overline": 12px, 0.08em, 600). */
export function overline(text: string): Html {
  // Rose (#FF2D95) appears only as a small live-dot fill next to the label, never as text.
  const dot = `<span style="display:inline-block;width:8px;height:8px;margin:0 8px 1px 0;border-radius:50%;background-color:${t.highlight};vertical-align:middle;"></span>`;
  return html(
    `<p class="mo-link" style="margin:0 0 12px;color:${t.link};font-size:12px;line-height:16px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;">${dot}${escapeHtml(text)}</p>`,
  );
}

export function heading(text: string, level: 1 | 2 = 2): Html {
  const style =
    level === 1
      ? 'margin:0 0 16px;font-size:28px;line-height:1.2;letter-spacing:-0.02em;font-weight:700;'
      : 'margin:8px 0 12px;font-size:13px;line-height:20px;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;';
  const color = level === 1 ? t.text : t.muted;
  return html(
    `<h${level} class="${level === 1 ? 'mo-text mo-h1' : 'mo-muted'}" style="${style}color:${color};">${escapeHtml(text)}</h${level}>`,
  );
}

/** Bulletproof button: a cerulean-filled table cell with a padded link (works in Outlook without VML images). */
export function button(url: string, label: string): Html {
  const href = escapeHtml(safeUrl(url));
  return html(
    `<table ${TABLE} style="margin:8px 0 28px;"><tr><td align="center" bgcolor="${t.primaryFill}" style="border-radius:${r.md}px;background-color:${t.primaryFill};border:1px solid ${t.link};">` +
      `<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;min-height:46px;line-height:46px;padding:0 28px;font-size:15px;font-weight:600;letter-spacing:0.01em;color:${t.onPrimary};text-decoration:none;border-radius:${r.md}px;mso-line-height-rule:exactly;">${escapeHtml(label)}&nbsp;&rarr;</a>` +
      `</td></tr></table>`,
  );
}

export function linkFallback(url: string, m: EmailMessages): Html {
  const safe = safeUrl(url);
  return html(
    `<table ${TABLE} width="100%" style="margin:0 0 8px;border-top:1px solid ${t.border};"><tr><td style="padding-top:20px;">` +
      `<p class="mo-muted" style="margin:0 0 6px;color:${t.muted};font-size:12px;line-height:1.5;">${escapeHtml(m.buttonFallback)}</p>` +
      `<a class="mo-link" href="${escapeHtml(safe)}" style="color:${t.link};font-family:${t.monoStack};font-size:12px;line-height:1.6;text-decoration:underline;word-break:break-all;">${escapeHtml(safe)}</a>` +
      `</td></tr></table>`,
  );
}

/** A raised card of plain-text lines. The first line can be emphasised as a title. */
export function panel(
  lines: string[],
  accent: 'primary' | 'destructive' = 'primary',
  opts: { titleFirst?: boolean } = {},
): Html {
  const danger = accent === 'destructive';
  const bar = danger ? t.destructive : t.primaryFill;
  const bg = danger ? t.destructiveTint : t.surfaceRaised;
  const body = lines
    .map((l, i) => {
      const title = opts.titleFirst && i === 0;
      const last = i === lines.length - 1;
      const color = title || danger || lines.length === 1 ? t.text : t.muted;
      return `<p class="${color === t.text ? 'mo-text' : 'mo-muted'}" style="margin:0 0 ${last ? 0 : title ? 10 : 6}px;color:${color};font-size:${title ? 17 : 15}px;font-weight:${title ? 600 : 400};line-height:1.6;">${nl2br(l)}</p>`;
    })
    .join('');
  return html(
    `<table ${TABLE} width="100%" style="margin:0 0 24px;border-collapse:separate;"><tr>` +
      `<td class="mo-surface" bgcolor="${bg}" style="background-color:${bg};padding:18px 20px;border:1px solid ${t.border};border-left:3px solid ${bar};border-radius:${r.lg}px;">${body}</td>` +
      `</tr></table>`,
  );
}

/** Inline pill chips (meeting date, counts, roles). */
export function chips(
  items: (string | false | undefined | null)[],
  tone: 'neutral' | 'primary' = 'neutral',
): Html {
  const list = items.filter((i): i is string => !!i);
  if (list.length === 0) return html('');
  const bg = tone === 'primary' ? t.primaryTint : t.surfaceRaised;
  const fg = tone === 'primary' ? t.link : t.text;
  const cells = list
    .map(
      (c) =>
        `<td style="padding:0 8px 8px 0;"><span class="${tone === 'primary' ? 'mo-link' : 'mo-text'}" style="display:inline-block;padding:5px 12px;border-radius:999px;background-color:${bg};border:1px solid ${t.border};color:${fg};font-size:12px;line-height:16px;font-weight:600;white-space:nowrap;">${escapeHtml(c)}</span></td>`,
    )
    .join('');
  return html(`<table ${TABLE} style="margin:0 0 16px;"><tr>${cells}</tr></table>`);
}

/** Numbered rows inside one bordered card (action items, task lists). Each row: title + optional meta chips. */
export function itemList(items: { title: string; meta?: (string | false | undefined)[] }[]): Html {
  if (items.length === 0) return html('');
  const rows = items
    .map((it, i) => {
      const meta = (it.meta ?? []).filter((x): x is string => !!x);
      const metaHtml = meta.length
        ? `<p class="mo-muted" style="margin:4px 0 0;color:${t.muted};font-size:13px;line-height:1.5;">${meta.map(escapeHtml).join(' &nbsp;&middot;&nbsp; ')}</p>`
        : '';
      const sep = i === 0 ? '' : `border-top:1px solid ${t.border};`;
      return (
        `<tr><td width="28" valign="top" style="padding:14px 0 14px 16px;${sep}">` +
        `<span class="mo-link" style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;border-radius:${r.sm}px;background-color:${t.primaryTint};color:${t.link};font-size:12px;font-weight:700;">${i + 1}</span></td>` +
        `<td valign="top" style="padding:14px 16px 14px 12px;${sep}">` +
        `<p class="mo-text" style="margin:0;color:${t.text};font-size:15px;line-height:1.5;font-weight:500;">${escapeHtml(it.title)}</p>${metaHtml}</td></tr>`
      );
    })
    .join('');
  return html(
    `<table ${TABLE} width="100%" class="mo-surface" bgcolor="${t.surfaceRaised}" style="margin:0 0 24px;background-color:${t.surfaceRaised};border:1px solid ${t.border};border-radius:${r.lg}px;border-collapse:separate;">${rows}</table>`,
  );
}

/** Plain bullet list, kept for simple lists. */
export function bulletList(items: string[]): Html {
  return itemList(items.map((title) => ({ title })));
}

export const join = (...parts: (Html | false | '' | 0 | undefined | null)[]): Html =>
  html(
    parts
      .filter((p): p is Html => !!p)
      .map((p) => p.__html)
      .join(''),
  );

/** Logo (CID image, alt text) + "MeetOps AI" wordmark matching apps/web MeetOpsLogo. */
function wordmark(m: EmailMessages, size: 'lg' | 'sm' = 'lg', onHero = false): string {
  const px = size === 'lg' ? 36 : 22;
  const fs = size === 'lg' ? 19 : 14;
  return (
    `<table ${TABLE}><tr>` +
    `<td width="${px}" style="width:${px}px;"><img src="cid:${LOGO_CID}" width="${px}" height="${px}" alt="${escapeHtml(m.logoAlt)}" style="display:block;width:${px}px;height:${px}px;border:0;outline:none;text-decoration:none;border-radius:${size === 'lg' ? 9 : 6}px;color:${t.text};font-size:10px;"></td>` +
    `<td${onHero ? '' : ' class="mo-text"'} style="padding-left:${size === 'lg' ? 12 : 8}px;color:${t.text};font-size:${fs}px;font-weight:600;letter-spacing:-0.01em;white-space:nowrap;">${escapeHtml(m.brand)} <span${onHero ? '' : ' class="mo-link"'} style="color:${t.link};">${escapeHtml(m.brandSuffix)}</span></td>` +
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
  /** Hero banner (inline CID image) shown at the top of the card. */
  banner?: { category: BannerCategory; alt: string; eyebrow: string; title: string } | undefined;
}

const lightCss =
  `@media (prefers-color-scheme: light){` +
  `.mo-bg{background-color:${t.light.background}!important}` +
  `.mo-surface{background-color:${t.light.surface}!important;border-color:${t.light.border}!important}` +
  `.mo-text{color:${t.light.text}!important}` +
  `.mo-muted{color:${t.light.muted}!important}` +
  `.mo-link{color:${t.light.link}!important}}` +
  `[data-ogsc] .mo-text{color:${t.light.text}!important}` +
  `@media only screen and (max-width:620px){.mo-container{width:100%!important}.mo-pad{padding:28px 22px!important}.mo-h1{font-size:24px!important}}`;

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
  const small = `margin:0 0 8px;color:${t.muted};font-size:12px;line-height:1.6;`;
  return (
    `<!doctype html><html lang="${escapeHtml(o.lang)}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="X-UA-Compatible" content="IE=edge">` +
    `<meta name="color-scheme" content="dark light"><meta name="supported-color-schemes" content="dark light">` +
    `<meta name="x-apple-disable-message-reformatting">` +
    `<title>${escapeHtml(o.subject)}</title><style>${lightCss}</style></head>` +
    `<body class="mo-bg" style="margin:0;padding:0;background-color:${t.background};-webkit-text-size-adjust:100%;">` +
    `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${t.background};">${escapeHtml(o.preheader)}${preheaderPad}</div>` +
    `<table ${TABLE} class="mo-bg" width="100%" bgcolor="${t.background}" style="background-color:${t.background};">` +
    `<tr><td align="center" style="padding:24px 12px 40px;">` +
    `<table ${TABLE} class="mo-container" width="600" style="width:600px;max-width:600px;font-family:${t.fontStack};">` +
    // Card: cerulean hairline on top (fill only), then content
    `<tr><td class="mo-surface" bgcolor="${t.surface}" style="background-color:${t.surface};border:1px solid ${t.border};border-radius:${r.xl}px;overflow:hidden;">` +
    `<table ${TABLE} width="100%">` +
    (o.banner
      ? `<tr><td>${banner(m, o.banner)}</td></tr>`
      : `<tr><td height="3" bgcolor="${t.primaryFill}" style="height:3px;line-height:3px;font-size:0;background-color:${t.primaryFill};border-radius:${r.xl}px ${r.xl}px 0 0;">&nbsp;</td></tr>`) +
    `<tr><td class="mo-pad" style="padding:40px 40px 32px;">${o.body.__html}</td></tr></table>` +
    `</td></tr>` +
    // Footer
    `<tr><td style="padding:28px 4px 0;">` +
    `<table ${TABLE} width="100%"><tr><td style="padding-bottom:16px;border-bottom:1px solid ${t.border};">${wordmark(m, 'sm')}</td></tr>` +
    `<tr><td style="padding-top:16px;">` +
    `<p class="mo-muted" style="${small}">${escapeHtml(m.tagline)}</p>` +
    `<p class="mo-muted" style="${small}">${escapeHtml(footerNote)}</p>` +
    (footerLinks.length
      ? `<p class="mo-muted" style="${small}">${footerLinks.join(' &nbsp;&middot;&nbsp; ')}</p>`
      : '') +
    `<p class="mo-muted" style="margin:0;color:${t.muted};font-size:12px;">&copy; ${escapeHtml(m.brand)} ${escapeHtml(m.brandSuffix)}</p>` +
    `</td></tr></table>` +
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

/** Glyphs for the image-free icon row (Outlook desktop / images off). */
const GLYPHS = ['&#9679;', '&#8767;', '&#10022;', '&#9745;', '&#10227;'] as const;

/**
 * Hero banner. Every word is live text; the only image is the animated icon strip, which modern clients get
 * and Outlook desktop never sees (it gets table cells + VML instead). With images blocked elsewhere, the strip's
 * cell keeps its dark fill and coloured alt text, and the chip, tagline and labels still render.
 */
function banner(
  m: EmailMessages,
  b: { category: BannerCategory; alt: string; eyebrow: string; title: string },
): string {
  const h = BANNER_FALLBACK;
  const cols = m.bannerFeatures;
  const top =
    `<tr><td class="mo-pad" style="padding:28px 40px 0;">${wordmark(m, 'lg', true)}</td></tr>` +
    `<tr><td class="mo-pad" style="padding:28px 40px 0;"><table ${TABLE}><tr>` +
    // Rose live dot: a filled cell in its own table so it stays an 8x8 dot (accent only, no text on it).
    `<td valign="middle" style="width:8px;"><table ${TABLE} width="8"><tr><td width="8" height="8" bgcolor="${t.highlight}" style="width:8px;height:8px;max-height:8px;background-color:${t.highlight};border-radius:50%;font-size:1px;line-height:8px;mso-line-height-rule:exactly;">&#8203;</td></tr></table></td>` +
    `<td style="padding-left:10px;color:${t.link};font-size:12px;line-height:16px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;font-family:${t.fontStack};">${escapeHtml(b.eyebrow)}</td>` +
    `</tr></table></td></tr>` +
    `<tr><td class="mo-pad" style="padding:12px 40px 8px;"><h1 class="mo-h1" style="margin:0;color:${t.text};font-size:30px;line-height:1.2;letter-spacing:-0.02em;font-weight:700;font-family:${t.fontStack};">${escapeHtml(b.title)}</h1></td></tr>`;
  const gif = `<!--[if !mso]><!--><img src="cid:${BANNER_CID}" width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}" alt="${escapeHtml(b.alt)}" style="display:block;width:100%;max-width:${BANNER_WIDTH}px;height:auto;border:0;outline:none;text-decoration:none;background-color:${h};color:${t.muted};font-size:12px;line-height:1.5;font-family:${t.fontStack};"><!--<![endif]-->`;
  const msoIcons =
    `<!--[if mso]><table ${TABLE} width="600"><tr>` +
    GLYPHS.map(
      (g) =>
        `<td width="120" align="center" style="padding:16px 0 12px;"><table ${TABLE}><tr><td width="44" height="44" align="center" valign="middle" bgcolor="#10232C" style="width:44px;height:44px;background-color:#10232C;border:1px solid #1B3A48;color:#4F7D90;font-size:18px;font-family:Segoe UI Symbol,Arial,sans-serif;">${g}</td></tr></table></td>`,
    ).join('') +
    `</tr></table><![endif]-->`;
  const labels =
    `<table ${TABLE} width="100%"><tr>` +
    cols
      .map(
        (c) =>
          `<td width="20%" align="center" style="padding:0 0 22px;color:${t.muted};font-size:12px;line-height:16px;font-weight:500;font-family:${t.fontStack};">${escapeHtml(c)}</td>`,
      )
      .join('') +
    `</tr></table>`;
  // Modern clients: solid fill + CSS glow gradients (dropped harmlessly where unsupported).
  const bg = `background-color:${h};background-image:radial-gradient(circle at 92% 0%,rgba(0,123,167,0.38),rgba(0,123,167,0) 50%),radial-gradient(circle at 0% 0%,rgba(255,45,149,0.14),rgba(255,45,149,0) 35%);`;
  const inner =
    `<table ${TABLE} width="100%" bgcolor="${h}" style="${bg}">` +
    top +
    `<tr><td style="padding-top:20px;font-size:0;line-height:0;">${gif}${msoIcons}</td></tr>` +
    `<tr><td>${labels}</td></tr></table>`;
  return (
    `<div style="background-color:${h};border-bottom:1px solid ${t.border};border-radius:${r.xl}px ${r.xl}px 0 0;overflow:hidden;">` +
    `<!--[if gte mso 9]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:600px;"><v:fill type="gradient" color="${h}" color2="${t.primaryTint}" angle="135"/><v:textbox style="mso-fit-shape-to-text:true" inset="0,0,0,0"><![endif]-->` +
    inner +
    `<!--[if gte mso 9]></v:textbox></v:rect><![endif]-->` +
    `</div>`
  );
}
