# 用假端点验 Pi（会话 / 续聊 / 权限扩展 / 确认帧）

**什么时候用**：动过「起 Pi」那条链路（`ai.rs` 的参数与环境、`piLaunch` 的开关、会话留档、
权限扩展）之后。它把内置那份 `cli.js` 直接驱动起来，不必有真的模型端点、不必把应用拉起来 ——
一轮几秒钟，验的是真进程、真协议。

做法：写一个临时脚本（放 `%TEMP%`，**别进版本库**），三件事凑齐就能跑：

1. **一个假端点**：`node:http` 起在本地，按 `openai-completions` 回 **SSE** 流
   （`data: {...choices:[{delta:{content}}]}` … `data: [DONE]`）。想验工具调用就按
   `tool_calls` 的增量格式下发一次 `bash`，第二次请求再回正文 —— 这样能一次看完
   「扩展问一句 → 答复 → 工具真的跑 → 模型接着说」。
2. **一份 models.json**：`{providers:{probe:{baseUrl:"http://127.0.0.1:<端口>/v1",
   api:"openai-completions", apiKey:"$PROBE_KEY", models:[{id:"fake-model"}]}}}`，
   放进一个临时 agent 目录；跑的时候 `PI_CODING_AGENT_DIR` 指过去，key 用环境变量给
   （与 `ai.rs` 注入 `WORKBENCH_AI_KEY` 同一套）。
3. **RPC 驱动**：`spawn('node', [cli, '--mode','rpc','--session-id',…,'--session-dir',…,
   '--provider','probe','--model','fake-model','--thinking','off'])`，提示词写成
   `{"type":"prompt","message":…}` 打进 stdin，stdout 按行读 JSONL；
   命名的命令（`get_messages` / `get_state`）带一个 `id`，**应答会把 id 原样带回来**
   （应用里 `aiRequest` 的配对就是靠它，实测确认过）。

## 这份探针验过的几条（2026-09-28，Pi 0.87.1）

- 同一个进程里连发两条 prompt 都跑得完（多轮）；
- 进程**硬杀**之后按同一个 `--session-id` 重开：`get_messages` 读得回全部消息
  （末行不完整的情况没出现 —— append-only 的会话文件不会留半行坏数据）；
- `--session-id` 指向不存在的会话时它自己新建一份，只在 stderr 留一行
  `No project session found with id …; creating a new session with that id`（不是错误）；
- 会话文件落在 `--session-dir` 下，名字是 `<ISO 时间戳>_<session-id>.jsonl`，
  **首行是 header**（`{"type":"session","version":3,"id":…,"cwd":…}`）—— 删会话认的是它；
- `--no-session` 与 `--session-id` 不能同时用（前者是「跑完即弃」）；
- `abort` 会让这一轮正常收尾（`agent_settled` 照常来），**进程留着**，适合做「停止」；
- `-e <权限扩展>` 与上面这套参数一起用时扩展照常加载：模型要跑命令时 stderr/stdout 上
  来一条 `extension_ui_request`（confirm），回 `{"type":"extension_ui_response","id",confirmed}`
  之后那次工具调用真的往下跑（`tool_execution_end`，`isError:false`）。
- **贴的图**（2026-09-29 补验）：prompt 那一行带 `images:[{type:"image",data,mimeType}]`
  时，`input` 里有 `"image"` 的模型收到的是 `image_url` 的**数据 URL**（base64 一字不差）；
  `input` 里没有的模型收到的是 `(image omitted: model does not support images)` ——
  所以界面上贴图那道门槛（`AiModelChoice.imageInput`）不是装饰。`get_messages` 读回来的
  用户消息里那段图还在（`{type:'image',data,mimeType}`，那段 base64 就是能直接画的数据 URL）。
- **瘦身后的树上（2026-09-29）**：删掉那 7 个包、`resources/pi` 只剩 59MB 之后，两条 API 形态
  （`openai-completions` 打 `/v1/chat/completions` 带 `Authorization: Bearer`、`anthropic-messages`
  打 `/v1/messages` 带 `x-api-key`）都照常把请求发到假端点，`-e permission.js` 照常加载、
  confirm 一问一答之后 `bash` 真的跑出结果；models.json 的 `apiKey` 照应用那样写
  `$WORKBENCH_AI_KEY`（借环境变量插值顺手把这条也验了）。**这两种形态各走哪条路（内联进
  bundle 还是落到树里）是新版本自己的事，换版本后要重跑。**

- **Pi 1.0.4（2026-10-06 重验）**：上面这些点全部照旧 —— 探针 9 项全过（两形态打假端点、
  confirm 一问一答、命令真跑）、硬杀后按同 id 重开 `get_messages` 读得回历史
  （应答仍是 `{success, data:{messages:[…]}}`）、abort 应答 + `agent_settled` + 进程留着、
  会话文件头仍是 `"type":"session","version":3`。models.dev 快照的 id 变了样
  （zai 全线 `chat:` 前缀、deepseek-v4.1-flash 没了）—— 内置模型目录跟着再生，
  ai.test.ts 的夹具换成了新表里真实存在的 id。

- **按保留清单裁剪之后（2026-10-22）**：`vendor-pi.mjs` 从「删几个包」改成「保留清单」、
  又收窄到运行时真正会加载的三个包（`PRUNE_REVISION=4`）之后重跑了一遍，`resources/pi`
  从 55.6MB 降到 **12.8MB（147 个文件）**，下面这些仍然成立：
  - `node cli.js --version` → `1.0.4`；
  - 假端点一轮：`extension_ui_request` 一问一答 → `bash` 真跑出 `probe-ok` → `agent_settled`；
  - `openai-completions` 与 `anthropic-messages` 两种形态各跑一轮都能到达假端点；
  - `read` / `write` / `edit` 三个工具各成功一次（`grep` / `find` / `ls` 在 1.0.4 的默认工具集里
    本来就没有，裁前裁后都是 `Tool … not found`，不是裁剪裁掉的）；
  - `-ns --skill <目录>` 之后 `get_commands` 里能列出 `skill:myskill`。
  **逐包删回去验过的三条**：删 `jiti` 时 Pi 照常启动、但扩展加载失败
  （`Cannot find module 'jiti'` → 确认次数 0、命令没人问就跑了），所以它在 KEEP 里；
  删 `typebox` / `pi-ai` / `pi-tui` / `pi-agent-core` / `chord` 时上面这一整轮探针仍然全过 ——
  它们只在扩展 `import` Pi SDK 时才会被 `getAliases()` 解析，当前那份 permission.js
  不 import 任何东西，所以这五个包已经不放进树里了（加回条件见 [ai.md](../modules/ai.md)）。
- 裁剪后启动耗时没有变化（`--version` 五次各 ~410ms，两边一致）—— 省的是体积，不是启动。
- 裁剪后启动耗时没有变化（`--version` 五次各 ~410ms，两边一致）—— 省的是体积，不是启动。

**换 Pi 版本后重跑一遍**这些点 —— CLI 与事件协议是外部契约（见
[ai.md](../modules/ai.md) 的文件头）。改裁剪规则（`KEEP` / `PRUNE_REVISION`）同样要重跑。
