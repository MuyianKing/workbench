//! 进程会话：起一条命令、按行回传输出、按进程树终止。
//!
//! 分工与 Electron 版一致，但边界更清楚：Rust 只做「起进程 / 读管道 / 杀进程树 /
//! 把输出成批发出去」，**起什么命令、状态机怎么转、日志落进哪个终端全在渲染层的适配层**。
//! 这样大部分改动仍然是 TS 的秒级热更新，不必重编 Rust。
//!
//! 两个从 Electron 版继承下来的关键点：
//!  - 终止必须按**进程树**（`taskkill /T`）：`cmd /C npm run dev` 之下才是真正的 dev server，
//!    只杀 cmd 会留下占着端口的孙进程，表现为「已停止」但端口仍然被占。
//!  - 输出要**按批**发：dev server 刷日志时逐行跨进程 send 会让两端互相拖累，
//!    这里攒够行数或超过时间窗就整批发一次（对应 Electron 版的 log-batcher）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// CREATE_NO_WINDOW：GUI 应用起子进程时不能闪出控制台窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 攒批上限：到这个行数就发，不等时间窗
const BATCH_LINES: usize = 200;
/// 攒批时间窗
const BATCH_WINDOW: Duration = Duration::from_millis(50);

pub struct Session {
    child: Child,
    pub pid: u32,
}

/// 活跃会话表。键是渲染层给的会话 ID（与终端键同源），值持有子进程句柄。
#[derive(Default)]
pub struct Sessions(pub Mutex<HashMap<String, Session>>);

fn shell_command(line: &str) -> Command {
    #[cfg(windows)]
    {
        // 走 shell 是必须的：npm / pnpm / yarn 都是 .cmd，而且自定义命令是整行原文
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(line);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }

    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(line);
        cmd
    }
}

/// 起一条命令。`line` 是交给 shell 的整行原文，`cwd` 为空则用当前进程的工作目录。
/// `path_prepend` 用于项目指定了 nvm 版本时把该版本目录前置到 PATH。
pub fn spawn(
    app: &AppHandle,
    session_id: String,
    line: String,
    cwd: Option<String>,
    path_prepend: Option<String>,
) -> Result<u32, String> {
    let mut cmd = shell_command(&line);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(dir) = cwd.as_deref().map(str::trim).filter(|dir| !dir.is_empty()) {
        cmd.current_dir(dir);
    }

    // 前置版本目录而不是调用 `nvm use`：后者要管理员权限去改软链，
    // 而只改子进程的 PATH 就能让 shell 里的 node / npm / npx 都解析到该版本。
    if let Some(dir) = path_prepend
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
    {
        let inherited = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = vec![PathBuf::from(dir)];
        paths.extend(std::env::split_paths(&inherited));
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }

    let mut child = cmd.spawn().map_err(|err| format!("启动失败: {err}"))?;
    let pid = child.id();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // 先入表再起等待线程：等待线程要能在表里找到它
    {
        let state = app.state::<Sessions>();
        state
            .0
            .lock()
            .unwrap()
            .insert(session_id.clone(), Session { child, pid });
    }

    if let Some(pipe) = stdout {
        pipe_lines(app.clone(), session_id.clone(), "out", pipe);
    }
    if let Some(pipe) = stderr {
        pipe_lines(app.clone(), session_id.clone(), "err", pipe);
    }

    // 退出通知单独一个线程等，别阻塞调用方（IPC 会因此卡住）
    let handle = app.clone();
    let id = session_id;
    std::thread::spawn(move || {
        let code = {
            let state = handle.state::<Sessions>();
            let mut map = state.0.lock().unwrap();
            match map.get_mut(&id) {
                Some(session) => session.child.wait().ok().and_then(|status| status.code()),
                None => return,
            }
        };
        let _ = handle.emit(
            "session:exit",
            serde_json::json!({ "sessionId": id, "code": code }),
        );
    });

    Ok(pid)
}

/// 行缓冲：攒够行数或超过时间窗就交出一批。
///
/// 抽成结构体是为了让「什么时候该冲」这条规则能被直接测到 ——
/// 它在 Electron 版里是 `log-batcher.ts` 加 88 行单测，移植时不能把这层保障丢掉。
/// `push_at` 允许注入时间点，测试因此不必真的等 50 毫秒。
pub struct LineBatcher {
    lines: Vec<String>,
    last_flush: Instant,
}

impl Default for LineBatcher {
    fn default() -> Self {
        Self::new()
    }
}

impl LineBatcher {
    pub fn new() -> Self {
        Self {
            lines: Vec::new(),
            last_flush: Instant::now(),
        }
    }

