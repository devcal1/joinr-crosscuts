// Password and PIN hashing: Node's built-in scrypt, so no native package is
// added to the image. Parameters are stored in the hash string, so they can be
// raised later without invalidating existing hashes.
// Format: scrypt$N$r$p$saltB64$hashB64
const crypto = require("crypto");

const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
// scrypt needs ~128*N*r bytes; Node's default maxmem (32MB) is exactly that,
// so give it headroom.
const MAXMEM = 64 * 1024 * 1024;

function scrypt(plain, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(plain, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

async function hashSecret(plain) {
  if (typeof plain !== "string" || plain === "") throw new Error("Empty secret");
  const salt = crypto.randomBytes(16);
  const key = await scrypt(plain, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

async function verifySecret(plain, stored) {
  if (typeof plain !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const key = await scrypt(plain, Buffer.from(saltB64, "base64"), Number(n), Number(r), Number(p));
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

module.exports = { hashSecret, verifySecret };
