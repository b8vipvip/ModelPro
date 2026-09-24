# Windows 10 本地基本测试

## 使用方法

1. 下载或解压 ModelPro 仓库到 Windows 10 本地目录。
2. 确保已安装 Node.js 20+（推荐 Node.js 22 LTS），并且 `node --version`、`npm --version` 在 CMD/PowerShell 可执行。
3. 双击根目录的 `Run-ModelPro-Basic-Test.cmd`。
4. 等待窗口显示 `TEST RESULT: PASS` 或 `FAIL`。
5. 将新生成的整个 `logs\ModelPro-YYYYMMDD-HHMMSS\` 文件夹压缩成 ZIP 后上传给 ChatGPT 分析。

脚本会执行仓库原有 `npm test`，再运行 Windows 本地基本测试 harness。测试覆盖确定性 probe、唯一性、模型排序（GPT-5.5 优先）、动态目录合并、picker A/B、终态判定、验证历史报告结构和 1000 次基础压力循环。

## 日志

每次运行都会创建独立目录，包含：

- `modelpro-basic-test.log`：可读的完整执行日志。
- `modelpro-basic-test.json`：逐项测试、耗时、结果和错误堆栈。
- `environment.log`：Windows、Node、npm、Git 和当前 commit 环境信息。
- `summary.json`：本轮 PASS/FAIL 汇总。

这些测试验证 ModelPro 的独立核心逻辑，不会访问真实 ChatGPT，也不会验证 GPTWork 的浏览器/CDP 网络适配层。真实模型请求/响应链仍需要在消费项目集成测试中验证。
