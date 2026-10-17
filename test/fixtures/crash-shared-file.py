import importlib.util
import json
import os
import signal
import sys
import time

spec = importlib.util.spec_from_file_location('transactions', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
boundary = sys.argv[2]
prepared = False

def phase(name):
    global prepared
    if name == 'prepared':
        prepared = True
    if boundary == 'hold' and name == 'locked':
        print('LOCKED', flush=True)
        while True:
            time.sleep(1)
    if name == boundary and (name != 'staged' or prepared):
        os.kill(os.getpid(), signal.SIGKILL)

module.phase = phase
print(json.dumps(module.execute(json.load(sys.stdin))))
