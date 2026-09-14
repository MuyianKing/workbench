//! 编码小工具。放在这里而不是塞进某个业务模块，是为了让调用方不必互相依赖。

/// 标准 base64 编码。只为 data URL 服务，不引第三方 crate。
pub fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);

    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;

        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// base64 解码。生产侧只编码不回读，这里纯粹给测试用（要验证抽出来的 PNG 真能解码）。
#[cfg(test)]
pub fn base64_decode(input: &str) -> Option<Vec<u8>> {
    const TABLE: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0;

    for ch in input.chars().filter(|ch| *ch != '=') {
        let value = TABLE.find(ch)? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
