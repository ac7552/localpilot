// Keys and encryption for talking to other LocalPilot machines.
//
// Every install has an Ed25519 key pair; the public key (base64url) is the device's id. Machines
// prove who they are by signing the handshake, agree on fresh session keys with X25519, and then
// encrypt every frame with ChaCha20-Poly1305. Pairing on a home network adds a 6-digit code,
// stretched with scrypt so it can't be guessed during the few seconds a handshake is allowed.

const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

function newIdentity() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { id: jwk.x, jwk };
}

const privateKeyOf = (identity) => crypto.createPrivateKey({ key: identity.jwk, format: 'jwk' });
const publicKeyOf = (id) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: id }, format: 'jwk' });

const sign = (identity, data) => b64u(crypto.sign(null, Buffer.from(data), privateKeyOf(identity)));

function verify(id, data, sig) {
  try {
    return crypto.verify(null, Buffer.from(data), publicKeyOf(id), unb64u(sig));
  } catch {
    return false;
  }
}

// A one-off X25519 key pair for one session.
function ephemeral() {
  const { privateKey } = crypto.generateKeyPairSync('x25519');
  return { privateKey, pub: privateKey.export({ format: 'jwk' }).x };
}

function sharedSecret(eph, peerPub) {
  const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: peerPub }, format: 'jwk' });
  return crypto.diffieHellman({ privateKey: eph.privateKey, publicKey });
}

const sha256 = (...parts) => crypto.createHash('sha256').update(parts.join('\n')).digest();
const hmac = (key, data) => b64u(crypto.createHmac('sha256', key).update(data).digest());

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Session keys for each direction, bound to the whole handshake transcript.
function sessionKeys(secret, transcript) {
  const okm = Buffer.from(crypto.hkdfSync('sha256', secret, transcript, 'localpilot session v1', 64));
  return { initiator: okm.subarray(0, 32), responder: okm.subarray(32, 64) };
}

// About 100 ms and 32 MB per guess, so a 6-digit code holds for the 10 s a handshake may take.
function pairingKey(code, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(code).replace(/\D/g, ''), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const newPairingCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

// Seals and opens frames in one direction; the nonce is a counter, so frames can't be replayed
// or reordered without failing.
class FrameCipher {
  constructor(key) {
    this.key = key;
    this.counter = 0n;
  }

  nonce() {
    const n = Buffer.alloc(12);
    n.writeBigUInt64BE(this.counter++, 4);
    return n;
  }

  seal(plain) {
    const c = crypto.createCipheriv('chacha20-poly1305', this.key, this.nonce(), { authTagLength: 16 });
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  }

  open(sealed) {
    if (sealed.length < 16) throw new Error('frame too short');
    const d = crypto.createDecipheriv('chacha20-poly1305', this.key, this.nonce(), { authTagLength: 16 });
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  }
}

module.exports = {
  b64u, unb64u, newIdentity, sign, verify, ephemeral, sharedSecret, sha256, hmac, safeEqual,
  sessionKeys, pairingKey, newPairingCode, FrameCipher,
};
