import { describe, it, expect } from 'vitest'
import {
  parseWechatXml,
  buildTextReplyXml,
  extractMessageText,
  WechatTextMessage,
  WechatImageMessage,
  WechatVoiceMessage,
  WechatVideoMessage,
  WechatLinkMessage,
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

  it('should parse a video message', () => {
    const xml = `<xml>
      <ToUserName><![CDATA[gh_test]]></ToUserName>
      <FromUserName><![CDATA[o_user]]></FromUserName>
      <CreateTime>1348831860</CreateTime>
      <MsgType><![CDATA[video]]></MsgType>
      <MediaId><![CDATA[media_video_1]]></MediaId>
      <ThumbMediaId><![CDATA[thumb_1]]></ThumbMediaId>
      <MsgId>789012</MsgId>
    </xml>`

    const msg = parseWechatXml(xml) as WechatVideoMessage
    expect(msg.MsgType).toBe('video')
    expect(msg.MediaId).toBe('media_video_1')
    expect(msg.ThumbMediaId).toBe('thumb_1')
  })

  it('should parse a link message', () => {
    const xml = `<xml>
      <ToUserName><![CDATA[gh_test]]></ToUserName>
      <FromUserName><![CDATA[o_user]]></FromUserName>
      <CreateTime>1348831860</CreateTime>
      <MsgType><![CDATA[link]]></MsgType>
      <Title><![CDATA[好文推荐]]></Title>
      <Description><![CDATA[这是一篇好文章]]></Description>
      <Url><![CDATA[https://example.com/article]]></Url>
      <MsgId>345678</MsgId>
    </xml>`

    const msg = parseWechatXml(xml) as WechatLinkMessage
    expect(msg.MsgType).toBe('link')
    expect(msg.Title).toBe('好文推荐')
    expect(msg.Description).toBe('这是一篇好文章')
    expect(msg.Url).toBe('https://example.com/article')
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

  it('should return PicUrl for image message', () => {
    const msg: WechatImageMessage = {
      ToUserName: 'gh_test',
      FromUserName: 'o_user',
      CreateTime: 1348831860,
      MsgType: 'image',
      PicUrl: 'http://example.com/pic.jpg',
      MediaId: 'media_123',
      MsgId: '123',
    }
    expect(extractMessageText(msg)).toBe('[图片] http://example.com/pic.jpg')
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

  it('should return mediaId for video message', () => {
    const msg: WechatVideoMessage = {
      ToUserName: 'gh_test',
      FromUserName: 'o_user',
      CreateTime: 1348831860,
      MsgType: 'video',
      MediaId: 'media_video_1',
      ThumbMediaId: 'thumb_1',
      MsgId: '123',
    }
    expect(extractMessageText(msg)).toBe('[视频] mediaId=media_video_1')
  })

  it('should return mediaId for shortvideo message', () => {
    const msg: WechatVideoMessage = {
      ToUserName: 'gh_test',
      FromUserName: 'o_user',
      CreateTime: 1348831860,
      MsgType: 'shortvideo',
      MediaId: 'media_shortvideo_1',
      ThumbMediaId: 'thumb_2',
      MsgId: '456',
    }
    expect(extractMessageText(msg)).toBe('[视频] mediaId=media_shortvideo_1')
  })

  it('should return formatted link for link message', () => {
    const msg: WechatLinkMessage = {
      ToUserName: 'gh_test',
      FromUserName: 'o_user',
      CreateTime: 1348831860,
      MsgType: 'link',
      Title: '好文推荐',
      Description: '这是描述',
      Url: 'https://example.com/article',
      MsgId: '789',
    }
    expect(extractMessageText(msg)).toBe('[链接] 好文推荐\n这是描述\nhttps://example.com/article')
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
