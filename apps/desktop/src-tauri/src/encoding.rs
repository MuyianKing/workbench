//! 编码 / 摘要小工具。放在这里而不是塞进某个业务模块，是为了让调用方不必互相依赖。
//!
//! 实现全部交给已经在编译图里的 crate（`base64` / `sha2`）—— 手写 SHA-256 那样一段
//! 逐轮的位运算既占地方，也正是「自己实现密码学」这种不该做的事；标准向量测试留着，
//! 换实现时它们就是等价性的证明。

use base64::Engine;
use sha2::{Digest, Sha256};

/// UTF-8 字符串 → 以 0 结尾的 UTF-16 数组，即 Win32 到处要的 `LPCWSTR`。
///
/// 几乎所有 Win32 字符串参数都得走这一道（oauth.rs 的 HTTP 与 credentials.rs 的凭据都用到）。
pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 标准 base64 编码。只为 data URL 与 git 的 Basic 头服务。
pub fn base64(input: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(input)
}

/// base64url（RFC 4648 §5）：`+` `/` 换成 `-` `_`，**去掉尾部填充**。
/// PKCE 的 `code_challenge` 要求这个形式。
pub fn base64_url(input: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(input)
}

/// SHA-256。目前只有 PKCE 的 `code_challenge` 用它一处（见 oauth.rs）。
pub fn sha256(input: &[u8]) -> [u8; 32] {
    Sha256::digest(input).into()
}

/// base64 解码。`note_image_upload` 用它把渲染层递过来的整张图还原成字节
/// （IPC 只走 JSON，二进制要编一手）；icon.rs 的测试也用它验证抽出来的 PNG 真能解码。
///
/// 解不开一律返回 None，由调用方给一句人话 —— 这里是唯一的调用对手方是渲染层，
/// 拿不到字节就是这次调用本身不对，不该 panic。
pub fn base64_decode(input: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(input).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 字节 → 小写十六进制。测试与调试用，生产侧没有调用点。
    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn encodes_base64_with_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // 非 ASCII 走的是字节，不是字符
        assert_eq!(base64("中".as_bytes()), "5Lit");
    }

    #[test]
    fn decodes_what_it_encodes() {
        for sample in [&b""[..], b"f", b"fo", b"foo", b"foobar"] {
            let encoded = base64(sample);
            assert_eq!(base64_decode(&encoded).as_deref(), Some(sample));
        }
    }

    /// Win32 的宽字符串必须是 0 结尾，且非 ASCII 要真的按 UTF-16 编出来
    #[test]
    fn wide_terminates_and_encodes_utf16() {
        assert_eq!(wide(""), vec![0]);
        assert_eq!(wide("ab"), vec![0x61, 0x62, 0]);
        assert_eq!(wide("中"), vec![0x4e2d, 0]);
        // 超出 BMP 的字符是代理对：两个 u16 才是一个字符
        assert_eq!(wide("😀"), vec![0xd83d, 0xde00, 0]);
    }

    /// FIPS 180-4 的标准向量。第三条 56 字节，补齐后跨两个分块，
    /// 正好覆盖「消息长度超过一个块」那条路径。
    #[test]
    fn sha256_matches_published_vectors() {
        assert_eq!(
            hex(&sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex(&sha256(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        // 一百万个 'a'：长消息、多分块
        assert_eq!(
            hex(&sha256(&vec![b'a'; 1_000_000])),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    /// PKCE 要的是无填充的 base64url，不是标准 base64
    #[test]
    fn base64_url_strips_padding_and_swaps_the_special_chars() {
        assert_eq!(base64_url(b"a"), "YQ");
        assert_eq!(base64_url(b"ab"), "YWI");
        assert_eq!(base64_url(b"abc"), "YWJj");
        // 标准 base64 里的 `+` 与 `/` 换成 `-` 与 `_`
        assert_eq!(base64(b"\xfb\xef\xff"), "++//");
        assert_eq!(base64_url(b"\xfb\xef\xff"), "--__");
    }
}
