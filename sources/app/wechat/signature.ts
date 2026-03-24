import { createHash } from 'crypto'

/**
 * Verify WeChat signature for server URL validation.
 *
 * WeChat sends GET with: signature, timestamp, nonce, echostr.
 * We sort [token, timestamp, nonce], join, SHA1, and compare to signature.
 */
export function verifyWechatSignature(
  token: string,
  signature: string,
  timestamp: string,
  nonce: string
): boolean {
  const sorted = [token, timestamp, nonce].sort().join('')
  const hash = createHash('sha1').update(sorted).digest('hex')
  return hash === signature
}
