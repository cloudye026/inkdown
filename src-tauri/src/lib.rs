//! Inkdown —— 桌面 Markdown 阅读 / 编辑器的宿主侧（Tauri）实现。
//!
//! 这里只做前端不该做的事：**文件 IO、编码探测、目录扫描、外部变更监听**。
//! 渲染、编辑器、UI 全部在前端完成。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

// ---------------------------------------------------------------------------
// 编码：国内用户的 .md 有相当比例是 GBK / GB18030，甚至带 BOM
// ---------------------------------------------------------------------------

/// 返回 (已归一化为 LF 的文本, 编码名, 是否带 UTF-8 BOM, 原文件的换行风格)。
///
/// 换行风格必须在归一化**之前**探测，否则永远得到 None——CRLF 文件就记不住了。
fn decode(bytes: &[u8]) -> (String, String, bool, Option<String>) {
    let (text, encoding, had_bom) = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        (
            String::from_utf8_lossy(&bytes[3..]).into_owned(),
            "UTF-8".to_string(),
            true,
        )
    } else if let Ok(s) = std::str::from_utf8(bytes) {
        (s.to_string(), "UTF-8".to_string(), false)
    } else {
        let mut detector = chardetng::EncodingDetector::new();
        detector.feed(bytes, true);
        let guessed = detector.guess(None, true);
        let (cow, _, _) = guessed.decode(bytes);
        let label = match guessed.name() {
            // 探测结果落在 GBK 时，用 GB18030 解码更宽容（GBK 是其子集）
            "GBK" | "gbk" => "GB18030".to_string(),
            other => other.to_string(),
        };
        (cow.into_owned(), label, false)
    };
    let eol = detect_eol(&text);
    (normalize_newlines(text), encoding, had_bom, eol)
}

/// CRLF 占多数时返回 `Some("\r\n")`，纯 LF 返回 `None`。
fn detect_eol(text: &str) -> Option<String> {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count();
    if crlf > 0 && crlf * 2 >= lf {
        Some("\r\n".to_string())
    } else {
        None
    }
}

/// 统一成 LF 交给前端：编辑器选区与偏移量计算依赖单一换行约定。
fn normalize_newlines(text: String) -> String {
    if text.contains('\r') {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text
    }
}

fn encoding_by_label(label: &str) -> &'static encoding_rs::Encoding {
    match label.to_ascii_uppercase().as_str() {
        "GB18030" | "GBK" | "GB2312" | "X-GBK" => encoding_rs::GB18030,
        "BIG5" | "BIG-5" => encoding_rs::BIG5,
        "SHIFT_JIS" | "SHIFT-JIS" | "SJIS" => encoding_rs::SHIFT_JIS,
        "EUC-KR" => encoding_rs::EUC_KR,
        "WINDOWS-1252" | "ISO-8859-1" | "LATIN1" => encoding_rs::WINDOWS_1252,
        "UTF-16LE" => encoding_rs::UTF_16LE,
        "UTF-16BE" => encoding_rs::UTF_16BE,
        _ => encoding_rs::UTF_8,
    }
}

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub path: String,
    pub name: String,
    pub text: String,
    pub encoding: String,
    pub bom: bool,
    pub eol: Option<String>,
    pub mtime_ms: f64,
    pub size: u64,
    pub is_markdown: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub mtime_ms: f64,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileChanged {
    path: String,
    mtime_ms: f64,
    size: u64,
}

const MD_EXT: [&str; 5] = ["md", "markdown", "mdown", "mkd", "mdx"];
const SKIP_DIRS: [&str; 12] = [
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "__pycache__",
    ".idea",
    ".vscode",
];

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| MD_EXT.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// (mtime_ms, size)；文件不存在时为 (-1, 0)。
fn stat_signature(path: &Path) -> (f64, u64) {
    match std::fs::metadata(path) {
        Ok(m) => (mtime_ms(&m), m.len()),
        Err(_) => (-1.0, 0),
    }
}

// ---------------------------------------------------------------------------
// 命令：读取 / 写入
// ---------------------------------------------------------------------------

