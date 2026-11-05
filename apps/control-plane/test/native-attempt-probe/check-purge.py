#!/usr/bin/env python3
"""Focused real-workerd purge checks; no model, scanner or production calls."""
import json
import sys
import urllib.request
import urllib.error

base = sys.argv[1].rstrip('/')
def get(path):
    with urllib.request.urlopen(base + path, timeout=30) as response:
        return json.load(response)

value = get('/purge?name=purge-focused')
for key in ['wrongRun', 'running', 'persistedPublishing', 'unknown', 'inflight', 'localRunning', 'publishing', 'session', 'reused']:
    assert '409:' in value[key], (key, value)
assert value['purged'] == value['repeat'] == {'runId': 'local-run', 'purged': True}, value
assert value['keys'] == value['finalKeys'] == [['purgedRunId', 'local-run']], value
assert value['alarm'] is None and 'purge_probe' not in value['tables'], value
assert all(name.startswith(('_cf', '__cf', 'sqlite_')) for name in value['tables']), value
for key in ['replay', 'controls', 'events']:
    assert '410:' in value[key], (key, value)
assert value['execution'] == {'state': 'absent', 'drained': True, 'unresolvedRemote': 0, 'sessionCleanupPending': False}, value
# Recreate the isolate to verify the fence is durable, not an in-memory flag.
try:
    get('/evict?name=purge-focused')
except Exception:
    pass  # ctx.abort intentionally terminates this request.
cold = get('/after-purge?name=purge-focused')
assert cold['keys'] == [['purgedRunId', 'local-run']] and cold['alarm'] is None, cold
assert '410:' in cold['replay'] and '410:' in cold['inspect'], cold
assert cold['browser'] == {'available': False} and cold['readiness']['drained'], cold
assert get('/purge-absent?name=purge-never-initialized') == {'runId': 'local-run', 'purged': True}
try:
    get('/purge-failure?name=purge-interrupted')
    raise AssertionError('cleanup failure should abort the request')
except urllib.error.HTTPError as error:
    message = error.read().decode()
    assert error.code == 500 and "LOCAL_PURGE_CLEANUP_INTERRUPTED" in message, message
interrupted = get('/after-purge?name=purge-interrupted')
assert ['purgedRunId', 'local-run'] in interrupted['keys'] and '410:' in interrupted['replay'], interrupted
assert get('/purge-absent?name=purge-interrupted') == {'runId': 'local-run', 'purged': True}
assert get('/after-purge?name=purge-interrupted')['keys'] == [['purgedRunId', 'local-run']]
print(json.dumps({'purge': 'passed', 'conflicts': 9, 'durable_fence_after_eviction': True, 'absent_attempt': True}))
