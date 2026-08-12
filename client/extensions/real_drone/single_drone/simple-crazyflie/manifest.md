# Simple Crazyflie — Connect, Telemetry, Propellers, Fly

A step-by-step guide to download, install, configure and run the `extension/simple_crazyflie` extension.

---

The extension contains four ready-made scripts, modified from the official Bitcraze tutorial, that use **cflib directly** — no server, no MediaMTX, no browser. Run them in this order to prove the radio link, read live telemetry, verify the propellers, and fly a first autonomous hover.

### Step 1 — Download

1. Clone the repository: `git clone https://github.com/kandeng/drone-navigation-v2.git`
2. The extension lives at `extension/simple_crazyflie` with four scripts: `01_connect.py`, `02_telemetry.py`, `03_propellers.py`, `04_flying.py`.
3. Assemble the Crazyflie 2.1 first, following the official Bitcraze guide "Getting started with the Crazyflie 2.0 or Crazyflie 2.1(+)".

### Step 2 — Install

1. Install Miniconda, then create and activate the environment:
```bash
conda create -n drone-navigation python=3.12 -y
conda activate drone-navigation
```
2. Install the Crazyflie library: `pip install cflib`
3. Grant user access to the Crazyradio PA (one-time, per platform):

#### Ubuntu / WSL2
```bash
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="1915", ATTR{idProduct}=="7777", MODE="0666"' \
  | sudo tee /etc/udev/rules.d/99-crazyradio.rules
sudo udevadm control --reload && sudo udevadm trigger
lsusb | grep 1915        # Nordic Semiconductor — the dongle is visible
```

#### Windows 10 / 11 (WSL2)
1. WSL2 cannot see USB by default. In PowerShell (Administrator): `winget install usbipd`
2. `usbipd list` — find the Crazyradio PA (VID 1915 PID 7777), note the BUSID
3. `usbipd bind --busid <BUSID>` (one-time), then `usbipd attach --wsl --busid <BUSID>` after each replug
4. Apply the udev rule above inside WSL, then replug the radio

#### macOS
1. `brew install libusb` — pyusb/cflib talks to the radio natively; no udev rules, no sudo.

### Step 3 — Configure

1. Plug the Crazyradio PA into USB; insert a charged battery and switch the drone ON.
2. Every script defines a `URI` constant at the top, set to the factory default `radio://0/80/2M/E7E7E7E7E7`.
3. Read the drone's current identity over its USB cable: `python ../crazyflie_bridge/provision_drone.py --read-only`
4. If the EEPROM identity was changed, edit the `URI` constant in all four scripts to match: `radio://0/<channel>/2M/<address>`.

### Step 4 — Run the four scripts in order

#### 4.1 Connect — `python 01_connect.py`
The smallest end-to-end check: connect, read the battery voltage, disconnect.
```
Link open: True
Battery: 3.97 V  (fly only if >= 3.9 V)
Disconnected cleanly.
```
If that prints, radio, permissions and URI are all correct.

#### 4.2 Telemetry — `python 02_telemetry.py`
Streams stabilizer roll / pitch / yaw at 100 Hz for 5 seconds. Pick the drone up and tilt it — the angles must react immediately. That proves the whole drone → radio → Python path, in both directions.

#### 4.3 Propellers — `python 03_propellers.py`
**Do this before every first flight.** Each motor spins individually for ~2.5 s; watch each propeller against the layout below, then a brief ~20 cm hover catches upside-down propellers.
```
             Front
        M4 (CW)    M1 (CCW)
             \    /
              \  /
              /  \
             /    \
        M3 (CCW)   M2 (CW)
             Back
```
M2/M4 take clockwise (CW) blades, M1/M3 counter-clockwise (CCW). A wrong direction means: power off, swap the propeller, re-run.

#### 4.4 Fly — `python 04_flying.py`
Safety checklist: battery ≥ 3.9 V; 2 m clear space; fly **on battery** (unplug USB); fingers near `Ctrl+C`.
The script arms, takes off to 0.3 m (3 s ramp), hovers 5 s, lands and disarms.
Emergency stop, fastest first: **unplug the Crazyradio** (watchdog cuts motors in ~1 s), **Ctrl+C** (gentler), or the drone's power switch once it is down.

### Step 5 — Next steps

When all four scripts behave as described, graduate to the **Crazyflie Bridge** extension (Real Drone → Single Drone → Crazyflie Bridge) for the full website pipeline: video livestream, HUD telemetry and browser flight control.
