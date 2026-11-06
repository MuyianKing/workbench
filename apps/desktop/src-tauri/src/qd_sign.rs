//! Qoder 的 COSY 推理签名与请求体编码。
//!
//! 逆向自官方客户端（与 `qoder2api-hub` 的 `qoder_sign.py` 逐字节对齐），四段：
//!
//! 1. **自定义 Base64**：先标准编码，再把结果按 `n/3` 切成「尾 / 中 / 首」三段轮转，
//!    逐字符映射到 Qoder 字母表，`=` 写成 `$`。
//! 2. **AES-128-CBC**（key == iv，PKCS#7）：把身份 JSON 装进 `info`。AES 是手写的，
//!    与 MD5 同一条理由 —— 依赖里没有、也不值得为几十 KB 数据拉整套密码学栈。
//! 3. **RSA-1024 PKCS#1 v1.5**：官方客户端硬编码的公钥，只做公钥加密（指数 65537）。
//!    大数运算用 16 个 u64 limb 的 Montgomery 模幂，够用且没有额外依赖。
//! 4. **COSY Bearer**：`md5(payload\ncosyKey\ndate\nbody\npath)`，path 去掉 `/algo` 前缀。
//!
//! 全部是纯函数 + 一个按账号的会话缓存；不碰网络、不碰文件。
//! 已知强度：会话密钥只有 16 个十六进制字符（64 bit 熵）、RSA 只有 1024 位 ——
//! 这是**服务端协议决定**的，不能单方面改，否则服务端解不开。

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use sha2::{Digest, Sha512};

use crate::qd_upstream;

// ---------- 自定义 Base64 ----------

const QODER_ALPHABET: &[u8; 64] = b"_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QODER_PAD: u8 = b'$';

/// 标准 Base64 → Qoder 变体（三段轮转 + 字母表映射）。
pub fn qoder_encode(plain: &[u8]) -> String {
    let std = base64::engine::general_purpose::STANDARD.encode(plain);
    let bytes = std.as_bytes();
    let n = bytes.len();
    let a = n / 3;
    let mut out = String::with_capacity(n);
    // 尾段 n-a..n、中段 a..n-a、首段 0..a
    for &ch in bytes[n - a..].iter().chain(&bytes[a..n - a]).chain(&bytes[..a]) {
        out.push(match ch {
            b'=' => QODER_PAD as char,
            other => {
                let at = STD_ALPHABET.iter().position(|x| *x == other).unwrap_or(0);
                QODER_ALPHABET[at] as char
            }
        });
    }
    out
}

/// Qoder 变体 → 标准 Base64（[`qoder_encode`] 的逆；只给测试与排障用）。
#[cfg_attr(not(test), allow(dead_code))]
pub fn qoder_decode(encoded: &str) -> Result<Vec<u8>, String> {
    let bytes = encoded.as_bytes();
    let n = bytes.len();
    if n % 4 != 0 {
        return Err(format!("Qoder Base64 长度不是 4 的倍数：{n}"));
    }
    let a = n / 3;
    let mut std = Vec::with_capacity(n);
    // 轮转的逆：尾段（原 std 的末尾）→ 首段，再中段，最后首段（原 std 的开头）
    let restored = bytes[n - a..]
        .iter()
        .chain(&bytes[a..n - a])
        .chain(&bytes[..a]);
    for &ch in restored {
        std.push(match ch {
            QODER_PAD => b'=',
            other => {
                let at = QODER_ALPHABET.iter().position(|x| *x == other)
                    .ok_or_else(|| format!("Qoder Base64 出现字母表外的字节：{other}"))?;
                STD_ALPHABET[at]
            }
        });
    }
    let text = std::str::from_utf8(&std).map_err(|err| format!("Base64 不是 UTF-8：{err}"))?;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|err| format!("Base64 解码失败：{err}"))
}

// ---------- AES-128-CBC ----------

const SBOX: [u8; 256] = [
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
];

const RCON: [u8; 10] = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

