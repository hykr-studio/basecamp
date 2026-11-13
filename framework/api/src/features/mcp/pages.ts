// The two pages a person sees while an MCP client connects: sign in, then allow or deny. Plain
// HTML from the API (the flow starts in another app's browser tab, not in ours), in the person's
// language. Everything the client chose (its name, the scopes) is escaped: a client names itself.
import { type Lang, t } from '@hykr/i18n';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);

/** No framing (clickjacking), no other origin's scripts, calls only to this API. */
export const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
};

const STYLE = `
:root { color-scheme: light dark; --bg:#fafaf9; --fg:#1c1917; --muted:#57534e; --line:#d6d3d1; --accent:#1d4ed8; --card:#fff; }
@media (prefers-color-scheme: dark) { :root { --bg:#0c0a09; --fg:#f5f5f4; --muted:#a8a29e; --line:#44403c; --accent:#60a5fa; --card:#1c1917; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, sans-serif; }
main { max-width:28rem; margin:3rem auto; padding:0 1rem; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:1.5rem; }
h1 { font-size:1.25rem; margin:0 0 .5rem; }
p { margin:.5rem 0; } .muted { color:var(--muted); font-size:.9rem; }
label { display:block; margin:.75rem 0 .25rem; font-weight:600; }
input[type=email], input[type=password] { width:100%; padding:.6rem; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; }
fieldset { border:1px solid var(--line); border-radius:8px; margin:1rem 0; padding:.5rem 1rem; }
legend { font-weight:600; padding:0 .25rem; }
.scope { display:flex; gap:.5rem; align-items:center; margin:.4rem 0; font-weight:400; }
.module { margin:.5rem 0 .75rem; } .module .name { font-weight:600; margin:.25rem 0; }
.row { display:flex; gap:.75rem; margin-top:1.25rem; }
button { flex:1; min-height:44px; padding:.6rem 1rem; border-radius:8px; border:1px solid var(--line); background:transparent; color:inherit; font:inherit; cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.error { color:#b91c1c; } @media (prefers-color-scheme: dark) { .error { color:#f87171; } }
`;

