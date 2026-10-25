# 睡眠合并规则草案 v0.1（2026-10-14）

> 板条「睡眠合并」：**先写规则草案，再谈实现**（备忘候选池缓条：合并＝在红线上跳舞，成本/风险高）。
> 本文只定**规则**，不动实现、不改六库。触发：管线的一半（候选生成）其实**早已建成**，卡点在 `--apply` / 回滚 / `revokes`（SCHEMA §P4 已设计未实现，原文「待本计划评审」）——本草案就是那份评审依据。

## 1. 现状盘点（先盘清，别重复造）

| 件 | 状态 | 证据 |
|---|---|---|
| merge **候选生成器** | ✅ 已有 | `sleep.mjs`：`PLAN_OP_ORDER={merge,discard}`；merge＝同库当前集、keep＝根 `logged_at` 最早（同则根 id 字典序）、贪心吸收（与 keep 直接 ≥θ），`reason:'near-duplicate'`、带 `evidence.{theta,field,pairs}`；frontier 另走 `duplicate-url` |
| discard（快照被取代） | ✅ 生成 / ❌ apply | `reason:'snapshot-superseded'` |
| `mergedText` | 占位（留空） | 计划注：「留模型/人填写」 |
| `--apply` / 回滚 / `revokes` | ✅ **已实现（2026-10-14，本日裁定后）** | `applyPlan` / `revokePlan`（sleep.mjs）+ CLI `sleep --apply/--revoke`；revokes 语义入 lib（SCHEMA §P4 已标实现）；R4 keep 已落（首例验证：keep v0.4 ← absorb v0.3）；主套件 232/232 |
| 近失报告 `nearMiss` | ✅ 只读 | 计划里带各家候选数与 top3（供 θ 校准采样） |
| 真库现状（2026-10-14 计划） | merge×1 · discard×3 | plan-d9aa98b74e7b3aa9：merge＝`canon-source-akasha-paper-v0-3-20261007` ← `…v0-4…`（jaccard 0.858 ≥ θ 0.8） |

## 2. 红线对齐（三条，写在最前）

1. **同题多源不合并**（2026-10-06 立）——合并**只**允许作用于「机械近重复」；同主题不同证据/不同角度**一律不并**。
2. **不改原文**（append-only 根本纪律）——执行**不得**改写任何既有行；一切"合并"以「保留者一字不动 ＋ 吸收者软退役」表达。
3. **可逆**——任何合并可撤销（走设计中的 `revokes` 语义：撤墓碑、不碰保留者）。

## 3. 规则草案

- **R1 候选域**：仅**同库**（跨库禁）、仅 `source.type` 相同者（跨来源类型禁）、仅当前集（已退役不参与）、**豁免面**：协议条 / 自我层（tag『自我』与 `canon-akasha-usage*` 等常驻注入条）、`pricing` 与 `lexicon`（定义表，命中率靠词面本身，不并）。
- **R2 判定口径**：文本近重复默认 `θ=0.8`（现有稀有词 Jaccard 面）；frontier 走 `duplicate-url`；**阈值校准**只能引用 `nearMiss` 只读采样，不得事后调参。
- **R3 执行语义（两档，默认 A）**：
  - **A 档（推荐·默认）**：保留者**一字不动**；吸收者 → **软退役墓碑**（`retires: <吸收者链尾>`＋`retired_reason: 'merged-into <keep-id>'`，`evidence` 抄录 jaccard/pairs）；**不写 `mergedText`**。语义＝「确认重复、折其一焉」，零改写风险、完全可逆。
  - **B 档（登记·默认关）**：新增合成版（需 SCHEMA 增列 `merged_from`＋由模型/人**逐条撰写** `mergedText`＋更高阈值＋逐条人工批）。理由：B 档本质是「以新写代旧」，只在两条都不完整且互补时才值得；风险面大，先不开。