fn xtime(value: u8) -> u8 {
    (value << 1) ^ if value & 0x80 != 0 { 0x1b } else { 0 }
}

/// 密钥扩展：16 字节 → 11 组轮密钥（176 字节）。
fn expand_key(key: &[u8; 16]) -> [u8; 176] {
    let mut w = [0u8; 176];
    w[..16].copy_from_slice(key);
    for round in 1..11 {
        let at = round * 16;
        let mut temp = [
            w[at - 4],
            w[at - 3],
            w[at - 2],
            w[at - 1],
        ];
        // RotWord → SubWord → Rcon
        temp.rotate_left(1);
        for byte in temp.iter_mut() {
            *byte = SBOX[*byte as usize];
        }
        temp[0] ^= RCON[round - 1];
        for i in 0..4 {
            w[at + i] = w[at - 16 + i] ^ temp[i];
        }
        for i in 4..16 {
            w[at + i] = w[at - 16 + i] ^ w[at + i - 4];
        }
    }
    w
}

fn encrypt_block(schedule: &[u8; 176], block: &mut [u8; 16]) {
    for i in 0..16 {
        block[i] ^= schedule[i];
    }
    for round in 1..11 {
        for byte in block.iter_mut() {
            *byte = SBOX[*byte as usize];
        }
        // ShiftRows：第 r 行左移 r 格（列优先布局）
        let original = *block;
        for r in 1..4 {
            for c in 0..4 {
                block[r + 4 * c] = original[r + 4 * ((c + r) % 4)];
            }
        }
        if round != 10 {
            for c in 0..4 {
                let a0 = block[4 * c];
                let a1 = block[4 * c + 1];
                let a2 = block[4 * c + 2];
                let a3 = block[4 * c + 3];
                let all = a0 ^ a1 ^ a2 ^ a3;
                block[4 * c] = a0 ^ all ^ xtime(a0 ^ a1);
                block[4 * c + 1] = a1 ^ all ^ xtime(a1 ^ a2);
                block[4 * c + 2] = a2 ^ all ^ xtime(a2 ^ a3);
                block[4 * c + 3] = a3 ^ all ^ xtime(a3 ^ a0);
            }
        }
        for i in 0..16 {
            block[i] ^= schedule[round * 16 + i];
        }
    }
}

/// AES-128-CBC，key 同时当 IV（Qoder 的 `info` 口径），PKCS#7 填充。
pub fn aes_cbc_encrypt(plain: &[u8], key: &[u8; 16]) -> Vec<u8> {
    let schedule = expand_key(key);
    let mut out = Vec::with_capacity((plain.len() / 16 + 1) * 16);
    let mut prev = *key;
    let pad = 16 - (plain.len() % 16);
    let mut padded = plain.to_vec();
    padded.extend(std::iter::repeat(pad as u8).take(pad));
    for chunk in padded.chunks_exact(16) {
        let mut block = [0u8; 16];
        for i in 0..16 {
            block[i] = chunk[i] ^ prev[i];
        }
        encrypt_block(&schedule, &mut block);
        out.extend_from_slice(&block);
        prev = block;
    }
    out
}

// ---------- RSA-1024（只做公钥加密） ----------

/// 官方客户端硬编码的公钥模数（1024 位，n；e = 65537）。
const RSA_N_HEX: &str = "c0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4a76e499bb938036a52af1eaf818cf79a2600620e3ce87e371d2ca6d85803606a1b3fa5e874643c9ed2db7e85673ef7227fca56e2e7c08f0927609bb896a9f24be1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecf";

const LIMBS: usize = 16;

type Big = [u64; LIMBS];

fn big_from_be(bytes: &[u8; 128]) -> Big {
    let mut out = [0u64; LIMBS];
    for (index, chunk) in bytes.chunks_exact(8).enumerate() {
        out[LIMBS - 1 - index] = u64::from_be_bytes([
            chunk[0], chunk[1], chunk[2], chunk[3], chunk[4], chunk[5], chunk[6], chunk[7],
        ]);
    }
    out
}

