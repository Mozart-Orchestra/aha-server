import { XMLParser } from 'fast-xml-parser'

/**
 * WeChat XML message types.
 */
export interface WechatTextMessage {
  ToUserName: string
  FromUserName: string
  CreateTime: number
  MsgType: 'text'
  Content: string
  MsgId: string
}

export interface WechatImageMessage {
  ToUserName: string
  FromUserName: string
  CreateTime: number
  MsgType: 'image'
  PicUrl: string
  MediaId: string
  MsgId: string
}

export interface WechatVoiceMessage {
  ToUserName: string
  FromUserName: string
  CreateTime: number
  MsgType: 'voice'
  MediaId: string
  Format: string
  Recognition?: string
  MsgId: string
}

export interface WechatVideoMessage {
  ToUserName: string
  FromUserName: string
  CreateTime: number
  MsgType: 'video' | 'shortvideo'
  MediaId: string
  ThumbMediaId: string
  MsgId: string
}

export interface WechatLinkMessage {
  ToUserName: string
  FromUserName: string
  CreateTime: number
  MsgType: 'link'
  Title: string
  Description: string
  Url: string
  MsgId: string
}

export interface WechatEventMessage {
  ToUserName: string
  FromUserName: string
  CreateTime: number
  MsgType: 'event'
  Event: 'subscribe' | 'unsubscribe' | 'CLICK' | 'VIEW' | string
  EventKey?: string
}

export type WechatIncomingMessage =
  | WechatTextMessage
  | WechatImageMessage
  | WechatVoiceMessage
  | WechatVideoMessage
  | WechatLinkMessage
  | WechatEventMessage

/**
 * Parse WeChat XML message body into a typed object.
 */
export function parseWechatXml(xml: string): WechatIncomingMessage {
  const parser = new XMLParser({
    trimValues: true,
    parseTagValue: false,
  })
  const parsed = parser.parse(xml)
  if (!parsed.xml) {
    throw new Error('Invalid WeChat XML: missing root <xml> element')
  }
  return parsed.xml as WechatIncomingMessage
}

/**
 * Build a text reply XML response for WeChat.
 */
export function buildTextReplyXml(
  toUser: string,
  fromUser: string,
  content: string
): string {
  const timestamp = Math.floor(Date.now() / 1000)
  return [
    '<xml>',
    `<ToUserName><![CDATA[${toUser}]]></ToUserName>`,
    `<FromUserName><![CDATA[${fromUser}]]></FromUserName>`,
    `<CreateTime>${timestamp}</CreateTime>`,
    '<MsgType><![CDATA[text]]></MsgType>',
    `<Content><![CDATA[${content}]]></Content>`,
    '</xml>',
  ].join('\n')
}

/**
 * Extract text content from any incoming WeChat message type.
 * Returns a human-readable string representation.
 */
export function extractMessageText(msg: WechatIncomingMessage): string {
  switch (msg.MsgType) {
    case 'text':
      return msg.Content
    case 'image':
      return `[图片] ${msg.PicUrl}`
    case 'voice':
      return msg.Recognition ?? '(语音消息)'
    case 'video':
    case 'shortvideo':
      return `[视频] mediaId=${msg.MediaId}`
    case 'link':
      return `[链接] ${msg.Title}\n${msg.Description}\n${msg.Url}`
    case 'event':
      return `(事件: ${msg.Event})`
    default:
      return '(未知消息类型)'
  }
}
