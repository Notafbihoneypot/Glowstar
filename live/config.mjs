import { readFileSync } from 'node:fs';

const list=value=>String(value||'').split(',').map(x=>x.trim()).filter(Boolean);
function secret(env,name){
  const file=String(env[name+'_FILE']||'').trim();
  if(file)return readFileSync(file,'utf8').trim();
  return String(env[name]||'').trim();
}
export function loadConfig(env=process.env){
  const publicURL=new URL(env.LIVE_PUBLIC_URL||'http://127.0.0.1:8090/live');
  if(publicURL.search||publicURL.hash)throw new Error('LIVE_PUBLIC_URL must not contain query or fragment');
  const allowed=list(env.LIVE_ALLOWED_PUBKEYS).map(x=>x.toLowerCase());
  if(allowed.length!==1||allowed.some(x=>!/^[0-9a-f]{64}$/.test(x)))throw new Error('Glowstr Live MVP requires exactly one 64-character hex creator pubkey because it uses one XMR receiving wallet');
  const key=secret(env,'LIVE_ENCRYPTION_KEY');
  if(!/^[0-9a-f]{64}$/i.test(key))throw new Error('Set LIVE_ENCRYPTION_KEY to 32 bytes encoded as 64 hex characters');
  const port=Number(env.LIVE_PORT||8090);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('LIVE_PORT is invalid');
  const relays=list(env.LIVE_NOSTR_RELAYS||'wss://relay.damus.io,wss://nos.lol');
  if(!relays.length||relays.some(x=>!/^wss?:\/\//.test(x)))throw new Error('LIVE_NOSTR_RELAYS must contain ws/wss URLs');
  const commerceURL=String(env.LIVE_COMMERCE_URL||'').replace(/\/$/,'');
  const commerceToken=secret(env,'GLOWSTR_COMMERCE_ADMIN_TOKEN');
  if(commerceURL&&!commerceToken)throw new Error('XMR tips require GLOWSTR_COMMERCE_ADMIN_TOKEN');
  const rtmpBase=String(env.LIVE_RTMP_PUBLIC_BASE||'rtmp://127.0.0.1:1935/live').replace(/\/$/,'');
  const hlsBase=String(env.LIVE_HLS_PUBLIC_BASE||publicURL.origin+'/hls/live').replace(/\/$/,'');
  const tipMin=BigInt(env.LIVE_TIP_MIN_ATOMIC||'100000000');
  const tipMax=BigInt(env.LIVE_TIP_MAX_ATOMIC||'100000000000000');
  if(tipMin<=0n||tipMax<tipMin)throw new Error('Invalid LIVE_TIP_MIN_ATOMIC/LIVE_TIP_MAX_ATOMIC');
  return {
    base:publicURL.href.replace(/\/$/,''),
    origin:publicURL.origin,
    cookiePath:publicURL.pathname.replace(/\/$/,'')||'/',
    secure:publicURL.protocol==='https:',
    host:env.LIVE_HOST||'127.0.0.1',
    port,
    data:env.LIVE_DATA||'./data',
    allowed:new Set(allowed),
    key:key.toLowerCase(),
    relays,
    commerceURL,
    commerceToken,
    rtmpBase,
    hlsBase,
    tipMin,
    tipMax,
    pollMs:Math.max(5000,Number(env.LIVE_TIP_POLL_SECONDS||10)*1000)
  };
}
