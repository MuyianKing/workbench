//! 网络吞吐：从 IP Helper 的接口表读**累计字节数**与**链路速率**。
//!
//! ## 为什么是 GetIfTable2 而不是 GetIfTable
//!
//! 老的那套 `MIB_IFROW.dwInOctets` 是 32 位，100Mbps 下几分钟就在 4GB 处回绕，
//! 读数会突然变成负数再爬回来 —— 这个功能每秒都要读一次，正撞在回绕上。
//! `MIB_IF_ROW2` 的 `InOctets` / `OutOctets` 是 64 位，跑到天荒地老也不会回绕。
//! 代价只是给已有的 windows-sys 多开一个 feature（`Win32_NetworkManagement_Ndis`，
//! 那两个结构体与 `IfOperStatusUp` 都在它下面），不新增编译单元。
//!
//! ## 这里只取原始数，不算速率
//!
//! 速率、单位进位、平滑都在 TS 侧（见 `packages/net-meter`）：后端只做「取原始数据 / 调系统能力」，
//! 业务语义留在适配层。调用方每秒问一次，拿两次的差自己算。

use serde::Serialize;
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::NetworkManagement::IpHelper::{
    FreeMibTable, GetIfTable2, IF_TYPE_SOFTWARE_LOOPBACK, MIB_IF_TABLE2,
};
use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;

/// 一张网卡上取到的那几样（从 `MIB_IF_ROW2` 抄下来的，抄的时候顺手做了过滤判断）
pub struct InterfaceCounters {
    pub in_octets: u64,
    pub out_octets: u64,
    /// 接收链路速率（bit/s）
    pub down_link: u64,
    /// 发送链路速率（bit/s）
    pub up_link: u64,
    /// 这张网卡现在是不是「已连接」（`OperStatus == IfOperStatusUp`）
    pub up: bool,
    /// 环回网卡：不算进去
    pub loopback: bool,
    /// 物理网卡（`InterfaceAndOperStatusFlags` 的第 0 位）。**只有它报的链路速率算数**：
    /// 虚拟网卡（Hyper-V 虚拟交换机、WSL、VPN 隧道）报的是 100Gbps 这种虚数 ——
    /// 实测一台机器 16 张网卡加起来 102Gbps，拿它当分母的话弧永远画不出来。
    pub hardware: bool,
}

/// 一次采样的结果。字段走 camelCase 出到渲染层。
#[derive(Serialize, Default, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NetCounters {
    /// 累计收到的字节数（所有计入的网卡之和）
    pub in_octets: u64,
    /// 累计发出的字节数
    pub out_octets: u64,
    /// 物理网卡里**最快**那条的接收速率（bit/s）—— 弧的分母。取不到时是 0，渲染层按「未知」处理、不画弧
    pub down_link: u64,
    /// 物理网卡里最快那条的发送速率（bit/s）
    pub up_link: u64,
    /// 计入了多少张网卡（取不到任何网卡时是 0）
    pub interfaces: u32,
}

/// 把接口表合计成一份结果。**过滤与累加都在这里**，与 Win32 那一段分开，单独可测。
///
/// 口径（用户选的「所有网卡合计」）：
/// - **字节数**：排除环回、只要「已连接」的，其余全部相加。
///   已知偏差：开着 VPN / WSL / Hyper-V 时同一份流量会在虚拟网卡与物理网卡上各算一次，数字偏大。
/// - **链路速率**：只取物理网卡，且取**最大**那条而不是相加 —— 一个连接跑不了两条网卡，
///   相加得到的是「所有网卡同时满速」这种不存在的数。
pub fn sum_interfaces(rows: &[InterfaceCounters]) -> NetCounters {
    let mut total = NetCounters::default();
    for row in rows {
        if row.loopback || !row.up {
            continue;
        }
        total.in_octets = total.in_octets.saturating_add(row.in_octets);
        total.out_octets = total.out_octets.saturating_add(row.out_octets);
        if row.hardware {
            total.down_link = total.down_link.max(row.down_link);
            total.up_link = total.up_link.max(row.up_link);
        }
        total.interfaces += 1;
    }
    total
}

/// 读一次接口表。拿不到就返回空表（调用方合计出全 0，界面按空态处理）。
fn read_interfaces() -> Vec<InterfaceCounters> {
    let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
    let status = unsafe { GetIfTable2(&mut table) };
    if status != ERROR_SUCCESS || table.is_null() {
        return Vec::new();
    }

    let mut rows = Vec::new();
    unsafe {
        let count = (*table).NumEntries as usize;
        // Table 声明成 [MIB_IF_ROW2; 1]，实际是一整片；按 NumEntries 往后读是这套 API 的常规用法
        // （system.rs 读 TCP 表同一手法）
        let first = (*table).Table.as_ptr();
        for index in 0..count {
            let row = &*first.add(index);
            rows.push(InterfaceCounters {
                in_octets: row.InOctets,
                out_octets: row.OutOctets,
                down_link: row.ReceiveLinkSpeed,
                up_link: row.TransmitLinkSpeed,
                up: row.OperStatus == IfOperStatusUp,
                loopback: row.Type == IF_TYPE_SOFTWARE_LOOPBACK,
                // 联合体里第 0 位是 HardwareInterface（windows-sys 只给了一个 u8，没给访问器）
                hardware: row.InterfaceAndOperStatusFlags._bitfield & 0b1 != 0,
            });
        }
        FreeMibTable(table.cast());
    }

    rows
}

