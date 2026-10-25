//! 微信取字：把选区那一块交给微信自带的 OCR 引擎（4.x 的 `wxocr.dll`）。
//!
//! ## 为什么用微信的
//!
//! Windows 自带的 `Windows.Media.Ocr` 对 12px 上下的界面小字有天花板（`ocr.rs` 的探针实测：
//! 放大、二值化、锐化都绕不过去）。微信截图那个「提取文字」用的引擎对小字明显更准，
//! 而且结果**每个字都带独立框**（Windows OCR 只到词）。引擎就在用户装的微信里：
//! 本进程加载微信目录的 `mmmojo_64.dll`，由它拉起 weixin.exe 子进程（`--type=wxocr`，
//! 跑 XPlugin 解出来的 `wxocr.dll`）——一个字节都不随包带；没装微信或引擎没起来，
//! `capture_ocr` 回退 [ocr::recognize]（Windows OCR）。
//!
//! ## 协议
//!
//! 来自对 mmmojo 的逆向（swigger/wechat-ocr，Apache-2.0；回调形状、启动开关都照它跑通的
//! 写法）。只实现 wx4（微信 4.x）这一条路：
//!
//! - `InitializeMMMojo` → `CreateMMMojoEnvironment` → 注册回调 / 初始化参数（宿主进程、
//!   weixin.exe 路径）/ 子进程开关（no-sandbox、user-lib-dir、type、app-path）→
//!   `StartMMMojoEnvironment`（mmmojo 自己按 Chromium mojo 把子进程拉起来）；
//! - 握手：子进程主动推 `HAND_SHAKE`，`OCRSupportMessage{supported:true}` 才算就绪；
//! - 请求：`ParseOCRReqMessage{task_id, pic_path, rt}` 以 kMMPush 发（request_id=`REQ_OCR`）。
//!   **图片走文件路径**（子进程自己读）：选区先落临时 PNG，认完即删（[TempPng] 兜底）；
//! - 响应：`RESP_OCR` 推回 `ParseOCRRespMessage{task_id, err_code, res{lines}}`，每行
//!   text + 行框 + 逐字框，坐标是喂进去的图上的像素（浮点）。
//!
//! ## 生命周期与线程
//!
//! 引擎是进程级单例（[ENGINE]），第一次取字时起，**之后不 Stop、不 FreeLibrary** ——
//! mmmojo 起的线程收不干净，卸载必崩（swigger 同款结论）；随进程退出自然收场。
//! 回调跑在 mmmojo 自己的线程上，经 user_data 指针回到 [Shared]，结果槽用 Mutex + Condvar
//! 交还等待中的取字调用。

use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CStr, OsStr};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use windows::core::{w, PCSTR, PCWSTR};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};

use crate::ocr::{OcrLine, OcrWord};

// ---- mmmojo 的常量（swigger/wechat-ocr 的 mojocall.h + PCWeChat/mmmojo 的 mmmojo.h）----

/// MMMojoInfoMethod：kMMPush（PullReq / PullResp / Shared 这条流程用不到）
const METHOD_PUSH: c_int = 1;
/// MMMojoEnvironmentCallbackType
const CB_USER_DATA: c_int = 0;
const CB_READ_PUSH: c_int = 1;
const CB_READ_PULL: c_int = 2;
const CB_READ_SHARED: c_int = 3;
const CB_CONNECT: c_int = 4;
const CB_DISCONNECT: c_int = 5;
const CB_LAUNCHED: c_int = 6;
const CB_LAUNCH_FAILED: c_int = 7;
const CB_ERROR: c_int = 8;
/// MMMojoEnvironmentInitParamType：kMMHostProcess / kMMExePath
const PARAM_HOST_PROCESS: c_int = 0;
const PARAM_EXE_PATH: c_int = 2;
/// RequestIdOCR4：握手 / 请求 / 响应
const REQ_HAND_SHAKE: u32 = 10001;
const REQ_REQ_OCR: u32 = 10010;
const REQ_RESP_OCR: u32 = 10011;
/// task_id 协议上是 64 位、实际只吃 31 位且必须 >0，1 被握手占着（wx3 注释同款约束）
const TASK_ID_MAX: u32 = 0x7fff_ffff;

// ---- protobuf 最小编解码（字段就这么几个，不值得为它引生成器）----

fn pb_varint(buf: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            buf.push(byte);
            break;
        }
        buf.push(byte | 0x80);
    }
}

fn pb_key(buf: &mut Vec<u8>, field: u32, wire: u8) {
    pb_varint(buf, (u64::from(field) << 3) | u64::from(wire));
}

fn pb_uint(buf: &mut Vec<u8>, field: u32, value: u64) {
    pb_key(buf, field, 0);
    pb_varint(buf, value);
}

fn pb_bool(buf: &mut Vec<u8>, field: u32, value: bool) {
    // proto3：false 即默认值，不必落线
    if value {
        pb_uint(buf, field, 1);
    }
}

fn pb_string(buf: &mut Vec<u8>, field: u32, value: &str) {
    pb_key(buf, field, 2);
    pb_varint(buf, value.len() as u64);
    buf.extend_from_slice(value.as_bytes());
}

fn pb_message(buf: &mut Vec<u8>, field: u32, body: &[u8]) {
    pb_key(buf, field, 2);
    pb_varint(buf, body.len() as u64);
    buf.extend_from_slice(body);
}

