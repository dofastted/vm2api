import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_OPTIONS,
  TotpError,
  buildOtpauthUri,
  counterFor,
  decodeSecret,
  encodeSecret,
  generateCode,
  generateSecret,
  hotp,
  matchCounter,
  normalizeSecret,
  parseAlgorithm,
  parseKey,
  timeRemaining,
  validate,
} from '../../src/lib/core/totp.mjs'

// RFC 6238 Appendix B seeds: ASCII "12345678901234567890" repeated to the
// digest's key length.
const SECRET_SHA1 = encodeSecret(Buffer.from('12345678901234567890'))
const SECRET_SHA256 = encodeSecret(Buffer.from('12345678901234567890123456789012'))
const SECRET_SHA512 = encodeSecret(Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'))

test('RFC 6238 test vectors match for SHA1, SHA256 and SHA512', () => {
  const vectors = [
    [59, 'SHA1', SECRET_SHA1, '94287082'],
    [59, 'SHA256', SECRET_SHA256, '46119246'],
    [59, 'SHA512', SECRET_SHA512, '90693936'],
    [1111111109, 'SHA1', SECRET_SHA1, '07081804'],
    [1111111109, 'SHA256', SECRET_SHA256, '68084774'],
    [1111111109, 'SHA512', SECRET_SHA512, '25091201'],
    [1111111111, 'SHA1', SECRET_SHA1, '14050471'],
    [1111111111, 'SHA256', SECRET_SHA256, '67062674'],
    [1111111111, 'SHA512', SECRET_SHA512, '99943326'],
    [1234567890, 'SHA1', SECRET_SHA1, '89005924'],
    [1234567890, 'SHA256', SECRET_SHA256, '91819424'],
    [1234567890, 'SHA512', SECRET_SHA512, '93441116'],
    [2000000000, 'SHA1', SECRET_SHA1, '69279037'],
    [2000000000, 'SHA256', SECRET_SHA256, '90698825'],
    [2000000000, 'SHA512', SECRET_SHA512, '38618901'],
    [20000000000, 'SHA1', SECRET_SHA1, '65353130'],
    [20000000000, 'SHA256', SECRET_SHA256, '77737706'],
    [20000000000, 'SHA512', SECRET_SHA512, '47863826'],
  ]
  for (const [seconds, algorithm, secret, expected] of vectors) {
    assert.equal(
      generateCode(secret, new Date(seconds * 1000), { digits: 8, algorithm }),
      expected,
      `vector t=${seconds} ${algorithm}`,
    )
  }
})

test('RFC 4226 HOTP vectors match for counters 0..9', () => {
  const key = Buffer.from('12345678901234567890')
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']
  for (let counter = 0; counter < expected.length; counter += 1) {
    assert.equal(hotp(key, counter, 6, 'SHA1'), expected[counter], `counter ${counter}`)
  }
})

test('secrets are normalized the way users transcribe them', () => {
  assert.equal(normalizeSecret('gezd gnbv-gy3t\tqojq\n'), 'GEZDGNBVGY3TQOJQ')
  assert.equal(normalizeSecret('GEZDGNBVGY3TQOJQ===='), 'GEZDGNBVGY3TQOJQ')
  // Spacing, casing and padding must not change the derived key.
  assert.deepEqual(decodeSecret('gezd gnbv-gy3t qojq'), decodeSecret('GEZDGNBVGY3TQOJQ'))
  assert.equal(parseKey('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq').secret, SECRET_SHA1)
})

test('base32 round-trips and rejects malformed secrets', () => {
  const raw = Buffer.from([0x00, 0xff, 0x10, 0x7a, 0x9b])
  assert.deepEqual(decodeSecret(encodeSecret(raw)), raw)
  assert.throws(
    () => decodeSecret(''),
    (e) => e instanceof TotpError && e.code === 'invalid_secret',
  )
  // '1', '8' and '0' are outside the base32 alphabet.
  assert.throws(
    () => decodeSecret('ABC1DEF8'),
    (e) => e.code === 'invalid_secret',
  )
  assert.throws(
    () => decodeSecret('!!!!!!!!'),
    (e) => e.code === 'invalid_secret',
  )
})

test('validation accepts one step of drift and rejects two', () => {
  const at = 1111111109 * 1000
  const opts = { digits: 8 }
  assert.equal(validate('07081804', SECRET_SHA1, new Date(at), opts), true)
  assert.equal(validate('07081804', SECRET_SHA1, new Date(at + 30_000), opts), true, 'next step')
  assert.equal(validate('07081804', SECRET_SHA1, new Date(at - 30_000), opts), true, 'previous step')
  assert.equal(validate('07081804', SECRET_SHA1, new Date(at + 70_000), opts), false, 'two steps later')
  assert.equal(validate('07081804', SECRET_SHA1, new Date(at - 70_000), opts), false, 'two steps earlier')
  // skew 0 pins validation to the current step only.
  assert.equal(validate('07081804', SECRET_SHA1, new Date(at + 30_000), { digits: 8, skew: 0 }), false)
})

test('matchCounter reports the step that matched, for replay protection', () => {
  const at = new Date(1111111109 * 1000)
  assert.equal(matchCounter('07081804', SECRET_SHA1, at, { digits: 8 }), counterFor(at, 30))
  assert.equal(matchCounter('00000000', SECRET_SHA1, at, { digits: 8 }), null)
})

test('a code of the wrong length is rejected without comparing', () => {
  const at = new Date(1111111109 * 1000)
  assert.equal(validate('0708180', SECRET_SHA1, at, { digits: 8 }), false)
  assert.equal(validate('070818040', SECRET_SHA1, at, { digits: 8 }), false)
  assert.equal(validate('', SECRET_SHA1, at, { digits: 8 }), false)
})

test('time step and remaining validity follow the period', () => {
  assert.equal(counterFor(new Date(59_000), 30), 1)
  assert.equal(counterFor(new Date(1111111109_000), 30), 37037036)
  assert.equal(timeRemaining(new Date(59_000), 30), 1_000)
  assert.equal(timeRemaining(new Date(60_000), 30), 30_000)
  assert.equal(timeRemaining(new Date(75_000), 30), 15_000)
})

test('otpauth URIs round-trip with their options', () => {
  const uri = buildOtpauthUri({
    secret: SECRET_SHA1,
    issuer: 'vm2api',
    account: 'admin',
    digits: 8,
    period: 60,
    algorithm: 'SHA256',
  })
  assert.match(uri, /^otpauth:\/\/totp\//)
  assert.match(uri, /issuer=vm2api/)
  const key = parseKey(uri)
  assert.equal(key.secret, SECRET_SHA1)
  assert.equal(key.issuer, 'vm2api')
  assert.equal(key.account, 'admin')
  assert.equal(key.options.digits, 8)
  assert.equal(key.options.period, 60)
  assert.equal(key.options.algorithm, 'SHA256')
})

test('otpauth parsing rejects bad input without echoing the secret', () => {
  assert.throws(
    () => parseKey('otpauth://hotp/vm2api:admin?secret=GEZDGNBVGY3TQOJQ'),
    (e) => e.code === 'invalid_uri',
  )
  assert.throws(
    () => parseKey('otpauth://totp/vm2api:admin?secret=!!!'),
    (e) => e.code === 'invalid_secret',
  )
  assert.throws(
    () => parseKey(`otpauth://totp/a?secret=${SECRET_SHA1}&digits=99`),
    (e) => e.code === 'invalid_digits',
  )
  assert.throws(
    () => parseKey(`otpauth://totp/a?secret=${SECRET_SHA1}&period=0`),
    (e) => e.code === 'invalid_period',
  )
  assert.throws(
    () => parseKey(`otpauth://totp/a?secret=${SECRET_SHA1}&algorithm=MD5`),
    (e) => e.code === 'invalid_algorithm',
  )
  try {
    parseKey('otpauth://totp/a?secret=%ZZ')
  } catch (e) {
    assert.doesNotMatch(String(e.message), /secret=/, 'the error must not repeat the URI')
  }
})

test('generated secrets are 160-bit base32 and usable', () => {
  const secret = generateSecret()
  assert.equal(secret.length, 32)
  assert.equal(decodeSecret(secret).length, 20)
  const code = generateCode(secret, new Date())
  assert.equal(code.length, DEFAULT_OPTIONS.digits)
  assert.equal(validate(code, secret, new Date()), true)
  assert.notEqual(generateSecret(), secret)
})

test('option and algorithm validation is strict', () => {
  assert.equal(parseAlgorithm(''), 'SHA1')
  assert.equal(parseAlgorithm(' sha256 '), 'SHA256')
  assert.throws(
    () => parseAlgorithm('SHA3'),
    (e) => e.code === 'invalid_algorithm',
  )
  assert.throws(
    () => hotp(Buffer.from('k'), 0, 0),
    (e) => e.code === 'invalid_digits',
  )
  assert.throws(
    () => hotp(Buffer.from('k'), 0, 11),
    (e) => e.code === 'invalid_digits',
  )
  assert.throws(
    () => generateCode(SECRET_SHA1, new Date(), { period: 0 }),
    (e) => e.code === 'invalid_period',
  )
  assert.throws(
    () => generateCode(SECRET_SHA1, new Date(), { skew: -1 }),
    (e) => e.code === 'invalid_skew',
  )
})
