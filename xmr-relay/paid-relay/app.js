'use strict';
const relay = 'wss://' + location.host + '/';
document.getElementById('relay-url').textContent = relay;
document.getElementById('copy-relay').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(relay);
    document.getElementById('copy-relay').textContent = 'Copied!';
  } catch {
    document.getElementById('copy-relay').textContent = 'Copy manually above';
  }
});
const statusEl = document.getElementById('status');
const buy = document.getElementById('buy');
const buyButton = document.getElementById('buy-button');
const invoiceEl = document.getElementById('invoice');
let paymentTimer = null;

const pubkeyInput = document.getElementById('pubkey');
const pubkeyHelp = document.getElementById('pubkey-help');
pubkeyInput.addEventListener('input', () => {
  pubkeyInput.setCustomValidity('');
  pubkeyHelp.textContent = 'Accepts a 63-character npub1… or a 64-character hexadecimal public key. Never enter nsec or a private key.';
});

// NIP-19 "npub" is a Bech32-encoded 32-byte public key (not Bech32m).
// Check its checksum, HRP, decoded length and padding before using it.
// The decoded hex is sent to Commerce; private keys are never accepted.
const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod(values) {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    if (top & 1) checksum ^= 0x3b6a57b2;
    if (top & 2) checksum ^= 0x26508e6d;
    if (top & 4) checksum ^= 0x1ea119fa;
    if (top & 8) checksum ^= 0x3d4233dd;
    if (top & 16) checksum ^= 0x2a1462b3;
  }
  return checksum >>> 0;
}
function parseNostrPubkey(raw) {
  const value = raw.trim();
  if (/^[a-fA-F0-9]{64}$/.test(value)) return value.toLowerCase();
  // Reject mixed case; the Bech32 standard permits only single-case strings.
  if (value !== value.toLowerCase() && value !== value.toUpperCase()) {
    throw Error('A Nostr npub must not mix upper and lowercase characters.');
  }
  const text = value.toLowerCase();
  if (!/^npub1[0-9a-z]{58}$/.test(text)) {
    throw Error('Paste a complete 63-character npub1… or 64-character hex public key (never nsec).');
  }
  const encoded = text.slice(5);
  const words = [];
  for (const char of encoded) {
    const word = BECH32_ALPHABET.indexOf(char);
    if (word < 0) throw Error('Invalid npub: not valid Bech32 characters.');
    words.push(word);
  }
  // Human-readable prefix expansion for "npub".
  const hrp = 'npub';
  const hrpExpanded = [...hrp].map(c => c.charCodeAt(0) >> 5)
    .concat(0, [...hrp].map(c => c.charCodeAt(0) & 31));
  if (bech32Polymod(hrpExpanded.concat(words)) !== 1) {
    throw Error('Invalid npub checksum. Copy the full public key again.');
  }
  const payload = words.slice(0, -6);
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (const word of payload) {
    acc = (acc << 5) | word;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >>> bits) & 255);
    }
  }
  if (bytes.length !== 32 || bits >= 5 || ((acc << (8 - bits)) & 255) !== 0) {
    throw Error('Invalid npub length or padding. Copy the full public key again.');
  }
  return bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function copyInvoiceField(value, button) {
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = 'Copied!';
  } catch {
    button.textContent = 'Copy manually above';
  }
}
function xmrAmount(atomicValue) {
  const amount = BigInt(String(atomicValue));
  const whole = amount / 1000000000000n;
  const fraction = String(amount % 1000000000000n).padStart(12, '0').replace(/0+$/, '');
  return String(whole) + (fraction ? '.' + fraction : '');
}
function line(parent, tag, text) {
  const element = document.createElement(tag);
  element.textContent = text;
  parent.append(element);
  return element;
}
fetch('/xmr-commerce/v1/features', {cache:'no-store'})
  .then(async response => {
    if (!response.ok) throw Error('unavailable');
    const data = await response.json();
    if (!data.features?.relay_365d || !data.features?.relay_lifetime) throw Error('outdated backend');
    statusEl.textContent = 'Payment service online · annual and lifetime memberships available';
  })
  .catch(() => {
    statusEl.textContent = 'Payment service unavailable or not updated. Do not send XMR until it is online.';
    buyButton.disabled = true;
  });
