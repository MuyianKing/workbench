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
//!
//! 第三点是移植时新踩的：**等子进程退出不能占着会话表的锁**。表锁被等待线程攥住的话，
//! 子进程活着的每一秒里，别的入口（停止、列活跃会话、起下一条）都永久阻塞在取锁上；
//! 而它们要么是同步 IPC、要么被主线程直接调用（托盘「退出」那条路），
//! 于是整个窗口跟着一起画不动，表现成「点一下停止，应用当场死掉」。
//! 所以：表锁只借一下就放，子进程句柄自带一把锁（见 `Session` 与 `wait_for_exit`）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, ErrorKind, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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
    /// 子进程句柄。等待线程要握着它一直等到进程退出，所以**单给它一把锁**：
    /// 拿整张表的锁去 `wait()` 的话，子进程活多久整张表就被锁多久（见 `wait_for_exit`）。
    child: Mutex<Child>,
    pub pid: u32,
}

/// 活跃会话表。键是渲染层给的会话 ID（与终端键同源），值持有子进程句柄。
/// 用 `Arc` 包着是为了让等待线程能先把句柄拎出来、再放开表锁去等。
#[derive(Default)]
pub struct Sessions(pub Mutex<HashMap<String, Arc<Session>>>);

/// 取一个会话（已克隆出 `Arc`，表锁随即释放）。取不到说明它已经被摘掉了。
fn session_of(sessions: &Sessions, id: &str) -> Option<Arc<Session>> {
    sessions.0.lock().unwrap().get(id).cloned()
}

/// 等子进程退出并取退出码。
///
/// 全场只有这一处会长时间持锁，而且锁的只是**这个会话自己的**子进程句柄 ——
/// 表锁在这期间是空着的。反过来（拿着表锁 `wait()`）会让子进程活着的每一秒都堵住别处：
/// 停止、`active_ids`、起下一条命令全卡在取锁上，而它们要么走同步 IPC、要么被主线程
/// 直接调用（托盘「退出」那条路），一卡就是整个窗口画不动 —— 症状是点一下停止应用当场死掉。
fn wait_for_exit(session: &Session) -> Option<i32> {
    session
        .child
        .lock()
        .unwrap()
        .wait()
        .ok()
        .and_then(|status| status.code())
}

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
        let entry = Arc::new(Session {
            child: Mutex::new(child),
            pid,
        });
        state.0.lock().unwrap().insert(session_id.clone(), entry);
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
        let state = handle.state::<Sessions>();
        // 先拎出句柄、放开表锁，再慢慢等 —— 顺序反了就是把整张表锁到进程结束
        let Some(session) = session_of(&state, &id) else {
            return;
        };
        let code = wait_for_exit(&session);

        // 进程没了就把自己从表里摘掉。留着的话有两个后果：退出确认框里的「还有几个在跑」
        // 是启动以来的总数（永远不为 0），而退出收尾会拿这些陈旧 pid 去 taskkill /T /F ——
        // PID 被系统回收复用时，杀的是别人的进程树。
        // 按 Arc 身份比对而不是直接 remove(&id)：同名的下一次会话可能已经入表了。
        {
            let mut map = state.0.lock().unwrap();
            if map.get(&id).is_some_and(|entry| Arc::ptr_eq(entry, &session)) {
                map.remove(&id);
            }
        }

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

    /// 时间窗到了就把攒着的行交出来（没到点、或没攒到东西都返回 None）。
    ///
    /// 给定时冲批线程用：读者阻塞在管道上时，只有这里能把「落在窗口内的最后几行」送出去 ——
    /// `push` 里那次检查要等下一行走完，而安静下来的 dev server 没有下一行了。
    pub fn flush_if_due(&mut self, now: Instant) -> Option<Vec<String>> {
        if now.duration_since(self.last_flush) < BATCH_WINDOW {
            return None;
        }
        self.last_flush = now;
        self.take()
    }

    fn take(&mut self) -> Option<Vec<String>> {
        if self.lines.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut self.lines))
    }
}

/// 一批行的去处。读管道与定时冲批两个线程共用同一个实例：
/// 批次顺序由「取批与发送在同一把锁里」保证（见 `flush_locked`）。
struct BatchSink {
    app: AppHandle,
    session_id: String,
    stream: &'static str,
}

impl BatchSink {
    /// 发一批行。**调用方必须持着攒批的锁**，否则两个线程可能把两批的先后颠倒过来。
    fn send(&self, batch: Vec<String>) {
        let lines: Vec<serde_json::Value> = batch
            .into_iter()
            .map(|text| serde_json::json!({ "stream": self.stream, "text": text }))
            .collect();
        let _ = self.app.emit(
            "session:lines",
            serde_json::json!({ "sessionId": self.session_id, "lines": lines }),
        );
    }
}

/// 取一批发出去（`force` 时连不足一批的剩余也发）。取与发都在同一把锁里完成。
fn flush_locked(pending: &Mutex<LineBatcher>, sink: &BatchSink, force: bool) {
    let mut batcher = pending.lock().unwrap();
    let batch = if force {
        batcher.flush()
    } else {
        batcher.flush_if_due(Instant::now())
    };
    if let Some(batch) = batch {
        sink.send(batch);
    }
}

