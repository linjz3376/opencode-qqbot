# Privacy and Data Handling / 隐私与数据处理

This document describes the categories of data the bot can process and the responsibilities of deployers. It is not a guarantee that every deployment has the same behavior. Actual data flows depend on configuration, enabled features, QQ and OpenCode settings, AI providers, network paths, and local operational choices.

## English

### Data the bot may process

- QQ messages, quoted content, group or user identifiers, and interaction data.
- Desktop session content, including the default full-text session mirror.
- Voice content and speech-recognition text, images, files, filenames, and file contents selected for upload or sending.
- Approval decisions, commands, task history, delivery and deduplication records, gateway session/sequence state, watchdog events, and diagnostic logs.
- Credentials such as `QQ_APP_SECRET` and `OPENCODE_PASSWORD`, which must remain in the designated secret store and must never be printed, copied into logs, committed, or disclosed.

### Where data may go

- QQ Open Platform and QQ clients, according to the bot's messaging behavior.
- The OpenCode service and execution environment selected by the deployer.
- AI/model providers configured for the OpenCode service. Their own privacy terms, retention policies, and regional processing rules may apply.
- External speech-to-text providers configured through `QQ_STT_*`: when enabled, audio bytes and filenames are sent to the selected transcription endpoint. That provider's privacy, retention, and regional processing rules also apply.
- Local runtime storage such as `~/.openqq/`, which can contain configuration, ledgers, message-related state, and logs.
- Downloaded image attachments are stored in the system temporary directory under `opencode/qq-images`. Files older than seven days are only subject to a cleanup attempt when the bot starts; all other retention and deletion remains an operational responsibility.

This repository does not establish a maintainer-operated data-processing service on your behalf. Deployers must nevertheless verify actual endpoints, providers, subprocesses, log destinations, and any telemetry or external integrations in their environment.

### Retention and access

- Runtime retention varies by feature and configuration. Some delivery-deduplication records are retained for a bounded period, while other session, form, queue, and diagnostic records may persist until their configured cleanup or manual deletion.
- The unified log uses rolling files with a configured size budget. Retention and deletion are operational responsibilities, not automatic privacy guarantees.
- Deployers must restrict access to runtime files, backups, logs, screenshots, and exported files, and must define retention, archival, deletion, and incident-response procedures suitable for their users and jurisdiction.

### Deployer and user responsibilities

Deployers must, as required by applicable law and their role:

1. Inform affected users what data is collected, why it is processed, who receives it, where it is stored, and how long it is retained.
2. Obtain consent or establish another valid legal basis before processing personal information, sensitive information, confidential content, or employee/user communications.
3. Avoid collecting unnecessary secrets, sensitive personal information, or confidential material, and minimize mirrored content and attachments where possible.
4. Assess cross-border transfer, processor, subprocessors, and industry-specific requirements before enabling external AI providers or remote QQ services.
5. Provide appropriate access, correction, deletion, withdrawal, and incident-handling channels.
6. Keep credentials out of source control and logs, rotate them after suspected disclosure, and do not share runtime secret files.

AI output may be inaccurate. Users must independently review it, especially for dangerous operations, permissions, files, professional judgments, and decisions affecting other people.

For privacy-related questions, open an issue in the project repository. Do not include secrets or sensitive personal information in the issue.

## 中文

### 可能处理的数据

- QQ 消息、引用内容、群或用户标识以及互动数据。
- 桌面会话内容，包括默认的全文会话镜像。
- 语音及语音识别文本、图片、文件、文件名，以及选择上传或发送的文件内容。
- 审批决定、命令、任务历史、投递与去重记录、网关 session/sequence 状态、看门狗事件和诊断日志。
- `QQ_APP_SECRET`、`OPENCODE_PASSWORD` 等凭据。凭据只能存放在指定密钥存储中，不得打印、复制进日志、提交或披露。

### 数据可能流向

- QQ 开放平台及 QQ 客户端，取决于机器人的消息行为。
- 部署者选择的 OpenCode 服务和执行环境。
- OpenCode 服务配置的 AI/模型提供方；其隐私条款、留存政策和地域处理规则可能同时适用。
- 通过 `QQ_STT_*` 配置的外部语音识别提供方：启用后，音频字节和文件名会发送至所选转写端点，该提供方的隐私、留存及地域处理规则同时适用。
- `~/.openqq/` 等本地运行时存储，可能包含配置、台账、消息相关状态和日志。
- 下载的图片附件保存在系统临时目录的 `opencode/qq-images` 下；超过七天的文件仅在 bot 启动时尝试清理，其余保存与删除仍属运维责任。

本仓库不会替部署者建立由维护者运营的数据处理服务。部署者仍须核实其实际端点、服务提供方、子进程、日志目的地，以及环境中的遥测或外部集成。

### 保存与访问

- 各类数据的保存期限随功能和配置而异。部分投递去重记录有有界保存期，其他会话、表单、队列和诊断记录可能持续保存，直到配置的清理或人工删除。
- 统一日志按配置预算滚动。留存与删除属于运维责任，不能仅凭滚动机制推定已经满足隐私要求。
- 部署者必须限制对运行时文件、备份、日志、截图和导出文件的访问，并根据用户及适用法域制定保存、归档、删除和事件响应程序。

### 部署者与用户责任

部署者应根据适用法律及其角色：

1. 向相关用户说明收集哪些数据、处理目的、接收方、存储位置和保存期限。
2. 在处理个人信息、敏感信息、保密内容或员工/用户通信前，取得必要授权或具备其他合法处理依据。
3. 避免收集不必要的密钥、敏感个人信息或保密材料，并尽可能减少镜像内容和附件。
4. 启用外部 AI 服务或远程 QQ 服务前，评估跨境传输、处理者、子处理者及行业特别要求。
5. 提供适当的查询、更正、删除、撤回同意和事件处理渠道。
6. 防止凭据进入版本控制和日志，疑似泄露时及时轮换，不共享运行时密钥文件。

AI 生成内容可能不准确。用户必须独立复核，尤其是危险操作、权限、文件、专业判断及影响他人的决定。

隐私相关问题请通过项目仓库 issue 联系，提交时不得包含密钥或敏感个人信息。
