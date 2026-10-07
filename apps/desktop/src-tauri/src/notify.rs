//! 系统级 toast 通知（Windows 右下角，点击可回调）。
//!
//! **为什么手写 WinRT**：通知的本体是 `Windows.UI.Notifications` 的 toast，社区常用
//! 的 tauri-plugin-notification 会拖进 notify-rust 一串新编译单元；这里的用量只有
//! 「邮件后台监视弹一条」，需要的子集小 —— 与 mail.rs 手写 IMAP、vault.rs 直接调
//! UserConsentVerifier 同一条口径：只给已在编译图里的 `windows` crate 加 feature。
//!
//! **AUMID（AppUserModelID）**：非打包应用弹 toast 的前提是开始菜单里有一条挂着
//! AUMID 的快捷方式。NSIS 安装器建的快捷方式已经带上了（值就是 tauri.conf.json 的
//! identifier，tauri-bundler 模板里的 `${BUNDLEID}`），装过的机器什么都不用做；
//! dev / 便携运行没有那条快捷方式，由 `ensure_aumid_shortcut` 用 IShellLinkW +
//! IPropertyStore 补一条（同样挂着 identifier）。
//!
//! **点击回调**：挂的是 in-process 的 `Activated` 事件 —— 进程活着（托盘常驻），
//! 点通知就回到本进程；进程死了 toast 也不会在场，不存在「点了没反应」的第三种情况。

use std::mem::ManuallyDrop;
use std::sync::Once;

use windows::core::{GUID, HSTRING, IInspectable, Interface, PWSTR};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{NotificationSetting, ToastNotification, ToastNotificationManager};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0_0};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, IPersistFile,
};
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::IShellLinkW;

/// CLSID_ShellLink（windows 0.62 不再生成 CoClass，直接给 GUID）。
const CLSID_SHELL_LINK: GUID = GUID::from_u128(0x00021401_0000_0000_c000_000000000046);
/// PKEY_AppUserModel_ID：System.AppUserModel.ID（widely documented 的固定 GUID）。
const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    pid: 5,
};

/// COM 公寓初始化。每个公开入口都先过一遍（幂等）—— 调用线程是我们自己拉起的
/// 监视线程，MTA 一次就够；已初始化成 STA 也无碍（toast 的激活工厂 STA 下照常可用）。
fn ensure_com() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    });
}

/// toast 的 XML：ToastGeneric 模板的两行文本 + 显式的「新邮件」提示音。
/// 默认那声系统音太轻，用户反映弹了注意不到 —— 显式挂 `ms-winsoundevent:Notification.Mail`
/// （就是经典的新邮件提示音）：走 Windows 自带音效，不用随包带任何资源。
/// 文本过 `escape_xml`，主题、地址里出现什么字符都不会把 XML 弄坏。
fn toast_xml(title: &str, body: &str) -> String {
    format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual>\
         <audio src=\"ms-winsoundevent:Notification.Mail\"/></toast>",
        escape_xml(title),
        escape_xml(body)
    )
}

/// 弹一条 toast。`on_click` 在用户点下通知的那一刻被调（系统自己的线程上，
/// 可能多次 —— 允许连点，别在里面消费只能用一次的东西）。
pub fn show_toast(
    aumid: &str,
    title: &str,
    body: &str,
    on_click: impl Fn() + Send + 'static,
) -> Result<(), String> {
    ensure_com();
    let xml = toast_xml(title, body);
    let document = XmlDocument::new().map_err(|err| format!("建通知 XML 失败：{err}"))?;
    document
        .LoadXml(&HSTRING::from(xml))
        .map_err(|err| format!("装通知 XML 失败：{err}"))?;
    let toast = ToastNotification::CreateToastNotification(&document)
        .map_err(|err| format!("建通知失败：{err}"))?;
    let activated: TypedEventHandler<ToastNotification, IInspectable> =
        TypedEventHandler::new(move |_, _| {
            on_click();
            Ok(())
        });
    toast
        .Activated(&activated)
        .map_err(|err| format!("挂通知点击回调失败：{err}"))?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(aumid))
        .map_err(|err| {
            format!("通知渠道（AUMID「{aumid}」）不可用：{err} —— 多半是开始菜单里还没有本应用的快捷方式")
        })?;
    // 弹之前先自查：Windows 允许用户对每个应用单独关通知，关着的时候 Show() 照样
    // 成功、通知却静默消失（事件日志里是 ToastSettingDisabled）—— 这层挡一声，
    // 错误信息里把人能动手的开关位置说清楚。
    let setting = notifier
        .Setting()
        .map_err(|err| format!("查询本应用的通知设置失败：{err}"))?;
    if setting != NotificationSetting::Enabled {
        return Err(format!(
            "系统把本应用的通知关了（{:?}）—— 去「设置 > 系统 > 通知」把 Workbench 的「通知」打开",
            setting
        ));
    }
    notifier.Show(&toast).map_err(|err| format!("弹通知失败：{err}"))?;
    // 通知对象故意不释放：平台的「正在显示」引用之外，多留这一份是保 Activated
    // 在部分 Windows 版本上一定回调的保险；一天几条的量，无所谓。
    std::mem::forget(toast);
    Ok(())
}

