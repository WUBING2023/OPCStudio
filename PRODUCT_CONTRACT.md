# OPC Studio · Product Contract(Stage 0 锁定)

> 日期:2026-06-30 · 本文是 OPC Studio 的**产品契约**——所有后续实现必须服务于它。
> 配套:`OPC-Studio-Product-Roadmap.md`(能力成熟度阶梯)。本契约 = Roadmap Stage 0 的产物。

## 最高约束
> **任何实现都必须推进「部署、运行、观察、改造、保存、分享 AI Team」主闭环。不直接推进的,默认延后。**
> 每个改动自问:这是否推进下方 10 个用户动作之一?否则降级。

## 10 个用户动作(产品最小承诺)
1. 选择或导入一个 AI Team。
2. 检查这个 Team 需要哪些模型 / CLI / MCP / Skill / 权限。
3. 选择 **Quick Run 或 Team Run**。
4. Team Run 中选 **Economy / Balanced / Max Quality**。
5. 输入任务。
6. 观察团队执行(组织图)。
7. 查看 artifacts / run story / trace / 成本 / 失败原因。
8. 查看每个员工的角色记忆。
9. 保存、导出、分享这个 Team。
10. 重新导入后复用。

## Run Type / Team Mode 分层(锁定)
```
Run Type
├── Quick Run  → 单 agent,1–2min,无团队增益(简单问题/没耐心用户)
└── Team Run   → 多 agent(慢,有产物/trace/记忆/验证)
       └── Team Mode
             ├── Economy     全 deepseek/Hermes
             ├── Balanced    Lead+FactCheck+Synth 用 Claude/Sonnet,其余 DeepSeek(= 实验配置 5B)
             └── Max Quality 全强模型(最贵,且因 CLI 串行最慢)
```

## 已锁定决策
| # | 决策 | 结论 |
|---|---|---|
| D1 | 第一个官方 Team | **AI Research Company** |
| D2 | MVP 含导出/复用 | **是** |
| D3 | 成本-质量三档 | **是** |
| **D4** | **交互模型** | **异步("丢任务→看进度→回来取报告")+ 提供 Quick Run 即时档** |
| D5 | 发布目标 | **默认本地单用户**(多租户=Stage 9 全做完才发;实现分叉时再问) |
| D6 | Balanced 档职位映射 | **5B**:Lead + FactCheck + Synth 用强模型,其余 DeepSeek |
| D7 | Research 验收标准 | 对真实研究任务**人工评** vs 单 Claude/单 GPT("更全/有引用/可信"),非 DRACO 分 |

## 产品成功验收(终极闸门)
**基础(普通用户 ~30min)**:安装→导入 Research Company→连一个可用模型→选 Quick/Team Run→跑出有产物/来源/trace summary 的报告→看懂每个 agent 做了什么→看到≥1 条角色记忆→导出 Team→重导入复用。
**进阶(power user)**:改 team 结构→换 agent 模型→加 verifier→改 artifact contract→存为自己的 template→分享。

> 基础闭环 ≈ Roadmap Stage 2 完成;进阶闭环 ≈ Stage 6/8 完成。

## 诚实声明
代码级"完成"(tsc/测试/API/流程绿)**≠ 产品级"好用"**。UI 可用性/UX、安全(Stage 9)、商业(Stage 10)需人工/业务判定;此类闸门会做完+如实标"待眼检/待决策",不冒充完成。