/// 读一条管道并按批发出。读到 EOF（进程结束）时把剩余的行冲出去。
///
/// 冲批不能只由读到的行驱动：读管道是阻塞的，而一个突发输出的最后几行落在时间窗内、
/// 之后进程又安静下来时（dev server 的启动横幅就是这样），没有新行进来它们会一直压在内存里，
/// 界面上表现成「日志停在某一行，后面再没有了」。所以这里另起一个到点就冲的线程；
/// 进程结束（EOF）后它随 `finished` 退出，不会给每个会话留一颗常驻心跳。
fn pipe_lines(app: AppHandle, session_id: String, stream: &'static str, pipe: impl Read + Send + 'static) {
    let sink = Arc::new(BatchSink { app, session_id, stream });
    let pending = Arc::new(Mutex::new(LineBatcher::new()));
    let finished = Arc::new(AtomicBool::new(false));

    {
        let pending = Arc::clone(&pending);
        let finished = Arc::clone(&finished);
        let sink = Arc::clone(&sink);
        std::thread::spawn(move || {
            while !finished.load(Ordering::Relaxed) {
                std::thread::sleep(BATCH_WINDOW);
                flush_locked(&pending, &sink, false);
            }
            // 收尾与 reader 那边同一条路，谁先到都行（冲完就是空批）
            flush_locked(&pending, &sink, true);
        });
    }

    std::thread::spawn(move || {
        let reader = BufReader::new(pipe);

        for line in reader.lines() {
            let text = match line {
                Ok(text) => text,
                // 非法 UTF-8 只丢这一行：Windows 上子进程按本地代码页（中文系统是 GBK）输出时
                // 很常见，早前这里直接 break，结果是整条会话的日志从此消失
                Err(err) if err.kind() == ErrorKind::InvalidData => continue,
                // 真读不动了（进程被杀、管道断开）才停：这类错误会一直重现，继续读只是空转
                Err(_) => break,
            };

            let mut batcher = pending.lock().unwrap();
            if let Some(batch) = batcher.push(text) {
                sink.send(batch);
            }
        }

        // 收尾：最后不足一批的几行不能丢
        flush_locked(&pending, &sink, true);
        finished.store(true, Ordering::Relaxed);
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

    // 进程可能刚退出、等待线程还没来得及把它摘掉；这时对着旧 pid 下手同样可能误伤
    // （PID 复用）。已经死了就当停好了 —— session:exit 随后就到，界面会回到空闲。
    if crate::proc::process_created_at(pid).is_none() {
        return Ok(());
    }

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
        // 表里正常只剩在跑的会话（等待线程退出时就摘了），但 taskkill /T /F 不可逆，
        // 下手前再核一次这个 PID 是否真的还活着，拿不准就不动它。
        if crate::proc::process_created_at(pid).is_none() {
            continue;
        }
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

    /// 没有新行进来时，时间窗一到也要把攒着的行交出去。
    ///
    /// 钉的是「dev server 启动横幅只显示一半」那个 bug：早前冲批只由 `push` 驱动，
    /// 一个突发输出的最后几行落在窗口内、之后进程又安静下来，它们就一直压在内存里不上去。
    #[test]
    fn flushes_when_the_window_elapses_without_new_lines() {
        let mut batcher = LineBatcher::new();
        let start = Instant::now();

        assert!(batcher.push_at("banner".to_string(), start).is_none());
        assert!(
            batcher
                .flush_if_due(start + BATCH_WINDOW - Duration::from_millis(1))
                .is_none(),
            "窗口没到就不该交出"
        );

        assert_eq!(
            batcher.flush_if_due(start + BATCH_WINDOW),
            Some(vec!["banner".to_string()]),
            "窗口到了就该把攒着的行交出去"
        );
        assert!(
            batcher
                .flush_if_due(start + BATCH_WINDOW + Duration::from_millis(1))
                .is_none(),
            "同一批不该重复交出去"
        );
    }

    /// 等子进程退出期间，整张会话表必须还是能拿到的。
    ///
    /// 钉的是「点停止整个应用卡死」那个 bug：等待线程原先握着表锁去 `child.wait()`，
    /// 于是子进程活着的整个期间，别的入口都永久阻塞在取锁上（当时的 `stop_session`
    /// 还是同步命令，卡的就是主线程）。这里用一条长命的 ping 当代替品，
    /// 把「等」这件事放到别的线程上去做。
    #[test]
    fn waiting_for_a_process_keeps_the_session_table_free() {
        let child = shell_command("ping -n 30 127.0.0.1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("起 ping 失败");
        let pid = child.id();

        let sessions = Sessions::default();
        sessions.0.lock().unwrap().insert(
            "probe".to_string(),
            Arc::new(Session {
                child: Mutex::new(child),
                pid,
            }),
        );

        // 与 spawn 里的等待线程同一条路径：拎出句柄 → 放开表锁 → 等退出
        let session = session_of(&sessions, "probe").expect("刚插进去的会话应当取得到");
        let waiter = std::thread::spawn(move || wait_for_exit(&session));

        // 等一小会儿，确认等待线程已经进去了：此时表锁必须空着
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            sessions.0.try_lock().is_ok(),
            "等子进程期间表锁必须空着，否则停止 / 列活跃会话 / 起下一条都会一起卡住"
        );
        assert!(session_of(&sessions, "probe").is_some(), "会话应当还在表里");

        // 收尾：掐掉 ping 让等待线程结束，别在测试进程外留下跑 30 秒的残留
        let _ = crate::proc::kill_process_tree(pid);
        assert!(waiter.join().is_ok(), "等待线程应当自己结束");
    }
}
