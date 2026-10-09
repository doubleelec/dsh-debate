# 01: 空壳联调

**What to build:** 用户在 dev 页面点输入框内辩论按钮（有草稿才亮）打开三模型对话框，完成建单与状态轮询与停止，看到自动判断回显。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] 无草稿时按钮置灰，有草稿才可点
- [ ] 点按钮收走草稿并清空输入框，对话框显示起点
- [ ] 建单成功并轮询到 running 状态，停止后变为 stopped
- [ ] 执行后回显自动判断（问题/题型/视角数/背景字数）
