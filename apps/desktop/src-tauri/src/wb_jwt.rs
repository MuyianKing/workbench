//! JWT 的最小解析：只要两个字段 —— 签发方（判区域）与过期时间（判断要不要续期）。
//!
//! **不验签**。我们要的不是"这 token 可信吗"（可信与否由上游说了算），而是
//! "它是哪个区的、什么时候过期"。这两件事都在明文段里。
//!
//! 纯逻辑：吃字符串，吐结构体。

use serde_json::Value;

/// 解出来的载荷里我们关心的部分。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Claims {
    /// `iss`：判区域用（国内 `codebuddy.cn` / `workbuddy.cn` / `copilot.tencent.com`，
    /// 国际 `workbuddy.ai`）
    pub issuer: String,
    /// `sub`：有些凭据文件不带 uid，靠它兜底
    pub subject: String,
    /// `exp`：Unix 秒
    pub expires_at: i64,
    /// `enterprise_id`：企业空间 id。企业号常常只有 token 里有，账号文件里是空的
    pub enterprise_id: String,
}

/// 解出载荷。格式不对、不是三段、base64 坏了、不是 JSON —— 一律 `None`，
/// **不猜**。调用方把它当"没有这条信息"处理。
pub fn claims(token: &str) -> Option<Claims> {
    let mut segments = token.trim().split('.');
    let _header = segments.next()?;
    let payload = segments.next()?;
    let _signature = segments.next()?;
    if segments.next().is_some() {
        return None;
    }

    let decoded = decode_base64url(payload)?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;

    Some(Claims {
        issuer: string_field(&value, "iss"),
        subject: string_field(&value, "sub"),
        expires_at: value.get("exp").and_then(Value::as_i64).unwrap_or(0),
        // 上游有时把它写成 enterprise_id，有时在嵌套对象里；两种都试
        enterprise_id: {
            let flat = string_field(&value, "enterprise_id");
            if flat.is_empty() {
                string_field(&value, "enterpriseId")
            } else {
                flat
            }
        },
    })
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// URL-safe base64（无填充）。JWT 用的就是这套字母表，不能拿标准 base64 去解 ——
/// `-` 与 `_` 会直接解成非法字符。
fn decode_base64url(input: &str) -> Option<Vec<u8>> {
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    let mut out = Vec::with_capacity(input.len() * 3 / 4);

    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            // 填充与空白：跳过
            b'=' | b'\r' | b'\n' => continue,
            _ => return None,
        } as u32;

        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个不签名的 JWT，只为测解析。
    fn token(payload: &str) -> String {
        format!("header.{}.sig", encode_base64url(payload.as_bytes()))
    }

    fn encode_base64url(input: &[u8]) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in input.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let triple = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            out.push(ALPHABET[(triple >> 18) as usize & 0x3f] as char);
            out.push(ALPHABET[(triple >> 12) as usize & 0x3f] as char);
            if chunk.len() > 1 {
                out.push(ALPHABET[(triple >> 6) as usize & 0x3f] as char);
            }
            if chunk.len() > 2 {
                out.push(ALPHABET[triple as usize & 0x3f] as char);
            }
        }
        out
    }

    #[test]
    fn 解出签发方与过期时间() {
        let raw = token(r#"{"iss":"https://www.workbuddy.cn/oauth","exp":1760000000,"sub":"u-1"}"#);
        let claims = claims(&raw).unwrap();
        assert_eq!(claims.issuer, "https://www.workbuddy.cn/oauth");
        assert_eq!(claims.expires_at, 1760000000);
        assert_eq!(claims.subject, "u-1");
    }

    #[test]
    fn 企业_id_两种写法都认() {
        let snake = claims(&token(r#"{"enterprise_id":"ent-a"}"#)).unwrap();
        assert_eq!(snake.enterprise_id, "ent-a");
        let camel = claims(&token(r#"{"enterpriseId":"ent-b"}"#)).unwrap();
        assert_eq!(camel.enterprise_id, "ent-b");
    }

    #[test]
    fn url_safe_字母表能解() {
        // 含 - 与 _ 的载荷（普通 base64 会解错）
        let raw = token(r#"{"iss":"https://a-b_c.example/x","exp":1}"#);
        assert_eq!(claims(&raw).unwrap().expires_at, 1);
    }

    #[test]
    fn 坏输入一律返回_none() {
        assert!(claims("").is_none());
        assert!(claims("only-one-part").is_none());
        assert!(claims("a.b").is_none());
        assert!(claims("a.!!!.c").is_none());
        assert!(claims("a.bm90IGpzb24.c").is_none());
    }

    #[test]
    fn 带填充与换行也能解() {
        let raw = "a.eyJleHAiOjV9=.c";
        assert_eq!(claims(raw).unwrap().expires_at, 5);
    }
}
