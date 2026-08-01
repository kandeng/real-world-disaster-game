"""Step 1: connect to the Crazyflie over the Crazyradio PA and read the
battery voltage — the smallest possible end-to-end check of the radio link.

Run:  python 01_connect.py
"""
import logging

import cflib.crtp
from cflib.crazyflie import Crazyflie
from cflib.crazyflie.syncCrazyflie import SyncCrazyflie

# URI of the Crazyflie to connect to (radio link via the Crazyradio PA):
#   radio://<dongle>/<channel>/<datarate>/<address>
# Adjust if the drone was provisioned to a different channel/address.
URI = 'radio://0/80/2M/E7E7E7E7E7'

# Only output errors from the logging framework
logging.basicConfig(level=logging.ERROR)

if __name__ == '__main__':
    # Initialize the low-level drivers (scans for the Crazyradio)
    cflib.crtp.init_drivers()

    with SyncCrazyflie(URI, cf=Crazyflie(rw_cache='./cache')) as scf:
        print('Link open:', scf.is_link_open())
        # Parameter values are refreshed automatically right after connect
        vbat = float(scf.cf.param.get_value('pm.vbat'))
        print(f'Battery: {vbat:.2f} V  (fly only if >= 3.9 V)')

    print('Disconnected cleanly.')