fn big_to_be(value: &Big) -> [u8; 128] {
    let mut out = [0u8; 128];
    for (index, limb) in value.iter().rev().enumerate() {
        out[index * 8..index * 8 + 8].copy_from_slice(&limb.to_be_bytes());
    }
    out
}

fn big_from_hex(text: &str) -> Big {
    let mut bytes = [0u8; 128];
    let clean = text.trim();
    // 左侧补零到 256 个十六进制字符
    let padded = format!("{clean:0>256}");
    for (index, byte) in bytes.iter_mut().enumerate() {
        let at = index * 2;
        *byte = u8::from_str_radix(&padded[at..at + 2], 16).unwrap_or(0);
    }
    big_from_be(&bytes)
}

fn big_ge(a: &Big, b: &Big) -> bool {
    for index in (0..LIMBS).rev() {
        if a[index] != b[index] {
            return a[index] > b[index];
        }
    }
    true
}

/// `a - b`（按 2^1024 取模；只在 `a >= b` 或需要借位回绕时用）。
fn big_sub(a: &Big, b: &Big) -> Big {
    let mut out = [0u64; LIMBS];
    let mut borrow = 0u64;
    for index in 0..LIMBS {
        let (diff, b1) = a[index].overflowing_sub(b[index]);
        let (diff, b2) = diff.overflowing_sub(borrow);
        out[index] = diff;
        borrow = u64::from(b1 || b2);
    }
    out
}

/// 模 2^1024 的加法，再按需减一次 n。
fn big_add_mod(a: &Big, b: &Big, n: &Big) -> Big {
    let mut out = [0u64; LIMBS];
    let mut carry = 0u64;
    for index in 0..LIMBS {
        let (sum, c1) = a[index].overflowing_add(b[index]);
        let (sum, c2) = sum.overflowing_add(carry);
        out[index] = sum;
        carry = u64::from(c1 || c2);
    }
    if carry != 0 || big_ge(&out, n) {
        out = big_sub(&out, n);
    }
    out
}

/// `-n[0]^{-1} mod 2^64`（Montgomery 归约用）。
fn neg_inv(n0: u64) -> u64 {
    let mut inv: u64 = 1;
    for _ in 0..6 {
        inv = inv.wrapping_mul(2u64.wrapping_sub(n0.wrapping_mul(inv)));
    }
    inv.wrapping_neg()
}

fn mont_mul(a: &Big, b: &Big, n: &Big, n0inv: u64) -> Big {
    let mut t = [0u64; 2 * LIMBS + 2];
    for i in 0..LIMBS {
        let mut carry: u128 = 0;
        for (j, value) in a.iter().enumerate() {
            let at = i + j;
            let sum = t[at] as u128 + (*value as u128) * (b[i] as u128) + carry;
            t[at] = sum as u64;
            carry = sum >> 64;
        }
        let mut at = i + LIMBS;
        let sum = t[at] as u128 + carry;
        t[at] = sum as u64;
        let mut extra = (sum >> 64) as u64;
        while extra != 0 {
            at += 1;
            let next = t[at] as u128 + extra as u128;
            t[at] = next as u64;
            extra = (next >> 64) as u64;
        }

        let m = t[i].wrapping_mul(n0inv);
        let mut carry: u128 = 0;
        for (j, value) in n.iter().enumerate() {
            let at = i + j;
            let sum = t[at] as u128 + (m as u128) * (*value as u128) + carry;
            t[at] = sum as u64;
            carry = sum >> 64;
        }
        let mut at = i + LIMBS;
        let sum = t[at] as u128 + carry;
        t[at] = sum as u64;
        let mut extra = (sum >> 64) as u64;
        while extra != 0 {
            at += 1;
            let next = t[at] as u128 + extra as u128;
            t[at] = next as u64;
            extra = (next >> 64) as u64;
        }
    }
    let mut out = [0u64; LIMBS];
    out.copy_from_slice(&t[LIMBS..2 * LIMBS]);
    if t[2 * LIMBS] != 0 || big_ge(&out, n) {
        out = big_sub(&out, n);
    }
    out
}

