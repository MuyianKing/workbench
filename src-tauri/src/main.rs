//! 迁移中的占位入口：先把依赖图编译热，正式实现见后续提交。

fn main() {
    let _ = rusqlite::version();
    let _ = zstd::zstd_version();
    let _ = uuid::Uuid::new_v4();
    println!("workbench tauri spike");
}
