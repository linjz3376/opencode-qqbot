// @input:  (none)
// @output: MessageContext, C2CMessageEvent, GroupMessageEvent, WSPayload, QQBotConfig
// @pos:    qq层 - QQ Bot 消息事件和协议类型定义
export interface QQBotConfig {
  appId: string
  clientSecret: string
}

/**
 * 富媒体附件
 */
export interface MessageAttachment {
  content_type: string
  filename?: string
  height?: number
  width?: number
  size?: number
  url: string
  voice_wav_url?: string
  /** 语音消息的 QQ 内置 ASR 转写文本（免费，省下载省 STT 调用） */
  asr_refer_text?: string
}

/**
 * C2C 消息事件
 */
export interface C2CMessageEvent {
  author: {
    id: string
    union_openid: string
    user_openid: string
  }
  content: string
  id: string
  timestamp: string
  message_scene?: {
    source: string
  }
  attachments?: MessageAttachment[]
  /** 长按回复引用的消息 id（QQ 客户端引用消息） */
  message_reference?: { message_id: string }
  /** 引用消息的嵌入内容载体（message_type=103 时随事件透传，官方未完全文档化） */
  message_type?: number
  msg_elements?: unknown
}

/**
 * 频道 AT 消息事件
 */
export interface GuildMessageEvent {
  id: string
  channel_id: string
  guild_id: string
  content: string
  timestamp: string
  author: {
    id: string
    username?: string
    bot?: boolean
  }
  member?: {
    nick?: string
    joined_at?: string
  }
  attachments?: MessageAttachment[]
}

/**
 * 群聊 AT 消息事件
 */
export interface GroupMessageEvent {
  author: {
    id: string
    member_openid: string
  }
  content: string
  id: string
  timestamp: string
  group_id: string
  group_openid: string
  attachments?: MessageAttachment[]
  /** 长按回复引用的消息 id（QQ 客户端引用消息） */
  message_reference?: { message_id: string }
  /** 引用消息的嵌入内容载体（message_type=103 时随事件透传，官方未完全文档化） */
  message_type?: number
  msg_elements?: unknown
}

/**
 * Hello 事件数据
 */
export interface GatewayHelloData {
  heartbeat_interval: number
}

/**
 * READY 事件数据
 */
export interface GatewayReadyData {
  session_id: string
}

/**
 * WebSocket 事件负载
 */
export interface WSPayload<T = unknown> {

  op: number
  d?: T
  s?: number
  t?: string
}

/**
 * 按钮交互回调事件（INTERACTION_CREATE）——A 项卡片审批（2026-10-29）。
 * 形状对齐 P0 官方 @tencent-connect/qqbot-nodejs protocol/types.ts。
 */
export interface InteractionButtonResolved {
  button_id?: string
  button_data?: string
}

export interface InteractionEvent {
  id: string
  type?: number
  scene?: string
  user_openid?: string
  group_openid?: string
  /** 群场景点击者身份（自我评审 2026-10-29：挂起槽对群用户用 member_openid 索引，
   *  只认 user_openid 会导致群按钮点击被静默拒识） */
  group_member_openid?: string
  data?: { type?: number; resolved?: InteractionButtonResolved }
}

/**
 * 桥接层统一使用的消息上下文
 */
export interface MessageContext {
  type: "c2c" | "group"
  userId: string
  groupId?: string
  msgId: string
  content: string
  /** 长按回复引用的消息 id（经 message_reference 透传） */
  referencedMsgId?: string
  /** 解析后的引用上文（bridge 从 context-buffer 解析得到，注入 prompt 前缀） */
  quoteText?: string
  /** 图片等富媒体附件（原生附件接入 2026-10-14；此前在网关被静默丢弃） */
  attachments?: MessageAttachment[]
  timestamp?: string
  rawEvent?: C2CMessageEvent | GroupMessageEvent
}
