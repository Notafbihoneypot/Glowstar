import twitterText from 'twitter-text';
import { verifyEvent } from 'nostr-tools/pure';
import { PLATFORMS } from './config.mjs';
export class Problem extends Error { constructor(message,status=400){super(message);this.status=status;} }
export const textFor = (post,platform) => post.overrides?.[platform] ?? post.text;
export const nostrContent = (post,url) => textFor(post,'nostr')+(url?'\n\n'+url:'');
export const graphemes = text => [...new Intl.Segmenter().segment(text)].length;
export function normalizePost(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.text !== 'string' || input.text.length>65000) throw new Problem('Invalid post text');
  if (!Array.isArray(input.destinations) || !input.destinations.length || input.destinations.length>PLATFORMS.length || input.destinations.some(p=>!PLATFORMS.includes(p))) throw new Problem('Choose valid destinations');
  const maps={};
  for(const key of ['overrides','expectedIdentities']) {
    const value=input[key] || {}; if(typeof value !== 'object' || Array.isArray(value)) throw new Problem('Invalid destination versions'); maps[key]={};
    for(const [p,v] of Object.entries(value)) {
      if(!PLATFORMS.includes(p) || typeof v !== 'string' || v.length>(key==='overrides'?65000:512)) throw new Problem('Invalid destination version or identity');
      maps[key][p]=v.trim();
    }
  }
  if(input.mediaId != null && (typeof input.mediaId!=='string' || !/^[a-f0-9]{64}$/.test(input.mediaId))) throw new Problem('Invalid image');
  return {text:input.text.trim(),destinations:[...new Set(input.destinations)],...maps,mediaId:input.mediaId || null,event:input.event || null};
}
export function inspectPost(post,connections={},media=null) {
  return post.destinations.map(platform=>{
    const text=textFor(post,platform),connection=connections[platform],errors=[];
    const count=platform==='x'?twitterText.parseTweet(text).weightedLength:graphemes(text);
    const limit=platform==='x'?280:platform==='bluesky'?300:platform==='nostr'?60000:connection?.secret?.limit || 500;
    if(platform!=='nostr' && !connection) errors.push('Connect this identity first');
    if(!text && !media) errors.push('Add text or an image');
    if(count>limit) errors.push(`Shorten this version to ${limit} characters (${count} now)`);
    if(platform==='bluesky' && Buffer.byteLength(text)>3000) errors.push('Bluesky text exceeds its UTF-8 byte limit');
    if(['mastodon','activitypub'].includes(platform)) {
      const other=platform==='mastodon'?'activitypub':'mastodon';
      if(post.destinations.includes(other) && connection && connections[other]?.identity===connection.identity) errors.push('This is the same federated account in two slots. Select it only once.');
    }
    return {platform,text,count,limit,errors};
  });
}
export function validateSignedNote(event,owner,content) {
  if(!event || event.pubkey!==owner || event.kind!==1 || event.content!==content || !Array.isArray(event.tags) || event.tags.some(t=>!Array.isArray(t)||!['client','imeta','t'].includes(t[0])) || Math.abs(Date.now()/1000-event.created_at)>300) throw new Problem('Nostr signature must match this public post and account');
  try {if(!verifyEvent(event))throw new Error();}catch{throw new Problem('Invalid Nostr signature');}
}
export function allowedServer(value,hosts) {
  let url;try{url=new URL(value.includes('://')?value:'https://'+value);}catch{throw new Problem('Invalid server');}
  if(url.protocol!=='https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname!=='/' || !hosts.has(url.hostname))throw new Problem('Server is not in the operator-approved host list');
  return url.origin;
}
