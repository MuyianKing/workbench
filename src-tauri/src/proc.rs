//! 子进程原语：带超时地跑一条命令并把输出收全。
//!
//! Electron 版到处在用 `spawn(bin, args, { shell: true, windowsHide: true })` 干这类活
//! （探测包管理器、装全局包、跑 nvm……）。抽成一个原语，后面进程管理器也复用它。
//!
//! 两个容易踩的点：
//!  - **必须边跑边读**：管道缓冲区写满后子进程会阻塞在 write 上，
//!    如果先 wait 再读，两边就互相等成死锁（npm install 的输出足够踩到）。
//!  - **超时后要 kill 并回收**：否则弹出的 npm 会一直挂着，用户以为卡死了。

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// CREATE_NO_WINDOW：GUI 应用起子进程时不能闪出控制台窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct Outcome {
    /// None 表示进程没有正常退出码（被信号杀掉，或超时后被我们杀掉的）
    pub status: Option<i32>,
    /// 是否因为超时被我们掐掉。与 status=None 分开记：将来按 pid 杀进程时
    /// 子进程可能带着信号退出，那时 status 也是 None，但并不是超时。
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
}

impl Outcome {
    pub fn ok(&self) -> bool {
        self.status == Some(0)
    }

    /// 首行输出，用于 `<bin> --version` 这类探测
    pub fn first_line(&self) -> String {
        self.stdout
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string()
    }
}

/// 走 shell 执行：Windows 上 npm / nvm 都是 .cmd，直接 spawn 程序名会找不到
fn shell_command(program: &str, args: &[String]) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(program).args(args);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }

    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(program);
        cmd.args(args);
        cmd
    }
}

pub fn run(program: &str, args: &[String], timeout: Duration) -> std::io::Result<Outcome> {
    let mut child = shell_command(program, args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // 两个独立的读者线程：边产出边清空管道，避免子进程卡在写
    let out_handle = std::thread::spawn(move || read_pipe(stdout));
    let err_handle = std::thread::spawn(move || read_pipe(stderr));

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status.code();
        }
        if Instant::now() >= deadline {
            // 只 kill 自己不够：`cmd /C ping ...` 里 ping 是孙进程，
            // 杀掉 cmd 之后它照样活着、还占着 stdout 管道，读者线程会一直等到它自然结束
            // （实测能拖到 29 秒，超时等于没生效）。必须连同进程树一起结束。
            let _ = kill_process_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break None;
        }
        std::thread::sleep(Duration::from_millis(40));
    };

    // 进程已结束（或被我们杀掉），管道随之关闭，读者线程会立刻读完返回
    Ok(Outcome {
        status,
        timed_out,
        stdout: out_handle.join().unwrap_or_default(),
        stderr: err_handle.join().unwrap_or_default(),
    })
}

fn read_pipe(pipe: Option<impl Read>) -> String {
    let mut text = String::new();
    if let Some(mut pipe) = pipe {
        let _ = pipe.read_to_string(&mut text);
    }
    text
}

