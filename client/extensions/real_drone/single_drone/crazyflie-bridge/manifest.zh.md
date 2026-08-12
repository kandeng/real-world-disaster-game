# Crazyflie Bridge —— 完整网站流水线

`extension/crazyflie_bridge` 扩展的下载、安装、配置与运行分步指南；随后在 Community → Live Stream 观看无人机摄像头直播，并在 Real Drone 页面遥控飞行。

---

bridge 由四个协作进程组成，把真实 Crazyflie 接入 drone-navigation 网站：AI-Deck 视频 → MediaMTX（WHIP）、遥测 → FastAPI → 浏览器 HUD、浏览器飞行指令 → 无人机。它是 Simple Crazyflie 脚本进阶后的完整生产流水线。

### 第 1 步 —— 下载

1. 克隆仓库：`git clone https://github.com/kandeng/drone-navigation-v2.git`
2. 扩展位于 `extension/crazyflie_bridge`（`start_bridge.sh`、`telemetry_relay.py`、`motion_control_ws.py`、`video_stream_proxy.py`、`crazyflie_mediamtx.py`、`provision_drone.py`、`e2e_command_check.py`）。

### 第 2 步 —— 安装网站整套环境

按仓库根目录对应平台的 README（Windows 10/11 WSL2、macOS、Ubuntu）安装。概要：

1. **前端**：`cd client && npm install && cp config.example.json config.json && npm run dev` → 网站位于 `http://localhost:5173`。
2. **后端**：PostgreSQL 开发集群（端口 5433，执行 001 + 002 迁移），然后 `cd server && conda create -n drone-navigation python=3.12 -y && conda activate drone-navigation && pip install -r requirements.txt && cp config.example.json config.json && uvicorn app.main:app --port 8000`。
3. **MediaMTX v1.9.0**：下载发布包、解压、运行 `./mediamtx` —— WHEP/WHIP 在 :8889，控制 API 在 :9997。
4. **bridge 依赖**：`pip install -r extension/crazyflie_bridge/requirements.txt`（cflib、websockets）。
5. **Crazyradio PA 的 USB 权限** —— 与 Simple Crazyflie 相同的一次性配置：Ubuntu/WSL2 用 udev 规则，Windows 用 `usbipd-win` 透传，macOS 用 `brew install libusb`。

### 第 3 步 —— 配置

1. **摄像头 IP**：AI-Deck 在本地 Wi-Fi 上以 `http://<无人机IP>/stream` 提供视频。逐个浏览 `http://192.168.0.x`（或 `nmap -sn 192.168.0.0/24`），直到看到摄像头页面。
2. **无线身份**：出厂默认 `radio://0/80/2M/E7E7E7E7E7` 仅适用于单架无人机。同房间多架无人机必须各自使用不同信道 / 地址（2M 速率下信道间隔 ≥2 MHz），通过 USB 写码：
```bash
cd extension/crazyflie_bridge
python provision_drone.py --channel 14 --address E7E7E7E707
```
3. **后端配置**（`server/config.json` 的 `mediamtx` 部分）：把 `whep_url` / `control_api_url` 指向你的 MediaMTX —— 本地默认值（`http://127.0.0.1:8889`、`http://127.0.0.1:9997`）即可用于本地整套环境。

### 第 4 步 —— 运行

1. 按顺序启动（每个进程一个终端）：PostgreSQL、后端（`uvicorn ... --port 8000`）、MediaMTX（`./mediamtx`）、前端（`npm run dev`）。
2. 启动 bridge —— 一个脚本拉起全部四个进程（自动激活 `drone-navigation` conda 环境）：
```bash
cd extension/crazyflie_bridge
CRAZYFLIE_IP="192.168.0.110" RADIO_URL="radio://0/80/2M/E7E7E7E7E7" \
TELEMETRY_SERVER="ws://127.0.0.1:8000/api/drone/telemetry/publish" \
MEDIAMTX_URL="http://127.0.0.1:8889" MEDIAMTX_API="http://127.0.0.1:9997" \
  ./start_bridge.sh
```
- `video_stream_proxy.py` —— 在 :8082 转发 AI-Deck 视频流
- `crazyflie_mediamtx.py` —— 以 `crazyflie-drone` 为名通过 WHIP 把无人机摄像头推入 MediaMTX
- `telemetry_relay.py` —— 遥测 + 飞行指令，无人机 ↔ FastAPI
- `motion_control_ws.py` —— 在 ws://:8765 接收浏览器的飞行指令
3. **不飞行验证**：`python e2e_command_check.py` 在不解锁电机的情况下验证完整指令链。`CF_NO_FLY=1` 会拒绝所有起飞（台架干跑模式）。
4. 停止：`Ctrl+C`（连按两次强制）—— 若正在飞行，bridge 会先降落。

### 第 5 步 —— 使用网站

1. **观看直播**：打开 `Community → Live Stream`。bridge 推流后，`crazyflie-drone` 卡片会带 LIVE 徽标出现；点击即可在浏览器中播放无人机摄像头。（也可以用「发起直播」按钮推送自己的摄像头。）
2. **浏览器遥控飞行**：打开 `Real Drone` 页面。HUD 显示 `Link live | ~20 Hz` 以及真实的位置、姿态、电量。用 Takeoff / Stop / Landing 按钮和飞行圆盘遥控无人机；右侧边栏顶部的红色按钮为紧急停止。
3. **始终生效的安全规则**：USB 线连接时拒绝起飞；指令中断 0.5 秒（关闭标签页、relay 挂掉）死机开关自动悬停；拔掉 Crazyradio 约 1 秒内切断电机。