/// 读一次当前累计字节与链路速率。
///
/// 标 `(async)`：每秒一问，落在线程池上，不占主线程（IPC 命令默认跑在主线程，
/// 漏标的后果不是慢而是界面卡）。
#[tauri::command(async)]
pub fn net_counters() -> NetCounters {
    sum_interfaces(&read_interfaces())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一张物理网卡
    fn phys(in_octets: u64, out_octets: u64, link: u64) -> InterfaceCounters {
        InterfaceCounters {
            in_octets,
            out_octets,
            down_link: link,
            up_link: link,
            up: true,
            loopback: false,
            hardware: true,
        }
    }

    /// 一张虚拟网卡（Hyper-V 虚拟交换机之类：报 100Gbps，但流量是借物理网卡走的）
    fn virt(in_octets: u64, out_octets: u64) -> InterfaceCounters {
        InterfaceCounters {
            in_octets,
            out_octets,
            down_link: 100_000_000_000,
            up_link: 100_000_000_000,
            up: true,
            loopback: false,
            hardware: false,
        }
    }

    #[test]
    fn 已连接的网卡字节相加() {
        let rows = vec![phys(1000, 200, 1_000_000_000), phys(300, 40, 2_500_000_000)];
        let total = sum_interfaces(&rows);
        assert_eq!(total.in_octets, 1300);
        assert_eq!(total.out_octets, 240);
        assert_eq!(total.interfaces, 2);
    }

    #[test]
    fn 链路速率取物理网卡里最快的那条而不是相加() {
        // 一个连接跑不了两条网卡，相加得到的是「两块网卡同时满速」这种不存在的数
        let rows = vec![phys(0, 0, 1_000_000_000), phys(0, 0, 2_500_000_000)];
        let total = sum_interfaces(&rows);
        assert_eq!(total.down_link, 2_500_000_000);
        assert_eq!(total.up_link, 2_500_000_000);
    }

    #[test]
    fn 虚拟网卡的虚数速率不算数但字节算() {
        // 实测一台机器 16 张网卡加起来 102Gbps —— 拿它当分母，弧永远画不出来
        let rows = vec![phys(0, 0, 1_000_000_000), virt(500, 600), virt(700, 800)];
        let total = sum_interfaces(&rows);
        assert_eq!(total.down_link, 1_000_000_000);
        assert_eq!(total.in_octets, 1200);
        assert_eq!(total.interfaces, 3);
    }

    #[test]
    fn 只有虚拟网卡时链路速率是零弧也不画() {
        let rows = vec![virt(500, 600)];
        let total = sum_interfaces(&rows);
        assert_eq!(total.down_link, 0);
        assert_eq!(total.in_octets, 500);
        assert_eq!(total.interfaces, 1);
    }

    #[test]
    fn 环回与断开的不算() {
        let mut loopback = phys(9999, 9999, 0);
        loopback.loopback = true;
        let mut down = phys(8888, 8888, 0);
        down.up = false;
        let rows = vec![loopback, down, phys(7, 8, 100)];
        let total = sum_interfaces(&rows);
        assert_eq!(total.in_octets, 7);
        assert_eq!(total.out_octets, 8);
        assert_eq!(total.interfaces, 1);
    }

    #[test]
    fn 一张网卡都没有时是全零() {
        let total = sum_interfaces(&[]);
        assert_eq!(total, NetCounters::default());
        assert_eq!(total.interfaces, 0);
    }

    #[test]
    fn 链路速率取不到时是零而不是漏掉流量() {
        // 有些网卡不报 LinkSpeed：字节数照样要算，弧那边按「未知」不画
        let rows = vec![phys(500, 600, 0)];
        let total = sum_interfaces(&rows);
        assert_eq!(total.in_octets, 500);
        assert_eq!(total.down_link, 0);
        assert_eq!(total.interfaces, 1);
    }

    #[test]
    fn 计数不会溢出() {
        // 累计字节是真会跑到 u64 上限附近的量级，加法一律 saturating
        let rows = vec![
            phys(u64::MAX - 1, u64::MAX, u64::MAX),
            phys(10, 10, 10),
        ];
        let total = sum_interfaces(&rows);
        assert_eq!(total.in_octets, u64::MAX);
        assert_eq!(total.out_octets, u64::MAX);
    }

    #[test]
    fn 本机真的能读到网卡() {
        // 不依赖具体数值（机器不同、时刻不同），只确认这条路真的通、且有网卡被计入
        let counters = net_counters();
        assert!(counters.interfaces >= 1, "至少该有一张已连接的网卡：{counters:?}");
    }

    #[test]
    fn 本机的链路速率取的是物理网卡那一档() {
        // 这条是拿真机当哨兵：虚拟网卡那种 100Gbps 的虚数混进来的话，这个上界会被撞破
        let counters = net_counters();
        assert!(
            counters.down_link <= 40_000_000_000,
            "链路速率看着像把虚拟网卡的虚数算进来了：{counters:?}",
        );
    }
}
