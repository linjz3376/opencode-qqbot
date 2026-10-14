// e2e 测试公共前置：从 ~/.openqq/.env 载入 OPENCODE_PASSWORD / OPENCODE_BASE_URL 等。
// 密钥单点在 .env（bot 与测试同源），测试文件内零硬编码。
// 用法：e2e 脚本在 import 列表末尾追加 `import "./load-env.ts"`。
import { ensureConfig } from "../src/config.ts"

await ensureConfig() // .env 存在时把密钥写入 process.env 并返回，不触发交互问询
