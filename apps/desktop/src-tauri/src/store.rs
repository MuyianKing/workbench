//! 去抖 JSON 单文件存储：`300ms 合并 + 临时文件 rename + 退出前同步落盘`。
//!
//! 与 Electron 版 `main/json-store.ts` 的行为对齐，但刻意做薄：Rust 只负责「把 TS 给的
//! JSON 原样安全写盘」，不做 sanitize —— 收敛逻辑留在 `apps/desktop/src/renderer/src/persisted-data.ts`，
//! 与渲染层共用一份，也就不需要为它写两遍测试。

use crate::fs_util;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 防抖窗口，与 Electron 版一致
const WRITE_DELAY: Duration = Duration::from_millis(300);

struct Inner {
    value: Value,
    /// 载入前不写盘，避免用空数据覆盖真实文件
    loaded: bool,
    /// 只在本进程真的改过之后才允许写回。
    /// 这一条是对 Electron 版的收紧：那边退出时无条件写一遍解析结果，
    /// 数据文件要是被手工改坏（解析失败 → 回落默认值），退出就会把损坏但还有救的原文件覆盖掉。
    dirty: bool,
    /// 启动时那次载入失败的原因。文件缺失不是错误（第一次运行），读不出来 / 解析不了才是 ——
    /// 留着给 `*_load` 通道如实回一个 `Err`，而不是让渲染层把「读失败」当成「空数据」。
    load_error: Option<String>,
}

pub struct JsonStore {
    /// 每次写盘时重新取路径：数据目录可被用户迁移，路径并非固定
    file: fn() -> PathBuf,
    label: &'static str,
    inner: Arc<Mutex<Inner>>,
    tx: Sender<()>,
}

impl JsonStore {
    pub fn new(file: fn() -> PathBuf, label: &'static str) -> Self {
        let inner = Arc::new(Mutex::new(Inner {
            value: Value::Null,
            loaded: false,
            dirty: false,
            load_error: None,
        }));

        let (tx, rx) = channel::<()>();
        let worker_inner = Arc::clone(&inner);
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                // 连续变更合并：直到静默 300ms 才真正落盘，等价于 clearTimeout + setTimeout
                loop {
                    match rx.recv_timeout(WRITE_DELAY) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                write_file(file(), label, &worker_inner);
            }
        });

        Self {
            file,
            label,
            inner,
            tx,
        }
    }

    /// 读磁盘原始 JSON。**文件不存在 = 第一次运行**（`Ok(Null)`）；
    /// 文件存在但读不出来 / 解析不了 = `Err`，由通道如实带回渲染层。
    /// 内存里那份仍然只放 `Null`：启动不能因为一份坏文件停住，但也别把它说成「空数据」。
    pub fn load(&self) -> Result<Value, String> {
        let path = (self.file)();
        let (value, error) = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(value) => (value, None),
                Err(err) => (
                    Value::Null,
                    Some(format!("{} 解析失败（{}）：{err}", self.label, path.display())),
                ),
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => (Value::Null, None),
            Err(err) => (
                Value::Null,
                Some(format!("{} 读取失败（{}）：{err}", self.label, path.display())),
            ),
        };

        let mut inner = self.inner.lock().expect("锁中毒");
        inner.value = value.clone();
        inner.loaded = true;
        inner.dirty = false;
        inner.load_error = error.clone();
        match error {
            Some(err) => Err(err),
            None => Ok(value),
        }
    }

    pub fn get(&self) -> Value {
        self.inner.lock().expect("锁中毒").value.clone()
    }

    /// 读一次内存里的值给通道用：启动那次载入出过错就回 `Err`。
    pub fn read(&self) -> Result<Value, String> {
        let inner = self.inner.lock().expect("锁中毒");
        match &inner.load_error {
            Some(err) => Err(err.clone()),
            None => Ok(inner.value.clone()),
        }
    }

    /// 直接替换内存值（调用方应已 sanitize 过）。写入了新值就说明用户已经覆盖了
    /// 上一份坏文件，载入错误随之作废。
    pub fn set(&self, value: Value) {
        let mut inner = self.inner.lock().expect("锁中毒");
        inner.value = value;
        inner.dirty = true;
        inner.load_error = None;
    }

    /// 变更即写，防抖 300ms
    pub fn schedule(&self) {
        if !should_write(&self.inner) {
            return;
        }
        // 接收端线程若已退出（进程收尾中），这里失败也无所谓：flush_sync 会兜住
        let _ = self.tx.send(());
    }

    /// 退出前同步落盘，防止防抖窗口内的改动丢失
    pub fn flush_sync(&self) {
        if !should_write(&self.inner) {
            return;
        }
        write_file((self.file)(), self.label, &self.inner);
    }
}

/// 载入完成、且本进程改过，才允许落盘
fn should_write(inner: &Arc<Mutex<Inner>>) -> bool {
    let inner = inner.lock().expect("锁中毒");
    inner.loaded && inner.dirty
}

/// 先写临时文件再 rename：rename 在同一卷上是原子的，不会留下半个 JSON。
fn write_file(path: PathBuf, label: &str, inner: &Arc<Mutex<Inner>>) {
    let value = inner.lock().expect("锁中毒").value.clone();
    let text = match serde_json::to_string_pretty(&value) {
        Ok(text) => text,
        Err(err) => {
            eprintln!("[workbench] {label}失败: {err}");
            return;
        }
    };

    // 数据目录可能还没建起来（首次启动，或用户手工删过）：不建好这一步只会静默失败
    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            eprintln!("[workbench] {label}失败: {err}");
            return;
        }
    }

    if let Err(err) = fs_util::write_atomic(&path, text.as_bytes()) {
        eprintln!("[workbench] {label}失败: {err}");
    }
}
