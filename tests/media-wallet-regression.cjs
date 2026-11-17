const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(process.argv[2] || path.join(__dirname, '../glowstr-v5.5-relay-frostr-media.html'), 'utf8');
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
const context = vm.createContext({URL, Event, console, AbortController, setTimeout:()=>1, clearTimeout:()=>{},
  state:{publicKey:'a'.repeat(64)}, _glowstrSignerEpoch:1,
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
vm.runInContext(section('let _glowstrInvoicePollV42', 'async function glowstrPayRelayV42('), context);
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
  const invoiceAddress='8'+'A'.repeat(94);
  const validInvoice={id:'invoice_12345678901234567890',token:'token_12345678901234567890',
    address:invoiceAddress,amount_atomic:'10000000000',
    uri:'monero:'+invoiceAddress+'?tx_amount=0.01',confirmations_required:2};
  context.state.publicKey='a'.repeat(64);
  vm.runInContext(`
    _glowstrCommerceFeaturesV54={features:{relay_365d:{}}};
    glowstrLoadCommerceFeaturesV54=async()=>{};
    glowstrPayOpenV42=()=>{};
    glowstrStopInvoicePollV54=()=>{};
    glowstrRenderInvoiceV42=()=>{};
    glowstrPollInvoiceV42=()=>{};
    glowstrCommerceFetchV54=async()=>invoice;
  `,context);
  const requestInvoice=invoice=>{
    context.invoice=invoice;
    return vm.runInContext("glowstrStartCommerceInvoiceV54('relay_365d','relay',{})",context);
  };
  await requestInvoice(validInvoice);
  await assert.rejects(()=>requestInvoice({...validInvoice,amount_atomic:'0',uri:'monero:'+invoiceAddress+'?tx_amount=0'}),/Invalid invoice amount/);
  await assert.rejects(()=>requestInvoice({...validInvoice,address:'1'+'A'.repeat(94)}),/Invalid Monero subaddress/);
  await assert.rejects(()=>requestInvoice({...validInvoice,confirmations_required:1}),/Unexpected Monero confirmation policy/);
  console.log('PASS commerce invoices require positive atomic amounts, mainnet address format, matching URI, and two confirmations');
})().catch(error=>{console.error(error);process.exitCode=1;});
