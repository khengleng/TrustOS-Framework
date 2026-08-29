/*
 * The TrustOS portal.
 *
 * This renders console *descriptors* — it does not know what an "operations console" or
 * a "risk console" is. The governance API returns a document describing what a console
 * contains: pages, and components of kind `kpi`, `table`, `search`, `queue` and so on. This
 * file turns that into a screen. An application built on TrustOS registers a descriptor
 * and gets an admin surface without anyone writing screens for it.
 *
 * That is the whole idea, and it is why this file contains no per-application code. If
 * you find yourself adding a branch for one particular application, the descriptor is
 * missing something instead.
 *
 * No framework, no build step, no bundler. The page is served under a strict CSP —
 * `default-src 'none'` with `script-src 'self'` — so every script is a real file, nothing
 * is inline, and the API is same-origin. Adding a bundler here would buy nothing and cost
 * a build pipeline for the one asset that has to keep working when everything else is
 * broken.
 */

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'trustos.portal.session';
const PKCE_KEY = 'trustos.portal.pkce';

/** Every view, so showing one reliably hides the rest. */
const VIEWS = ['loading', 'signin', 'catalog', 'console', 'error'];

function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view;
}

function text(element, value) {
  element.textContent = value ?? '';
}

/** Builds an element without innerHTML, so descriptor text can never become markup. */
function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined && content !== null) node.textContent = String(content);
  return node;
}

function fail(message, detail) {
  text($('error-message'), message);
  text($('error-detail'), detail ? String(detail) : '');
  $('error-detail').hidden = !detail;
  show('error');
}

// --- session -----------------------------------------------------------------

function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    // An expired token would produce a 401 on the first call and look like a bug.
    if (!session.expiresAt || Date.now() >= session.expiresAt) return null;
    return session;
  } catch {
    return null;
  }
}

function writeSession(session) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // A browser refusing storage is not a reason to fail the page; the session
    // simply lasts until the next reload.
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing to clean up */
  }
}

// --- PKCE --------------------------------------------------------------------

function randomString(bytes = 32) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64Url(buffer);
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

// --- OIDC --------------------------------------------------------------------

