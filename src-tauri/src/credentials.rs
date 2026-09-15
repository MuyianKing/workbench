//! Windows 凭据管理器读写。access_token 落在这里，不落 JSON。
//!
//! **为什么不落 `workbench-data.json`**：那是明文 JSON，还会跟着「数据目录迁移」被复制到
//! 网盘或共享盘上。凭据管理器走 DPAPI，按当前 Windows 用户加密，文件被拷走也解不开。
//!
//! 一个 provider 一条记录，目标名 `Workbench/<provider>/token`。删掉应用也不会带走它 ——
//! 用户能在「控制面板 → 凭据管理器 → Windows 凭据」里看到并手工清除。

use std::ffi::c_void;

use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

use crate::encoding::wide;

/// `ERROR_NOT_FOUND`：这条凭据不存在。读写时都不算错误，只是「还没登录过」。
const ERROR_NOT_FOUND: i32 = 1168;

fn target_name(provider: &str) -> String {
    format!("Workbench/{provider}/token")
}

/// 存 / 覆盖。凭据管理器自己会覆盖同名记录。
pub fn store(provider: &str, secret: &str) -> Result<(), String> {
    let mut target = wide(&target_name(provider));
    // 用户名只用于在凭据管理器界面里显示，走 generic 凭据时没有语义
    let mut user = wide("Workbench");
    let mut blob = secret.as_bytes().to_vec();

    let mut credential = CREDENTIALW::default();
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = target.as_mut_ptr();
    credential.UserName = user.as_mut_ptr();
    credential.CredentialBlobSize = blob.len() as u32;
    credential.CredentialBlob = blob.as_mut_ptr();
    // LOCAL_MACHINE：跟着这台机器留存，而不是只在本次登录会话里有效。
    // 凭据本身仍由 DPAPI 按用户加密，别的用户读不到。
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;

    let written = unsafe { CredWriteW(&credential, 0) };
    if written == 0 {
        return Err(format!("保存凭据失败: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

/// 读。没存过（或已被用户在凭据管理器里删掉）返回 None，不报错。
pub fn read(provider: &str) -> Option<String> {
    let target = wide(&target_name(provider));
    let mut pointer: *mut CREDENTIALW = std::ptr::null_mut();

    let found = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pointer) };
    if found == 0 || pointer.is_null() {
        return None;
    }

    let credential = unsafe { &*pointer };
    let blob = if credential.CredentialBlob.is_null() || credential.CredentialBlobSize == 0 {
        Vec::new()
    } else {
        // 凭据体是裸字节，不带 0 结尾
        unsafe {
            std::slice::from_raw_parts(credential.CredentialBlob, credential.CredentialBlobSize as usize)
        }
        .to_vec()
    };
    // CredReadW 分配的内存必须还给系统，不管后面怎么走
    unsafe { CredFree(pointer as *const c_void) };

    let text = String::from_utf8_lossy(&blob).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// 删。本来就没有也算成功 —— 登出的语义是「之后不该再有凭据」，而不是「必须删掉了一行」。
pub fn remove(provider: &str) -> Result<(), String> {
    let target = wide(&target_name(provider));
    let deleted = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
    if deleted != 0 {
        return Ok(());
    }

    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(ERROR_NOT_FOUND) {
        Ok(())
    } else {
        Err(format!("清除凭据失败: {err}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 往真凭据管理器里写一条再读回来。用固定的测试 provider 名，
    /// 不碰真实账号那两条记录（`github` / `gitee`）。
    #[test]
    fn stores_reads_and_removes_a_secret() {
        let provider = "self-test";
        let _ = remove(provider);

        assert_eq!(read(provider), None, "清干净之后不该读到东西");

        store(provider, "s3cret-值 with spaces").expect("写入凭据失败");
        assert_eq!(read(provider).as_deref(), Some("s3cret-值 with spaces"));

        // 覆盖写：同名记录应该被替换，不是变成两条
        store(provider, "second").expect("覆盖凭据失败");
        assert_eq!(read(provider).as_deref(), Some("second"));

        remove(provider).expect("删除凭据失败");
        assert_eq!(read(provider), None);

        // 重复删不报错：登出会被点第二次
        remove(provider).expect("重复删除不该失败");
    }

    /// 目标名要带上前缀，免得和别的应用撞名字
    #[test]
    fn target_name_is_namespaced() {
        assert_eq!(target_name("github"), "Workbench/github/token");
    }
}
