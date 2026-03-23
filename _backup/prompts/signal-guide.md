# Star AI 日报 — 信号判读指南

feed JSON 中每条推文附带 `_metrics` 字段，顶层有 `_crossSignals`。
用这些指标辅助你的判断，但最终决定权在你。

## _metrics 字段说明

- `engagementScore`: likes + retweets * 3，衡量传播热度
- `isHighEngagement`: score > 500 为 true，表示这条推文传播量显著高于平均

## _crossSignals 字段说明

- `sharedTopics`: 被 2 个以上 builder 同时提到的关键词及提及者列表
- `activeBuilders`: 今天有动态的 builder 总数

## 高信号特征（优先放入"今日必看"）

- `isHighEngagement: true` 且内容有实质观点（不是段子或社交寒暄）
- `sharedTopics` 中某个话题被 3+ 个 builder 提及，说明行业注意力聚焦
- officialBlogs 标题含 introducing / launching / announcing / releasing
- cnMedia 含 融资/收购/发布 + 具体金额或产品名

## 低信号特征（可以跳过）

- 高 engagement 但内容是段子、闲聊、节日祝福（likes 高不等于有价值）
- 纯转发没有自己的评论
- 泛泛的转发 + "boosting" 类内容
- 重复信息（多条推文说的是同一件事，只保留最有信息量的一条）

## 规则

- 这些指标是辅助参考，不是硬性规则。你的判断力比数字重要。
- 一条推文 engagement 低但观点独到，仍然可以进"今日必看"。
- 一条推文 engagement 爆表但只是个梗图，应该降级或跳过。
- 如果 `sharedTopics` 为空，说明今天没有明显的话题聚焦，正常处理即可。
