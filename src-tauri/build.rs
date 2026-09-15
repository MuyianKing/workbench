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
    let source = if local.is_file() { local.clone() } else { example };

    // 两个路径都盯着：新增 / 删除 oauth.local.json 也要触发重跑，
    // 否则改了凭据却不重新注入，表现是「改了没生效」。
    println!("cargo:rerun-if-changed={}", local.display());
    println!("cargo:rerun-if-changed={}", source.display());

    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR 未设置"))
        .join("oauth.json");
    std::fs::copy(&source, &out)
        .unwrap_or_else(|err| panic!("复制 {} 失败: {err}", source.display()));
}
