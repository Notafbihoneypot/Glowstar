import { chromium } from 'playwright';
import { finalizeEvent } from 'nostr-tools/pure';
import assert from 'node:assert/strict';
import { fixture, response } from './helpers.mjs';
const cleanup=[],delivered=[],errors=[];
const f=await fixture({after(fn){cleanup.push(fn);}}, {},{
  fetcher:async url=>{
    if(url==='https://api.x.com/2/users/me')return response({data:{id:'123',username:'glowstr_test'}});
    if(url.endsWith('createSession'))return response({did:'did:plc:test',handle:'glowstr.bsky.social',accessJwt:'test-access',refreshJwt:'test-refresh'});
    if(url.endsWith('/verify_credentials'))return response({id:'1',acct:'glowstr',url:new URL(url).origin+'/@glowstr'});
    if(url.endsWith('/api/v2/instance'))return response({configuration:{statuses:{max_characters:500}}});
    throw new Error('Unexpected outbound call');
  },
  publish:async(platform,post,_connection,_media,context)=>{context.markPublishing();delivered.push({platform,post});return{id:'test-'+platform};},
});
let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.CROSSPOST_CHROMIUM_PATH||undefined});
  const page=await browser.newPage({viewport:{width:1280,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('testSign',template=>finalizeEvent(template,f.key));await page.addInitScript(()=>{window.nostr={signEvent:template=>window.testSign(template)};});
  await page.goto(f.config.base+'/');await page.getByRole('button',{name:'Connect signer'}).click();await page.getByText('Signed in. Link your identities, then choose where to publish.').waitFor();
  await page.locator('[data-tab=accounts]').click();
  for(const [name,fields]of [['Bluesky',{'Handle or DID':'glowstr.bsky.social','App password':'test-password'}],['Mastodon',{'User access token':'test-token'}],['X',{'User access token':'test-token'}],['ActivityPub',{'Compatible server URL':'https://fedi.example','User access token':'test-token'}]]){
    await page.locator('.account-card').filter({has:page.getByRole('heading',{name,exact:true})}).getByRole('button',{name:'Link identity'}).click();
    for(const [label,value]of Object.entries(fields))await page.getByLabel(label,{exact:true}).fill(value);
    await page.getByRole('button',{name:'Verify & link'}).click();await page.locator('#account-dialog').waitFor({state:'hidden'});
  }
  assert.equal(await page.locator('.account-card a').count(),4);
  if(process.env.CROSSPOST_SCREENSHOT_DIR)await page.screenshot({path:process.env.CROSSPOST_SCREENSHOT_DIR+'/crosspost-identities.png',fullPage:true});
  await page.locator('[data-tab=compose]').click();for(const p of ['bluesky','mastodon','x','activitypub'])await page.locator('[data-destination='+p+']').check();
  await page.getByLabel('Post text',{exact:true}).fill('One public update, across my linked identities.');
  if(process.env.CROSSPOST_SCREENSHOT_DIR)await page.screenshot({path:process.env.CROSSPOST_SCREENSHOT_DIR+'/crosspost-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'Review post'}).click();await page.locator('#review-dialog').waitFor();assert.equal(await page.locator('#versions .version').count(),4);assert.equal(await page.locator('#publish').isDisabled(),true);
  await page.locator('#public-consent').check();await page.locator('#publish').click();await page.getByText('Queued 4 identities. Track each delivery here.').waitFor();
  for(let i=0;i<4;i++)await f.worker.tick();await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.delivery-row .success').length===4);
  assert.equal(delivered.length,4);assert.deepEqual(new Set(delivered.map(d=>d.platform)),new Set(['bluesky','mastodon','x','activitypub']));assert.deepEqual(errors,[]);
  await page.setViewportSize({width:390,height:844});await page.locator('[data-tab=compose]').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(process.env.CROSSPOST_SCREENSHOT_DIR)await page.screenshot({path:process.env.CROSSPOST_SCREENSHOT_DIR+'/crosspost-mobile.png',fullPage:true});
  console.log('Browser flow passed: signed login, four linked identities, profile links, review consent, four simulated deliveries, history, and mobile layout. No external posts.');
}finally{await browser?.close();for(const fn of cleanup.reverse())await fn();}