fn modulus() -> Big {
    big_from_hex(RSA_N_HEX)
}

fn big_one() -> Big {
    let mut out = [0u64; LIMBS];
    out[0] = 1;
    out
}

/// `R^2 mod n`（R = 2^1024）：从 1 起连续翻倍 2048 次。
fn r_squared(n: &Big) -> Big {
    let mut value = big_one();
    for _ in 0..(2 * LIMBS * 64) {
        value = big_add_mod(&value, &value, n);
    }
    value
}

fn to_mont(value: &Big, n: &Big, rr: &Big, n0inv: u64) -> Big {
    mont_mul(value, rr, n, n0inv)
}

fn from_mont(value: &Big, n: &Big, n0inv: u64) -> Big {
    mont_mul(value, &big_one(), n, n0inv)
}

fn modexp_with(base: &Big, exponent: &Big, n: &Big) -> Big {
    let n0inv = neg_inv(n[0]);
    let rr = r_squared(n);
    let mut acc = to_mont(&big_one(), n, &rr, n0inv);
    let base_m = to_mont(base, n, &rr, n0inv);
    let mut started = false;
    for bit in (0..(LIMBS * 64)).rev() {
        let limb = exponent[bit / 64];
        let set = (limb >> (bit % 64)) & 1 == 1;
        if !started && !set {
            continue;
        }
        started = true;
        acc = mont_mul(&acc, &acc, n, n0inv);
        if set {
            acc = mont_mul(&acc, &base_m, n, n0inv);
        }
    }
    from_mont(&acc, n, n0inv)
}

fn modexp(base: &Big, exponent: &Big) -> Big {
    modexp_with(base, exponent, &modulus())
}

/// 伪随机字节：xorshift64*。只给 PKCS#1 的非零填充与 PKCE verifier 用
/// （协议本身的熵也不高），不用于任何需要密码学强度的地方。
pub(crate) fn random_bytes(len: usize) -> Vec<u8> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0x9e37_79b9_7f4a_7c15);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x243f_6a88_85a3_08d3);
    let mut state = nanos ^ COUNTER.fetch_add(0x9e37_79b9_7f4a_7c15, Ordering::Relaxed);
    let mut out = Vec::with_capacity(len);
    while out.len() < len {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        for byte in state.to_le_bytes() {
            if out.len() < len {
                // PKCS#1 v1.5 的填充字节必须非零
                out.push(if byte == 0 { 1 } else { byte });
            }
        }
    }
    out
}

/// RSA PKCS#1 v1.5（type 2）公钥加密，输出 128 字节。
pub fn rsa_pkcs1v15_encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
    const K: usize = 128;
    if plain.len() + 11 > K {
        return Err(format!("RSA 明文太长：{} 字节（上限 {K}）", plain.len()));
    }
    let mut em = [0u8; K];
    em[0] = 0;
    em[1] = 2;
    let ps_len = K - 3 - plain.len();
    em[2..2 + ps_len].copy_from_slice(&random_bytes(ps_len));
    em[2 + ps_len] = 0;
    em[3 + ps_len..].copy_from_slice(plain);
    let message = big_from_be(&em);
    let mut exponent = big_one();
    exponent[0] = 65537;
    Ok(big_to_be(&modexp(&message, &exponent)).to_vec())
}

// ---------- 身份 JSON 与 COSY 会话 ----------

/// 键排序 + 无空白的紧凑 JSON（服务端签名字节与此强绑定）。
pub fn json_sorted_compact(pairs: &[(&str, &str)]) -> String {
    let mut sorted = pairs.to_vec();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let mut out = String::from("{");
    for (index, (key, value)) in sorted.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        let key = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".into());
        let value = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into());
        out.push_str(&key);
        out.push(':');
        out.push_str(&value);
    }
    out.push('}');
    out
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn machine_token(uid: &str) -> String {
    let digest = Sha512::digest(format!("machinetoken:{uid}").as_bytes());
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
    encoded.chars().take(43).collect()
}