/// 顺一遍 protobuf 线格式：按 (字段号, wire 类型) 逐个吐给闭包；坏数据半路返回 None
fn for_each_field(
    buf: &[u8],
    mut visit: impl FnMut(u32, Field<'_>),
) -> Option<()> {
    let mut rest = buf;
    while !rest.is_empty() {
        let mut reader = PbReader { rest };
        let key = reader.varint()?;
        let field = (key >> 3) as u32;
        let payload = match key & 7 {
            0 => Field::Varint(reader.varint()?),
            1 => Field::Fixed64(reader.take::<8>()?),
            2 => Field::Bytes(reader.len_bytes()?),
            5 => Field::Fixed32(reader.take::<4>()?),
            _ => return None,
        };
        rest = reader.rest;
        visit(field, payload);
    }
    Some(())
}

#[derive(Clone, Copy)]
enum Field<'a> {
    Varint(u64),
    #[allow(dead_code)]
    Fixed64(&'a [u8]),
    Bytes(&'a [u8]),
    Fixed32(&'a [u8]),
}

impl Field<'_> {
    fn varint(&self) -> Option<u64> {
        match *self {
            Field::Varint(value) => Some(value),
            _ => None,
        }
    }

    fn bytes(&self) -> Option<&[u8]> {
        match *self {
            Field::Bytes(bytes) => Some(bytes),
            _ => None,
        }
    }

    fn fixed32(&self) -> Option<f32> {
        match *self {
            Field::Fixed32(bytes) => Some(f32::from_le_bytes(bytes.try_into().ok()?)),
            _ => None,
        }
    }
}

/// 剩余未读的线格式字节
struct PbReader<'a> {
    rest: &'a [u8],
}

impl<'a> PbReader<'a> {
    fn varint(&mut self) -> Option<u64> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            // 先把切片引用拷出来再推进：直接 self.rest = &self.rest[1..] 是借用冲突
            let rest = self.rest;
            let &byte = rest.first()?;
            self.rest = &rest[1..];
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
        None
    }

    // 返回值挂 'a（缓冲区）不挂 &mut self：读出的切片不拴住 reader 本身
    fn len_bytes(&mut self) -> Option<&'a [u8]> {
        let len = self.varint()? as usize;
        let rest = self.rest;
        let bytes = rest.get(..len)?;
        self.rest = &rest[len..];
        Some(bytes)
    }

    fn take<const N: usize>(&mut self) -> Option<&'a [u8]> {
        let rest = self.rest;
        let bytes = rest.get(..N)?;
        self.rest = &rest[N..];
        Some(bytes)
    }
}

/// wx4 的 `ParseOCRReqMessage{task_id=1, pic_path=2, rt=6}`（rt 里 t1、t2 置真 —— swigger 同款）
fn encode_ocr_request(task: u32, pic_path: &str) -> Vec<u8> {
    let mut rt = Vec::new();
    pb_bool(&mut rt, 1, true);
    pb_bool(&mut rt, 2, true);
    let mut buf = Vec::new();
    pb_uint(&mut buf, 1, u64::from(task));
    pb_string(&mut buf, 2, pic_path);
    pb_message(&mut buf, 6, &rt);
    buf
}

/// `OCRSupportMessage{supported=1}`：握手响应，supported 为真才算就绪
fn decode_supported(buf: &[u8]) -> bool {
    let mut supported = false;
    for_each_field(buf, |field, payload| {
        if field == 1 {
            supported = payload.varint() == Some(1);
        }
    });
    supported
}

/// 微信认出来的一行：文本 + 行框 + 逐字框（选区图上的像素）
struct WxLine {
    text: String,
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
    chars: Vec<WxChar>,
}

struct WxChar {
    text: String,
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
}

/// `ParseOCRRespMessage{task_id=1, err_code=2, res=3}` → (task_id, err_code, 行)
fn decode_ocr_response(buf: &[u8]) -> (u32, i32, Vec<WxLine>) {
    let mut task = 0u32;
    let mut err = 0i32;
    let mut lines = Vec::new();
    for_each_field(buf, |field, payload| {
        match (field, payload) {
            (1, payload) => {
                if let Some(value) = payload.varint() {
                    task = value as u32;
                }
            }
            (2, payload) => {
                if let Some(value) = payload.varint() {
                    err = value as u32 as i32;
                }
            }
            (3, payload) => {
                if let Some(bytes) = payload.bytes() {
                    lines = decode_result_info(bytes);
                }
            }
            _ => {}
        }
    });
    (task, err, lines)
}

/// `OCRResultInfo{lines=3}`（img_width/height 不取 —— 坐标都在行里）
fn decode_result_info(buf: &[u8]) -> Vec<WxLine> {
    let mut lines = Vec::new();
    for_each_field(buf, |field, payload| {
        if field == 3 {
            if let Some(bytes) = payload.bytes() {
                if let Some(line) = decode_line(bytes) {
                    lines.push(line);
                }
            }
        }
    });
    lines
}

/// `OCRResultLine{text=2, blocks=4, left=5, top=6, right=7, bottom=8}`（line_box=1、rate=3 等用不上）
fn decode_line(buf: &[u8]) -> Option<WxLine> {
    let mut text = String::new();
    let mut bounds = [0f32; 4];
    let mut seen = 0u8;
    let mut chars = Vec::new();
    for_each_field(buf, |field, payload| {
        match (field, payload) {
            (2, payload) => {
                if let Some(bytes) = payload.bytes() {
                    text = String::from_utf8_lossy(bytes).into_owned();
                }
            }
            (4, payload) => {
                if let Some(bytes) = payload.bytes() {
                    if let Some(word) = decode_char(bytes) {
                        chars.push(word);
                    }
                }
            }
            (5, payload) => {
                if let Some(value) = payload.fixed32() {
                    bounds[0] = value;
                    seen |= 1;
                }
            }
            (6, payload) => {
                if let Some(value) = payload.fixed32() {
                    bounds[1] = value;
                    seen |= 2;
                }
            }
            (7, payload) => {
                if let Some(value) = payload.fixed32() {
                    bounds[2] = value;
                    seen |= 4;
                }
            }
            (8, payload) => {
                if let Some(value) = payload.fixed32() {
                    bounds[3] = value;
                    seen |= 8;
                }
            }
            _ => {}
        }
    });
    (seen == 0b1111).then(|| WxLine {
        text,
        left: bounds[0],
        top: bounds[1],
        right: bounds[2],
        bottom: bounds[3],
        chars,
    })
}

/// `OCRResultChar{char_box=1, chars=2}`；空文本或没框的块丢弃（摆不出东西还挡选区）
fn decode_char(buf: &[u8]) -> Option<WxChar> {
    let mut text = String::new();
    let mut corners = None;
    for_each_field(buf, |field, payload| {
        match (field, payload) {
            (1, payload) => {
                if let Some(bytes) = payload.bytes() {
                    corners = decode_box(bytes);
                }
            }
            (2, payload) => {
                if let Some(bytes) = payload.bytes() {
                    text = String::from_utf8_lossy(bytes).into_owned();
                }
            }
            _ => {}
        }
    });
    // 四角转包围盒：框可能带微旋转，min/max 包住即可（swigger 同款口径）
    let [topleft, topright, bottomright, bottomleft] = corners?;
    if text.trim().is_empty() {
        return None;
    }
    let xs = [topleft[0], topright[0], bottomright[0], bottomleft[0]];
    let ys = [topleft[1], topright[1], bottomright[1], bottomleft[1]];
    Some(WxChar {
        text,
        left: xs.into_iter().fold(f32::MAX, f32::min),
        top: ys.into_iter().fold(f32::MAX, f32::min),
        right: xs.into_iter().fold(f32::MIN, f32::max),
        bottom: ys.into_iter().fold(f32::MIN, f32::max),
    })
}

