/**
 * `window.workbench` 上的一组通道：密码保险库。
 * 实现见 `workbench/vault.ts`；这里只有形状。
 */

import type { Result } from '@workbench/core'
import type { VaultEntry, VaultRecord } from '@workbench/vault'
import type {
  VaultHelloState,
  VaultKeyState,
  VaultLoaded,
  VaultSyncOutcome,
} from '../index'

export interface VaultChannel {
  // ---------- 密码保险库（见 @workbench/vault） ----------
  /**
   * 密钥状态：这台机器上有没有一把密钥、这会儿解没解锁、公钥指纹是多少。
   *
   * **不返回密钥本身**。保险库的私钥存在 Windows 凭据管理器里（Rust 的 `vault.rs`），
   * 加解密在渲染层做（WebView2 自带 WebCrypto，而 Rust 侧引任何一套密码学库都会新增成片的
   * 编译单元，见 AGENTS.md 第 1 节），所以它是全项目唯一一处机密过 IPC 的地方。
   */
  vaultKeyState: () => Promise<Result<VaultKeyState>>

  /** 现生成一把密钥并落进凭据管理器；已有密钥时 `replace` 为假则不动它（换密钥等于把现有条目全作废） */
  vaultCreateKey: (replace: boolean) => Promise<Result<VaultKeyState>>

  /** 这台机器的 Windows 验证（Hello）配没配好：解锁屏据此决定弹系统验证框还是输本机账户密码 */
  vaultHello: () => Promise<Result<VaultHelloState>>

  /**
   * 解锁（输本机账户密码那条路，回退用）：先由 Windows 校验密码（Rust 侧的 `LogonUserW`），
   * 过了才把密钥取进内存。**它只验本机 SAM** —— 微软账户的机器上登录密码由云端认，这条路走不通。
   *
   * 密码只在这条通道上过一次，**不落盘、不进凭据管理器**；应用不存它、也不拿它派生任何东西 ——
   * 认密码的是 Windows，改 Windows 密码不影响保险库。
   */
  vaultUnlock: (password: string) => Promise<Result<VaultKeyState>>

  /**
   * 解锁（Windows Hello 那条路，默认）：弹系统自己的验证框，过了才把密钥取进内存。
   * 返回 null 是用户把验证框关掉了 —— 不是失败，界面不该报错。
   */
  vaultUnlockHello: () => Promise<Result<VaultKeyState | null>>

  /** 把内存里那把丢掉（不动凭据管理器） */
  vaultLock: () => Promise<Result<VaultKeyState>>

  /**
   * 把本机密钥导出成一个文件：自己弹「另存为」，再写进去。
   * 返回 false 表示用户在对话框里取消了 —— 那不是失败，界面不该报错。
   */
  vaultExportKey: () => Promise<Result<boolean>>

  /**
   * 从一个导出的密钥文件导入：自己弹文件选择框，读回来存进凭据管理器。
   * 返回 false 表示用户取消了。
   */
  vaultImportKeyFile: () => Promise<Result<boolean>>

  /** 忘掉本机密钥。**不动仓库里那份数据**，所以界面上必须先确认一次 */
  vaultForgetKey: () => Promise<Result<VaultKeyState>>

  /** 解开本机那份里的全部条目（解密在渲染层，明文只在内存里） */
  vaultLoad: () => Promise<Result<VaultLoaded>>

  /** 新增 / 改动一条：**只重封这一条**，其余密文原样留着 */
  vaultSaveEntry: (id: string, entry: VaultEntry) => Promise<Result<VaultRecord>>

  /** 删一条：留下一个墓碑，让别的机器别把它复活 */
  vaultRemoveEntry: (id: string) => Promise<Result<null>>

  /**
   * 同步一轮：拉回远端 → 与本机那份合并 → 落盘 → 推上去。
   *
   * 远端那份是所有机器**共写**的一份文件（用户的要求），所以合并规则必须自己定死
   * （见 @workbench/vault 的 mergeVaultItems）—— 同一个文件的两种改法**不交给 git**，
   * 否则只会留下一堆冲突标记。远端在同步途中被别的机器改过时，这一轮会自动重走。
   * 与其余几条同步一样，没登录就没有同步（仓库地址由适配层按登录状态给）。
   */
  vaultSync: () => Promise<Result<VaultSyncOutcome>>

  /** 仓库里那份与本机这把密钥对不对得上：`none` / `match` / `mismatch` */
  vaultRemoteKeyStatus: () => Promise<Result<'none' | 'match' | 'mismatch'>>
}
