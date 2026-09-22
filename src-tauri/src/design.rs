//! 设计规范（DESIGN.md）的落盘。
//!
//! 内容是渲染层按一套设计的 token 现生成的 markdown（见 shared/design-export.ts），
//! 这一侧只做一件事：把它写到目标项目的根目录。生成什么、给谁看属于业务语义，留在 TS；
//! 磁盘操作留在 Rust —— 与笔记、技能那些模块同一条分工。
//!
//! 落点是固定的 `<项目根>/DESIGN.md`，没有相对路径要解析，所以不需要 notes.rs 那套越界校验。

use std::path::Path;

/// 落在项目根下的文件名
pub const FILE_NAME: &str = "DESIGN.md";

/// 写完之后的回执：落在哪、原本是否已经有这个文件（渲染层据此换提示文案）
#[derive(serde::Serialize)]
pub struct WriteOutcome {
    pub path: String,
    pub existed: bool,
}

/// 把一份设计规范写到项目根目录；同名文件会被覆盖（回执里说明原本就有）
pub fn write(project_dir: &str, content: &str) -> Result<WriteOutcome, String> {
    let dir = project_dir.trim();
    if dir.is_empty() {
        return Err("没有指定要应用到哪个项目".into());
    }
    let root = Path::new(dir);
    if !root.is_dir() {
        return Err(format!("找不到目标项目：{dir}"));
    }

    let target = root.join(FILE_NAME);
    let existed = target.exists();

    // 先写同目录的临时文件再改名：与 notes.rs 同一条口径，
    // 中途失败（断电、盘满）不会在项目里留下半篇规范
    let temp = target.with_file_name(format!("{FILE_NAME}.tmp"));
    std::fs::write(&temp, content).map_err(|err| format!("写入失败：{err}"))?;
    std::fs::rename(&temp, &target).map_err(|err| {
        let _ = std::fs::remove_file(&temp);
        format!("写入失败：{err}")
    })?;

    Ok(WriteOutcome {
        path: target.to_string_lossy().into_owned(),
        existed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-design-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_the_file_and_says_it_was_new() {
        let root = temp_root("new");
        let outcome = write(root.to_str().unwrap(), "# 示例\n").unwrap();

        assert!(!outcome.existed);
        assert!(outcome.path.ends_with("DESIGN.md"));
        assert_eq!(
            std::fs::read_to_string(root.join("DESIGN.md")).unwrap(),
            "# 示例\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn overwrites_and_says_it_existed() {
        let root = temp_root("overwrite");
        let dir = root.to_str().unwrap();

        assert!(!write(dir, "第一版").unwrap().existed);
        let again = write(dir, "第二版").unwrap();
        assert!(again.existed);
        assert_eq!(
            std::fs::read_to_string(root.join("DESIGN.md")).unwrap(),
            "第二版"
        );
        // 临时文件不留残渣
        assert!(!root.join("DESIGN.md.tmp").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn keeps_long_chinese_content_intact() {
        let root = temp_root("unicode");
        let content = format!("# 设计规范\n\n{}\n", "颜色与字体、行高与圆角。".repeat(400));

        write(root.to_str().unwrap(), &content).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("DESIGN.md")).unwrap(),
            content
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_blank_or_missing_target() {
        assert!(write("   ", "x").is_err());

        let missing = std::env::temp_dir().join("wb-design-not-there");
        assert!(write(missing.to_str().unwrap(), "x").is_err());
    }

    /// 目标是一个文件而不是目录时也要拦住（用户可能传了项目里某个文件的路径）
    #[test]
    fn rejects_a_file_as_target() {
        let root = temp_root("file-target");
        let file = root.join("package.json");
        std::fs::write(&file, "{}").unwrap();

        assert!(write(file.to_str().unwrap(), "x").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
