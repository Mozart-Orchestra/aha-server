import { describe, it, expect } from 'vitest'
import { extractText } from './weixinBridge'

describe('extractText (iLink Bot bridge)', () => {
  it('should extract text from type 1 text item', () => {
    const msg = {
      item_list: [{ type: 1, text_item: { text: 'Hello world' } }],
    }
    expect(extractText(msg)).toBe('Hello world')
  })

  it('should extract image URL from type 2 image item', () => {
    const msg = {
      item_list: [{ type: 2, image_item: { url: 'https://example.com/pic.jpg' } }],
    }
    expect(extractText(msg)).toBe('[图片] https://example.com/pic.jpg')
  })

  it('should fallback to pic_url for type 2 image item', () => {
    const msg = {
      item_list: [{ type: 2, image_item: { pic_url: 'https://example.com/pic2.jpg' } }],
    }
    expect(extractText(msg)).toBe('[图片] https://example.com/pic2.jpg')
  })

  it('should fallback to placeholder for type 2 image without URL', () => {
    const msg = {
      item_list: [{ type: 2, image_item: {} }],
    }
    expect(extractText(msg)).toBe('[图片] (图片)')
  })

  it('should extract voice text from type 3 voice item', () => {
    const msg = {
      item_list: [{ type: 3, voice_item: { text: '语音识别结果' } }],
    }
    expect(extractText(msg)).toBe('语音识别结果')
  })

  it('should fallback to recognition for type 3 voice item', () => {
    const msg = {
      item_list: [{ type: 3, voice_item: { recognition: '备用识别结果' } }],
    }
    expect(extractText(msg)).toBe('备用识别结果')
  })

  it('should fallback to placeholder for type 3 voice without text', () => {
    const msg = {
      item_list: [{ type: 3, voice_item: {} }],
    }
    expect(extractText(msg)).toBe('(语音)')
  })

  it('should extract file info from type 4 file item', () => {
    const msg = {
      item_list: [{ type: 4, file_item: { file_name: 'doc.pdf', url: 'https://example.com/doc.pdf' } }],
    }
    expect(extractText(msg)).toBe('[文件] doc.pdf https://example.com/doc.pdf')
  })

  it('should handle type 4 file without URL', () => {
    const msg = {
      item_list: [{ type: 4, file_item: { file_name: 'doc.pdf' } }],
    }
    expect(extractText(msg)).toBe('[文件] doc.pdf ')
  })

  it('should extract video URL from type 5 video item', () => {
    const msg = {
      item_list: [{ type: 5, video_item: { url: 'https://example.com/video.mp4' } }],
    }
    expect(extractText(msg)).toBe('[视频] https://example.com/video.mp4')
  })

  it('should fallback to thumb_url for type 5 video item', () => {
    const msg = {
      item_list: [{ type: 5, video_item: { thumb_url: 'https://example.com/thumb.jpg' } }],
    }
    expect(extractText(msg)).toBe('[视频] https://example.com/thumb.jpg')
  })

  it('should fallback to placeholder for type 5 video without URL', () => {
    const msg = {
      item_list: [{ type: 5, video_item: {} }],
    }
    expect(extractText(msg)).toBe('[视频] (视频)')
  })

  it('should extract link info from type 6 link item', () => {
    const msg = {
      item_list: [{ type: 6, link_item: { title: '好文推荐', url: 'https://example.com/article' } }],
    }
    expect(extractText(msg)).toBe('[链接] 好文推荐 https://example.com/article')
  })

  it('should fallback to link field in link_item', () => {
    const msg = {
      item_list: [{ type: 6, link_item: { title: '文章', link: 'https://example.com/link' } }],
    }
    expect(extractText(msg)).toBe('[链接] 文章 https://example.com/link')
  })

  it('should extract link via link_item property (without type 6)', () => {
    const msg = {
      item_list: [{ link_item: { title: '发现', url: 'https://example.com/discover' } }],
    }
    expect(extractText(msg)).toBe('[链接] 发现 https://example.com/discover')
  })

  it('should extract app/mini-program link from type 49', () => {
    const msg = {
      item_list: [{ type: 49, app_item: { title: '小程序', url: 'https://example.com/miniapp' } }],
    }
    expect(extractText(msg)).toBe('[链接] 小程序 https://example.com/miniapp')
  })

  it('should extract app link via app_item property (without type 49)', () => {
    const msg = {
      item_list: [{ app_item: { title: '应用', url: 'https://example.com/app' } }],
    }
    expect(extractText(msg)).toBe('[链接] 应用 https://example.com/app')
  })

  it('should handle mixed message types', () => {
    const msg = {
      item_list: [
        { type: 1, text_item: { text: '看看这个' } },
        { type: 2, image_item: { url: 'https://example.com/pic.jpg' } },
        { type: 6, link_item: { title: '文章', url: 'https://example.com' } },
      ],
    }
    expect(extractText(msg)).toBe('看看这个\n[图片] https://example.com/pic.jpg\n[链接] 文章 https://example.com')
  })

  it('should return empty message placeholder for empty item_list', () => {
    const msg = { item_list: [] }
    expect(extractText(msg)).toBe('(空消息)')
  })

  it('should return empty message placeholder for missing item_list', () => {
    const msg = {}
    expect(extractText(msg)).toBe('(空消息)')
  })

  it('should skip items with unknown types', () => {
    const msg = {
      item_list: [
        { type: 99, unknown_item: { data: 'something' } },
        { type: 1, text_item: { text: 'hello' } },
      ],
    }
    expect(extractText(msg)).toBe('hello')
  })
})
