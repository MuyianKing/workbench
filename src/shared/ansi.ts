/**
 * 终端控制序列清理：把子进程的一行输出变成日志面板里能直接看的文本。
 *
 * 为什么需要：日志面板一行一条、每条自带时间戳，既没有光标也没有屏幕；而 CLI 会按
 * 「有屏幕」的假设往输出里塞控制序列。典型的就是 Vue CLI 项目的进度条
 * （`progress-webpack-plugin` 经 `log-update` 重画）：每帧先来一套
 * `ESC[2K ESC[1A ESC[2K ESC[G`（清行、上移一行、清行、回到行首），再写这一帧的
 * `[92%] sealing (...)`；上色时每段外面还套一层 `ESC[33m` 这类 SGR。
 * 这些字节在本机终端里看不见，在面板里却会以「方框 + [2K」的样子原样显示出来
 * （踩过一次：启动日志整片刷成 `[2K[1A[2K[G[92%]`）。
 * 面板既没有行可清、也不该往回退，所以只能把它们丢掉。
 */

/**
 * CSI：`ESC [ 参数 中间字节 结束字节`。
 * 清行（`2K`）、上移（`1A`）、回车到行首（`G`）、颜色（`92m`、`38;5;196m`）、
 * 隐藏光标（`?25l`）都是这一类，全部丢掉。
 */
const CSI = /\u001b\[[0-9;:<=>?]*[ -/]*[@-~]/g

/** OSC：`ESC ] ... BEL`（或以 ST 结尾），改窗口标题、写超链接用，尾巴要一起吃掉 */
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/**
 * 其余短的转义：字符集切换 `ESC ( B`，以及 `ESC =`、`ESC 7` 这种两字符序列
 * （后者的第二个字符落在 0x30–0x3F 与 0x40–0x5F 两段里）。
 */
const SHORT_ESCAPE = /\u001b[()#][0-9A-Za-z]|\u001b[0-?]|\u001b[@-Z\\-_]/g

/**
 * 收尾：上一步没匹配掉的 C0 / C1 控制字符（包括落单的 ESC）、DEL。
 * 空白只留 `\t`（对齐有意义）——`\r` 单独在这里处理，见 `cleanLogLine`。
 */
const CONTROL = /[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f]/g

/** 去掉控制序列，其余一字不改 */
export function stripAnsi(text: string): string {
  return text
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(SHORT_ESCAPE, '')
    .replace(CONTROL, '')
}

/**
 * 一行终端输出 → 一行可显示的日志文本。
 *
 * `\r` 按终端语义处理：光标回到行首重新写，所以只保留最后一个 `\r` 之后的内容。
 * 进度条就是靠 `\r` 反复改写同一行，全留下的话一条日志里会堆出一串百分比
 * （面板里 `\r` 还会被当成换行，行高与滚动都会跟着乱）。
 */
export function cleanLogLine(text: string): string {
  const clean = stripAnsi(text)
  const cut = clean.lastIndexOf('\r')
  return cut === -1 ? clean : clean.slice(cut + 1)
}
