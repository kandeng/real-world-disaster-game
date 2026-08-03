import logging
import sys
import time
import warnings
from threading import Event

import cflib.crtp
from cflib.crazyflie import Crazyflie
from cflib.crazyflie.log import LogConfig
from cflib.crazyflie.syncCrazyflie import SyncCrazyflie
from cflib.positioning.motion_commander import MotionCommander

# URI of the Crazyflie to connect to (radio link via the Crazyradio PA):
#   radio://<dongle>/<channel>/<datarate>/<address>
URI = 'radio://0/80/2M/E7E7E7E7E7'

DEFAULT_HEIGHT = 0.5
BOX_LIMIT = 0.5

deck_attached_event = Event()

logging.basicConfig(level=logging.ERROR)

# This drone runs a custom firmware build (CRTP protocol v6). cflib emits three
# harmless compatibility warnings — the legacy codepaths it falls back to are
# exactly what this firmware needs. Suppress them all.
warnings.filterwarnings(
    'ignore',
    message=r'Using legacy TYPE_.*_LEGACY',  # hover/zdistance packet types
    category=DeprecationWarning,
)
warnings.filterwarnings(
    'ignore',
    message=r'platform\.send_arming_request is deprecated',
    category=DeprecationWarning,
)
warnings.filterwarnings(
    'ignore',
    message=r'supervisor subsystem requires CRTP protocol version 12 or later',
    category=UserWarning,
)

position_estimate = [0, 0]


def move_box_limit(scf):
    with MotionCommander(scf, default_height=DEFAULT_HEIGHT) as mc:
        body_x_cmd = 0.2
        body_y_cmd = 0.1
        max_vel = 0.2

        # Exit if the radio link drops (e.g. the Crazyradio was unplugged as
        # an emergency stop) — cflib silently drops packets on a dead link,
        # so without this check the loop would spin forever doing nothing.
        while scf.is_link_open():
            #if position_estimate[0] > BOX_LIMIT:
            #    mc.start_back()
            #elif position_estimate[0] < -BOX_LIMIT:
            #    mc.start_forward()

            if position_estimate[0] > BOX_LIMIT:
                body_x_cmd = -max_vel
            elif position_estimate[0] < -BOX_LIMIT:
                body_x_cmd = max_vel
            if position_estimate[1] > BOX_LIMIT:
                body_y_cmd = -max_vel
            elif position_estimate[1] < -BOX_LIMIT:
                body_y_cmd = max_vel

            mc.start_linear_motion(body_x_cmd, body_y_cmd, 0)

            time.sleep(0.1)

    print('Radio link lost — script exiting.')


def log_pos_callback(timestamp, data, logconf):
    print(f'{{"x": {data["stateEstimate.x"]:.4e},'
          f' "y": {data["stateEstimate.y"]:.4e},'
          f' "z": {data["stateEstimate.z"]:.4e}}}')
    global position_estimate
    position_estimate[0] = data['stateEstimate.x']
    position_estimate[1] = data['stateEstimate.y']


def param_deck_flow(_, value_str):
    value = int(value_str)
    print(value)
    if value:
        deck_attached_event.set()
        print('Deck is attached!')
    else:
        print('Deck is NOT attached!')


if __name__ == '__main__':
    cflib.crtp.init_drivers()

    with SyncCrazyflie(URI, cf=Crazyflie(rw_cache='./cache')) as scf:

        scf.cf.param.add_update_callback(group='deck', name='bcFlow2',
                                         cb=param_deck_flow)
        time.sleep(1)

        logconf = LogConfig(name='Position', period_in_ms=10)
        logconf.add_variable('stateEstimate.x', 'float')
        logconf.add_variable('stateEstimate.y', 'float')
        logconf.add_variable('stateEstimate.z', 'float')
        scf.cf.log.add_config(logconf)
        logconf.data_received_cb.add_callback(log_pos_callback)

        if not deck_attached_event.wait(timeout=5):
            print('No flow deck detected!')
            sys.exit(1)

        # Arm the Crazyflie
        scf.cf.platform.send_arming_request(True)
        time.sleep(1.0)

        logconf.start()
        move_box_limit(scf)
        logconf.stop()