/// 确保 AUMID 有地方落：开始菜单里 `{product}.lnk` 存在（安装器建的、模板里挂着
/// identifier）就不管；没有（dev / 便携）就建一条指向当前 exe 的。整个进程只做一次。
pub fn ensure_aumid_shortcut(aumid: &str, product: &str) -> Result<(), String> {
    static ONCE: Once = Once::new();
    let mut outcome = Ok(());
    ONCE.call_once(|| outcome = ensure_aumid_shortcut_once(aumid, product));
    outcome
}

fn ensure_aumid_shortcut_once(aumid: &str, product: &str) -> Result<(), String> {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return Err("拿不到 APPDATA 目录".into());
    };
    let programs = std::path::Path::new(&appdata)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs");
    // 文件名只要产品名里的安全字符（安装器模板用的就是 `${PRODUCTNAME}.lnk`）
    let safe: String = product
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '(' | ')' | '.'))
        .collect();
    let shortcut = programs.join(format!("{safe}.lnk"));
    if shortcut.exists() {
        return Ok(());
    }

    let exe = std::env::current_exe().map_err(|err| format!("拿不到当前程序路径：{err}"))?;
    ensure_com();
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&CLSID_SHELL_LINK, None, CLSCTX_INPROC_SERVER)
            .map_err(|err| format!("建快捷方式组件失败：{err}"))?;
        link.SetPath(&HSTRING::from(exe.as_path()))
            .map_err(|err| format!("设快捷方式目标失败：{err}"))?;
        // AUMID 走属性库挂上去（System.AppUserModel.ID，VT_LPWSTR）：toast 平台
        // 靠它把通知认到本应用头上。PROPVARIANT 的联合体字段包在 ManuallyDrop 里，
        // 整个内层构造好再一次性写进槽位。
        let wide = HSTRING::from(aumid);
        let mut payload = PROPVARIANT_0_0::default();
        payload.vt = VT_LPWSTR;
        payload.Anonymous.pwszVal = PWSTR(wide.as_ptr() as *mut u16);
        let mut prop = PROPVARIANT::default();
        prop.Anonymous.Anonymous = ManuallyDrop::new(payload);
        let store: IPropertyStore = link
            .cast()
            .map_err(|err| format!("开快捷方式属性库失败：{err}"))?;
        store
            .SetValue(&PKEY_APP_USER_MODEL_ID, &prop)
            .map_err(|err| format!("挂 AppUserModelID 失败：{err}"))?;
        store
            .Commit()
            .map_err(|err| format!("提交 AppUserModelID 失败：{err}"))?;
        let persist: IPersistFile = link
            .cast()
            .map_err(|err| format!("开快捷方式落盘接口失败：{err}"))?;
        persist
            .Save(&HSTRING::from(shortcut.as_path()), false)
            .map_err(|err| format!("写快捷方式（{}）失败：{err}", shortcut.display()))?;
    }
    Ok(())
}

/// XML 文本转义。toast 的标题正文都过这里 —— 主题与地址里出现 `<`、`&` 之类
/// 不能把整个通知弄坏。
fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '\'' => out.push_str("&apos;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_text_is_escaped() {
        assert_eq!(escape_xml("a<b>&c"), "a&lt;b&gt;&amp;c");
        assert_eq!(escape_xml("引\"号'"), "引&quot;号&apos;");
        assert_eq!(escape_xml("普通中文"), "普通中文");
    }

    /// toast 的 XML：正文要转义，且显式挂着「新邮件」提示音（默认音太轻用户注意不到）
    #[test]
    fn toast_xml_carries_mail_sound_and_escapes_text() {
        let xml = toast_xml("标题<1>", "正文&2");
        assert!(xml.starts_with("<toast><visual>"));
        assert!(xml.contains("<text>标题&lt;1&gt;</text><text>正文&amp;2</text>"));
        assert!(xml.ends_with("<audio src=\"ms-winsoundevent:Notification.Mail\"/></toast>"));
    }

    /// PROPERTYKEY 的 GUID 不能抄错 —— 抄错了 AUMID 挂不上，toast 静默失踪
    #[test]
    fn app_user_model_id_key_is_the_documented_one() {
        assert_eq!(PKEY_APP_USER_MODEL_ID.pid, 5);
        assert_eq!(
            format!("{:?}", PKEY_APP_USER_MODEL_ID.fmtid),
            "9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"
        );
    }
}