/// `Box{topleft=1, topright=2, bottomright=3, bottomleft=4}`，每角 `Point{x=1, y=2}`；
/// 四角齐了才算数
fn decode_box(buf: &[u8]) -> Option<[[f32; 2]; 4]> {
    let mut points = [[0f32; 2]; 4];
    let mut seen = 0u8;
    for_each_field(buf, |field, payload| {
        let (index, bytes) = match (field, payload.bytes()) {
            (1, Some(bytes)) => (0, bytes),
            (2, Some(bytes)) => (1, bytes),
            (3, Some(bytes)) => (2, bytes),
            (4, Some(bytes)) => (3, bytes),
            _ => return,
        };
        if let Some(point) = decode_point(bytes) {
            points[index] = point;
            seen |= 1 << index;
        }
    });
    (seen == 0b1111).then_some(points)
}

fn decode_point(buf: &[u8]) -> Option<[f32; 2]> {
    let mut point = [0f32; 2];
    for_each_field(buf, |field, payload| {
        match (field, payload.fixed32()) {
            (1, Some(value)) => point[0] = value,
            (2, Some(value)) => point[1] = value,
            _ => {}
        }
    });
    Some(point)
}

// ---- 微信三样东西的定位：mmmojo_64.dll、weixin.exe、wxocr.dll ----

struct Runtime {
    mmmojo_dll: PathBuf,
    weixin_exe: PathBuf,
    /// 版本目录（mmmojo 起子进程要的库都在这，作为 user-lib-dir 开关传下去）
    user_lib_dir: PathBuf,
    /// XPlugin 解出来的目录（wxocr.dll 在这，作为 app-path 开关传下去）
    plugin_dir: PathBuf,
}

/// 安装根：注册表 InstallPath（自定义安装路径靠它）→ Program Files 两个根兜底；
/// 第一个能翻出版本目录的算数。
fn find_runtime() -> Option<Runtime> {
    let version_dir = [install_root_from_registry(), install_root_from_program_files()]
        .into_iter()
        .flatten()
        .find_map(|root| best_version_dir(&root))?;
    let root = version_dir.parent()?;
    // 子进程是安装根的 weixin.exe（swigger 的 wx4 口径：版本目录的上一级）；
    // 有的布局把它放版本目录里，兜底找一遍
    let weixin_exe = [root.join("weixin.exe"), version_dir.join("weixin.exe")]
        .into_iter()
        .find(|path| path.is_file())?;
    let plugin_dir = best_plugin_dir()?;
    Some(Runtime {
        mmmojo_dll: version_dir.join("mmmojo_64.dll"),
        weixin_exe,
        user_lib_dir: version_dir,
        plugin_dir,
    })
}

fn install_root_from_registry() -> Option<PathBuf> {
    let mut buf = [0u16; 520];
    let mut size = (buf.len() * 2) as u32;
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR::from_raw(w!("SOFTWARE\\Tencent\\Weixin").as_ptr()),
            PCWSTR::from_raw(w!("InstallPath").as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if result.is_err() {
        return None;
    }
    let len = buf.iter().position(|&unit| unit == 0)?;
    let path = String::from_utf16_lossy(&buf[..len]);
    (!path.is_empty() && Path::new(&path).is_dir()).then_some(PathBuf::from(path))
}

fn install_root_from_program_files() -> Option<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(|dir| PathBuf::from(dir).join("Tencent").join("Weixin"))
        .find(|root| root.is_dir())
}

/// 版本目录：root 下名字是版本号、且装着 mmmojo_64.dll 的目录里最新的一个
fn best_version_dir(root: &Path) -> Option<PathBuf> {
    let mut best: Option<(Vec<u32>, PathBuf)> = None;
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(key) = version_key(name) else {
            continue;
        };
        if !path.join("mmmojo_64.dll").is_file() {
            continue;
        }
        if best.as_ref().map_or(true, |(best_key, _)| key > *best_key) {
            best = Some((key, path));
        }
    }
    best.map(|(_, path)| path)
}

/// "4.1.15.55" → [4, 1, 15, 55]：逐段比大小
fn version_key(name: &str) -> Option<Vec<u32>> {
    let parts: Option<Vec<u32>> = name.split('.').map(|part| part.parse().ok()).collect();
    parts.filter(|key| !key.is_empty())
}

/// XPlugin 引擎目录：`%APPDATA%\Tencent\xwechat\XPlugin\Plugins\WeChatOcr\<编号>\extracted`
/// （wxocr.dll 是微信第一次用「提取文字」时从 WeChatOcr.bin 解出来的，编号取最新的）
fn best_plugin_dir() -> Option<PathBuf> {
    let base = PathBuf::from(std::env::var_os("APPDATA")?)
        .join("Tencent")
        .join("xwechat")
        .join("XPlugin")
        .join("Plugins")
        .join("WeChatOcr");
    let mut best: Option<(u32, PathBuf)> = None;
    for entry in std::fs::read_dir(base).ok()?.flatten() {
        let path = entry.path();
        let Some(number) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Ok(number) = number.parse::<u32>() else {
            continue;
        };
        let extracted = path.join("extracted").join("wxocr.dll");
        if !extracted.is_file() {
            continue;
        }
        if best.as_ref().map_or(true, |(best_number, _)| number > *best_number) {
            best = Some((number, path.join("extracted")));
        }
    }
    best.map(|(_, path)| path)
}

// ---- 引擎：mmmojo 环境 + 任务表 ----