#[tauri::command]
fn read_file(path: String) -> Result<ReadResult, String> {
    let p = PathBuf::from(&path);
    let bytes = std::fs::read(&p).map_err(|e| format!("读取失败 {path}: {e}"))?;
    let meta = std::fs::metadata(&p).map_err(|e| format!("读取元信息失败 {path}: {e}"))?;
    let size = meta.len();
    let (text, encoding, bom, eol) = decode(&bytes);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());

    Ok(ReadResult {
        path,
        name,
        text,
        encoding,
        bom,
        eol,
        mtime_ms: mtime_ms(&meta),
        size,
        is_markdown: is_markdown(&p),
    })
}

/// 把前端传回的文本按目标编码/换行/BOM 编成字节。
/// 单独抽出来是为了能脱离文件系统做往返测试（GBK 往返是必须保证的）。
fn encode(contents: &str, encoding: &str, bom: bool, eol: Option<&str>) -> Vec<u8> {
    let enc = encoding_by_label(encoding);
    let body = match eol {
        Some("\r\n") => contents.replace('\n', "\r\n"),
        _ => contents.to_string(),
    };

    let mut out: Vec<u8> = Vec::with_capacity(body.len() + 3);
    if bom {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    if enc == encoding_rs::UTF_8 {
        out.extend_from_slice(body.as_bytes());
    } else {
        let (encoded, _, _) = enc.encode(&body);
        out.extend_from_slice(&encoded);
    }
    out
}

/// 原子写入：先写临时文件再 rename，避免写一半崩溃损坏用户文件。
#[tauri::command]
fn write_file(
    path: String,
    contents: String,
    encoding: Option<String>,
    bom: Option<bool>,
    eol: Option<String>,
) -> Result<WriteResult, String> {
    let p = PathBuf::from(&path);
    let label = encoding.unwrap_or_else(|| "UTF-8".to_string());
    let out = encode(&contents, &label, bom.unwrap_or(false), eol.as_deref());

    let tmp = p.with_extension(format!(
        "{}.tmp{}",
        p.extension().and_then(|e| e.to_str()).unwrap_or("md"),
        std::process::id()
    ));
    std::fs::write(&tmp, &out).map_err(|e| format!("写入临时文件失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换原文件失败: {e}")
    })?;

    let meta = std::fs::metadata(&p).map_err(|e| format!("读取元信息失败: {e}"))?;
    Ok(WriteResult {
        mtime_ms: mtime_ms(&meta),
        size: meta.len(),
    })
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err("文件已存在".into());
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    std::fs::write(&p, b"").map_err(|e| format!("创建文件失败: {e}"))
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(PathBuf::from(path)).map_err(|e| format!("创建目录失败: {e}"))
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    std::fs::rename(PathBuf::from(from), PathBuf::from(to)).map_err(|e| format!("重命名失败: {e}"))
}

/// 移入系统回收站，而不是永久删除。
#[tauri::command]
fn trash_path(path: String) -> Result<(), String> {
    trash::delete(PathBuf::from(&path)).map_err(|e| format!("移入回收站失败 {path}: {e}"))
}

// ---------------------------------------------------------------------------
// 命令：目录
// ---------------------------------------------------------------------------

/// 单层扫描（文件树懒加载用）。
#[tauri::command]
fn scan_dir(path: String, only_markdown: bool) -> Result<Vec<DirEntry>, String> {
    let p = PathBuf::from(&path);
    let rd = std::fs::read_dir(&p).map_err(|e| format!("读取目录失败 {path}: {e}"))?;
    let mut items: Vec<DirEntry> = Vec::new();

    for entry in rd.flatten() {
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(meta) = entry.metadata() else { continue };

        if meta.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            items.push(DirEntry {
                path: entry_path.to_string_lossy().into_owned(),
                name,
                is_dir: true,
                size: 0,
            });
        } else {
            if name.starts_with('~') || name.ends_with(".tmp") {
                continue;
            }
            if only_markdown && !is_markdown(&entry_path) {
                continue;
            }
            items.push(DirEntry {
                path: entry_path.to_string_lossy().into_owned(),
                name,
                is_dir: false,
                size: meta.len(),
            });
        }
    }

    // 目录在前，同类按名称排序（拼音排序在前端做）
    items.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(items)
}