/// 结束整棵进程树。
///
/// Windows 上必须 /T：`cmd /C npm run dev` 之下还有真正的 dev server，
/// 只杀 cmd 会留下占着端口的孙进程，表现为「已结束」但端口仍然被占。
pub fn kill_process_tree(pid: u32) -> Result<(), String> {
    let mut killer = Command::new("taskkill");
    killer.args(["/pid", &pid.to_string(), "/T", "/F"]);
    #[cfg(windows)]
    killer.creation_flags(CREATE_NO_WINDOW);

    let status = killer
        .status()
        .map_err(|err| format!("taskkill 启动失败: {err}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("taskkill 退出码 {:?}", status.code()))
    }
}

/// 探测 `<bin> --version`：可用返回版本串，不可用或超时返回 None。
/// 与 Electron 版的 probeVersion 行为一致（超时 8 秒）。
pub fn probe_version(bin: &str) -> Option<String> {
    let outcome = run(bin, &["--version".to_string()], Duration::from_secs(8)).ok()?;
    if outcome.ok() {
        Some(outcome.first_line())
    } else {
        None
    }
}

/// 进程的创建时间（毫秒，Unix 纪元）；**进程已经退出则返回 None**。
///
/// 用来回答「这个 PID 还是不是当初那个进程」。比比对命令行强：
/// PID 被系统复用后创建时间必然不同，而命令行有可能碰巧相似。
///
/// 关键一点：创建时间本身**不能**证明进程还活着。Windows 上进程对象会一直留到最后一个
/// 句柄关闭为止（父进程、调试器、任务管理器都可能持有），这期间 `GetProcessTimes` 依然有效，
/// 于是「刚被强杀的宿主」看起来还活着 —— 记录会被永远当成有主，残留进程永远清不掉（踩过）。
/// 所以这里额外核 `GetExitCodeProcess == STILL_ACTIVE`。
///
/// 打不开进程（已退出、权限不足）同样返回 None —— 调用方据此跳过，绝不对拿不准的进程下手。
pub fn process_created_at(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }

    let empty = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (empty, empty, empty, empty);
    let mut exit_code: u32 = 0;

    let times_ok =
        unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
    let exit_ok = unsafe { GetExitCodeProcess(handle, &mut exit_code) };
    unsafe { CloseHandle(handle) };

    if times_ok == 0 || exit_ok == 0 {
        return None;
    }
    // 已退出（含"死了但进程对象还没被回收"）一律当认不出来
    if exit_code != STILL_ACTIVE as u32 {
        return None;
    }

    // FILETIME 是「1601-01-01 起的 100 纳秒数」，换算成 Unix 毫秒
    const FILETIME_EPOCH_OFFSET_MS: u64 = 11_644_473_600_000;
    let ticks = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
    Some((ticks / 10_000).saturating_sub(FILETIME_EPOCH_OFFSET_MS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probes_a_real_command() {
        // cmd /C 是系统自带的，任何 Windows 上都在
        let outcome = run("cmd", &["/C".into(), "echo".into(), "hi".into()], Duration::from_secs(8))
            .expect("启动 cmd 失败");
        assert!(outcome.ok());
        assert_eq!(outcome.first_line(), "hi");
    }

    #[test]
    fn missing_binary_is_not_ok() {
        let outcome = run(
            "definitely-not-a-real-binary-xyz",
            &["--version".into()],
            Duration::from_secs(8),
        )
        .expect("cmd 本身应当能启动");
        assert!(!outcome.ok());
    }

    #[test]
    #[ignore = "环境相关诊断：cargo test -- --ignored --nocapture"]
    fn diagnose_real_probes() {
        for bin in ["node", "npm", "yarn", "pnpm"] {
            eprintln!("{bin:<6} -> {:?}", probe_version(bin));
        }
    }

    #[test]
    fn timeout_kills_the_child() {
        // ping 到本机足够久，2 秒超时必须把它掐掉，而不是干等
        let started = Instant::now();
        let outcome = run(
            "cmd",
            &["/C".into(), "ping".into(), "-n".into(), "30".into(), "127.0.0.1".into()],
            Duration::from_secs(2),
        )
        .expect("启动 cmd 失败");

        assert!(outcome.timed_out, "超时应当被标记出来");
        assert!(started.elapsed() < Duration::from_secs(10), "超时没有及时生效");
    }

    /// 真问一次自己所在进程的创建时间：应当是一个晚于 2020 年的 Unix 毫秒值
    #[test]
    fn reports_creation_time_of_a_live_process() {
        let created = process_created_at(std::process::id()).expect("自己这个进程应当能问到");
        // 2020-01-01 的 Unix 毫秒
        assert!(created > 1_577_836_800_000, "创建时间不合理: {created}");
    }

    /// 不存在的 PID 返回 None，而不是编一个值出来
    #[test]
    fn unknown_pid_has_no_creation_time() {
        // 4 在 Windows 上不会是一个用户进程
        assert!(process_created_at(4).is_none());
    }
}
