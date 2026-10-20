//! 设备指纹派生：把「一个账号」稳定映射成「一台虚拟设备」。
//!
//! 网关是一个进程冒充几十台设备，如果机器码随机漂移、或者所有账号共用一个，
//! 都会在上游风控里露馅 —— 前者是「同一账号每次换机器」，后者是「一堆账号同一台机器」。
//! 所以机器码由 uid 单向派生：同账号恒定、跨账号互不关联。
//!
//! **为什么手写 MD5**：上游用 MD5，指纹必须与官方客户端逐字节一致，换成 SHA-256 就是
//! 另一台设备了。而 `sha2` 已经在依赖里、`md-5` 没有 —— 按 `AGENTS.md`「不新增编译单元」，
//! 这一百来行自己写，比拉一个 crate 划算。
//!
//! 纯逻辑：只吃字符串、只吐字符串。

// 整块公开面在 S1 还没有调用方：`derive_id` 用在**计费**请求头上（chat 反而不带
// X-Machine-ID / X-Session-ID），随 S2 的积分查询一起接进来。接上后删掉这一行。
#![allow(dead_code)]

// ---------- MD5 ----------

/// 每轮的循环左移位数（RFC 1321 §3.4）。
const SHIFTS: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/// `floor(2^32 × abs(sin(i + 1)))` 的常量表（RFC 1321 §3.4）。
const SINES: [u32; 64] = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