- **R4 keep 选择**：**按代际定，不按最老定**——同源快照的两代 ⇒ 保留**最新**（`event_time`/`logged_at` 较晚者）；真重复（无代际关系）⇒ 保留最早。机器不能判定代际时 ⇒ **默认交人工在评审时指定**，`apply` 拒绝无 keep 的 op。（**对现有实现的必改点**：现规则恒取"最早"，首例即反例。）
- **R5 幂等**：吸收者已在退役集 ⇒ skip；计划指纹比对（同 planId 不重复执行）；`apply` 后写 `sleep-merge` 观测线（含 planId/op 计数/keep/absorb）。
- **R6 审计**：每条 op 落 **review-log**（复用 I-10：`verdict:'合并'`、`by` 记人工/self、note 带 jaccard），并在计划文件保留 ops 原样（证据可回溯）。
- **R7 禁令**（一律拒执行）：跨库 · 跨 `source.type` · 文本差异超阈（同题异证）· 豁免面（R1）· 无 keep 指定 · 计划指纹过期（库在评审后又被改过——按当前集 `(根 id, 正文)` 复核）。**生产路径另加硬闸：非演练的 `--force` 拒绝**（`sleep --apply --yes --force` 不写库）。指纹过期的处置是重新 `sleep --plan`，不是强行执行。
- **R8 执行入口**：`node akasha.mjs sleep --apply <planId>`——**默认关**、首批**逐条人工确认**；`--revoke <planId>` 走 `revokes`；二者都要在**当前集比对**上验收（不比逐行，历史行一条不删）。`--force` 只留在演练（不加 `--yes`）里，用来查看过期计划会做什么。

## 4. 首例案例研究（写草案当天真库唯一候选）

- 对：`canon-source-akasha-paper-v0-3-20261007`（keep 位，2026-10-06 回填）← `…-v0-4-20261007`（吸收位，2026-10-07 回填）；jaccard 0.858；同库、同 `source.type=复现` ✓ 过 R1/R2。
- **人工判读**：两条是**同一论文源头材料的两个代际**（v0.3 稿骨架 §1.4「推演现场」→ v0.4 稿 §1.4「源起弧线」，同一骨架小改几节）⇒ **属于可合并类**（不是同题异证）。
- **但按 R4，keep 应取 v0.4（最新代），现管线取最老的 v0.3 ⇒ 本条若照现计划执行会把现稿骨架埋掉。** ⇒ 结论：**此例应并，但必须先修 keep 规则（R4）**；修好后重生成计划再执行。

## 5. 实现清单（apply/revoke 落地时的验收，8 条）

1. fixture：keep 原文逐字不动（与 apply 前 byte-equal）；2. 吸收者墓碑形状与 `retires` 悬空检查（`check` 绿）；3. 当前集变化符合预期（`lookup/brief/cross/summary` 均不再见吸收者）；4. 幂等（重跑 0 新增）；5. 回滚（`--revoke` 后当前集恢复、历史零行删除）；6. 豁免面拒执行（协议条/自我层构造用例）；7. 计划指纹过期拒执行（评审后改库场景）；8. 审计（review-log 行＋`sleep-merge` 观测线）。

## 6. 留裁（给 Master 的三问）→ 已裁定（2026-10-14）

1. **A 档默认先行** ✓（当日实现）；**B 档：保留待启用**——用户明示「实际 B 档可能也需要些」，登记不启用，等真需要再开。
2. **R4 keep 按代际** ✓ 落实现（首例验证：`keep v0.4 ← absorb v0.3`；此前会误埋现稿）。
3. **骨架共用、各自验收** ✓——apply/revoke 骨架一批交付，merge 与 discard 各自跑验收（守卫测试分开成块）。

## 7. 附：与 discard 的关系

discard（`snapshot-superseded`）与 merge 共用同一 apply/回滚骨架，但语义不同（**取代** vs **折一**）：discard 的保留对象由修订链决定、不需要 keep 选择；两件的实现可同批，验收清单各自跑（discard 另有"被取代者的链尾仍在历史"断言）。