/// mmmojo 导出函数。回调形状照 swigger/wechat-ocr 跑通的 lambda；
/// 可变参那两个（注册回调 / 设参数）按 x64 Windows 的 C ABI 声明（system 同型）。
#[derive(Clone, Copy)]
struct Funcs {
    initialize: unsafe extern "system" fn(c_int, *const *const c_char),
    create_env: unsafe extern "system" fn() -> *mut c_void,
    set_callbacks: unsafe extern "C" fn(*mut c_void, c_int, ...),
    set_params: unsafe extern "C" fn(*mut c_void, c_int, ...),
    append_switch: unsafe extern "system" fn(*mut c_void, *const c_char, *const u16),
    start: unsafe extern "system" fn(*mut c_void),
    create_write_info: unsafe extern "system" fn(c_int, bool, u32) -> *mut c_void,
    get_write_info_request: unsafe extern "system" fn(*mut c_void, u32) -> *mut c_void,
    send_write_info: unsafe extern "system" fn(*mut c_void, *mut c_void) -> bool,
    remove_write_info: unsafe extern "system" fn(*mut c_void),
    get_read_info_request: unsafe extern "system" fn(*const c_void, *mut u32) -> *const c_void,
    remove_read_info: unsafe extern "system" fn(*mut c_void),
}

type ReadPushFn = unsafe extern "system" fn(u32, *const c_void, *mut c_void);
type ConnectFn = unsafe extern "system" fn(bool, *mut c_void);
type DisconnectFn = unsafe extern "system" fn(*mut c_void);
type LaunchFailedFn = unsafe extern "system" fn(c_int, *mut c_void);
type RemoteErrorFn = unsafe extern "system" fn(*const c_void, c_int, *mut c_void);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Conn {
    Pending,
    Connected,
    Inited,
    Failed,
}

struct Task {
    result: Option<Result<Vec<WxLine>, i32>>,
}

/// 引擎共享态。mmmojo 在自己的线程上回调我们，全部交互都过锁；
/// env 指针只在 Start 前写一次、之后只读，Send/Sync 是安全的。
struct Shared {
    funcs: Funcs,
    env: *mut c_void,
    conn: Mutex<Conn>,
    conn_cv: Condvar,
    tasks: Mutex<HashMap<u32, Task>>,
    tasks_cv: Condvar,
    next_task: AtomicU32,
}

unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

impl Shared {
    /// mmmojo 推来的消息：握手定连接态，响应填任务槽
    fn on_push(&self, request_id: u32, bytes: &[u8]) {
        match request_id {
            REQ_HAND_SHAKE => {
                let supported = decode_supported(bytes);
                let mut conn = self.conn.lock().expect("mmmojo 回调线程把连接锁毒化了");
                if matches!(*conn, Conn::Pending | Conn::Connected) {
                    *conn = if supported { Conn::Inited } else { Conn::Failed };
                    self.conn_cv.notify_all();
                }
            }
            REQ_RESP_OCR => {
                let (task, err, lines) = decode_ocr_response(bytes);
                let mut tasks = self.tasks.lock().expect("mmmojo 回调线程把任务锁毒化了");
                if let Some(slot) = tasks.get_mut(&task) {
                    slot.result = Some(if err == 0 { Ok(lines) } else { Err(err) });
                    self.tasks_cv.notify_all();
                }
            }
            _ => {}
        }
    }

    fn alloc_task(&self) -> u32 {
        loop {
            let id = self.next_task.fetch_add(1, Ordering::Relaxed);
            if (2..=TASK_ID_MAX).contains(&id) {
                return id;
            }
            self.next_task.store(2, Ordering::Relaxed);
        }
    }

    fn recognize_wx(&self, image: &image::RgbaImage) -> Result<Vec<WxLine>, String> {
        {
            let conn = self.conn.lock().expect("mmmojo 回调线程把连接锁毒化了");
            if *conn != Conn::Inited {
                return Err("微信取字引擎没有连上（微信可能刚更新过，重开一次微信再试）".into());
            }
        }
        let task = self.alloc_task();
        // 结果槽先于请求落表：响应从 mmmojo 线程回来时要在里面
        self.tasks
            .lock()
            .expect("mmmojo 回调线程把任务锁毒化了")
            .insert(task, Task { result: None });
        let png = TempPng::create(task, image)?;
        let request = encode_ocr_request(task, &png.utf8_path());
        let sent = unsafe {
            let info = (self.funcs.create_write_info)(METHOD_PUSH, false, REQ_REQ_OCR);
            if info.is_null() {
                return Err("微信取字建不了请求".into());
            }
            let buf = (self.funcs.get_write_info_request)(info, request.len() as u32);
            if buf.is_null() {
                (self.funcs.remove_write_info)(info);
                return Err("微信取字装不下请求".into());
            }
            ptr::copy_nonoverlapping(request.as_ptr(), buf.cast(), request.len());
            (self.funcs.send_write_info)(self.env, info)
        };
        if !sent {
            self.tasks.lock().expect("mmmojo 回调线程把任务锁毒化了").remove(&task);
            return Err("微信取字请求没有发出去".into());
        }
        // 等结果（整屏也就几百毫秒；15s 封顶 —— 子进程卡死就回退，别挂着）
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut tasks = self.tasks.lock().expect("mmmojo 回调线程把任务锁毒化了");
        let result = loop {
            if let Some(slot) = tasks.get_mut(&task) {
                if let Some(result) = slot.result.take() {
                    break result;
                }
            } else {
                break Err(-2);
            }
            let now = Instant::now();
            if now >= deadline {
                break Err(-1);
            }
            let (next, _) = self
                .tasks_cv
                .wait_timeout(tasks, deadline - now)
                .expect("mmmojo 回调线程把任务锁毒化了");
            tasks = next;
        };
        tasks.remove(&task);
        drop(tasks);
        match result {
            Ok(lines) => Ok(lines),
            Err(code) => Err(format!("微信取字没有返回（错误码 {code}）")),
        }
    }
}

/// 进程级单例：第一次取字时起（起进程 + 握手要一两秒）；Err 也缓存 —— 微信不在 /
/// 引擎没起来就这一轮会话都直接走 Windows OCR，不再反复试。
static ENGINE: OnceLock<Result<Arc<Shared>, String>> = OnceLock::new();

fn engine() -> Result<&'static Arc<Shared>, String> {
    ENGINE.get_or_init(init).as_ref().map_err(Clone::clone)
}

