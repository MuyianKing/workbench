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

**换 Pi 版本后重跑一遍**这些点 —— CLI 与事件协议是外部契约（见
[constraints/ai.md](../constraints/ai.md) 的文件头）。