fn machine_hostname(uid: &str) -> String {
    let digest = hex(&crate::wb_fingerprint::md5(
        format!("hostname:{uid}").as_bytes(),
    ));
    format!("DESKTOP-{}", digest[..7].to_uppercase())
}

/// 一个账号的 COSY 签名会话。
pub struct CosySession {
    pub uid: String,
    pub machine_id: String,
    machine_token: String,
    machine_type: String,
    machine_hostname: String,
    cosy_key: String,
    info: String,
}

impl CosySession {
    /// 新建会话：随机 16 字符临时密钥 → RSA 包裹成 `cosyKey`；
    /// 身份 JSON（9 键）→ AES-CBC 加密成 `info`。临时密钥每会话唯一。
    pub fn new(
        uid: &str,
        nickname: &str,
        access_token: &str,
        refresh_token: &str,
        user_type: &str,
        org_id: &str,
        org_name: &str,
    ) -> Result<Self, String> {
        let subject = if uid.trim().is_empty() { "anonymous" } else { uid };
        let temp_text = uuid::Uuid::new_v4().simple().to_string();
        let temp_key = &temp_text[..16];
        let key_bytes: [u8; 16] = temp_key
            .as_bytes()
            .try_into()
            .map_err(|_| "COSY 临时密钥不是 16 字节".to_string())?;
        let wrapped = rsa_pkcs1v15_encrypt(temp_key.as_bytes())?;
        let cosy_key = base64::engine::general_purpose::STANDARD.encode(wrapped);

        let identity = json_sorted_compact(&[
            ("name", nickname),
            ("aid", uid),
            ("uid", uid),
            ("yx_uid", ""),
            ("organization_id", org_id),
            ("organization_name", org_name),
            ("user_type", user_type),
            ("security_oauth_token", access_token),
            ("refresh_token", refresh_token),
        ]);
        let info = base64::engine::general_purpose::STANDARD
            .encode(aes_cbc_encrypt(identity.as_bytes(), &key_bytes));

        Ok(Self {
            uid: subject.to_string(),
            machine_id: crate::wb_fingerprint::derive_id(subject, "machine"),
            machine_token: machine_token(subject),
            machine_type: crate::wb_fingerprint::derive_id(subject, "machinetype")
                .replace('-', "")
                .chars()
                .take(18)
                .collect(),
            machine_hostname: machine_hostname(subject),
            cosy_key,
            info,
        })
    }

    /// 一次请求的 Bearer：签名覆盖 `body` 与去掉 `/algo` 前缀的 path。
    pub fn bearer(&self, body: &str, raw_url: &str) -> Result<(String, String, String), String> {
        let parsed = url::Url::parse(raw_url).map_err(|err| format!("URL 解析失败：{err}"))?;
        let path = parsed.path();
        let path = path.strip_prefix("/algo").unwrap_or(path);
        let payload = json_sorted_compact(&[
            ("cosyVersion", qd_upstream::COSY_VERSION),
            ("ideVersion", ""),
            ("info", &self.info),
            ("requestId", &uuid::Uuid::new_v4().to_string()),
            ("version", "v1"),
        ]);
        let payload = base64::engine::general_purpose::STANDARD.encode(payload.as_bytes());
        let date = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
            .to_string();
        let raw = format!(
            "{payload}\n{}\n{date}\n{body}\n{path}",
            self.cosy_key
        );
        let signature = hex(&crate::wb_fingerprint::md5(raw.as_bytes()));
        Ok((payload.clone(), date, format!("Bearer COSY.{payload}.{signature}")))
    }