fn init() -> Result<Arc<Shared>, String> {
    let runtime = find_runtime().ok_or_else(|| {
        "没找到微信的取字引擎（要装微信 4.x，且在微信里用过一次「提取文字」让它解出 wxocr.dll）".to_string()
    })?;
    let funcs = load_funcs(&runtime.mmmojo_dll)?;

    unsafe {
        (funcs.initialize)(0, ptr::null());
    }
    let env = unsafe { (funcs.create_env)() };
    if env.is_null() {
        return Err("微信取字引擎建不了环境".into());
    }
    let shared = Arc::new(Shared {
        funcs,
        env,
        conn: Mutex::new(Conn::Pending),
        conn_cv: Condvar::new(),
        tasks: Mutex::new(HashMap::new()),
        tasks_cv: Condvar::new(),
        next_task: AtomicU32::new(2),
    });
    // user_data 泄漏一份引用计数换稳定地址：引擎与进程同寿（不 Stop / 不 FreeLibrary，
    // 见文件头「生命周期与线程」），回调从这根指针回到 Shared
    let user_data = Arc::as_ptr(&shared) as *mut c_void;

    let exe_wide = to_wide(runtime.weixin_exe.as_os_str());
    let lib_dir_wide = to_wide(runtime.user_lib_dir.as_os_str());
    let type_wide = to_wide(OsStr::new("wxocr"));
    let app_path_wide = to_wide(runtime.plugin_dir.as_os_str());
    let empty_wide = [0u16];
    unsafe {
        let f = &shared.funcs;
        (f.set_callbacks)(env, CB_USER_DATA, user_data);
        (f.set_callbacks)(env, CB_READ_PUSH, on_read_push as ReadPushFn);
        (f.set_callbacks)(env, CB_READ_PULL, noop_read as ReadPushFn);
        (f.set_callbacks)(env, CB_READ_SHARED, noop_read as ReadPushFn);
        (f.set_callbacks)(env, CB_CONNECT, on_connect as ConnectFn);
        (f.set_callbacks)(env, CB_DISCONNECT, on_disconnect as DisconnectFn);
        (f.set_callbacks)(env, CB_LAUNCHED, noop_user as DisconnectFn);
        (f.set_callbacks)(env, CB_LAUNCH_FAILED, on_launch_failed as LaunchFailedFn);
        (f.set_callbacks)(env, CB_ERROR, on_remote_error as RemoteErrorFn);
        // 宿主进程身份 + 子进程路径；开关：禁沙箱、mmmojo 要的库目录、跑 wxocr 模块、
        // wxocr.dll 所在目录（所有值都在调用现场拷走，临时 buffer 出了调用就没了）
        (f.set_params)(env, PARAM_HOST_PROCESS, 1 as c_int);
        (f.set_params)(env, PARAM_EXE_PATH, exe_wide.as_ptr());
        (f.append_switch)(env, c"no-sandbox".as_ptr(), empty_wide.as_ptr());
        (f.append_switch)(env, c"user-lib-dir".as_ptr(), lib_dir_wide.as_ptr());
        (f.append_switch)(env, c"type".as_ptr(), type_wide.as_ptr());
        (f.append_switch)(env, c"app-path".as_ptr(), app_path_wide.as_ptr());
        (f.start)(env);
    }
    // 等握手：子进程要起 weixin.exe、加载模型，冷启动给 8s
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut conn = shared.conn.lock().expect("mmmojo 回调线程把连接锁毒化了");
    while *conn != Conn::Inited {
        if *conn == Conn::Failed {
            return Err("微信取字引擎握手失败（微信可能刚更新过，重开一次微信再试）".into());
        }
        let now = Instant::now();
        if now >= deadline {
            return Err("微信取字引擎握手没有完成".into());
        }
        let (next, _) = shared
            .conn_cv
            .wait_timeout(conn, deadline - now)
            .expect("mmmojo 回调线程把连接锁毒化了");
        conn = next;
    }
    drop(conn);
    Ok(shared)
}

unsafe extern "system" fn on_read_push(request_id: u32, info: *const c_void, user_data: *mut c_void) {
    let shared = &*(user_data as *const Shared);
    if info.is_null() {
        return;
    }
    let mut size = 0u32;
    let data = (shared.funcs.get_read_info_request)(info, &mut size);
    if !data.is_null() && size > 0 {
        let bytes = std::slice::from_raw_parts(data.cast::<u8>(), size as usize);
        shared.on_push(request_id, bytes);
    }
    (shared.funcs.remove_read_info)(info as *mut c_void);
}

/// Pull / Shared 两条路取字用不到，但 info 是 mmmojo 的堆内存，必须删
unsafe extern "system" fn noop_read(_request_id: u32, info: *const c_void, user_data: *mut c_void) {
    if info.is_null() {
        return;
    }
    let shared = &*(user_data as *const Shared);
    (shared.funcs.remove_read_info)(info as *mut c_void);
}

unsafe extern "system" fn on_connect(connected: bool, user_data: *mut c_void) {
    let shared = &*(user_data as *const Shared);
    let mut conn = shared.conn.lock().expect("mmmojo 回调线程把连接锁毒化了");
    if *conn == Conn::Pending {
        *conn = if connected { Conn::Connected } else { Conn::Failed };
        shared.conn_cv.notify_all();
    }
}

/// 子进程断开（死了 / 被关了）：连接作废，之后的取字都直接失败回退
unsafe extern "system" fn on_disconnect(user_data: *mut c_void) {
    let shared = &*(user_data as *const Shared);
    let mut conn = shared.conn.lock().expect("mmmojo 回调线程把连接锁毒化了");
    *conn = Conn::Failed;
    shared.conn_cv.notify_all();
}

unsafe extern "system" fn noop_user(_user_data: *mut c_void) {}

unsafe extern "system" fn on_launch_failed(_error_code: c_int, user_data: *mut c_void) {
    let shared = &*(user_data as *const Shared);
    let mut conn = shared.conn.lock().expect("mmmojo 回调线程把连接锁毒化了");
    if *conn == Conn::Pending {
        *conn = Conn::Failed;
        shared.conn_cv.notify_all();
    }
}

/// mojo 层的错误文本：拿不到更多上下文，也不用给用户看 —— 静默
unsafe extern "system" fn on_remote_error(_buf: *const c_void, _size: c_int, _user_data: *mut c_void) {}

