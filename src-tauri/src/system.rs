//! 系统能力：端口检测、结束进程树、在资源管理器中定位、用系统程序打开链接。
//!
//! 端口到进程的翻译走 Win32 的 TCP 表（`GetExtendedTcpTable`），不再 shell 出去解析
//! `netstat` / `tasklist` 的文本输出 —— 见 `find_pid_by_port` 上方的说明。

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

/// 端口是否有人在监听。判据与渲染层一致：127.0.0.1 上连得上就算在监听。
pub fn is_port_in_use(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// 按端口找占用进程 PID（只认监听中的 IPv4 套接字，与原来的 `netstat -p tcp` 同口径）。
///
/// **一次系统调用换一次文本解析**：这条路不起子进程，也不依赖 netstat 的列格式与系统语言。
/// 启动时的全量检测会并发问十几个端口，原先每个端口要起 netstat + tasklist 两个进程。
fn find_pid_by_port(port: u16) -> Option<u32> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::Networking::WinSock::AF_INET;

    // 第一次只问需要多大缓冲：此时返回非 0（ERROR_INSUFFICIENT_BUFFER），尺寸写进 size
    let mut size: u32 = 0;
    unsafe {
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
    }
    if size == 0 {
        return None;
    }

    // u32 而不是 u8：下面那张表是 4 字节对齐的结构体，拿 Vec<u8> 的指针去转是未定义行为
    let mut buffer = vec![0u32; (size as usize).div_ceil(4)];
    let mut size = (buffer.len() * 4) as u32;
    let status = unsafe {
        GetExtendedTcpTable(
            buffer.as_mut_ptr().cast(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if status != 0 {
        return None;
    }

    unsafe {
        let table = buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID;
        let count = (*table).dwNumEntries as usize;
        let rows = std::slice::from_raw_parts((*table).table.as_ptr(), count);
        rows.iter()
            // dwLocalPort 的低 16 位是网络字节序的端口号，要换回来才比得上
            .find(|row| u16::from_be(row.dwLocalPort as u16) == port)
            .map(|row| row.dwOwningPid)
    }
}

/// 进程的映像文件名（不带目录）。用完即关句柄，不给 GDI / 内核句柄留下泄漏。
fn process_name_of(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }

    // MAX_PATH 大小的缓冲；进程路径比它长时 API 返回失败，此时宁可没有名字（调用方按「未知」显示）
    let mut buffer = [0u16; 260];
    let mut len = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut len) };
    unsafe { CloseHandle(handle) };
    if ok == 0 {
        return None;
    }

    let path = String::from_utf16_lossy(&buffer[..len as usize]);
    path.rsplit(['\\', '/']).next().map(str::to_string)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 自己监听一个端口，再按端口把「自己」找回来。
    /// 这条同时覆盖了 TCP 表的读取、端口字节序换算与进程名查询。
    #[test]
    fn finds_the_process_listening_on_a_port() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("绑定端口失败");
        let port = listener.local_addr().expect("取本地地址失败").port();

        assert!(is_port_in_use(port), "刚监听的端口应当算占用");
        assert_eq!(
            find_pid_by_port(port),
            Some(std::process::id()),
            "按端口找回的 PID 不是当前进程"
        );

        let name = process_name_of(std::process::id()).expect("应当问得到自己的进程名");
        assert!(name.to_lowercase().ends_with(".exe"), "进程名看起来不对: {name}");
    }

    /// 没人监听的端口：既不该算占用，也找不到 PID。
    /// 端口号来自一次「绑定后立刻释放」，正常情况下不会再有人占它。
    #[test]
    fn idle_port_has_no_owner() {
        let port = {
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("绑定端口失败");
            listener.local_addr().expect("取本地地址失败").port()
        };

        assert_eq!(find_pid_by_port(port), None, "空闲端口不该有占用进程");
        let checked = check_port(port);
        assert_eq!(checked["inUse"], json!(false), "空闲端口被报成占用了");
    }

    /// 查不到进程的 PID 一律返回 None，而不是编一个名字出来
    #[test]
    fn unknown_pid_has_no_name() {
        // 4 在 Windows 上不会是一个用户进程
        assert!(process_name_of(4).is_none());
    }
}
