r"""Verify propeller assembly — spin each motor individually and check
its direction BY EYE.

The Crazyflie 2.1 motor layout (X-configuration, top-down view):

             Front
        M4 (CW)    M1 (CCW)
             \    /
              \  /
              /  \
             /    \
        M3 (CCW)   M2 (CW)
             Back

Each motor must spin in the direction shown AND carry the matching
propeller type (CW or CCW).  A wrong prop or wrong motor order makes
the drone flip on takeoff.

Run:  python 03_propellers.py

Why by eye and not by the gyroscope?  A single small propeller on a
grounded quad produces a yaw reaction torque far below the gyro's
vibration-rectification noise floor.  In practice the gyro reading
during a one-motor spin is dominated by vibration artifacts — the
same motor can read +0.16 rad/s in one run and +1.28 rad/s in the
next, with the sign unrelated to the actual spin direction.  Human
eyes (plus a phone in slow-motion mode if needed) are the reliable
sensor for this check.

The script spins each motor one at a time via motorPowerSet so you
can see exactly which motor spins and in which direction.  If the
motorPowerSet params are missing from this firmware, all four motors
are spun together during the hover instead.

After the individual check the script performs a short hover at
~10 cm.  This catches the one fault a spin-direction check cannot:
a propeller mounted upside-down (correct rotation, but no lift).
"""
import logging
import time
import warnings

import cflib.crtp
from cflib.crazyflie import Crazyflie
from cflib.crazyflie.syncCrazyflie import SyncCrazyflie

URI = 'radio://0/80/2M/E7E7E7E7E7'
POWER = 20000          # ~30 % — clearly visible spin, safe on the ground
SPIN_TIME = 2.5        # seconds per motor — long enough to see direction
PAUSE = 1.5            # between motors

logging.basicConfig(level=logging.ERROR)

# Suppress CRTP-v6 compatibility warnings (same rationale as the other
# scripts — this firmware needs the legacy paths).
warnings.filterwarnings(
    'ignore',
    message=r'Using legacy TYPE_.*_LEGACY',
    category=DeprecationWarning,
)
warnings.filterwarnings(
    'ignore',
    message=r'platform\.send_arming_request is deprecated',
    category=DeprecationWarning,
)
warnings.filterwarnings(
    'ignore',
    message=r'The supervisor subsystem requires CRTP protocol version 12 or later',
    category=UserWarning,
)

DIAGRAM = """\
               Front
          M4 (CW)    M1 (CCW)
               \\    /
                \\  /
                /  \\
               /    \\
          M3 (CCW)   M2 (CW)
               Back"""


# ── individual motor check (motorPowerSet required) ─────────────────

def _spin_each_motor(cf):
    """Spin each motor one at a time; the user verifies direction."""
    print()
    print('Individual motor check — watch each propeller as it spins')
    print('-' * 50)
    print()
    print('  Top view (front of the drone pointing away from you):')
    print()
    print(DIAGRAM)
    print()
    motors = [
        ('M1', 'm1', 'front-right', 'counter-clockwise ↺'),
        ('M2', 'm2', 'rear-right ', 'clockwise ↻'),
        ('M3', 'm3', 'rear-left  ', 'counter-clockwise ↺'),
        ('M4', 'm4', 'front-left ', 'clockwise ↻'),
    ]
    for tag, param, pos, direction in motors:
        print(f'  {tag} ({pos}) — expect {direction}')
        print(f'      spinning for {SPIN_TIME:.0f} s ...', flush=True)
        cf.param.set_value(f'motorPowerSet.{param}', POWER)
        time.sleep(SPIN_TIME)
        cf.param.set_value(f'motorPowerSet.{param}', 0)
        time.sleep(PAUSE)
    print()
    print('  Checklist:')
    print('    [ ] M1 — front-right — counter-clockwise ↺')
    print('    [ ] M2 — rear-right  — clockwise ↻')
    print('    [ ] M3 — rear-left   — counter-clockwise ↺')
    print('    [ ] M4 — front-left  — clockwise ↻')
    print()
    print('  A motor that did not spin at all: check its wiring and')
    print('  connectors — a kinked or pinched wire is a common cause.')
    print()


