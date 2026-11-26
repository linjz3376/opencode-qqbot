// @input:  音频字节 + OpenAI 兼容 STT 端点配置（fetch 可注入，测试用）
// @output: sttConfigured / sttTranscribe
// @pos:    core - 语音外部转写回退（2026-11-23 学习参考 AD 项，源=hermes-agent adapter.py P0 邻接）
//
// 链路：QQ 内置 ASR（asr_refer_text，免费优先）→ 空时回退本模块（GLM-ASR/Whisper/
// 任意 OpenAI 兼容 /audio/transcriptions 端点）。未配置三键时本模块整体离线——
// 语音消息走既有「不支持」路径，行为零变化。密钥只经 env 读取，绝不落盘/回显。

export interface SttConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/** 从 env 读 STT 配置；缺任一必需项返回 null（=外部回退离线）。 */
export function sttConfigured(env: NodeJS.ProcessEnv = process.env): SttConfig | null {
  const baseUrl = (env.QQ_STT_BASE_URL ?? "").trim().replace(/\/+$/, "")
  const apiKey = (env.QQ_STT_API_KEY ?? "").trim()
  const model = (env.QQ_STT_MODEL ?? "whisper-1").trim()
  if (!baseUrl || !apiKey) return null
  return { baseUrl, apiKey, model }
}

/**
 * 调 OpenAI 兼容转写端点。失败抛错（调用方转有据短语）；fetchImpl 可注入。
 * multipart：file + model；30s 超时。
 */
export async function sttTranscribe(
  bytes: Uint8Array,
  filename: string,
  cfg: SttConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const form = new FormData()
  form.append("model", cfg.model)
  form.append("file", new Blob([bytes.buffer as ArrayBuffer]), filename)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  let res: Response
  try {
    res = await fetchImpl(`${cfg.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) throw new Error(`STT ${res.status}`)
  const j = (await res.json()) as { text?: string }
  const text = (j.text ?? "").trim()
  if (!text) throw new Error("STT 空转写")
  return text
}
