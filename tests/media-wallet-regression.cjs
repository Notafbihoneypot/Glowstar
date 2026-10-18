const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '../glowstr-v5.3-bluetooth-direct.html'), 'utf8');
function section(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, 'Missing shipped source section: ' + start);
  return html.slice(a, b);
}
const elements = new Map([
  ['compose-input', {value:'Keep my draft', dispatchEvent(){}}],
  ['compose-media-btn', {disabled:false}]
]);
const messages = [], opened = [];
const context = vm.createContext({URL, Event, console,
  state:{publicKey:'account-one'}, _glowstrSignerEpoch:1,
  document:{getElementById:id=>elements.get(id)},
  window:{location:{}, GlowstrAndroid:{openExternal:uri=>{opened.push(uri);return true;}}},
  showToast:message=>messages.push(message),
  glowstrCleanComposeImage:async file=>file,
  glowstrUploadMedia:async()=>null,
  // The image-URL gate is loaded from the shipped source below.
  location:{protocol:'https:',href:'https://app.glowstr.local/'}
});
vm.runInContext(section('function glowstrIsMoneroAddress(', 'function showSellModal('), context);
vm.runInContext(section('function safeRemoteMediaUrl(', "document.addEventListener('click', glowstrHandleDynamicAction)"), context);
vm.runInContext(section('async function glowstrUploadComposeMedia(', 'function glowstrInitBlossom('), context);
const address = '4' + 'a'.repeat(94);
context.address = address;
assert.equal(vm.runInContext("glowstrBuildMoneroUri(address, '0', 'Test & label')", context),
  'monero:' + address + '?tx_description=Test%20%26%20label');
assert.equal(vm.runInContext("glowstrBuildMoneroUri(address, '0.000000000001', '')", context),
  'monero:' + address + '?tx_amount=0.000000000001');
for (const amount of ['-1', 'Infinity', 'NaN', '1e-8', '0.0000000000001']) {
  context.badAmount = amount;
  assert.throws(()=>vm.runInContext("glowstrBuildMoneroUri(address, badAmount, '')", context));
}
for (const invalid of [address + 'a', '8' + 'a'.repeat(105), 'javascript:alert(1)']) {
  context.invalidAddress = invalid;
  assert.equal(vm.runInContext('glowstrIsMoneroAddress(invalidAddress)', context), false);
}
vm.runInContext("openXmrPay(address, '0', 'Tip')", context);
assert.equal(opened[0], 'monero:' + address + '?tx_description=Tip');
assert.equal(context.window.location.href, undefined);
console.log('PASS payment URI query delimiters, exact atomic precision, format validation, native wallet handoff');

function input() { return {files:[{name:'photo.jpg'}], value:'selected'}; }
(async()=>{
  for (const badResult of [null, '', 'javascript:alert(1)']) {
    context.glowstrUploadMedia = async()=>badResult;
    context.input = input();
    await vm.runInContext('glowstrUploadComposeMedia(input)', context);
    assert.equal(elements.get('compose-input').value, 'Keep my draft');
    assert.equal(elements.get('compose-media-btn').disabled, false);
    assert.equal(context.input.value, '');
  }
  console.log('PASS failed/unsafe uploads preserve the draft, reset the file input, and restore the media button');
  context.glowstrUploadMedia = async()=>{
    context.state.publicKey = 'account-two'; ++context._glowstrSignerEpoch;
    return 'https://images.example/photo.jpg';
  };
  context.input = input();
  await vm.runInContext('glowstrUploadComposeMedia(input)', context);
  assert.equal(elements.get('compose-input').value, 'Keep my draft');
  assert(messages.at(-1).includes('Account changed'));
  context.glowstrUploadMedia = async()=> 'https://images.example/photo.jpg';
  context.input = input();
  await vm.runInContext('glowstrUploadComposeMedia(input)', context);
  assert.equal(elements.get('compose-input').value, 'Keep my draft\nhttps://images.example/photo.jpg\n');
  console.log('PASS account-switch upload isolation and successful attachment insertion');
})().catch(error=>{console.error(error);process.exitCode=1;});
