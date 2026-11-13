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
use std::process::{Child, Command, Stdio};
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

/// 按**原始字节**收输出的一份结果。
///
/// 只给「内容本身可能不是 UTF-8」的调用方用（Git 客户端的补丁预览）：`read_to_string`
/// 遇到非法 UTF-8 会提前中断，看起来就像补丁被截断；这里保留字节，由调用方决定怎么解。
pub struct OutcomeBytes {
    pub status: Option<i32>,
    pub timed_out: bool,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl OutcomeBytes {
    pub fn ok(&self) -> bool {
        self.status == Some(0)
    }
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

/// 直接起可执行文件，不经 `cmd /C`。
///
/// 程序本身就是 .exe 的必须走这条路（git 就是）：绕开 cmd 就绕开了它对参数行的二次解析，
/// 参数里带空格、引号、中文时不会被拆错 —— `cmd /C` 的引号规则是出了名的坑。
/// `cwd` 给工作目录（git 的 `-C` 之外还有别的用法，交给调用方决定），
/// `envs` 给子进程加环境变量（git 靠 `GIT_TERMINAL_PROMPT=0` 避免弹出看不见的凭据输入框后挂住）。
pub fn run_direct(
    program: &str,
    args: &[String],
    timeout: Duration,
    cwd: Option<&std::path::Path>,
    envs: &[(&str, &str)],
) -> std::io::Result<Outcome> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for (key, value) in envs {
        cmd.env(key, value);
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    collect(cmd, timeout)
}

pub fn run(program: &str, args: &[String], timeout: Duration) -> std::io::Result<Outcome> {
    collect(shell_command(program, args), timeout)
}

/// 与 `run_direct` 同一条路，但输出按字节收（见 `OutcomeBytes`）。
pub fn run_direct_bytes(
    program: &str,
    args: &[String],
    timeout: Duration,
    cwd: Option<&std::path::Path>,
    envs: &[(&str, &str)],
) -> std::io::Result<OutcomeBytes> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for (key, value) in envs {
        cmd.env(key, value);
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    collect_bytes(cmd, timeout)
}

/// 起进程 → 边跑边收输出 → 超时按进程树终止。`run` 与 `run_direct` 共用这一段。
fn collect(cmd: Command, timeout: Duration) -> std::io::Result<Outcome> {
    let mut child = spawn(cmd)?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // 两个独立的读者线程：边产出边清空管道，避免子进程卡在写
    let out_handle = std::thread::spawn(move || read_pipe(stdout));
    let err_handle = std::thread::spawn(move || read_pipe(stderr));
    let (status, timed_out) = wait_with_timeout(&mut child, timeout)?;

    // 进程已结束（或被我们杀掉），管道随之关闭，读者线程会立刻读完返回
    Ok(Outcome {
        status,
        timed_out,
        stdout: out_handle.join().unwrap_or_default(),
        stderr: err_handle.join().unwrap_or_default(),
    })
}

fn collect_bytes(cmd: Command, timeout: Duration) -> std::io::Result<OutcomeBytes> {
    let mut child = spawn(cmd)?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let out_handle = std::thread::spawn(move || read_pipe_bytes(stdout));
    let err_handle = std::thread::spawn(move || read_pipe_bytes(stderr));
    let (status, timed_out) = wait_with_timeout(&mut child, timeout)?;

    Ok(OutcomeBytes {
        status,
        timed_out,
        stdout: out_handle.join().unwrap_or_default(),
        stderr: err_handle.join().unwrap_or_default(),
    })
}

fn spawn(mut cmd: Command) -> std::io::Result<Child> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

/// 等进程结束；到点就连同整棵进程树一起结束。
fn wait_with_timeout(child: &mut Child, timeout: Duration) -> std::io::Result<(Option<i32>, bool)> {
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
    Ok((status, timed_out))
}

fn read_pipe(pipe: Option<impl Read>) -> String {
    let mut text = String::new();
    if let Some(mut pipe) = pipe {
        let _ = pipe.read_to_string(&mut text);
    }
    text
}

fn read_pipe_bytes(pipe: Option<impl Read>) -> Vec<u8> {
    let mut bytes = Vec::new();
    if let Some(mut pipe) = pipe {
        let _ = pipe.read_to_end(&mut bytes);
    }
    bytes
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
///
/// **只在测试里用**（用例要先判「本机有没有装 git」再决定跳不跳）；生产侧一律走
/// [`probe_version_checked`]，因为通道上要把「没装」与「探测失败」分开。
#[cfg(test)]
pub fn probe_version(bin: &str) -> Option<String> {
    probe_version_checked(bin).ok().flatten()
}

/// 探测 `<bin> --version`：`Ok(Some(版本))` = 可用，`Ok(None)` = 起来了但没用，
/// `Err` = 起不来 / 超时（通道上要如实告诉用户，而不是当成「没装」）。
pub fn probe_version_checked(bin: &str) -> Result<Option<String>, String> {
    let outcome = run(bin, &["--version".to_string()], Duration::from_secs(8))
        .map_err(|err| format!("探测 {bin} 失败：{err}"))?;
    Ok(if outcome.ok() {
        Some(outcome.first_line())
    } else {
        None
    })
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
    process_created_at_checked(pid).ok().flatten()
}

/// 同 [`process_created_at`]，但把「问不到」与「没这个进程」分开：
/// `Ok(Some(时间))` = 还活着，`Ok(None)` = 进程已退出 / 没有这个 PID，`Err` = 查询本身失败
/// （权限不足、系统调用失败）—— 后者不能再被当成「进程没了」，否则残留清理会跳过它。
pub fn process_created_at_checked(pid: u32) -> Result<Option<u64>, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, GetLastError, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        let code = unsafe { GetLastError() };
        // ERROR_INVALID_PARAMETER = 87：这个 PID 不存在（已退出 / 被复用前的空档）
        return if code == 87 {
            Ok(None)
        } else {
            Err(format!("查询进程 {pid} 失败（Win32 错误码 {code}）"))
        };
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
        // 拿到句柄之后进程刚好退出：不是查询失败
        return Ok(None);
    }
    // 已退出（含"死了但进程对象还没被回收"）一律当认不出来
    if exit_code != STILL_ACTIVE as u32 {
        return Ok(None);
    }

    // FILETIME 是「1601-01-01 起的 100 纳秒数」，换算成 Unix 毫秒
    const FILETIME_EPOCH_OFFSET_MS: u64 = 11_644_473_600_000;
    let ticks = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
    Ok(Some(
        (ticks / 10_000).saturating_sub(FILETIME_EPOCH_OFFSET_MS),
    ))
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

    /// 直启：不经 cmd 也能起（cmd.exe 自己就是可执行文件，用它当被测对象不依赖外部程序）
    #[test]
    fn direct_run_works() {
        let outcome = run_direct(
            "cmd",
            &["/C".into(), "echo".into(), "hi".into()],
            Duration::from_secs(8),
            None,
            &[],
        )
        .expect("直启 cmd 失败");

        assert!(outcome.ok());
        assert_eq!(outcome.first_line(), "hi");
    }

    /// 环境变量确实传到了子进程里 —— git 的「别弹凭据框」就靠这条
    #[test]
    fn direct_run_passes_envs() {
        let outcome = run_direct(
            "cmd",
            &["/C".into(), "echo".into(), "%WB_PROBE%".into()],
            Duration::from_secs(8),
            None,
            &[("WB_PROBE", "xyz")],
        )
        .expect("直启 cmd 失败");

        assert_eq!(outcome.first_line(), "xyz");
    }

    /// 工作目录确实生效（git 的子命令都在克隆目录里跑，目录错了会去动别的仓库）
    #[test]
    fn direct_run_honors_cwd() {
        let cwd = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let outcome = run_direct(
            "cmd",
            &["/C".into(), "cd".into()],
            Duration::from_secs(8),
            Some(cwd),
            &[],
        )
        .expect("直启 cmd 失败");

        assert!(
            outcome.stdout.contains("src-tauri"),
            "工作目录没生效: {}",
            outcome.stdout
        );
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
        // 拿一个**不可能存在**的 PID：Windows 的 PID 是 4 的倍数，`u32::MAX - 3` 是其中之一，
        // 也远在实际会分配到的范围之外。**别拿 4 当「不存在的进程」** —— 那是 System：普通权限下
        // 只是一个 OpenProcess 被拒、看着像「问不到」，以管理员跑的机器（CI runner 就是）能问到，
        // 这条就红了（CI 上踩过一次）
        assert!(process_created_at(u32::MAX - 3).is_none());
    }
}
