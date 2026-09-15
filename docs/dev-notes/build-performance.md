# 构建与打包性能

「改一行 Rust → 拿到安装包」这条链上的时间几乎全在 Rust 的 release 编译，前端不是瓶颈
（`vite build` 实测 1.2s 上下；换成 vite 8 / rolldown 之前是 6～17s，取决于系统缓存暖不暖）。
本文记录能把它压到多快、怎么量、以及量的时候容易掉进去的坑。

## 现状与改法

| release 档位 | 边际重建（只改一行 Rust） | 产物体积 |
|---|---|---|
| 改前：`lto = true` + `codegen-units = 1` + MSVC `link.exe` | 3m03s | 5,729,280 B |
| 改后：`lto = "thin"` + `codegen-units = 16` + `rust-lld` | **49.9s** | 6,325,760 B（+10.4%） |

两处改动：

- `src-tauri/Cargo.toml` 的 `[profile.release]`：`lto` 由 `true`（fat）改为 `"thin"`，
  `codegen-units` 由 1 改为 16。fat LTO 会把所有 crate 的 IR 汇进单个 codegen 单元，
  由单个 LLVM 线程做完优化与代码生成，而这一步**改任何一行 Rust 都要整份重付**；
  thin LTO 允许 16 个单元并行，代价是体积涨约一成。
- 仓库根新增 `.cargo/config.toml`，链接器换成工具链自带的 `rust-lld`。

`strip = true` / `panic = "abort"` / `opt-level = "s"` 保持不动 —— 体积的大头在它们身上，
拿它们换编译速度不划算。

改档位或换链接器都会让整个 `target/` 缓存失效，下一次构建必然全量重来：实测全量重建 3m21s
（283 个编译单元）。这是一次性成本，不是配置写错了。

## 完整打包链路

`npm run dist`（即 `tauri build`）依次做三件事：跑 `beforeBuildCommand` 编前端、编 Rust、
用 makensis 出安装包。实测两次连续打包：

| | 首次（`target/` 里还没有 `custom-protocol` 变体） | 第二次 |
|---|---|---|
| 前端 `vite build` | 1.2s | 1.2s |
| Rust | 1m27s（含 tauri 栈重编） | 42.9s（只重编 `workbench`） |
| NSIS 工具链下载 + makensis | 含下载 | 已缓存 |
| **合计** | **1m50s** | **1m02s** |

前端那一行是换到 vite 8（打包器换成 rolldown）之后重量的，vite 7 时是 6.19s。
Rust 两行与前端用什么打包器无关；**合计两行仍是 vite 7 那次的原值**，
按新的前端耗时各减去约 5s 才是现在的链路总耗时。

安装包 11,012,639 B，落在 `src-tauri/target/release/bundle/nsis/`。

几点必须知道：

- **每次 `tauri build` 都会重编 `workbench` 这个最终 crate**，即使一行源码都没改。
  原因是 `beforeBuildCommand` 重写了 `out/renderer`，而前端产物是在编译期内嵌进二进制的，
  `tauri-build` 盯着它。所以 release 档位的 LTO 设置**对每一次打包都直接生效** ——
  这也是为什么 fat LTO 改成 thin LTO 的收益在打包链路上是全额兑现的。
- `tauri build` 实际执行的是
  `cargo build --bins --features tauri/custom-protocol --release`
  （`tauri build -v` 可看到），比手敲 `cargo build --release` 多一个 `custom-protocol` feature。
  两者在 `target/` 里是**两个独立的编译变体、各自缓存**：只在首次切到 `tauri build` 时
  多编一遍 tauri 及其依赖（约 +48s），之后来回切不再重复付。
- NSIS 工具链只下载一次，缓存在 `%LOCALAPPDATA%\tauri\NSIS`
  （`nsis-3.11.zip` 与 `nsis_tauri_utils-v0.5.3.dll`）。首次打包要联网。

## 怎么量

要量的是**边际重建**，不是全量构建。日常「改代码 → 打包」时依赖早就缓存在 `target/` 里，
只有最终 crate 会被重编，这一段的耗时才是每次都要付的那一份。

```bash
touch src-tauri/src/main.rs      # 只动 mtime，不改内容
time cargo build --release --manifest-path src-tauri/Cargo.toml
```

cargo 按 mtime 判定新鲜度，所以 `touch` 既触发了重编，又没往仓库里塞任何语义变化。
对比前后必须用同一条命令、同一个 `touch` 目标，否则量到的不是同一件事。
（注意上面这条命令量的是 `cargo build` 那个变体；要量打包链路上的那个变体，
把命令换成 `npm run dist:dir`。）

## 坑

### 打包时不要在同一个仓库里跑 `tauri dev`

两个 cargo 对同一个 `target/` 目录会互相等文件锁，dev 的 watcher 还会因为同一批改动反复重编，
两边都变慢。更隐蔽的是**测量会被污染**：同一个操作在有人并行编译时先后量到 2m23s 与 3m47s，
而干净环境下是 3m03s —— 差 40% 以上，足以让人对优化效果得出完全错误的结论。

量之前先确认没有别的 cargo / rustc 在跑：

```bash
powershell -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \"Name='cargo.exe' or Name='rustc.exe'\").Count"
```

`AGENTS.md` 里「改 Rust 前先关掉正在运行的应用」原本只讲了 exe 被占用（os error 5），
并行编译本身也是打包变慢的一大来源。

### `.cargo/config.toml` 必须放仓库根，不能放 `src-tauri/`

cargo 只从**当前工作目录及其父目录**找 `.cargo/config.toml`，与 `--manifest-path` 无关。
`tauri build` 与手敲 `cargo` 的 cwd 都是仓库根，所以配置得放仓库根；放 `src-tauri/.cargo/`
下则从仓库根敲命令读不到，而若某条链路恰好以 `src-tauri` 为 cwd 又能读到，
表现为「dev 生效、打包不生效」这种更难查的样子。

验证配置有没有被读到不必真跑一遍构建，用 `cargo metadata` 看 `target_directory` 就够
（临时往配置里加一行 `[build] target-dir = "target-cfgtest"`，看完删掉）：

```bash
cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 | tr ',' '\n' | grep target_directory
```

### `rust-lld` 不在 PATH 上，裸名字却能解析

`rustc` 在 PATH 上找不到同名程序时会回退到 sysroot 的 `lib/rustlib/<target>/bin/`，
所以配置里写裸名 `rust-lld.exe` 在任何装了 rustup 的机器上都成立，不必写死绝对路径。

想确认它真在用 lld 而不是悄悄退回 `link.exe`，用一个不存在的名字做对照：
`rustc -C linker=definitely-not-a-linker.exe t.rs` 会报 `linker not found`，
说明该字段是被认真解析的。产物体积也会变：同一个 hello world，rust-lld 出 133,632 B，
link.exe 出 134,656 B。

### `tauri build` 没有 `--profile`

想把「日常构建」和「正式安装包」分成两个档位（日常 thin LTO、出包才 fat LTO）是行不通的：
`tauri build` 不接受 `--profile`，`tauri bundle` 也只认 `target/release/` 或 `target/debug/`
两个固定路径，自定义 profile 的产物它找不到。所以只有一个 `[profile.release]`，只能折中。

## 没有单独拆开归因

上面的 49.9s 是「thin LTO + 16 单元」与「rust-lld」两处一起改的结果，没有分别单独量过 ——
拆开每验证一次都要付一次全量重建（约 3.5 分钟）再加一次边际重建。从机制上看主因是前者：
fat LTO 的单线程 codegen 占了原来那 3 分钟里的绝大部分。