fn to_wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn load_funcs(dll: &Path) -> Result<Funcs, String> {
    let wide = to_wide(dll.as_os_str());
    let module = unsafe { LoadLibraryW(PCWSTR::from_raw(wide.as_ptr())) }
        .map_err(|err| format!("微信的 mmmojo_64.dll 装不上（{err}）"))?;
    unsafe {
        Ok(Funcs {
            initialize: get_proc(module, c"InitializeMMMojo")?,
            create_env: get_proc(module, c"CreateMMMojoEnvironment")?,
            set_callbacks: get_proc(module, c"SetMMMojoEnvironmentCallbacks")?,
            set_params: get_proc(module, c"SetMMMojoEnvironmentInitParams")?,
            append_switch: get_proc(module, c"AppendMMSubProcessSwitchNative")?,
            start: get_proc(module, c"StartMMMojoEnvironment")?,
            create_write_info: get_proc(module, c"CreateMMMojoWriteInfo")?,
            get_write_info_request: get_proc(module, c"GetMMMojoWriteInfoRequest")?,
            send_write_info: get_proc(module, c"SendMMMojoWriteInfo")?,
            remove_write_info: get_proc(module, c"RemoveMMMojoWriteInfo")?,
            get_read_info_request: get_proc(module, c"GetMMMojoReadInfoRequest")?,
            remove_read_info: get_proc(module, c"RemoveMMMojoReadInfo")?,
        })
    }
}

unsafe fn get_proc<F>(module: HMODULE, name: &CStr) -> Result<F, String> {
    let Some(address) = GetProcAddress(module, PCSTR::from_raw(name.as_ptr().cast())) else {
        return Err(format!(
            "mmmojo_64.dll 缺导出 {}（微信版本可能不兼容）",
            name.to_string_lossy()
        ));
    };
    Ok(std::mem::transmute_copy(&address))
}

/// 临时 PNG：微信子进程按路径自己读图，认完即删（Drop 兜底，错误路径也不留）
struct TempPng {
    path: PathBuf,
}

impl TempPng {
    fn create(task: u32, image: &image::RgbaImage) -> Result<TempPng, String> {
        let path = std::env::temp_dir().join(format!("workbench-wxocr-{task}.png"));
        image.save(&path).map_err(|err| format!("取字的临时图写不了（{err}）"))?;
        Ok(TempPng { path })
    }

    /// 子进程要绝对路径；`\\?\` 前缀它吃不下，剥掉
    fn utf8_path(&self) -> String {
        let abs = dunce::canonicalize(&self.path).unwrap_or_else(|_| self.path.clone());
        abs.as_os_str().to_string_lossy().into_owned()
    }
}

impl Drop for TempPng {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// 子序列对齐向前看的步数：块的字符在文本里隔这么远还找得到就当「中间的字缺框」
const ALIGN_LOOKAHEAD: usize = 4;

/// 一行 → 逐字位。**line.text 是权威文本，字框只覆盖约八成的字**（实测 87 字的行只有 66 框，
/// 且「文本去空白 == 字框拼接」一字不差）——按字符相等做子序列对齐：对上的字用真框，
/// 缺框的字（含空格，块里没有空格框）夹在相邻两块之间插值出位。整行每个字都有位，
/// 选中高亮才连得起来、复制才不丢字；两边认得不一样的以块为准（框是真像素）。
fn line_words(line: &WxLine) -> Vec<OcrWord> {
    // 真框发位时**裁到下一块的左缘**：微信的四角框普遍比步进宽 2~5px（小字号外扩），
    // 不裁的话相邻选中底色叠两层，深浅斑驳 —— 高亮只需盖住笔画，笔画不会伸进下一个字
    let block_word = |word: &WxChar, next: Option<&WxChar>| {
        let mut w = f64::from(word.right - word.left);
        if let Some(next) = next {
            let next_left = f64::from(next.left);
            if next_left > f64::from(word.left) {
                w = w.min(next_left - f64::from(word.left));
            }
        }
        OcrWord {
            text: word.text.clone(),
            x: f64::from(word.left),
            y: f64::from(word.top),
            w,
            h: f64::from(word.bottom - word.top),
        }
    };
    let text_chars: Vec<char> = line.text.chars().collect();
    let line_height = f64::from(line.bottom - line.top);
    let mut words: Vec<OcrWord> = Vec::new();
    let mut at = 0usize;
    let mut block = 0usize;
    while at < text_chars.len() {
        let tc = text_chars[at];
        // 在文本里向前找当前块的首字符：找到 → 中间的字缺框；找不到 → 两边认得不一样
        let mut matched_at = None;
        if let Some(next) = line.chars.get(block) {
            let first = next.text.chars().next();
            if first == Some(tc) {
                matched_at = Some(at);
            } else {
                let window_end = (at + 1 + ALIGN_LOOKAHEAD).min(text_chars.len());
                for (offset, other) in text_chars[at + 1..window_end].iter().enumerate() {
                    if Some(*other) == first {
                        matched_at = Some(at + 1 + offset);
                        break;
                    }
                }
            }
        }
        match matched_at {
            Some(pos) => {
                // [at, pos) 缺框：与当前块均分「上一已发位右缘 → 块左缘」这段区间
                let (run_left, height) = match words.last() {
                    Some(prev) => (prev.x + prev.w, prev.h),
                    None => (f64::from(line.left), line_height),
                };
                let run_right = f64::from(line.chars[block].left);
                // 缺框的字把「上一已发位右缘 → 块左缘」整段分掉（真块有自己的框，不占这段），
                // 步进被 1px 下限撑出去时按区间右缘裁住，不许搭到真块上
                let step = ((run_right - run_left) / ((pos - at) as f64)).max(1.0);
                for (offset, missed) in text_chars[at..pos].iter().enumerate() {
                    let x = run_left + step * offset as f64;
                    words.push(OcrWord {
                        text: missed.to_string(),
                        x,
                        y: f64::from(line.chars[block].top),
                        w: step.min((run_right - x).max(0.5)),
                        h: height,
                    });
                }
                words.push(block_word(&line.chars[block], line.chars.get(block + 1)));
                at = pos + 1;
                block += 1;
            }
            None => {
                match line.chars.get(block) {
                    Some(word) => {
                        // 块的字符在附近找不到（两边认得不一样）：块为准，文本这个字让位
                        words.push(block_word(word, line.chars.get(block + 1)));
                        block += 1;
                        at += 1;
                    }
                    None => {
                        // 块用完了：剩下的文本按行框剩余宽度摊成一块
                        let rest: String =
                            text_chars[at..].iter().filter(|c| !c.is_whitespace()).collect();
                        let (x, y, h) = match words.last() {
                            Some(prev) => (prev.x + prev.w, prev.y, prev.h),
                            None => (f64::from(line.left), f64::from(line.top), line_height),
                        };
                        if !rest.is_empty() {
                            words.push(OcrWord {
                                text: rest,
                                x,
                                y,
                                w: (f64::from(line.right) - x).max(1.0),
                                h,
                            });
                        }
                        at = text_chars.len();
                    }
                }
            }
        }
    }
    // 文本走完了块还有剩：照常摆（框是真像素）
    for index in block..line.chars.len() {
        words.push(block_word(&line.chars[index], line.chars.get(index + 1)));
    }
    words
}

/// 行 → wire（文字层摆位）；行按 (y, x) 排成阅读顺序
fn to_wire(lines: Vec<WxLine>) -> Vec<OcrLine> {
    let mut rows: Vec<OcrLine> = lines
        .into_iter()
        .filter(|line| !line.text.trim().is_empty())
        .map(|line| OcrLine { words: line_words(&line) })
        .collect();
    rows.sort_by(|a, b| {
        let (ay, ax) = line_origin(a);
        let (by, bx) = line_origin(b);
        // NaN 兜底成 Equal，保证比较是全序
        ay.partial_cmp(&by)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| ax.partial_cmp(&bx).unwrap_or(std::cmp::Ordering::Equal))
    });
    rows
}

