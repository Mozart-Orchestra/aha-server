import { describe, it, expect } from 'vitest'
import {
  parseWechatXml,
  buildTextReplyXml,
  extractMessageText,
  WechatTextMessage,
  WechatImageMessage,
  WechatVoiceMessage,
  WechatEventMessage,
} from './xmlParser'

describe('parseWechatXml', () => {
  it('should parse a text message', () => {
    const xml = `<xml>
      <ToUserName><![CDATA[gh_test123]]></ToUserName>
      <FromUserName><![CDATA[o_user456]]></FromUserName>
      <CreateTime>1348831860</CreateTime>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[Hello World]]></Content>
      <MsgId>1234567890123456</MsgId>
    </xml>`

    const msg = parseWechatXml(xml) as WechatTextMessage
    expect(msg.ToUserName).toBe('gh_test123')
    expect(msg.FromUserName).toBe('o_user456')
    expect(msg.CreateTime).toBe('1348831860')
    expect(msg.MsgType).toBe('text')
    expect(msg.Content).toBe('Hello World')
    expect(msg.MsgId).toBe('1234567890123456')
  })

  it('should parse an image message', () => {
    const xml = `<xml>
      <ToUserName><![CDATA[gh_test]]></ToUserName>
      <FromUserName><![CDATA[o_user]]></FromUserName>
      <CreateTime>1348831860</CreateTime>
      <MsgType><![CDATA[image]]></MsgType>
      <PicUrl><![CDATA[http://example.com/pic.jpg]]></PicUrl>
      <MediaId><![CDATA[media_id_123]]></MediaId>
      <MsgId>123456</MsgId>
    </xml>`

    const msg = parseWechatXml(xml) as WechatImageMessage
    expect(msg.MsgType).toBe('image')
    expect(msg.PicUrl).toBe('http://example.com/pic.jpg')
    expect(msg.MediaId).toBe('media_id_123')
  })

  it('should parse a subscribe event', () => {
    const xml = `<xml>
      <ToUserName><![CDATA[gh_test]]></ToUserName>
      <FromUserName><![CDATA[o_user]]></FromUserName>
      <CreateTime>1348831860</CreateTime>
      <MsgType><![CDATA[event]]></MsgType>
      <Event><![CDATA[subscribe]]></Event>
    </xml>`

    const msg = parseWechatXml(xml) as WechatEventMessage
    expect(msg.MsgType).toBe('event')
    expect(msg.Event).toBe('subscribe')
  })

  it('should throw on invalid XML without root element', () => {
    expect(() => parseWechatXml('<notxml>test</notxml>')).toThrow(
      'Invalid WeChat XML: missing root <xml> element'
    )
  })

  it('should throw on empty string', () => {
    expect(() => parseWechatXml('')).toThrow()
  })
})

describe('buildTextReplyXml', () => {
  it('should build a valid XML reply', () => {
    const xml = buildTextReplyXml('o_user', 'gh_test', 'Hello reply')

    expect(xml).toContain('<ToUserName><![CDATA[o_user]]></ToUserName>')
    expect(xml).toContain('<FromUserName><![CDATA[gh_test]]></FromUserName>')
    expect(xml).toContain('<MsgType><![CDATA[text]]></MsgType>')
    expect(xml).toContain('<Content><![CDATA[Hello reply]]></Content>')
    expect(xml).toContain('<CreateTime>')
    expect(xml).toMatch(/^<xml>/)
    expect(xml).toMatch(/<\/xml>$/)
  })

  it('should handle special characters in content', () => {
    const xml = buildTextReplyXml('user', 'bot', 'Hello <world> & "quotes"')
    expect(xml).toContain('<Content><![CDATA[Hello <world> & "quotes"]]></Content>')
  })

  it('should handle Chinese characters', () => {
    const xml = buildTextReplyXml('user', 'bot', '你好世界')
    expect(xml).toContain('<Content><![CDATA[你好世界]]></Content>')
  })
})

describe('extractMessageText', () => {
  it('should extract text from text message', () => {
    const msg: WechatTextMessage = {
      ToUserName: 'gh_test',
      FromUserName: 'o_user',
      CreateTime: 1348831860,
      MsgType: 'text',
      Content: 'Hello',
      MsgId: '123',
    }
    expect(extractMessageText(msg)).toBe('Hello')
  })

  it('should return placeholder for image message', () => {
    const msg: WechatImageMessage = {
      ToUserName: 'gh_test',
      FromUserName: 'o_user',
      CreateTime: 1348831860,
      MsgType: 'image',
      PicUrl: 'http://example.com/pic.jpg',
      MediaId: 'media_123',
      MsgId: '123',
    }
    expect(extractMessageText(msg)).toBe('(图片消息)')
  })

  it('should return recognition text for voice message', () => {
    const msg: WechatVoiceMessage = {
      ToUserName: 'gh_test',
      FromUserName: 'o_user',
      CreateTime: 1348831860,
      MsgType: 'voice',
      MediaId: 'media_123',
      Format: 'amr',
      Recognition: '语音识别结果',
      MsgId: '123',
    }
    expect(extractMessageText(msg)).toBe('语音识别结果')
  })

  it('should return placeholder for voice without recognition', () => {
    const msg: WechatVoiceMessage = {
      ToUserName: 'gh_test',
      FromUserName: 'o_user',
      CreateTime: 1348831860,
      MsgType: 'voice',
      MediaId: 'media_123',
      Format: 'amr',
      MsgId: '123',
    }
    expect(extractMessageText(msg)).toBe('(语音消息)')
  })

  it('should return event info for event message', () => {
    const msg: WechatEventMessage = {
      ToUserName: 'gh_test',
      FromUserName: 'o_user',
      CreateTime: 1348831860,
      MsgType: 'event',
      Event: 'subscribe',
    }
    expect(extractMessageText(msg)).toBe('(事件: subscribe)')
  })
})