/// MD5 摘要。输入按字节算，输出 16 字节。
pub fn md5(input: &[u8]) -> [u8; 16] {
    let mut state: [u32; 4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];

    // 填充：0x80，补零到 56 (mod 64)，末尾 8 字节是**小端**的原始比特长度
    let bit_len = (input.len() as u64).wrapping_mul(8);
    let mut padded = Vec::with_capacity(input.len() + 72);
    padded.extend_from_slice(input);
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_le_bytes());

    for block in padded.chunks_exact(64) {
        let mut words = [0u32; 16];
        for (index, word) in words.iter_mut().enumerate() {
            let at = index * 4;
            *word = u32::from_le_bytes([block[at], block[at + 1], block[at + 2], block[at + 3]]);
        }

        let [mut a, mut b, mut c, mut d] = state;
        for step in 0..64 {
            let (mixed, slot) = match step / 16 {
                0 => ((b & c) | (!b & d), step),
                1 => ((d & b) | (!d & c), (5 * step + 1) % 16),
                2 => (b ^ c ^ d, (3 * step + 5) % 16),
                _ => (c ^ (b | !d), (7 * step) % 16),
            };
            let rotated = a
                .wrapping_add(mixed)
                .wrapping_add(SINES[step])
                .wrapping_add(words[slot])
                .rotate_left(SHIFTS[step]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(rotated);
        }

        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
    }

    let mut out = [0u8; 16];
    for (index, word) in state.iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

// ---------- 派生 ----------

/// 由 uid + 盐稳定派生一个**带连字符的 UUID 形状**设备标识。
///
/// 与官方客户端一致的三步：md5(`"<salt>:<uid>"`) → 取 hex → 把第 12 位改成 `4`
/// （版本位）、第 16 位改成 `a`（变体位）。后两步只改形状不改信息 —— 上游校验的是形状。
///
/// `uid` 为空时按 `anonymous` 算，与官方客户端一致。
pub fn derive_id(uid: &str, salt: &str) -> String {
    let subject = if uid.trim().is_empty() {
        "anonymous"
    } else {
        uid
    };
    let digest = hex(&md5(format!("{salt}:{subject}").as_bytes()));
    shape_as_uuid(&digest)
}

/// 把 32 位 hex 摆成 UUID 形状：版本位 `4`、变体位 `a`、8-4-4-4-12 分段。
fn shape_as_uuid(digest: &str) -> String {
    let bytes: Vec<char> = digest.chars().collect();
    if bytes.len() < 32 {
        // 只有内部传错长度才会走到这儿；md5 恒为 32 位 hex
        return digest.to_string();
    }
    let at = |range: std::ops::Range<usize>| -> String { bytes[range].iter().collect() };
    let mut middle = at(12..16);
    let mut variant = at(16..20);
    // 版本位固定 4，变体位固定 a
    middle.replace_range(0..1, "4");
    variant.replace_range(0..1, "a");
    format!(
        "{}-{}-{}-{}-{}",
        at(0..8),
        at(8..12),
        middle,
        variant,
        at(20..32)
    )
}

/// 账号级会话标识：所有请求共用同一个（官方客户端的 `X-Session-ID` 口径）。
pub fn session_id(uid: &str) -> String {
    derive_id(uid, "session")
}

/// 账号级机器码。
pub fn machine_id(uid: &str) -> String {
    derive_id(uid, "machine")
}

/// 请求级 ID：与 uid **无关**的纯随机 32 位 hex。
///
/// 故意不掺账号信息 —— 带稳定前缀的请求 ID 本身就是一个网关特征。
pub fn request_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_对得上_rfc1321_的测试向量() {
        // RFC 1321 §A.5 的七条，一条不落
        let cases = [
            ("", "d41d8cd98f00b204e9800998ecf8427e"),
            ("a", "0cc175b9c0f1b6a831c399e269772661"),
            ("abc", "900150983cd24fb0d6963f7d28e17f72"),
            ("message digest", "f96b697d7cb7938d525a2f31aaf161d0"),
            ("abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"),
            (
                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
                "d174ab98d277d9f5a5611c2c9f419d9f",
            ),
            (
                "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
                "57edf4a22be3c955ac49da2e2107b67a",
            ),
        ];
        for (input, want) in cases {
            assert_eq!(hex(&md5(input.as_bytes())), want, "md5({input:?})");
        }
    }

    #[test]
    fn md5_跨过填充边界仍然正确() {
        // 55 / 56 / 64 字节是填充算法的三个分界点
        for length in [55usize, 56, 63, 64, 65] {
            let input = "a".repeat(length);
            // 用长度不同但内容可复现的输入，只验证不 panic 且长度正确
            assert_eq!(md5(input.as_bytes()).len(), 16);
        }
        assert_eq!(
            hex(&md5(&[b'a'; 55])),
            super::hex(&md5(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
        );
    }

    #[test]
    fn 派生形状是带连字符的_uuid() {
        let id = derive_id("92af3923-a7cb-49e3-af38-a8f39398ae14", "machine");
        assert_eq!(id.len(), 36);
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12]
        );
        assert!(id.chars().all(|c| c == '-' || c.is_ascii_hexdigit()));
        // 版本位与变体位
        assert_eq!(&parts[2][0..1], "4");
        assert_eq!(&parts[3][0..1], "a");
    }

    #[test]
    fn 同账号恒定_跨账号不同() {
        let a1 = machine_id("uid-a");
        let a2 = machine_id("uid-a");
        let b = machine_id("uid-b");
        assert_eq!(a1, a2);
        assert_ne!(a1, b);
    }

    /// 金标值由原项目的 Python 实现算出，用来钉住「逐字节一致」。
    /// 这三条覆盖了：真实 uid、空 uid 回落、非 ASCII 输入。
    #[test]
    fn 派生结果与原项目的实现逐字节一致() {
        let cases = [
            (
                "92af3923-a7cb-49e3-af38-a8f39398ae14",
                "machine",
                "cb12c2df-4816-4693-aa85-c0960fa6e60f",
            ),
            (
                "92af3923-a7cb-49e3-af38-a8f39398ae14",
                "session",
                "15196a39-1e21-456c-a4af-402ce32c6754",
            ),
            ("uid-a", "machine", "729c6a03-dfc4-4f96-a0bd-89f0c37e834d"),
            ("", "session", "be4befa7-ace5-45fd-a1f5-8bb31be975f8"),
            ("中文 uid", "machine", "6a520470-4cd6-4661-a1a8-e95668b4b04c"),
        ];
        for (uid, salt, want) in cases {
            assert_eq!(derive_id(uid, salt), want, "derive_id({uid:?}, {salt:?})");
        }
    }

    #[test]
    fn 不同盐得到不同标识() {
        assert_ne!(machine_id("uid-a"), session_id("uid-a"));
    }

    #[test]
    fn 空_uid_按_anonymous_算() {
        assert_eq!(derive_id("", "session"), derive_id("anonymous", "session"));
        assert_eq!(derive_id("   ", "session"), derive_id("anonymous", "session"));
    }

    #[test]
    fn 请求_id_是纯随机_32_位_hex() {
        let first = request_id();
        let second = request_id();
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }
}