/// 递归收集工作区内的 markdown 文件（全库搜索 / 快速打开用）。
#[tauri::command]
fn collect_markdown(root: String, limit: Option<usize>) -> Result<Vec<String>, String> {
    let cap = limit.unwrap_or(5000);
    let mut out: Vec<String> = Vec::new();
    for entry in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            !(e.file_type().is_dir() && SKIP_DIRS.contains(&e.file_name().to_string_lossy().as_ref()))
        })
        .flatten()
    {
        if out.len() >= cap {
            break;
        }
        if entry.file_type().is_file() && is_markdown(entry.path()) {
            out.push(entry.path().to_string_lossy().into_owned());
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 命令：外部变更监听
// ---------------------------------------------------------------------------

struct WatchHandle {
    stop: Arc<AtomicBool>,
    /// 我们自己最近一次写入的 (mtime, size)，用于吞掉自写事件。
    self_write: Arc<Mutex<Option<(f64, u64)>>>,
}

#[derive(Default)]
struct WatcherState {
    inner: Mutex<HashMap<String, WatchHandle>>,
}

/// 前端保存成功后调用：登记这次写入，监听线程会忽略它。
#[tauri::command]
fn mark_self_write(
    state: State<'_, WatcherState>,
    path: String,
    mtime_ms: f64,
    size: u64,
) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|_| "状态锁异常")?;
    if let Some(h) = guard.get(&path) {
        if let Ok(mut sw) = h.self_write.lock() {
            *sw = Some((mtime_ms, size));
        }
    }
    Ok(())
}

/// `initial`：前端刚读到的 (mtime, size)。传进来可以让线程以正确基线起步，
/// 否则"新建文件后首次被发现"会被误报为外部修改。
#[tauri::command]
fn watch_file(
    app: AppHandle,
    state: State<'_, WatcherState>,
    path: String,
    initial: Option<(f64, u64)>,
) -> Result<(), String> {
    {
        let guard = state.inner.lock().map_err(|_| "状态锁异常")?;
        if guard.contains_key(&path) {
            return Ok(());
        }
    }

    let stop = Arc::new(AtomicBool::new(false));
    let self_write: Arc<Mutex<Option<(f64, u64)>>> = Arc::new(Mutex::new(None));
    // mtime 精度只有秒级的文件系统上，一次预期比对用来兜底
    let expected: Arc<Mutex<Option<(f64, u64)>>> = Arc::new(Mutex::new(None));
    {
        let mut guard = state.inner.lock().map_err(|_| "状态锁异常")?;
        guard.insert(
            path.clone(),
            WatchHandle {
                stop: stop.clone(),
                self_write: self_write.clone(),
            },
        );
    }

    let app2 = app.clone();
    std::thread::spawn(move || {
        let p = PathBuf::from(&path);
        let mut last = initial.unwrap_or_else(|| stat_signature(&p));
        // 变化开始的时间；只有"停稳"之后才发事件（防抖）
        let mut pending_since: Option<Instant> = None;

        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(600));
            if stop.load(Ordering::Relaxed) {
                break;
            }

            let now = stat_signature(&p);
            if now == last {
                if pending_since.is_some_and(|t| t.elapsed() > Duration::from_millis(300)) {
                    pending_since = None;
                    let _ = app2.emit(
                        "file-changed",
                        FileChanged {
                            path: path.clone(),
                            mtime_ms: now.0,
                            size: now.1,
                        },
                    );
                }
                continue;
            }

            // 变化了：是我们自己刚写的吗？
            if let Ok(mut sw) = self_write.lock() {
                if let Some(written) = *sw {
                    last = now;
                    if now == written {
                        // 完全一致 → 就是我们这次写入，吞掉
                        *sw = None;
                        pending_since = None;
                        continue;
                    }
                    // mtime 精度不足（秒级）时留一次预期：下一次轮询若签名不变才算自写
                    if let Ok(mut exp) = expected.lock() {
                        *exp = Some(now);
                    }
                }
            }

            if let Ok(mut exp) = expected.lock() {
                if let Some(e) = *exp {
                    if e == now {
                        *exp = None;
                        if let Ok(mut sw) = self_write.lock() {
                            *sw = None;
                        }
                        pending_since = None;
                        last = now;
                        continue;
                    }
                }
            }

            last = now;
            if pending_since.is_none() {
                pending_since = Some(Instant::now());
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn unwatch_file(state: State<'_, WatcherState>, path: String) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|_| "状态锁异常")?;
    if let Some(h) = guard.remove(&path) {
        h.stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    PathBuf::from(path).exists()
}

/// 在系统文件管理器里定位并选中某个路径。
///
/// 为什么不用 `tauri-plugin-opener`：它在 Windows 上会先做"路径必须存在"的检查，
/// 再由父目录构造 ITEMIDLIST，任何一步失败都只给一个含义模糊的错误
/// （比如 `FailedToConvertPathToItemIdList`），前端只能显示一句"打开失败"，
/// 无从判断到底是路径不存在、父目录取不到、还是 shell 调用被拒。
///
/// 这里自己实现：先把路径绝对化，文件不存在时**退回打开它所在目录**，
/// 并把每一步的结果作为可读信息返回，让用户和排查都有依据。
///
/// 返回 `Ok(说明文字)`（用于提示"文件不存在，已打开目录"这类降级），失败返回可读原因。
#[tauri::command]
fn reveal_path(path: String) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("路径为空".into());
    }
    let target = PathBuf::from(&path);

    // 文件没了（被外部删除/移动）时，退回打开它所在的目录；目录也没了就明确报错
    if !target.exists() {
        let parent = target.parent().filter(|p| p.exists());
        return match parent {
            Some(dir) => {
                reveal_in_file_manager(dir)?;
                Ok(format!("文件已不存在，改为打开所在文件夹：{}", dir.display()))
            }
            None => Err(format!("路径不存在：{path}")),
        };
    }

    reveal_in_file_manager(&target)?;
    Ok(String::new())
}

#[cfg(windows)]
fn reveal_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    // `explorer /select,"<路径>"` 会在打开的窗口里选中该项。
    // 注意：explorer 成功时也常返回非 0 退出码，所以只看能否启动，不看退出码。
    Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("调用资源管理器失败：{e}"))
}