fn line_origin(line: &OcrLine) -> (f64, f64) {
    line.words
        .first()
        .map_or((0.0, 0.0), |word| (word.y, word.x))
}

/// 微信引擎认一块选区图。没装微信 / 引擎没起来返回 Err，调用方回退 Windows OCR。
pub fn recognize(image: &image::RgbaImage) -> Result<Vec<OcrLine>, String> {
    engine()?.recognize_wx(image).map(to_wire)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pb_f32(buf: &mut Vec<u8>, field: u32, value: f32) {
        pb_key(buf, field, 5);
        buf.extend_from_slice(&value.to_le_bytes());
    }

    /// 请求编码：字段号与嵌套形状要跟 wx4 的 proto 对上（task_id=1、pic_path=2、rt=6）
    #[test]
    fn 请求编码形状对上wx4协议() {
        let buf = encode_ocr_request(7, "C:\\temp\\a.png");
        let mut saw_task = None;
        let mut saw_path = None;
        let mut saw_rt = None;
        for_each_field(&buf, |field, payload| {
            match (field, &payload) {
                (1, Field::Varint(value)) => saw_task = Some(*value),
                (2, Field::Bytes(bytes)) => {
                    saw_path = Some(String::from_utf8_lossy(bytes).into_owned())
                }
                (6, Field::Bytes(bytes)) => saw_rt = Some(bytes.to_vec()),
                _ => {}
            }
        });
        assert_eq!(saw_task, Some(7));
        assert_eq!(saw_path.as_deref(), Some("C:\\temp\\a.png"));
        // rt{t1=1, t2=1}：两个 varint 1（tag 0x08 / 0x10）
        assert_eq!(saw_rt.as_deref(), Some(&[0x08, 0x01, 0x10, 0x01][..]));
    }

    /// 响应解码：手编一段带逐字框的响应，验文本、行框、四角转包围盒
    #[test]
    fn 响应解码出行文本行框与逐字框() {
        let point = |x: f32, y: f32| {
            let mut p = Vec::new();
            pb_f32(&mut p, 1, x);
            pb_f32(&mut p, 2, y);
            p
        };
        let mut char_box = Vec::new();
        pb_message(&mut char_box, 1, &point(0.0, 0.0));
        pb_message(&mut char_box, 2, &point(10.0, 0.0));
        pb_message(&mut char_box, 3, &point(10.0, 12.0));
        pb_message(&mut char_box, 4, &point(0.0, 12.0));
        let mut char_field = Vec::new();
        pb_message(&mut char_field, 1, &char_box);
        pb_string(&mut char_field, 2, "p");

        let mut line = Vec::new();
        pb_string(&mut line, 2, "pnpm run");
        pb_message(&mut line, 4, &char_field);
        pb_f32(&mut line, 5, 1.0);
        pb_f32(&mut line, 6, 2.0);
        pb_f32(&mut line, 7, 31.0);
        pb_f32(&mut line, 8, 14.0);
        let mut res = Vec::new();
        pb_message(&mut res, 3, &line);
        let mut resp = Vec::new();
        pb_uint(&mut resp, 1, 9);
        pb_message(&mut resp, 3, &res);

        let (task, err, lines) = decode_ocr_response(&resp);
        assert_eq!((task, err), (9, 0));
        assert_eq!(lines.len(), 1);
        let line = &lines[0];
        assert_eq!(line.text, "pnpm run");
        assert_eq!((line.left, line.top, line.right, line.bottom), (1.0, 2.0, 31.0, 14.0));
        assert_eq!(line.chars.len(), 1);
        let word = &line.chars[0];
        assert_eq!(word.text, "p");
        assert_eq!((word.left, word.top, word.right, word.bottom), (0.0, 0.0, 10.0, 12.0));
    }

    /// 支持位：supported=false 或缺字段都当不支持（握手不放行）
    #[test]
    fn 握手支持位要为真才放行() {
        let mut yes = Vec::new();
        pb_bool(&mut yes, 1, true);
        assert!(decode_supported(&yes));
        assert!(!decode_supported(&[]));
        let mut no = Vec::new();
        pb_bool(&mut no, 1, false);
        assert!(!decode_supported(&no));
    }

    /// 版本号逐段比大小（找最新版本目录的依据）
    #[test]
    fn 版本号逐段比大小() {
        assert!(version_key("4.1.15.55").unwrap() > version_key("4.1.9.99").unwrap());
        assert!(version_key("10.0.0.0").unwrap() > version_key("9.9.9.9").unwrap());
        assert_eq!(version_key("abc"), None);
    }

    /// 行对齐出逐字位：块按字符相等做子序列匹配，缺框的字（含空格）在相邻两块间插值，
    /// 整行每个文本字符都有位 —— 高亮才连续、复制才不丢字
    #[test]
    fn 行对齐出逐字位缺框的插值() {
        let char_at = |text: &str, left: f32| WxChar {
            text: text.into(),
            left,
            top: 0.0,
            right: left + 10.0,
            bottom: 12.0,
        };
        // text「成熟得多」 blocks 成、多（熟、得缺框）：4 个位，中间两个在成右缘与多左缘间均分
        let line = WxLine {
            text: "成熟得多".into(),
            left: 0.0,
            top: 0.0,
            right: 100.0,
            bottom: 12.0,
            chars: vec![char_at("成", 0.0), char_at("多", 60.0)],
        };
        let words = line_words(&line);
        assert_eq!(words.len(), 4);
        assert_eq!(words[0].text, "成");
        assert_eq!((words[0].x, words[0].w), (0.0, 10.0));
        assert_eq!(words[1].text, "熟");
        assert_eq!(words[2].text, "得");
        // 缺框的两个字均分 (60 - 10) 的区间
        assert_eq!((words[1].x, words[1].w), (10.0, 25.0));
        assert_eq!((words[2].x, words[2].w), (35.0, 25.0));
        assert_eq!(words[3].text, "多");
        assert_eq!((words[3].x, words[3].w), (60.0, 10.0));

        // 空格没有框：夹在 m 与 r 之间，撑满真实间隙
        let mut chars = Vec::new();
        for (at, text) in ["p", "n", "p", "m", "r", "u", "n"].iter().enumerate() {
            let left = if at < 4 { at as f32 * 10.0 } else { 45.0 + (at - 4) as f32 * 10.0 };
            chars.push(char_at(text, left));
        }
        let line = WxLine {
            text: "pnpm run".into(),
            left: 0.0,
            top: 0.0,
            right: 75.0,
            bottom: 12.0,
            chars,
        };
        let words = line_words(&line);
        assert_eq!(words.len(), 8);
        assert_eq!(words[4].text, " ");
        assert_eq!((words[4].x, words[4].w), (40.0, 5.0));
        assert_eq!(words[5].text, "r");

        // 块用完了：剩下的文本按行框剩余宽度摊成一块（内容不丢）
        let line = WxLine {
            text: "abcd".into(),
            left: 0.0,
            top: 0.0,
            right: 40.0,
            bottom: 12.0,
            chars: vec![char_at("a", 0.0), char_at("b", 10.0)],
        };
        let words = line_words(&line);
        assert_eq!(words.len(), 3);
        assert_eq!(words[2].text, "cd");
        assert_eq!((words[2].x, words[2].w), (20.0, 20.0));

        // 两边认得不一样：块为准（框是真像素），剩下的文本进尾巴
        let line = WxLine {
            text: "abc".into(),
            left: 0.0,
            top: 0.0,
            right: 40.0,
            bottom: 12.0,
            chars: vec![char_at("a", 0.0), char_at("x", 10.0)],
        };
        let words = line_words(&line);
        assert_eq!(words.len(), 3);
        assert_eq!(words[1].text, "x");
        assert_eq!(words[2].text, "c");

        // 真框外扩（比下一块的左缘宽）：裁到下一块左缘，选中底色不叠两层
        let line = WxLine {
            text: "修法".into(),
            left: 0.0,
            top: 0.0,
            right: 30.0,
            bottom: 12.0,
            chars: vec![char_at("修", 4.6), char_at("法", 14.1)],
        };
        // 修 的框本来到 14.6（4.6 + 10），裁到 14.1 就停
        let words = line_words(&line);
        assert!((words[0].x - 4.6).abs() < 1e-4 && (words[0].w - 9.5).abs() < 1e-4);
        assert!((words[1].x - 14.1).abs() < 1e-4 && (words[1].w - 10.0).abs() < 1e-4);
    }

    /// 手动探针：走一遍微信引擎（要装着微信 4.x 且解出过 wxocr.dll）
    /// `WXOCR_PROBE_IMAGE=<png> cargo test ... wechat_ocr_probe -- --ignored --nocapture`
    /// 行 → wire：有字框逐字摆，没有就整行一框；行按 (y, x) 排阅读顺序
    #[test]
    fn 行映射成wire并按阅读顺序排() {
        let make = |text: &str, top: f32, left: f32| WxLine {
            text: text.into(),
            left,
            top,
            right: left + 10.0,
            bottom: top + 12.0,
            chars: vec![WxChar {
                text: text.into(),
                left,
                top,
                right: left + 10.0,
                bottom: top + 12.0,
            }],
        };
        let mut rows = to_wire(vec![make("下", 20.0, 0.0), make("上", 0.0, 5.0)]);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].words[0].text, "上");
        assert_eq!(rows[1].words[0].text, "下");
        rows = to_wire(vec![make("", 0.0, 0.0)]);
        assert!(rows.is_empty(), "空文本行不进 wire");
        // 没有字框的行：整行文本一个框
        rows = to_wire(vec![WxLine {
            text: "整行".into(),
            left: 1.0,
            top: 2.0,
            right: 21.0,
            bottom: 14.0,
            chars: Vec::new(),
        }]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].words.len(), 1);
        assert_eq!(rows[0].words[0].text, "整行");
        assert_eq!((rows[0].words[0].x, rows[0].words[0].w), (1.0, 20.0));
    }

    #[test]
    #[ignore = "手动探针：传 WXOCR_PROBE_IMAGE 看微信引擎的识别结果"]
    fn wechat_ocr_probe() {
        let path = std::env::var("WXOCR_PROBE_IMAGE").expect("设 WXOCR_PROBE_IMAGE 指到截图 png");
        let image = image::open(&path).expect("图解不开").to_rgba8();
        let started = Instant::now();
        let shared = engine().expect("引擎起不来");
        let lines = shared.recognize_wx(&image).expect("微信取字失败");
        println!("耗时 {:?}，{} 行", started.elapsed(), lines.len());
        for line in &lines {
            let joined: String = line.chars.iter().map(|c| c.text.as_str()).collect();
            let wired = line_words(line);
            println!(
                "  行文本 {} 字 / 字框 {} / 输出位 {}：{:?}",
                line.text.chars().count(),
                line.chars.len(),
                wired.len(),
                line.text
            );
            println!("  字框拼：{:?}", joined);
            // 重叠检测：半透明选中底色叠两层就会更深，量出哪些位搭在一起
            for pair in wired.windows(2) {
                let overlap = pair[0].x + pair[0].w - pair[1].x;
                if overlap > 0.3 {
                    println!(
                        "    重叠 {:.1}px：{:?}({:.1}+{:.1}) → {:?}({:.1})",
                        overlap, pair[0].text, pair[0].x, pair[0].w, pair[1].text, pair[1].x
                    );
                }
            }
        }
    }
}
