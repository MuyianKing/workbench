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
    /// 载入时发现文件损坏、又没能把它另存出去（挪 / 复制都失败）。
    /// 这时**整轮运行都不允许落盘**：宁可这次改动不保存，也不能用空数据把唯一还能人工救回的原文件盖掉。
    write_blocked: bool,
}

pub struct JsonStore {
    /// 每次写盘时重新取路径：数据目录可被用户迁移，路径并非固定。
    /// 用 `Arc<dyn Fn>` 而不是 `fn` 指针，单测才能把临时目录的闭包传进来；调用方传函数项照旧。
    file: Arc<dyn Fn() -> PathBuf + Send + Sync>,
    label: &'static str,
    inner: Arc<Mutex<Inner>>,
    tx: Sender<()>,
}

impl JsonStore {
    pub fn new(file: impl Fn() -> PathBuf + Send + Sync + 'static, label: &'static str) -> Self {
        let file: Arc<dyn Fn() -> PathBuf + Send + Sync> = Arc::new(file);
        let inner = Arc::new(Mutex::new(Inner {
            value: Value::Null,
            loaded: false,
            dirty: false,
            load_error: None,
            write_blocked: false,
        }));

        let (tx, rx) = channel::<()>();
        let worker_inner = Arc::clone(&inner);
        let worker_file = Arc::clone(&file);
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
                write_file(worker_file(), label, &worker_inner);
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
    ///
    /// **解析不了的文件先另存一份 `<文件>.corrupt-<时间>`**，再按空数据启动：
    /// 文件是坏的但内容可能还能人工救回来，绝不能留在原地等下一次保存用空数据盖掉
    /// （踩过：断电把 workbench-data.json 写成全 0，启动按空数据跑、保存时又把它覆盖成空壳）。
    /// 另存失败就把 `write_blocked` 立起来 —— 整轮不落盘，宁可这次改动不保存。
    pub fn load(&self) -> Result<Value, String> {
        let path = (self.file)();
        let (value, mut error, parse_failed) = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(value) => (value, None, false),
                Err(err) => (
                    Value::Null,
                    Some(format!("{} 解析失败（{}）：{err}", self.label, path.display())),
                    true,
                ),
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => (Value::Null, None, false),
            Err(err) => (
                Value::Null,
                Some(format!("{} 读取失败（{}）：{err}", self.label, path.display())),
                false,
            ),
        };

        // 解析失败的文件先挪到旁边，别让之后的空数据覆盖掉；读不出来（权限 / 被占用）时
        // 文件本身可能是好的，**不挪**，只禁止本次落盘。
        let write_blocked = if error.is_none() {
            false
        } else if parse_failed {
            if !path.is_file() {
                // 解析失败但文件已经不在了（读完之后被删）：没有可覆盖的东西
                false
            } else {
                match preserve_corrupt(&path, self.label) {
                    Ok(saved) => {
                        crate::error_log::warn(
                            self.label,
                            format!("载入失败，原文件已另存为 {}；本次按空数据启动", saved.display()),
                        );
                        // 把副本位置带进给渲染层的错误里，提示条上能直接告诉用户去哪儿找
                        if let Some(message) = error.as_mut() {
                            message.push_str(&format!("；原文件已另存为 {}", saved.display()));
                        }
                        false
                    }
                    Err(preserve_err) => {
                        crate::error_log::error(
                            self.label,
                            format!(
                                "载入失败且无法另存原文件（{preserve_err}）；本次不落盘，避免覆盖仍可能人工恢复的文件"
                            ),
                        );
                        true
                    }
                }
            }
        } else {
            // 文件读不出来但没坏：留着它，本次不写
            if let Some(err) = &error {
                crate::error_log::error(
                    self.label,
                    format!("文件读不出来，本次不落盘以免覆盖（{err}）"),
                );
            }
            true
        };

        let mut inner = self.inner.lock().expect("锁中毒");
        inner.value = value.clone();
        inner.loaded = true;
        inner.dirty = false;
        inner.load_error = error.clone();
        inner.write_blocked = write_blocked;
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

/// 载入完成、且本进程改过、且没有被"坏文件保护"挡住，才允许落盘
fn should_write(inner: &Arc<Mutex<Inner>>) -> bool {
    let inner = inner.lock().expect("锁中毒");
    inner.loaded && inner.dirty && !inner.write_blocked
}

/// 把解析失败的原文件挪到旁边：`<文件名>.corrupt-<时间>`。
///
/// 优先 `rename`（同一目录内、原子）；被占用挪不动时退回 `copy` —— 副本能留下来就够，
/// 原文件之后即使被新数据覆盖，坏内容也还在副本里。两条都失败才报 `Err`，由调用方禁止落盘。
fn preserve_corrupt(path: &std::path::Path, label: &str) -> Result<PathBuf, String> {
    let stamp = crate::panic_log::local_time_text().replace([' ', ':'], "-");
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| label.to_string());
    let saved = path.with_file_name(format!("{name}.corrupt-{stamp}"));
    match std::fs::rename(path, &saved) {
        Ok(()) => Ok(saved),
        Err(rename_err) => match std::fs::copy(path, &saved) {
            Ok(_) => Ok(saved),
            Err(copy_err) => Err(format!(
                "移动到 {} 失败（{rename_err}），复制也失败（{copy_err}）",
                saved.display()
            )),
        },
    }
}

/// 先写临时文件再 rename：rename 在同一卷上是原子的，不会留下半个 JSON。
fn write_file(path: PathBuf, label: &str, inner: &Arc<Mutex<Inner>>) {
    let value = inner.lock().expect("锁中毒").value.clone();
    let text = match serde_json::to_string_pretty(&value) {
        Ok(text) => text,
        Err(err) => {
            crate::error_log::error(label, format!("落盘失败：{err}"));
            return;
        }
    };

    // 数据目录可能还没建起来（首次启动，或用户手工删过）：不建好这一步只会静默失败
    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            crate::error_log::error(label, format!("落盘失败：{err}"));
            return;
        }
    }

    if let Err(err) = fs_util::write_atomic(&path, text.as_bytes()) {
        eprintln!("[workbench] {label}失败: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-store-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn corrupt_files(dir: &PathBuf) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .expect("读目录")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.to_string_lossy().contains(".corrupt-"))
            .collect()
    }

    /// 解析失败的文件先被另存，之后的新数据照常写回 —— 坏内容不会被空数据原地覆盖。
    #[test]
    fn 载入失败先另存坏文件再允许写回() {
        let dir = temp_dir("corrupt-save");
        let path = dir.join("workbench-data.json");
        std::fs::write(&path, "not json at all").expect("写坏文件");

        let file = path.clone();
        let store = JsonStore::new(move || file.clone(), "测试数据");
        let loaded = store.load();
        assert!(loaded.is_err(), "坏文件要如实回 Err");

        let saved = corrupt_files(&dir);
        assert_eq!(saved.len(), 1, "坏文件应被另存一份");
        assert_eq!(std::fs::read_to_string(&saved[0]).unwrap(), "not json at all");

        // 用户之后保存：新数据写到原路径，坏文件不在原地了，副本还在
        store.set(json!({ "projects": [] }));
        store.flush_sync();
        assert!(serde_json::from_str::<Value>(&std::fs::read_to_string(&path).unwrap()).is_ok());
        assert_eq!(std::fs::read_to_string(&saved[0]).unwrap(), "not json at all");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 好文件照常载入，不需要另存；写入也不是"被挡住"的状态。
    #[test]
    fn 正常文件不另存也不挡写() {
        let dir = temp_dir("good");
        let path = dir.join("workbench-data.json");
        std::fs::write(&path, r#"{"projects":[]}"#).expect("写好文件");

        let file = path.clone();
        let store = JsonStore::new(move || file.clone(), "测试数据");
        assert!(store.load().is_ok());
        assert!(corrupt_files(&dir).is_empty(), "好文件不该另存");
        assert!(!store.inner.lock().unwrap().write_blocked, "正常文件不该挡写");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文件不存在是第一次运行：不算错误，也不另存。
    #[test]
    fn 文件缺失按首次运行处理() {
        let dir = temp_dir("missing");
        let path = dir.join("workbench-data.json");

        let file = path.clone();
        let store = JsonStore::new(move || file.clone(), "测试数据");
        assert!(store.load().is_ok());
        assert!(corrupt_files(&dir).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 另存失败时整轮禁止落盘：宁可这次改动不保存，也不能盖掉还能人工恢复的原文件。
    #[test]
    fn 另存失败时禁止落盘() {
        let inner = Arc::new(Mutex::new(Inner {
            value: Value::Null,
            loaded: true,
            dirty: true,
            load_error: Some("坏".into()),
            write_blocked: true,
        }));
        assert!(!should_write(&inner), "写了也是覆盖坏文件，必须挡住");
    }
}