    /// 推理 / 模型列表 / 签到共用的 COSY 请求头。
    pub fn headers(
        &self,
        body: &str,
        raw_url: &str,
        model_key: &str,
        sse: bool,
        accept: &str,
    ) -> Result<Vec<(&'static str, String)>, String> {
        let (_, date, bearer) = self.bearer(body, raw_url)?;
        let mut headers: Vec<(&'static str, String)> = vec![
            ("cosy-data-policy", "agree".into()),
            ("content-type", "application/json".into()),
            ("cosy-business-product", "cli".into()),
            ("cosy-business-type", "agent".into()),
            ("cosy-scene", "assistant".into()),
            ("cosy-clienttype", qd_upstream::COSY_CLIENT_TYPE.into()),
            ("cosy-date", date),
            ("cosy-user", self.uid.clone()),
            ("cosy-key", self.cosy_key.clone()),
            ("accept", accept.into()),
            ("authorization", bearer),
            ("accept-encoding", "identity".into()),
            ("cosy-version", qd_upstream::COSY_VERSION.into()),
            ("cosy-machineid", self.machine_id.clone()),
            ("cosy-machinetoken", self.machine_token.clone()),
            ("cosy-machinetype", self.machine_type.clone()),
            ("cosy-clientip", "169.254.198.161".into()),
            ("login-version", "v2".into()),
            ("user-agent", qd_upstream::COSY_USER_AGENT.into()),
            ("cosy-machineos", qd_upstream::COSY_MACHINE_OS.into()),
        ];
        if sse {
            headers.push(("cosy-machinehostname", self.machine_hostname.clone()));
            headers.push(("cache-control", "no-cache".into()));
        }
        if !model_key.is_empty() {
            headers.push(("x-model-key", model_key.into()));
            headers.push(("x-model-source", "system".into()));
        }
        Ok(headers)
    }
}

/// 按 `(uid, access_token)` 缓存的会话表。token 轮换后旧会话自动作废。
#[derive(Default)]
pub struct CosyCache {
    entries: HashMap<String, (String, CosySession)>,
}

