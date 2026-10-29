# 工作计划：opencode-qq-bot 全域验收任务书生成

- [x] 前置闸门：项目区枚举与目标确认 —— 唯一候选 `dev/opencode-qq-bot`（git 仓库 + test 基建 + 设计文档），无需回问
- [x] 技能路由回执：acceptance-contract-governance（生成模式·全域轮）
- [x] 源头新鲜度核验 —— `git fetch` 完成，HEAD 与 origin/master 同步（0 落后），快照锚 89854aa @2026-10-26（`git cat-file -e` 核验通过）
- [x] 四活源盘点 —— 缺陷台账：不存在（全树动态扫描零命中，头部声明）；fixtures/golden：不存在（AI 判据点将标「人工判定」）；设计文档：`src/_FOLDER.md`+`src/*/_FOLDER.md`+`deploy/README.md`；历史任务书：不存在（无派生基底问题）
- [x] 素材自挖：subagent 全量源码侦察完成 → 能力清单 C01–C32 + 用户可见文案逐字表 + 端点清单
- [x] 生成期环境基线探测 —— bot 进程在线（pid 20680）；计划任务 OpenQQ-Bot Running / Watchdog Ready；heartbeat 文件陈旧 480min 且进程存活（基线疑点，交由 AC-OPS-007 验证，不预设结论）
- [x] 场景建模：11 场景（G1–G3 + G-DOM×7 + G0），八要素齐、矩阵双向闭合（11+8+9+9+16+8+11+11+4+1=88）、handoff 5 条
- [x] 覆盖依据表 + 十一维深度表（D8 显式 N/A，其余十维全落点；域类型分档全部达标）
- [x] 验收点表 88 点（[MACHINE] 87 / [DOC] 1；负向 27/88=30.7%）
- [x] 造数通道盘点表 + 环境前置 + 执行者手册 + Final-Report-Gate 内嵌（grep 4 命中）
- [x] 计数机跑全绿：§1 唯一 88/零重号、§3 列完整 88×8、§9 密度 30.7%、§14 标签 0 异常、§2 悬空 0、§4/§5 指针清零（仅头部留痕行豁免）、§6 零实例 0 命中、§7 无乱码、§11 入口映射零 MISSING、快照锚 git cat-file 通过
- [x] 落盘：`test/plans/opencode-qq-bot-uat-full-20261028.md`（项目实际目录 `test/` 适配模板 `tests/plans/`）
- [x] AC 来源充分性审计（provenance-gate E 段）：88/88 四类来源齐全，零历史测试文档引用，覆盖矩阵闭合

**审计结论（E 段格式）**：
结论：PASS ｜ AC 总数：88 ｜ 来源齐全：88/88 ｜ 缺失来源：无 ｜ 历史测试文档引用：无（项目无历史任务书）｜ 覆盖缺口：无（C01–C32 全归宿；端点/入口 26 项全映射；D1–D11 全落点或 N/A；台账不存在→映射 N/A 已声明）｜ 点数一致性：通过（88 在头部/§1/§3/0.1 矩阵/§5/§11 全一致）｜ 入口标签：UI 0 / MACHINE 87 / DOC 1 / 缺省 0 / 双标签 0 ｜ 修正建议：① 执行期把审批触发规程与 golden case 回填拟建 fixtures；② ⏸️-C1/C2 递单裁定；③ AC-OPS-007 验证生成期 heartbeat 陈旧疑点