async function discover(issuerUrl) {
  const response = await fetch(`${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`Identity provider returned ${response.status}`);
  return response.json();
}

async function beginSignIn(identity) {
  const meta = await discover(identity.issuerUrl);
  const verifier = randomString();
  const state = randomString(16);

  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, meta }));

  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('client_id', identity.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');

  /*
   * Ask for the assurance level this platform requires, rather than hoping the
   * provider volunteers a second factor.
   *
   * Without this the sign-in completes with a password *and* a TOTP code and the
   * token still says `acr: 1` with an empty `amr` — indistinguishable from a
   * password-only login, which is why the platform refused every read by a
   * privileged role. `acr_values` is the OIDC request parameter for exactly this,
   * and the identity provider maps `mfa` onto the step-up level its browser flow
   * enforces.
   *
   * Requesting it is not the same as trusting the answer: the token is still
   * verified, and the platform still decides whether what came back counts.
   */
  url.searchParams.set('acr_values', identity.acrValues ?? 'mfa');

  window.location.assign(url.toString());
}

/** The registered redirect target. Deliberately without query or hash. */
function redirectUri() {
  return `${window.location.origin}/`;
}

async function completeSignIn(identity, code, returnedState) {
  const stored = sessionStorage.getItem(PKCE_KEY);
  sessionStorage.removeItem(PKCE_KEY);
  if (!stored) throw new Error('No sign-in was in progress in this tab.');

  const { verifier, state, meta } = JSON.parse(stored);
  // Guards against a code delivered by a page the user did not start the flow on.
  if (state !== returnedState) throw new Error('Sign-in state did not match. Start again.');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: identity.clientId,
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });

  const response = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    throw new Error(`The identity provider refused the sign-in (${response.status}).`);
  }

  const token = await response.json();
  const claims = readClaims(token.access_token);

  writeSession({
    accessToken: token.access_token,
    expiresAt: Date.now() + (token.expires_in ?? 300) * 1000,
    name: claims.name ?? claims.preferred_username ?? claims.email ?? 'Signed in',
    endSession: meta.end_session_endpoint ?? null,
    idToken: token.id_token ?? null,
  });
}

/** The payload, for display only. Nothing here is trusted — the API re-verifies. */
function readClaims(accessToken) {
  try {
    const payload = accessToken.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return {};
  }
}

// --- API ---------------------------------------------------------------------

async function api(path, session) {
  const response = await fetch(`/api${path}`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body.message ?? '';
    } catch {
      /* a body that is not JSON tells us nothing extra */
    }

    /*
     * A 401 is not necessarily an expired session, and saying so was actively
     * misleading: the first real sign-in failed here because the API rejected the
     * token's authorized party, and the portal reported "The session expired" — which
     * sent the reader looking at token lifetimes instead of client configuration.
     *
     * The API deliberately does not say which check failed, so neither can this. It
     * reports what the API said and offers signing in again as a possibility rather
     * than a diagnosis.
     */
    const error = new Error(
      detail ||
        (response.status === 401
          ? 'The platform did not accept the sign-in.'
          : `The API returned ${response.status}.`),
    );
    error.status = response.status;
    if (response.status === 401) error.hint = 'Signing in again may help.';
    throw error;
  }

  return response.json();
}

// --- rendering ---------------------------------------------------------------

function renderCatalog(payload, onOpen) {
  text($('catalog-lede'), `${payload.applications.length} registered in ${payload.environment}.`);

  const container = $('apps');
  container.replaceChildren();

  for (const app of payload.applications) {
    const card = el('button', 'card');
    card.type = 'button';
    card.append(el('span', 'card-name', app.name));
    if (app.description) card.append(el('span', 'card-desc', app.description));

    const tags = el('span', 'tags');
    for (const [label, value] of [
      ['owner', app.owner],
      ['lifecycle', app.lifecycleStatus],
      ['data', app.dataClassification],
      ['risk', app.riskClassification],
    ]) {
      if (value) tags.append(el('span', 'tag', `${label}: ${value}`));
    }
    card.append(tags);

    card.addEventListener('click', () => onOpen(app.appId));
    container.append(card);
  }
}

function renderConsole(app) {
  text($('console-name'), app.name);
  text($('console-purpose'), app.businessPurpose ?? app.description ?? '');

  const meta = $('console-meta');
  meta.replaceChildren();
  for (const [label, value] of [
    ['Business owner', app.businessOwner],
    ['Technical owner', app.technicalOwner],
    ['Environment', app.environment],
    ['Version', app.version],
    ['Lifecycle', app.lifecycleStatus],
    ['Data', app.dataClassification],
    ['Risk', app.riskClassification],
    ['Next review', app.nextSecurityReview?.slice(0, 10)],
  ]) {
    if (!value) continue;
    const item = el('div', 'meta-item');
    item.append(el('span', 'meta-label', label));
    item.append(el('span', 'meta-value', value));
    meta.append(item);
  }

  const pages = $('console-pages');
  pages.replaceChildren();

  /*
   * Data sources and actions are declared once on the application and referenced by id
   * from the components that use them. Resolving them here means a component shows
   * "reporting.transactions · search" rather than the word "transactions", which is the
   * difference between a screen you can review and a screen you have to cross-reference
   * by hand.
   */
  const sources = new Map((app.dataSources ?? []).map((source) => [source.id, source]));
  const actions = new Map((app.actions ?? []).map((action) => [action.id, action]));

  for (const page of app.pages ?? []) {
    const section = el('section', 'page');
    section.append(el('h2', null, page.title ?? page.id));
    if (page.permission) section.append(el('p', 'muted small', `Requires ${page.permission}`));

    const grid = el('div', 'sections');
    for (const component of page.components ?? []) {
      grid.append(renderComponent(component, sources, actions));
    }
    section.append(grid);

    if ((page.components ?? []).length === 0) {
      section.append(el('p', 'muted small', 'This page declares no components.'));
    }
    pages.append(section);
  }

  if ((app.pages ?? []).length === 0) {
    pages.append(el('p', 'muted', 'This application declares no pages.'));
  }
}

/*
 * One component, rendered from what the descriptor says it is.
 *
 * Deliberately generic: the portal shows a component's kind, the source it reads and the
 * fields it exposes. It does not fetch that data, because this gateway serves descriptors
 * and carries no traffic — a component claiming to show live transactions here would be
 * inventing them.
 *
 * The shape is the descriptor's, not one I invented: `kind`, `dataSourceId`, `actionIds`
 * and `fields`. An earlier version of this read `type` and `sections`, which exist nowhere
 * in the schema, so every console rendered its page titles with nothing underneath.
 */
function renderComponent(component, sources, actions) {
  const card = el('article', 'section-card');

  const head = el('div', 'section-head');
  head.append(el('span', 'section-type', component.kind ?? 'component'));
  head.append(el('span', 'section-title', component.id ?? ''));
  card.append(head);

  const facts = el('dl', 'facts');

  const source = sources.get(component.dataSourceId);
  if (source) {
    facts.append(el('dt', null, 'Reads'));
    facts.append(el('dd', null, `${source.resourceId} · ${source.operation}`));
    if (source.maxRows) {
      facts.append(el('dt', null, 'Max rows'));
      facts.append(el('dd', null, source.maxRows));
    }
  } else if (component.dataSourceId) {
    facts.append(el('dt', null, 'Reads'));
    facts.append(el('dd', null, component.dataSourceId));
  }

  if ((component.fields ?? []).length > 0) {
    facts.append(el('dt', null, 'Fields'));
    facts.append(el('dd', null, component.fields.join(', ')));
  }

  for (const id of component.actionIds ?? []) {
    const action = actions.get(id);
    facts.append(el('dt', null, 'Action'));
    // Whether an action needs a reason or an approval is the governed part, so it is
    // shown rather than left to whoever opens the console to discover.
    const notes = action
      ? [
          action.requiresReason ? 'reason required' : null,
          action.requiresApproval ? 'approval required' : null,
          action.reversible ? 'reversible' : 'not reversible',
        ].filter(Boolean)
      : [];
    facts.append(el('dd', null, action ? `${action.label} — ${notes.join(', ')}` : id));
  }

  if (facts.childElementCount > 0) card.append(facts);
  return card;
}

// --- boot --------------------------------------------------------------------

async function main() {
  let config;
  try {
    config = await (await fetch('/api/portal/config')).json();
  } catch (error) {
    fail('The portal could not reach this service.', error.message);
    return;
  }

  const env = $('env');
  text(env, config.environment);
  env.hidden = false;
  text($('foot-note'), `TrustOS Platform · ${config.environment}`);

  const identity = config.identity;

  // A code on the URL means we have just come back from the identity provider.
  const params = new URLSearchParams(window.location.search);
  if (params.has('code') && identity) {
    show('loading');
    try {
      await completeSignIn(identity, params.get('code'), params.get('state'));
      window.history.replaceState({}, '', '/');
    } catch (error) {
      fail('Sign-in did not complete.', error.message);
      return;
    }
  } else if (params.has('error')) {
    fail(
      'The identity provider refused the sign-in.',
      params.get('error_description') ?? params.get('error'),
    );
    window.history.replaceState({}, '', '/');
    return;
  }

  const session = readSession();

  if (!session) {
    show('signin');
    if (!identity) {
      $('signin-button').disabled = true;
      text(
        $('signin-note'),
        'This deployment is not configured with an identity provider, so there is nothing to sign in to.',
      );
    } else {
      $('signin-button').addEventListener('click', () => {
        beginSignIn(identity).catch((error) => fail('Could not start sign-in.', error.message));
      });
    }
    return;
  }

  text($('user'), session.name);
  $('signout').hidden = false;
  $('signout').addEventListener('click', () => {
    clearSession();
    if (session.endSession) {
      const url = new URL(session.endSession);
      url.searchParams.set('post_logout_redirect_uri', window.location.origin + '/');
      if (session.idToken) url.searchParams.set('id_token_hint', session.idToken);
      window.location.assign(url.toString());
      return;
    }
    window.location.assign('/');
  });

  const openConsole = async (appId) => {
    show('loading');
    try {
      const app = await api(`/governance/consoles/${encodeURIComponent(appId)}`, session);
      renderConsole(app.application ?? app);
      show('console');
    } catch (error) {
      fail('That console could not be read.', error.message);
    }
  };

  $('back').addEventListener('click', () => {
    show('catalog');
  });

  show('loading');
  try {
    const catalog = await api('/governance/apps', session);
    renderCatalog(catalog, openConsole);
    show('catalog');
  } catch (error) {
    // The most likely refusal here is the MFA gate, and saying so is more useful
    // than "403".
    fail('The platform refused that read.', error.message);
  }
}

main().catch((error) => fail('The portal failed to start.', error.message));