buy.addEventListener('submit', async event => {
  event.preventDefault();
  let pubkey;
  try {
    pubkey = parseNostrPubkey(pubkeyInput.value);
    pubkeyInput.setCustomValidity('');
    pubkeyHelp.textContent = pubkeyInput.value.trim().toLowerCase().startsWith('npub1')
      ? 'Valid npub — converted to the matching 64-character hex public key locally.'
      : 'Valid hexadecimal public key. Membership will use this identity.';
  } catch (error) {
    pubkeyInput.setCustomValidity(error.message);
    pubkeyInput.reportValidity();
    return;
  }
  if (paymentTimer) { clearTimeout(paymentTimer); paymentTimer = null; }
  const feature = document.querySelector('input[name="plan"]:checked').value;
  buyButton.disabled = true;
  invoiceEl.replaceChildren();
  line(invoiceEl, 'p', 'Creating your private invoice…');
  try {
    const res = await fetch('/xmr-commerce/v1/invoices', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({pubkey, feature, target:location.hostname})
    });
    const data = await res.json();
    if (!res.ok) throw Error(data.error || 'Invoice unavailable');
    invoiceEl.replaceChildren();
    line(invoiceEl, 'h3', feature === 'relay_lifetime' ? 'Lifetime invoice' : 'Annual invoice');
    line(invoiceEl, 'p', 'Pay exactly ' + xmrAmount(data.amount_atomic) + ' XMR');
    const expectedAmount = xmrAmount(data.amount_atomic);
    const paymentUri = new URL(data.uri);
    if (paymentUri.protocol !== 'monero:' ||
        paymentUri.pathname !== data.address ||
        paymentUri.searchParams.get('tx_amount') !== expectedAmount ||
        !/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{95}$/.test(data.address)) {
      throw Error('Invalid invoice payment URI or address. Do not send XMR.');
    }
    line(invoiceEl, 'p', 'Scan with your Monero wallet to fill the exact address and amount:');
    const qr = line(invoiceEl, 'div', '');
    qr.id = 'payment-qr';
    qr.setAttribute('role', 'img');
    qr.setAttribute('aria-label', 'Monero invoice QR code containing payment address and exact amount');
    try {
      if (typeof QRCode !== 'function') throw Error('QR generator unavailable');
      new QRCode(qr, {
        text: data.uri,
        width: 256, height: 256,
        colorDark: '#000000', colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    } catch (err) {
      qr.replaceChildren();
      line(invoiceEl, 'p', 'QR code unavailable. You can still copy the address or open the wallet link.');
    }
    line(invoiceEl, 'p', 'Payment address (verify in your wallet):');
    const address = line(invoiceEl, 'address', data.address);
    address.style.marginBottom = '12px';
    const copyAddress = line(invoiceEl, 'button', 'Copy address');
    copyAddress.type = 'button';
    copyAddress.addEventListener('click', () => copyInvoiceField(data.address, copyAddress));
    const copyPaymentUri = line(invoiceEl, 'button', 'Copy payment link');
    copyPaymentUri.type = 'button';
    copyPaymentUri.addEventListener('click', () => copyInvoiceField(data.uri, copyPaymentUri));
    const wallet = document.createElement('a');
    wallet.href = data.uri;
    wallet.textContent = 'Open Monero wallet with address and amount';
    wallet.className = 'wallet-link';
    invoiceEl.append(wallet);
    line(invoiceEl, 'p', 'Invoice ID: ' + data.id);
    line(invoiceEl, 'p', 'Expires: ' + new Date(data.expires_at * 1000).toLocaleString() +
      '. Do not pay after expiry; check the amount and address before sending.');
    const progress = line(invoiceEl, 'p', 'Waiting for payment…');
    const poll = async () => {
      try {
        const res = await fetch('/xmr-commerce/v1/invoices/' + encodeURIComponent(data.id), {
          headers:{Authorization:'Bearer ' + data.token}, cache:'no-store'
        });
        if (!res.ok) throw Error('status unavailable');
        const state = await res.json();
        if (state.status === 'PAID') {
          progress.textContent = 'Payment confirmed — publishing access activated. Add the relay URL to your Nostr client and authenticate.';
          buyButton.disabled = false;
          return;
        }
        if (state.status === 'EXPIRED') {
          progress.textContent = 'Invoice expired. Create a fresh one; do not reuse this payment address.';
          buyButton.disabled = false;
          return;
        }
        if (state.verification_healthy === false) {
          progress.textContent = 'Payment monitor has not yet completed a recent successful scan. Do not send XMR until verification is healthy.';
        } else {
          progress.textContent = 'Payment: ' + (state.status || 'WAITING') +
            ' · confirmations: ' + (state.confirmations ?? 0) + ' / ' + data.confirmations_required;
        }
      } catch {
        progress.textContent = 'Payment verification unavailable. Do not send XMR until the status checker is working. If you already paid, do not pay again; contact the relay operator.';
      }
      paymentTimer = setTimeout(poll, 15000);
    };
    poll();
  } catch (error) {
    invoiceEl.replaceChildren();
    line(invoiceEl, 'p', 'Could not create invoice: ' + error.message);
    buyButton.disabled = false;
  }
});
