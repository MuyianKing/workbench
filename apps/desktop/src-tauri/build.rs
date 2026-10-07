fn main() {
    inject_oauth_credentials();
    tauri_build::build()
}

/// 把 OAuth 应用凭据送进编译产物（见 oauth.rs）。
///
/// 来源二选一：`oauth.local.json`（开发者本地，**不入库**）优先，没有就退回
/// `oauth.example.json`（入库的模板，值全是空的）。
///
/// **为什么绕一圈写进 OUT_DIR，而不是直接 `include_str!("../oauth.local.json")`**：
/// 后者在文件不存在时是编译错误，而「刚 clone 下来、还没注册 OAuth 应用」必须仍然能编译 ——
/// 那种构建里登录按钮显示「未内置凭据」即可，不该连编都编不过。
fn inject_oauth_credentials() {
    let dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR 未设置"),
    );
    let local = dir.join("oauth.local.json");
    let example = dir.join("oauth.example.json");

    // 只盯存在的那个文件：cargo 对「被盯但不存在的路径」每次构建都判脏（cargo 1.98 实测），
    // build script 一脏，整个 bin 就跟着重编重链 —— 表现是 pnpm dev 零改动也要全量构建。
    // 删除 local 会触发（被盯的文件没了算变更）；唯一不触发的是凭空新建——
    // 第一次建 oauth.local.json 后随手保存一个 Rust 文件再构建即可。
    println!("cargo:rerun-if-changed={}", example.display());
    if local.is_file() {
        println!("cargo:rerun-if-changed={}", local.display());
    }

    let source = if local.is_file() { local.clone() } else { example };

    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR 未设置"))
        .join("oauth.json");
    std::fs::copy(&source, &out)
        .unwrap_or_else(|err| panic!("复制 {} 失败: {err}", source.display()));
}
