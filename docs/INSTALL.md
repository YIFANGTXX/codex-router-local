# 安装、升级与卸载

## 支持范围

| 系统 | Codex 界面 |
| --- | --- |
| Windows | Codex App / CLI |
| macOS | Codex App / CLI |
| Linux | Codex CLI |

需要 Node.js 22.19+、Git，以及 `uv` 或 Python 3.10+。安装器不会静默安装系统包；缺少依赖时会停止并给出提示。

## 推荐：克隆后检查再安装

Windows PowerShell：

```powershell
git clone https://github.com/XJOQAW/codex-router-local.git
Set-Location codex-router-local
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Target codex -Guided
```

macOS / Linux：

```sh
git clone https://github.com/XJOQAW/codex-router-local.git
cd codex-router-local
./install.sh --target codex --guided
```

安装前请停止正在执行的 Codex 请求；安装器不会替你退出 Codex。它会识别现有配置、创建回滚快照并保留 ChatGPT 登录和未归 Router 管理的设置。

## 安装控制中心

引导安装会询问是否构建桌面控制中心。也可以明确指定：

```powershell
.\install.ps1 -Target codex -Guided -WithTray
```

```sh
./install.sh --target codex --guided --with-tray
```

Windows 使用 Electron 控制中心和系统托盘；macOS 使用菜单栏入口；Linux 使用 Electron 控制中心。构建缺少依赖时，路由器安装仍会给出可操作提示。

## 升级

在克隆目录中：

```powershell
git pull --ff-only
.\install.ps1 -Target codex -Guided
```

```sh
git pull --ff-only
./install.sh --target codex --guided
```

升级前仍会创建快照。不要用未知来源的安装脚本覆盖本机配置。

## 检查状态

```powershell
.\bin\model-router codex doctor
```

控制中心中的“检测连接”只访问你填写的 API 地址；“读取模型”只在你主动点击后访问该连接的 `/models`。

## 切回原生模型

在控制中心点击“断开/切回原生模型”，等待状态显示原生模式，然后完整重启 Codex。Router 保存的连接不会因此删除，但不会继续代理 Codex 请求。

## 卸载

先从控制中心切回原生模型，再运行：

```powershell
.\bin\model-router codex uninstall
```

```sh
./bin/model-router codex uninstall
```

卸载只移除 Router 管理的配置。若要清理保存的 API Key，请在控制中心逐个删除连接/密钥；不要直接删除整个 Codex 配置目录。

## 安全提示

- 不要把 API Key 粘贴到 issue、聊天、截图或命令行参数。
- 只连接你信任的 Base URL。
- 本地模型服务应保持监听 `127.0.0.1`。
- 发布日志前先检查其中是否包含工作目录、用户名或供应商响应。