impl CosyCache {
    pub fn get_or_create(&mut self, account: &crate::qd_account::Account) -> Result<&CosySession, String> {
        let token = account.access_token.trim().to_string();
        if token.is_empty() {
            return Err("COSY 需要 access token，账号尚未登录".into());
        }
        let fresh = !matches!(
            self.entries.get(&account.uid),
            Some((cached, _)) if *cached == token
        );
        if fresh {
            let session = CosySession::new(
                &account.uid,
                &account.nickname,
                &token,
                &account.refresh_token,
                &account.user_type,
                &account.organization_id,
                &account.organization_name,
            )?;
            self.entries.insert(account.uid.clone(), (token, session));
        }
        Ok(&self.entries[&account.uid].1)
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 自定义_base64_对得上参考实现() {
        let cases = [
            ("", ""),
            ("7b7d", "$kwm"),
            ("68656c6c6f", "q$FruHPH"),
            ("e4b8ade696872068656c6c6f", "LuH%b)PZBHiQG*tQ"),
        ];
        for (plain_hex, expected) in cases {
            let plain: Vec<u8> = (0..plain_hex.len() / 2)
                .map(|i| u8::from_str_radix(&plain_hex[i * 2..i * 2 + 2], 16).unwrap_or(0))
                .collect();
            assert_eq!(qoder_encode(&plain), expected, "{plain_hex}");
            assert_eq!(qoder_decode(expected).unwrap_or_default(), plain, "{plain_hex}");
        }
    }

    #[test]
    fn aes_cbc_对得上参考实现() {
        let key = *b"0123456789abcdef";
        let cases = [
            ("", "ed47fee0545c3fa7dd070d44b86e98d9"),
            ("68656c6c6f20776f726c64", "c1e9b4529aac9793010f4677f6358efe"),
            (
                "000102030405060708090a0b0c0d0e0f",
                "59b24fcf01976acae963981ba6573d33b56175f66382014d16cc41f289d2b779",
            ),
        ];
        for (plain_hex, expected) in cases {
            let plain: Vec<u8> = (0..plain_hex.len() / 2)
                .map(|i| u8::from_str_radix(&plain_hex[i * 2..i * 2 + 2], 16).unwrap_or(0))
                .collect();
            assert_eq!(hex(&aes_cbc_encrypt(&plain, &key)), expected, "{plain_hex}");
        }
    }

    #[test]
    fn 身份_json_按键排序且空值写成空串() {
        let text = json_sorted_compact(&[("b", "1"), ("a", "x"), ("c", "")]);
        assert_eq!(text, r#"{"a":"x","b":"1","c":""}"#);
    }

    #[test]
    fn rsa_对得上参考实现的固定填充() {
        let message = b"0123456789abcdef";
        let em = {
            let mut em = [0u8; 128];
            em[0] = 0;
            em[1] = 2;
            let ps_len = 128 - 3 - message.len();
            for byte in em[2..2 + ps_len].iter_mut() {
                *byte = 0xaa;
            }
            em[2 + ps_len] = 0;
            em[3 + ps_len..].copy_from_slice(message);
            em
        };
        let message = big_from_be(&em);
        let mut exponent = big_one();
        exponent[0] = 65537;
        let cipher = big_to_be(&modexp(&message, &exponent));
        assert_eq!(
            hex(&cipher),
            "20f54b780a30c8b12fc1c01aa1ec43c6bf73e09948eca6dbd446736ab2f71350e4d54268a4f67c265d34f1d1a7f12c1b382888e29a1a717c2b15f40579b698c64c480ed14214d2ed65323f1e3f827cb778b5fc3f547c4028316c5470f8f9e543d08099acc228319a9e0a6f204bddd75be1e8cafb8621c1488e6cc4d4cf0cb871"
        );
    }

    #[test]
    fn rsa_pkcs1_填充可被私钥解开() {
        // 固定测试钥（1024 位，由 openssl 生成，仅测试用）
        let n = big_from_hex("c0ada1363512e3df9466e8941702c0f7711f59365f27841b62934838457a88752169cca4751b5d49e56a09548bad35b7363fa425239e0e111897074268e721806a5732d9c434109f0fa6c9c2e2493b8f5bbf660c63612c2fb2d8521a3f06f9d77d53d8ac87188fde530f84612dd7e1a5c8041a24b3c5551e02591e2d8e20f6d3");
        let d = big_from_hex("163cf3fa59add077219daf0248959cc7f25a77e57a9e08f5502f478a971a495d9b79a690e4a33fe52381558a5884a94a780c685990fed108d019be50bfe2cd4edd9ae2e1e35cca116924d8264e40f0b36defc1aead8b8b086fe95f0b2878fcfc90fa9cb52030b7429256d92e748fe39eea026cd9d145b3a774b522970a731681");
        let message = b"qoder-cosy-test";
        let mut em = [0u8; 128];
        em[0] = 0;
        em[1] = 2;
        let ps_len = 128 - 3 - message.len();
        for byte in em[2..2 + ps_len].iter_mut() {
            *byte = 0x5a;
        }
        em[2 + ps_len] = 0;
        em[3 + ps_len..].copy_from_slice(message);

        let m = big_from_be(&em);
        let mut e = big_one();
        e[0] = 65537;
        // 私钥路径只是测试用：先用 e 加密，再用 d 解回
        let cipher = modexp_with(&m, &e, &n);
        let recovered = big_to_be(&modexp_with(&cipher, &d, &n));
        assert_eq!(hex(&recovered), hex(&em));
    }

    #[test]
    fn bearer_签名覆盖去掉_algo_的_path() {
        let session = CosySession::new("u1", "nick", "dt-abc", "drt-def", "personal_professional_trial", "", "")
            .unwrap_or_else(|err| panic!("会话创建失败：{err}"));
        let (payload, date, bearer) = session
            .bearer("{}", "https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1")
            .unwrap_or_else(|err| panic!("签名失败：{err}"));
        assert!(bearer.starts_with(&format!("Bearer COSY.{payload}.")));
        assert!(!date.is_empty());
        // 同样的输入 + 同样的 requestId 才会得到同样的签名；这里只校验结构
        assert_eq!(bearer.matches("COSY.").count(), 1);
        assert_eq!(session.machine_id.len(), 36);
        assert_eq!(session.machine_token.len(), 43);
    }
}