# ── hover check (all four motors at once) ───────────────────────────
#
# Uses send_hover_setpoint() which goes to COMMANDER_GENERIC with
# TYPE_HOVER_LEGACY on this CRTP v6 firmware — the same packet type
# MotionCommander uses successfully in 04_flying.py.
#
# The trade-off: the drone must actually hover (~10 cm) for the
# controller to spool up all four motors.  A brief low hover is the
# most reliable integration check available on this firmware.

HOVER_HEIGHT = 0.10      # metres — low enough that a wrong prop causes
                         # immediate visible tilt, not a fly-away
HOVER_TIME = 4.0         # seconds of hover — time to check all four


def _pump_hover(cf, vx, vy, yaw_rate, zdistance, duration):
    """Send hover setpoints at ~20 Hz for *duration* seconds.

    The commander watchdog expires after ~1 s without a fresh setpoint,
    so a single call + sleep() is NOT safe.
    """
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        cf.commander.send_hover_setpoint(vx, vy, yaw_rate, zdistance)
        time.sleep(0.05)  # ~20 Hz
    # Land: zero height target, then stop
    cf.commander.send_hover_setpoint(0, 0, 0, 0)
    time.sleep(0.05)


def _hover_check(cf):
    """Brief low hover — verifies the props actually produce lift.

    Catches a propeller mounted upside-down (spins the right way but
    pushes air up) and confirms the flight controller drives all four
    channels.  If any propeller is wrong the drone will tilt or flip
    immediately at this low height, making the error obvious.
    """
    print()
    print('Final check — brief hover at ~10 cm')
    print('-' * 50)
    print()
    print('  ⚠️  The drone will lift off briefly.')
    print('  Keep the area clear and your hands away.')
    print()
    print('  The drone should rise straight up and hold position.')
    print('  Immediate tilt, spin, or failure to lift = something')
    print('  is still wrong (re-check the diagram):')
    print()
    print(DIAGRAM)
    print()
    print(f'  Hovering at ~{HOVER_HEIGHT * 100:.0f} cm for '
          f'{HOVER_TIME:.0f} s ...')
    _pump_hover(cf, 0, 0, 0, HOVER_HEIGHT, HOVER_TIME)
    print()
    print('-' * 50)
    print('Tip: if the propellers are too fast to see, film them with')
    print('your phone in slow-motion mode (120/240 fps), or watch the')
    print('blur from the side rather than from above.')


# ── main ────────────────────────────────────────────────────────────

if __name__ == '__main__':
    cflib.crtp.init_drivers()
    with SyncCrazyflie(URI, cf=Crazyflie(rw_cache='./cache')) as scf:
        time.sleep(2)

        toc = scf.cf.param.toc.toc
        use_motor_power = ('motorPowerSet' in toc
                           and 'm1' in toc['motorPowerSet'])

        if use_motor_power:
            # Some firmware versions gate individual motor control
            # behind the enable flag.  Harmless if absent.
            try:
                scf.cf.param.set_value('motorPowerSet.enable', 1)
            except Exception:
                pass

        scf.cf.platform.send_arming_request(True)
        time.sleep(0.5)

        if use_motor_power:
            _spin_each_motor(scf.cf)
            # Hand motor control back to the flight controller so the
            # hover check can use the normal commander pipeline.
            try:
                scf.cf.param.set_value('motorPowerSet.enable', 0)
            except Exception:
                pass
            time.sleep(0.2)
        else:
            print('NOTE: motorPowerSet params not found — all four')
            print('motors will spin together during the hover check.')

        _hover_check(scf.cf)

        scf.cf.commander.send_stop_setpoint()
        time.sleep(0.1)
        scf.cf.platform.send_arming_request(False)

    print('\nDone.')
    print('Remember: correct propeller TYPES (CW/CCW) are just as '
          'important as direction.')