    /// 收一行；到了该冲的时机就把整批交出来（否则返回 None）
    pub fn push(&mut self, line: String) -> Option<Vec<String>> {
        self.push_at(line, Instant::now())
    }

    pub fn push_at(&mut self, line: String, now: Instant) -> Option<Vec<String>> {
        self.lines.push(line);

        if self.lines.len() >= BATCH_LINES || now.duration_since(self.last_flush) >= BATCH_WINDOW {
            self.last_flush = now;
            return self.take();
        }
        None
    }

    /// 收尾：把不足一批的剩余行交出来（全部已冲出去时返回 None）
    pub fn flush(&mut self) -> Option<Vec<String>> {
        self.last_flush = Instant::now();
        self.take()
    }

    fn take(&mut self) -> Option<Vec<String>> {
        if self.lines.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut self.lines))
    }
}

/// 读一条管道并按批发出。读到 EOF（进程结束）时把剩余的行冲出去。
fn pipe_lines(app: AppHandle, session_id: String, stream: &'static str, pipe: impl Read + Send + 'static) {
    std::thread::spawn(move || {
        let reader = BufReader::new(pipe);
        let mut batcher = LineBatcher::new();

        let emit_batch = |batch: Vec<String>| {
            let lines: Vec<serde_json::Value> = batch
                .into_iter()
                .map(|text| serde_json::json!({ "stream": stream, "text": text }))
                .collect();
            let _ = app.emit(
                "session:lines",
                serde_json::json!({ "sessionId": session_id, "lines": lines }),
            );
        };

        for line in reader.lines() {
            let text = match line {
                Ok(text) => text,
                // 读不动了（进程被杀、编码异常）就停，不是错误
                Err(_) => break,
            };
            if let Some(batch) = batcher.push(text) {
                emit_batch(batch);
            }
        }

        // 收尾：最后不足一批的几行不能丢
        if let Some(batch) = batcher.flush() {
            emit_batch(batch);
        }
    });
}

/// 结束一个会话：按进程树杀。真正的退出码由等待线程发出去。
pub fn stop(app: &AppHandle, session_id: &str) -> Result<(), String> {
    let pid = {
        let state = app.state::<Sessions>();
        let map = state.0.lock().unwrap();
        map.get(session_id).map(|session| session.pid)
    };

    let Some(pid) = pid else {
        return Err("该会话已经不在运行".to_string());
    };

    crate::proc::kill_process_tree(pid)
}

/// 结束所有会话，供退出时收尾
pub fn stop_all(app: &AppHandle) {
    let pids: Vec<u32> = {
        let state = app.state::<Sessions>();
        let map = state.0.lock().unwrap();
        map.values().map(|session| session.pid).collect()
    };

    for pid in pids {
        let _ = crate::proc::kill_process_tree(pid);
    }
}

/// 当前活跃的会话 ID
pub fn active_ids(app: &AppHandle) -> Vec<String> {
    let state = app.state::<Sessions>();
    let map = state.0.lock().unwrap();
    map.keys().cloned().collect()
}

/// 会话是否还在（等待线程结束后才会从表里移除，所以这里只用来判断「起没起过」）
pub fn forget(app: &AppHandle, session_id: &str) {
    let state = app.state::<Sessions>();
    state.0.lock().unwrap().remove(session_id);
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flushes_when_the_line_limit_is_reached() {
        let mut batcher = LineBatcher::new();
        let now = Instant::now();

        for index in 0..BATCH_LINES - 1 {
            assert!(batcher.push_at(format!("line {index}"), now).is_none());
        }

        let batch = batcher.push_at("line last".to_string(), now).expect("到了上限应当交出一批");
        assert_eq!(batch.len(), BATCH_LINES);
        assert_eq!(batch[0], "line 0");
    }

    #[test]
    fn flushes_when_the_time_window_elapses() {
        let mut batcher = LineBatcher::new();
        let start = Instant::now();

        assert!(batcher.push_at("one".to_string(), start).is_none());

        let within = start + BATCH_WINDOW - Duration::from_millis(1);
        assert!(batcher.push_at("two".to_string(), within).is_none());

        let past = start + BATCH_WINDOW;
        let batch = batcher.push_at("three".to_string(), past).expect("过了时间窗应当交出");
        assert_eq!(batch, vec!["one", "two", "three"]);
    }

    #[test]
    fn flush_returns_the_remainder_once() {
        let mut batcher = LineBatcher::new();
        assert!(batcher.push("only".to_string()).is_none());

        assert_eq!(batcher.flush(), Some(vec!["only".to_string()]));
        assert_eq!(batcher.flush(), None, "冲过一次之后没有剩余");
    }
}