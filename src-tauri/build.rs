fn main() {
    // Windows 上 exe 的图标是这里生成资源文件（resource.rc → .res）后链进去的。
    //
    // 坑：**tauri-build 自己没把图标声明成构建输入**——只替换 src-tauri/icons/
    // 下的图标不会让这个脚本重跑，于是 exe 会继续带着旧图标（只有安装包里的图标变了，
    // 因为打包那一步才读 icons/icon.ico）。表现是"重新打包了但任务栏图标还是旧的"。
    //
    // 显式声明输入之后，改图标 / 改 tauri.conf.json 都会自动触发重编，不用再手动
    // cargo clean -p mddeveloper。判断有没有生效：看
    // target/release/build/mddeveloper-*/out/resource.rc 的时间戳。
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