function page(lang: Lang, title: string, body: string, script = '') {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main><div class="card">${body}</div></main>${script ? `<script>${script}</script>` : ''}</body>
</html>`;
}

/** A page that only says something (an expired request, a signed-out person). */
export function messagePage(lang: Lang, title: string, message: string) {
  return page(lang, title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

/**
 * The signed query the page posts back (`oauth_query`), a language to carry on, and the consent
 * page it may carry it to: what the server checked, not the address bar, which may hold more (an
 * added `lang`).
 */
const queryField = (oauthQuery: string, carry?: Lang, consent?: string) =>
  `<input type="hidden" id="q" value="${escapeHtml(oauthQuery)}"${carry ? ` data-lang="${escapeHtml(carry)}"` : ''}${consent ? ` data-consent="${escapeHtml(consent)}"` : ''}>`;

/**
 * Where the sign-in page goes once signed in: Better Auth's answer (`target`), with the language
 * carried on only when it is this API's own consent page (`consent`, as the server renders it:
 * same origin and path). Anything else (a remembered consent or an error, which is the client's
 * own redirect_uri with its code or error) is left exactly as it came: a client's callback never
 * gets a parameter it did not ask for. It runs in the page (its source is the page's script), so
 * it uses nothing but its arguments and the browser's URL.
 */
export function afterSignIn(target: string, consent: string | undefined, lang: string | undefined) {
  if (!lang || !consent) return target;
  const page = new URL(consent);
  const to = new URL(target, page);
  if (to.origin !== page.origin || to.pathname !== page.pathname) return target;
  if (to.searchParams.has('lang')) return target;
  to.searchParams.set('lang', lang);
  return to.toString();
}

/**
 * Sign in, then Better Auth continues the authorization the signed query describes. `carry` goes
 * on as `?lang` to the consent screen (`consent`, its address), and to nowhere else.
 */
export function signInPage(
  lang: Lang,
  app: string,
  oauthQuery: string,
  carry?: Lang,
  consent?: string,
) {
  const v = { app };
  const body = `
${queryField(oauthQuery, carry, consent)}
<h1>${escapeHtml(t(lang, 'mcp.signIn.title', v))}</h1>
<p class="muted">${escapeHtml(t(lang, 'mcp.signIn.lead', v))}</p>
<form id="f" novalidate>
<label for="email">${escapeHtml(t(lang, 'mcp.signIn.email'))}</label>
<input id="email" name="email" type="email" autocomplete="username" required>
<label for="password">${escapeHtml(t(lang, 'mcp.signIn.password'))}</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<p id="err" class="error" role="alert" hidden>${escapeHtml(t(lang, 'mcp.signIn.failed'))}</p>
<div class="row"><button class="primary" type="submit">${escapeHtml(t(lang, 'mcp.signIn.submit'))}</button></div>
</form>
<p class="muted">${escapeHtml(t(lang, 'mcp.signIn.noAccount', v))}</p>`;
  const script = `
${afterSignIn.toString()}
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.hidden = true;
  try {
    const res = await fetch('/api/auth/sign-in/email', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
        oauth_query: document.getElementById('q').value,
      }),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && out && out.url) {
      const q = document.getElementById('q').dataset;
      location.href = afterSignIn(new URL(out.url, location.href).toString(), q.consent, q.lang);
      return;
    }
  } catch {}
  err.hidden = false;
});`;
  return page(lang, t(lang, 'mcp.signIn.title', v), body, script);
}

/**
 * What the consent screen offers: per module asked for, reading it (`read`, when it was asked)
 * and changing it (`change`, the scopes that allow it); and staying connected.
 */
export type ConsentChoice =
  | { kind: 'module'; module: string; label: string; read?: string; change?: string }
  | { kind: 'offline'; label: string };

/** One module's row: not allowed, read, or change; the most the client asked is chosen. */
function moduleRow(lang: Lang, c: Extract<ConsentChoice, { kind: 'module' }>, i: number) {
  const options = [
    { value: '', label: t(lang, 'mcp.consent.none') },
    ...(c.read ? [{ value: c.read, label: t(lang, 'mcp.consent.read') }] : []),
    ...(c.change ? [{ value: c.change, label: t(lang, 'mcp.consent.write') }] : []),
  ];
  const chosen = c.change ?? c.read ?? '';
  const radios = options
    .map(
      (o) =>
        `<label class="scope"><input type="radio" name="m${i}" value="${escapeHtml(o.value)}"${o.value === chosen ? ' checked' : ''}> ${escapeHtml(o.label)}</label>`,
    )
    .join('\n');
  return `<div class="module" role="radiogroup" aria-labelledby="m${i}l"><p id="m${i}l" class="name">${escapeHtml(c.label)}</p>\n${radios}\n</div>`;
}

/** Allow or deny the client, choosing per module what it may do. */
export function consentPage(
  lang: Lang,
  v: { app: string; client: string; person: string; business: string },
  choices: readonly ConsentChoice[],
  oauthQuery: string,
) {
  const boxes = choices
    .map((c, i) =>
      c.kind === 'module'
        ? moduleRow(lang, c, i)
        : `<label class="scope"><input type="checkbox" name="offline" value="offline_access" checked> ${escapeHtml(c.label)}</label>`,
    )
    .join('\n');
  const body = `
${queryField(oauthQuery)}
<h1>${escapeHtml(t(lang, 'mcp.consent.title', v))}</h1>
<p>${escapeHtml(t(lang, 'mcp.consent.lead', v))}</p>
<p class="muted">${escapeHtml(t(lang, 'mcp.consent.unverified', v))}</p>
<fieldset><legend>${escapeHtml(t(lang, 'mcp.consent.what'))}</legend>
${boxes}
</fieldset>
<p id="err" class="error" role="alert" hidden>${escapeHtml(t(lang, 'mcp.consent.failed'))}</p>
<div class="row">
<button id="deny" type="button">${escapeHtml(t(lang, 'mcp.consent.deny'))}</button>
<button id="allow" class="primary" type="button">${escapeHtml(t(lang, 'mcp.consent.allow'))}</button>
</div>
<p class="muted">${escapeHtml(t(lang, 'mcp.consent.revoke'))}</p>`;
  const script = `
async function decide(accept) {
  const err = document.getElementById('err');
  err.hidden = true;
  const chosen = [...document.querySelectorAll('input[type=radio]:checked, input[name=offline]:checked')]
    .flatMap((b) => b.value.split(' '))
    .filter(Boolean);
  // Nothing of any module allowed is a denial.
  if (accept && !chosen.some((s) => s !== 'offline_access')) accept = false;
  try {
    const res = await fetch('/api/auth/oauth2/consent', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        accept,
        ...(accept ? { scope: chosen.join(' ') } : {}),
        oauth_query: document.getElementById('q').value,
      }),
    });
    const out = await res.json().catch(() => ({}));
    const to = out && (out.url || out.redirect_uri);
    if (res.ok && to) { location.href = to; return; }
  } catch {}
  err.hidden = false;
}
document.getElementById('allow').addEventListener('click', () => decide(true));
document.getElementById('deny').addEventListener('click', () => decide(false));`;
  return page(lang, t(lang, 'mcp.consent.title', v), body, script);
}
