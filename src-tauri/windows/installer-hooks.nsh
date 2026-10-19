; 安装完成后的钩子（由 tauri.conf.json 的 bundle.windows.nsis.installerHooks 引用）。
;
; 为什么需要：Windows 的图标缓存是**按路径**记的。应用一直装在同一目录时，
; 覆盖安装后资源管理器仍会拿旧缓存显示开始菜单/桌面/文件列表里的图标，
; 表现为"重新打包安装了，图标还是旧的"——其实 exe 里已经是新图标了。
;
; SHCNE_ASSOCCHANGED (0x08000000) 会通知 shell"文件关联/图标这一摊变了"，
; 让它丢掉缓存重新读。这是低风险的：只是让资源管理器刷新，不碰任何用户数据。
!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Refreshing shell icon cache..."
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
