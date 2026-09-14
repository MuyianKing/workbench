//! 系统能力：端口检测、结束进程树、在资源管理器中定位、用系统程序打开链接。
//!
//! 这些在 Electron 版里本来就是 shell 出去调 `netstat` / `taskkill` / `powershell`，
//! 所以移植基本是逐行直译，行为可以对齐。

use serde_json::{json, Value};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// CREATE_NO_WINDOW：GUI 应用起子进程时不能闪出控制台窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn hidden(command: &str) -> Command {
    let mut cmd = Command::new(command);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn run(command: &str, args: &[&str]) -> Result<String, String> {
    let out = hidden(command)
        .args(args)
        .output()
        .map_err(|err| format!("{command} 启动失败: {err}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// 端口是否有人在监听。判据与渲染层一致：127.0.0.1 上连得上就算在监听。
pub fn is_port_in_use(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// 按端口找占用进程 PID。用 netstat 而不是 PowerShell：退出检测会一次问好几个端口，
/// 而 PowerShell 每次冷启动要 200ms 以上。
fn find_pid_by_port(port: u16) -> Option<u32> {
    let text = run("netstat", &["-ano", "-p", "tcp"]).ok()?;
    let needle = format!(":{port}");

    text.lines()
        .filter(|line| line.contains("LISTENING"))
        .find(|line| {
            line.split_whitespace()
                .nth(1)
                .is_some_and(|addr| addr.ends_with(&needle))
        })
        .and_then(|line| line.split_whitespace().last())
        .and_then(|pid| pid.parse::<u32>().ok())
}

fn process_name_of(pid: u32) -> Option<String> {
    let text = run(
        "tasklist",
        &["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"],
    )
    .ok()?;
    let first = text.lines().next()?;
    first.strip_prefix('"')?.split('"').next().map(str::to_string)
}

/// 端口检测，返回结构与 Electron 版一致：port / inUse / pid? / processName?
pub fn check_port(port: u16) -> Value {
    if !is_port_in_use(port) {
        return json!({ "port": port, "inUse": false });
    }
    let pid = find_pid_by_port(port);
    let name = pid.and_then(process_name_of);
    json!({ "port": port, "inUse": true, "pid": pid, "processName": name })
}

/// 结束整棵进程树。实现已下沉到 proc 原语（超时清理也要用它），这里只做端口到 pid 的翻译。
pub fn kill_process_tree(pid: u32) -> Result<(), String> {
    crate::proc::kill_process_tree(pid)
}

pub fn kill_port_process(port: u16) -> Result<(), String> {
    let pid = find_pid_by_port(port).ok_or_else(|| format!("端口 {port} 上没找到监听进程"))?;
    kill_process_tree(pid)
}

/// 在资源管理器中打开目标：目录就进到里面，文件则在所在目录里选中它。
///
/// 这两条分支与 Electron 版一致（目录走 `shell.openPath`、文件走 `shell.showItemInFolder`）。
/// 目录若也走 `/select`，资源管理器只会停在**上级目录**把那个文件夹高亮一下 ——
/// 用户要的是看产物，不是看装着产物的那个文件夹。
///
/// explorer 即使成功也常返回非 0 退出码，所以只发起、不校验结果。
pub fn reveal(path: &str) {
    let arg = if Path::new(path).is_dir() {
        path.to_string()
    } else {
        format!("/select,{path}")
    };
    let _ = hidden("explorer").arg(arg).spawn();
}

/// 外部链接交给系统浏览器
pub fn open_external(url: &str) -> Result<(), String> {
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|err| err.to_string())
}

/// 用系统最自然的方式打开一个路径（等价于 Electron 的 `shell.openPath`，
/// 走的都是 ShellExecute）：.lnk 解析到它自己的目标、.exe 直接运行、
/// .bat/.cmd 自己开控制台、文档按系统关联打开。
/// 进程不归我们管，应用退出也不影响它。
pub fn open_path(path: &str) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|err| err.to_string())
}