#[cfg(target_os = "macos")]
fn reveal_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    // `open -R` 在访达里显示并选中
    Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("调用访达失败：{e}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    use std::process::Command;
    // Linux 等平台没有统一的"选中"能力，退而打开所在目录
    let dir = if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    Command::new("xdg-open")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("调用文件管理器失败：{e}"))
}

#[tauri::command]
fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

// ---------------------------------------------------------------------------
// 命令行打开：inkdown.exe <文件.md>，或关联 .md 后双击打开
// ---------------------------------------------------------------------------

/// 支持的启动参数：文件（打开为标签）、`--workspace <目录>`（打开工作区）。
pub struct StartupArgs {
    pub file: Option<String>,
    pub workspace: Option<String>,
}

fn parse_startup_args() -> StartupArgs {
    let mut args = StartupArgs {
        file: None,
        workspace: None,
    };
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;

    while i < argv.len() {
        let arg = argv[i].clone();
        if arg == "--workspace" || arg == "-w" {
            if let Some(next) = argv.get(i + 1) {
                let p = PathBuf::from(next);
                if p.is_dir() {
                    args.workspace = Some(p.to_string_lossy().into_owned());
                }
                i += 2;
                continue;
            }
        } else if !arg.starts_with('-') {
            let p = PathBuf::from(&arg);
            if p.is_file() {
                args.file = Some(p.to_string_lossy().into_owned());
            } else if p.is_dir() && args.workspace.is_none() {
                // 直接拖一个文件夹进来/命令行给目录 → 当作工作区
                args.workspace = Some(p.to_string_lossy().into_owned());
            }
        }
        i += 1;
    }

    args
}

/// 前端启动时查询一次：命令行带来了什么。
/// 用"前端来拉"而不是 setup 里 emit，避免前端还没监听就发出去丢事件。
#[tauri::command]
fn get_startup_args() -> serde_json::Value {
    let args = parse_startup_args();
    serde_json::json!({ "file": args.file, "workspace": args.workspace })
}

// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            create_file,
            create_dir,
            rename_path,
            trash_path,
            scan_dir,
            collect_markdown,
            watch_file,
            unwatch_file,
            mark_self_write,
            path_exists,
            reveal_path,
            now_ms,
            get_startup_args
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// 编码往返测试：国内用户的 .md 有相当比例是 GBK，这是最不能出错的一条链路。
// 运行：cargo test --manifest-path src-tauri/Cargo.toml
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------------------------------------------------------- 显示位置
    // 只测**不会弹出窗口**的分支：成功路径会真的打开资源管理器，
    // 不适合放进自动化测试。

    #[test]
    fn reveal_path_空路径报错() {
        let err = reveal_path("".into()).unwrap_err();
        assert!(err.contains("路径为空"), "实际：{err}");
        let err2 = reveal_path("   ".into()).unwrap_err();
        assert!(err2.contains("路径为空"), "实际：{err2}");
    }

    #[test]
    fn reveal_path_路径与父目录都不存在时报错并带上路径() {
        let bogus = if cfg!(windows) {
            r"Z:\这个盘不存在\也不存在\文件.md"
        } else {
            "/这个目录不存在/也不存在/文件.md"
        };
        let err = reveal_path(bogus.into()).unwrap_err();
        assert!(err.contains("路径不存在"), "实际：{err}");
        // 错误信息里要有具体路径，用户才能看出是哪一个
        assert!(err.contains("文件.md"), "实际：{err}");
    }

    #[test]
    fn reveal_path_父目录存在但文件不在时走降级而不是报错() {
        // 用一个**存在的临时目录**放一个不存在的文件名：
        // 这条会真的打开资源管理器窗口，因此只在明确需要时跑。
        // 默认跳过，避免 CI / 本地测试时弹窗打扰。
        if std::env::var("MDDEV_TEST_REVEAL").is_err() {
            return;
        }
        let dir = std::env::temp_dir().join("inkdown-reveal-test");
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let missing = dir.join("不存在的文件.md");
        let notice = reveal_path(missing.to_string_lossy().into_owned()).expect("应降级成功");
        assert!(notice.contains("文件已不存在"), "实际：{notice}");
        assert!(notice.contains("inkdown-reveal-test"), "实际：{notice}");
    }

    #[test]
    fn utf8_往返() {
        let text = "# 标题\n\n中文正文 with English。\n";
        let bytes = encode(text, "UTF-8", false, None);
        let (back, enc, bom, eol) = decode(&bytes);
        assert_eq!(back, text);
        assert_eq!(enc, "UTF-8");
        assert!(!bom);
        assert_eq!(eol, None, "LF 文件不应报告 CRLF");
    }

    #[test]
    fn gbk_往返_中文不乱码() {
        let text = "第一行：中文\n第二行：测试\n";
        let bytes = encode(text, "GB18030", false, None);
        // GBK 下中文占 2 字节，字节数必须大于字符数
        assert!(bytes.len() > text.chars().count());
        assert!(std::str::from_utf8(&bytes).is_err(), "非 UTF-8 才说明真的用了 GBK");

        let (back, enc, _, _) = decode(&bytes);
        assert_eq!(back, text);
        assert_eq!(enc, "GB18030", "GBK 探测结果统一升级为 GB18030");
    }

    #[test]
    fn crlf_保留并正确探测() {
        let text = "第一行\n第二行\n";
        let bytes = encode(text, "UTF-8", false, Some("\r\n"));
        assert!(bytes.windows(2).any(|w| w == b"\r\n"), "应写出 CRLF");

        let (back, _, _, eol) = decode(&bytes);
        assert_eq!(back, text, "交给前端的文本必须是 LF 归一化后的");
        assert_eq!(eol, Some("\r\n".to_string()), "探测结果告诉前端按 CRLF 存回");
    }

    #[test]
    fn crlf_文件也带上编码与_bom_信息() {
        let text = "中文\r\n第二行\r\n";
        let (back, enc, bom, eol) = decode(text.as_bytes());
        assert_eq!(back, "中文\n第二行\n");
        assert_eq!(enc, "UTF-8");
        assert!(!bom);
        assert_eq!(eol, Some("\r\n".to_string()));
    }

    #[test]
    fn gbk_加_crlf_的真实老文件() {
        // 模拟"Windows 记事本另存为 ANSI"的历史文件：GBK 编码 + CRLF 换行。
        // 注意 encode 的输入契约是**已归一化为 LF** 的文本（前端就是这样传的），
        // 所以这里先按契约写出字节，再验证读回来时两个属性都被正确识别。
        let lf_text = "标题\n\n正文内容\n";
        let bytes = encode(lf_text, "GB18030", false, Some("\r\n"));

        let (back, enc, bom, eol) = decode(&bytes);
        assert_eq!(back, lf_text, "读回来必须是 LF 归一化的同一段文本");
        assert_eq!(enc, "GB18030");
        assert!(!bom);
        assert_eq!(eol, Some("\r\n".to_string()));

        // 再原样存回去，字节应与原文件一致（不发生编码漂移）
        let again = encode(&back, &enc, bom, eol.as_deref());
        assert_eq!(again, bytes, "打开再保存不应改变文件字节");
    }

    #[test]
    fn 纯_lf_不误判为_crlf() {
        assert_eq!(detect_eol("a\nb\nc\n"), None);
    }

    #[test]
    fn bom_写出与识别() {
        let bytes = encode("中文\n", "UTF-8", true, None);
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
        let (back, enc, bom, _) = decode(&bytes);
        assert_eq!(back, "中文\n", "BOM 不能留在正文里");
        assert_eq!(enc, "UTF-8");
        assert!(bom, "要告诉前端原文件带 BOM，保存时写回");
    }

    #[test]
    fn 混合换行归一化为_lf() {
        assert_eq!(normalize_newlines("a\r\nb\rc\nd".into()), "a\nb\nc\nd");
    }

    #[test]
    fn 只有_markdown_扩展名被识别() {
        assert!(is_markdown(Path::new(r"D:\notes\a.md")));
        assert!(is_markdown(Path::new("/notes/a.MARKDOWN")));
        assert!(!is_markdown(Path::new("/notes/a.txt")));
        assert!(!is_markdown(Path::new("/notes/md")));
    }

    #[test]
    fn 未知编码标签退回_utf8() {
        assert_eq!(encoding_by_label("什么编码"), encoding_rs::UTF_8);
        assert_eq!(encoding_by_label("gbk"), encoding_rs::GB18030);
        assert_eq!(encoding_by_label("Big5"), encoding_rs::BIG5);
    }

    /// 真正走一遍"临时文件 + rename"的落盘路径。
    ///
    /// 编码往返测试只验证了字节，没验证**文件真的被替换**——
    /// 而用户报的"提示已保存但实际没写"如果出在底层，就必须靠这个测试抓出来。
    #[test]
    fn 原子写入真的替换了磁盘内容() {
        let dir = std::env::temp_dir().join(format!("mddev-write-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.md");
        std::fs::write(&file, b"original").unwrap();

        // 一次写入
        write_file(
            file.to_string_lossy().into_owned(),
            "第一版内容".to_string(),
            None,
            None,
            None,
        )
        .expect("写入应成功");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "第一版内容");

        // 二次写入：验证覆盖的是同一个文件，而不是写到别处
        write_file(
            file.to_string_lossy().into_owned(),
            "第二版内容".to_string(),
            None,
            None,
            None,
        )
        .expect("重复写入应成功");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "第二版内容");

        // 内容与"已保存"完全相同时也要真的写盘：显式保存必须确定性生效
        write_file(
            file.to_string_lossy().into_owned(),
            "第二版内容".to_string(),
            None,
            None,
            None,
        )
        .expect("内容相同时的写入也应成功");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "第二版内容");

        // 不留临时文件
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不应留下临时文件: {leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 原子写入保留_gbk_编码与_crlf() {
        let dir = std::env::temp_dir().join(format!("mddev-enc-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("gbk.md");

        write_file(
            file.to_string_lossy().into_owned(),
            "中文内容\n".to_string(),
            Some("GB18030".to_string()),
            None,
            Some("\r\n".to_string()),
        )
        .expect("写入应成功");

        let bytes = std::fs::read(&file).unwrap();
        assert!(std::str::from_utf8(&bytes).is_err(), "应真的写成 GBK 字节");
        assert!(bytes.windows(2).any(|w| w == b"\r\n"), "应写成 CRLF");

        let (text, enc, _, eol) = decode(&bytes);
        assert_eq!(text, "中文内容\n");
        assert_eq!(enc, "GB18030");
        assert_eq!(eol, Some("\r\n".to_string()));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
