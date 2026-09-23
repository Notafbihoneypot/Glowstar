import { readFileSync } from 'node:fs';
export const PLATFORMS = ['bluesky', 'mastodon', 'x', 'activitypub', 'nostr'];
const list = value => (value || '').split(',').map(v => v.trim()).filter(Boolean);
const secret = (env, name) => env[name + '_FILE'] ? readFileSync(env[name + '_FILE'], 'utf8').trim() : (env[name] || '').trim();
export function loadConfig(env = process.env) {
  const base = new URL(env.CROSSPOST_PUBLIC_URL || 'http://localhost:8790');
  if (base.search || base.hash || base.username || base.password || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost','127.0.0.1'].includes(base.hostname)))) throw new Error('Use a valid HTTPS public URL, or HTTP on localhost');
  const key = secret(env, 'CROSSPOST_ENCRYPTION_KEY'), allowed = list(env.CROSSPOST_ALLOWED_PUBKEYS);
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Set CROSSPOST_ENCRYPTION_KEY_FILE to a file containing 64 random hex characters');
  if (!allowed.length || allowed.some(p => !/^[a-f0-9]{64}$/i.test(p))) throw new Error('Set CROSSPOST_ALLOWED_PUBKEYS to your hex Nostr public key(s)');
  const port = Number(env.CROSSPOST_PORT || 8790), dailyLimit = Number(env.CROSSPOST_DAILY_LIMIT || 50);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(dailyLimit) || dailyLimit < 1) throw new Error('Invalid port or daily limit');
  const relays = list(env.CROSSPOST_NOSTR_RELAYS || 'wss://relay.damus.io,wss://nos.lol');
  if (relays.some(r => new URL(r).protocol !== 'wss:')) throw new Error('Nostr output relays must use WSS');
  const commerceToken = secret(env, 'GLOWSTR_COMMERCE_ADMIN_TOKEN'), xClientId=(env.CROSSPOST_X_CLIENT_ID||'').trim(), xClientSecret=secret(env,'CROSSPOST_X_CLIENT_SECRET');
  if (env.CROSSPOST_COMMERCE_URL && !commerceToken) throw new Error('Commerce checks require an admin token');
  return { base:base.href.replace(/\/$/,''), origin:base.origin, secure:base.protocol === 'https:', cookiePath:base.pathname.replace(/\/$/,'') || '/', key,
    allowed:new Set(allowed.map(p=>p.toLowerCase())), data:env.CROSSPOST_DATA || './data', host:env.CROSSPOST_HOST || '127.0.0.1', port, dailyLimit,
    relays, previewOnly:env.CROSSPOST_PREVIEW_ONLY !== 'false', mastodonHosts:new Set(list(env.CROSSPOST_MASTODON_HOSTS || 'mastodon.social,fosstodon.org,hachyderm.io')),
    activitypubHosts:new Set(list(env.CROSSPOST_ACTIVITYPUB_HOSTS)), pdsHosts:new Set(list(env.CROSSPOST_BLUESKY_HOSTS || 'bsky.social')), xClientId, xClientSecret,
    commerceURL:env.CROSSPOST_COMMERCE_URL || '', commerceToken, entitlementFeature:env.CROSSPOST_ENTITLEMENT_FEATURE || 'relay_30d', entitlementTarget:env.CROSSPOST_ENTITLEMENT_TARGET || '' };
}
