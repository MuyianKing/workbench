// ! base64 与字节数组的小工具。渲染层、Node 测试两侧都要能跑 —— btoa/atob
// ! 在 WebView2 与 Node ≥ 16 里都是全局，不用再引 polyfill。

/** 字节数组 → 标准 base64。分段拼，免得大数组把 `String.fromCharCode` 的栈撑爆。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/** 标准 base64 → 字节数组。解不开返回 null，由调用方给一句人话。 */
export function base64ToBytes(input: string): Uint8Array | null {
  try {
    const binary = atob(input.replace(/\s/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }
  catch {
    return null
  }
}
