# Simple Crazyflie —— 连接、遥测、螺旋桨、飞行

`extension/simple_crazyflie` 扩展的下载、安装、配置与运行分步指南。

---

本扩展包含四个现成脚本，修改自 Bitcraze 官方教程，**直接使用 cflib** —— 无需服务器、无需 MediaMTX、无需浏览器。按顺序运行，即可验证无线链路、读取实时遥测、检查螺旋桨，并完成首次自主悬停飞行。

### 第 1 步 —— 下载

1. 克隆仓库：`git clone https://github.com/kandeng/drone-navigation-v2.git`
2. 扩展位于 `extension/simple_crazyflie`，含四个脚本：`01_connect.py`、`02_telemetry.py`、`03_propellers.py`、`04_flying.py`。
3. 先按 Bitcraze 官方指南《Getting started with the Crazyflie 2.0 or Crazyflie 2.1(+)》组装好 Crazyflie 2.1。

### 第 2 步 —— 安装

1. 安装 Miniconda，创建并激活环境：
```bash
conda create -n drone-navigation python=3.12 -y
conda activate drone-navigation
```
2. 安装 Crazyflie 库：`pip install cflib`
3. 授予用户访问 Crazyradio PA 的权限（每个平台只需一次）：

#### Ubuntu / WSL2
```bash
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="1915", ATTR{idProduct}=="7777", MODE="0666"' \
  | sudo tee /etc/udev/rules.d/99-crazyradio.rules
sudo udevadm control --reload && sudo udevadm trigger
lsusb | grep 1915        # Nordic Semiconductor —— 能看到加密狗
```

#### Windows 10 / 11（WSL2）
1. WSL2 默认看不到 USB 设备。在 PowerShell（管理员）中：`winget install usbipd`
2. `usbipd list` —— 找到 Crazyradio PA（VID 1915 PID 7777），记下 BUSID
3. `usbipd bind --busid <BUSID>`（一次性），之后每次重插 / 重启 WSL 执行 `usbipd attach --wsl --busid <BUSID>`
4. 在 WSL 内应用上面的 udev 规则，然后重插无线电

#### macOS
1. `brew install libusb` —— pyusb/cflib 原生与无线电通信；无需 udev 规则，无需 sudo。

### 第 3 步 —— 配置

1. 将 Crazyradio PA 插入 USB；装上充好电的电池，开机。
2. 每个脚本顶部都有 `URI` 常量，出厂默认为 `radio://0/80/2M/E7E7E7E7E7`。
3. 通过 USB 线读取无人机当前身份：`python ../crazyflie_bridge/provision_drone.py --read-only`
4. 若 EEPROM 身份曾被修改，把四个脚本中的 `URI` 常量改为一致：`radio://0/<信道>/2M/<地址>`。

### 第 4 步 —— 按顺序运行四个脚本

#### 4.1 连接 —— `python 01_connect.py`
最小的端到端验证：连接、读电池电压、断开。
```
Link open: True
Battery: 3.97 V  (fly only if >= 3.9 V)
Disconnected cleanly.
```
打印出以上内容，说明无线电、权限、URI 全部正确。

#### 4.2 遥测 —— `python 02_telemetry.py`
以 100 Hz 连续打印 roll / pitch / yaw，持续 5 秒。拿起无人机倾斜 —— 角度应立即随之变化，证明 无人机 → 无线电 → Python 的双向链路完全畅通。

#### 4.3 螺旋桨 —— `python 03_propellers.py`
**每次首飞前必做。** 每个电机单独转动约 2.5 秒，对照下图目视确认转向；随后一次约 20 厘米的短暂悬停，可发现上下装反的螺旋桨。
```
             前
        M4 (CW)    M1 (CCW)
             \    /
              \  /
              /  \
             /    \
        M3 (CCW)   M2 (CW)
             后
```
M2/M4 使用顺时针（CW）桨叶，M1/M3 使用逆时针（CCW）桨叶。转向错误时：断电、换桨、重跑。

#### 4.4 飞行 —— `python 04_flying.py`
安全检查：电池 ≥ 3.9 V；四周 2 米净空；**用电池飞行**（拔掉 USB）；手指放在 `Ctrl+C` 附近。
脚本会解锁、3 秒缓坡起飞到 0.3 米、悬停 5 秒、降落并上锁。
紧急停止（从快到慢）：**拔掉 Crazyradio**（看门狗约 1 秒内切断电机）、**Ctrl+C**（更温和）、落地后拨电源开关。

### 第 5 步 —— 下一步

四个脚本都正常后，即可进阶到 **Crazyflie Bridge** 扩展（Real Drone → Single Drone → Crazyflie Bridge），接入完整网站流水线：视频直播、HUD 遥测与浏览器飞行控制。
