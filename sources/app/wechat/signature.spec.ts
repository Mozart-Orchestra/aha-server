import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { verifyWechatSignature } from './signature'

describe('verifyWechatSignature', () => {
  const token = 'test-token-123'

  function makeSignature(token: string, timestamp: string, nonce: string): string {
    const sorted = [token, timestamp, nonce].sort().join('')
    return createHash('sha1').update(sorted).digest('hex')
  }

  it('should return true for a valid signature', () => {
    const timestamp = '1348831860'
    const nonce = 'abc123'
    const signature = makeSignature(token, timestamp, nonce)

    expect(verifyWechatSignature(token, signature, timestamp, nonce)).toBe(true)
  })

  it('should return false for an invalid signature', () => {
    const timestamp = '1348831860'
    const nonce = 'abc123'

    expect(verifyWechatSignature(token, 'invalid-signature', timestamp, nonce)).toBe(false)
  })

  it('should return false when token is wrong', () => {
    const timestamp = '1348831860'
    const nonce = 'abc123'
    const signature = makeSignature(token, timestamp, nonce)

    expect(verifyWechatSignature('wrong-token', signature, timestamp, nonce)).toBe(false)
  })

  it('should handle empty strings', () => {
    const signature = makeSignature('', '', '')
    expect(verifyWechatSignature('', signature, '', '')).toBe(true)
  })

  it('should produce consistent results regardless of parameter order', () => {
    const timestamp = '999'
    const nonce = 'aaa'
    const sig1 = makeSignature(token, timestamp, nonce)
    const sig2 = makeSignature(token, nonce, timestamp)

    // Both should match since sort is deterministic
    expect(verifyWechatSignature(token, sig1, timestamp, nonce)).toBe(true)
    // sig2 is computed with args in different order but sort makes them equal
    expect(sig1).toBe(sig2)
  })
})
