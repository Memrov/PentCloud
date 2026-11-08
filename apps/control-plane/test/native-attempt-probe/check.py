#!/usr/bin/env python3
"""Real workerd invariants. Run local wrangler with this directory's config first."""
import concurrent.futures
import json
import sys
import urllib.request
import urllib.error
import uuid

base = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8794'
def probe(kind):
    try:
        with urllib.request.urlopen(base + '/' + kind, timeout=55) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise AssertionError((kind, error.code, error.read().decode()[:2000])) from error
    assert 'error' not in result, (kind, result.get('error'))
    return kind, result

_, echoed = probe('header-redaction')
assert 'private-header-marker' not in json.dumps(echoed), echoed
assert '[REDACTED]' in json.dumps(echoed).upper(), echoed
_, packages = probe('package-only')
assert 'pentcloud_tool' in packages['tools'] and not any(name.startswith('pentcloud_kali_') for name in packages['tools']), packages
assert packages['runs'] == packages['stops'] == 1, packages
assert packages['readies'] == packages['initializes'] == 0, packages
assert packages['execution']['drained'] and not packages['execution']['sessionCleanupPending'], packages
assert 'bounded profiles' in packages['prompt'] and 'pentcloud_tool' in packages['skill'], packages
assert 'Kali tools are unavailable' in packages['skill'], packages
assert packages['shell']['exitCode'] == 0 and packages['shell']['stdout'] == 'owned\n', packages
_, compatibility = probe('prompt-compatibility')
for case in compatibility['results']:
    assert case['saved'] == case['replayed'], case
    assert 'template execution is retired' in case['error'] and 'Markdown' in case['error'], case
    assert not case['created'], case
assert compatibility['modelRequests'] == 0, compatibility
# Exercise different DOs concurrently: unique Git directories must prevent global
# isomorphic-git locks from crossing DO-owned SQLite I/O contexts.
with concurrent.futures.ThreadPoolExecutor(max_workers=7) as pool:
    results = dict(pool.map(probe, ['computer', 'computer-coder', 'shell', 'javascript', 'publish', 'cancel', 'replay', 'drain', 'known-running', 'memory', 'research-policy', 'mcp-schema', 'session-stateless', 'session-cleanup-failure', 'metasploit-owned', 'metasploit-unknown', 'metasploit-control-race', 'metasploit-inspect-race', 'metasploit-stale-inventory']))
results['header-secret-redaction'] = {'passed': True}
for kind in ['native-discovery', 'native-discovery-failed', 'native-discovery-empty', 'native-discovery-legacy']:
    _, result = probe(kind)
    assert result['modelRequests'] == 0 and not result['modelKeyConfigured'], result
    assert result['result']['model'] is None and result['record']['model'] is None, result
    assert result['record']['execution_kind'] == 'discovery', result
    assert result['result']['status'] == ('failed' if kind.endswith(('failed','empty')) else 'completed'), result
    assert result['scannerArguments'] == {'target':'http://127.0.0.1/','aggression':'polite' if kind.endswith('legacy') else 'stealthy','timeout':60}, result
    if kind.endswith('empty'):
        assert result['result']['arguments']['scanStatus'] == 'no-http-response', result
    results[kind] = {'passed': True}
_, model_probe = probe('native-model-probe')
assert model_probe['requests'] == [{'native': True, 'authenticated': True, 'model': 'fixture-console', 'tools': 0}], model_probe
assert model_probe['empty'], model_probe
_, pinned_model = probe('native-pinned-model')
assert pinned_model['model'] == 'opencode:fixture-console' and pinned_model['modelRequests'] == 1, pinned_model
results['native-model-connection'] = {'passed': True}
_, finding_contract = probe('finding-contract')
assert finding_contract['proposalAfterMissing'] is False
assert finding_contract['version'] == 1 and finding_contract['modelRequests'] == 0
assert len(finding_contract['outputCommit']) == 40
_, live_transport = probe('sdk-live-transport')
assert live_transport['partialBeforeEnd'] and live_transport['evidenceRetained'], live_transport
assert live_transport['stops'] == 1 and live_transport['remainingStreams'] == 0, live_transport
assert live_transport['modelRequests'] == live_transport['kaliReadies'] == 0, live_transport
assert not live_transport['secretLeak'], live_transport
assert live_transport['completedSnapshotRetained'], live_transport
assert not live_transport['quotedSecretLeak'] and not live_transport['overlapDuplicated'] and live_transport['permittedSummary'], live_transport
results['sdk-live-transport'] = {'passed': True}
_, cold_history = probe('sdk-terminal-cold')
assert cold_history['before'] > 0 and cold_history['after'] == cold_history['before'], cold_history
assert 'event: end\n' in cold_history['events'] and 'Retained terminal conversation' in cold_history['events'], cold_history
assert cold_history['credentialReads'] == cold_history['modelRequests'] == cold_history['kaliReadies'] == 0, cold_history
assert not cold_history['canReply'] and cold_history['steerDenied'], cold_history
assert cold_history['activeWorkDenied'] and cold_history['crossRunWorkDenied'], cold_history
assert cold_history['recorded']['messages'] == cold_history['before'] and cold_history['recorded']['historyAvailable'], cold_history
assert cold_history['recorded']['pages'] >= 4 and cold_history['recorded']['remote'] == 'unknown', cold_history
assert cold_history['recorded']['outputLength'] > 100000, cold_history
results['cold-terminal-history'] = {'passed': True}
# Real native conversation, scripted loopback model and actual Git checkout.
for case in ['preparation-chat', 'preparation-stop', 'preparation-chat?failure=clone', 'preparation-chat?failure=reload']:
    _, prepared = probe(case)
    assert set(prepared['before']['tools']['names']) == {'computer_read','computer_ls','computer_find','computer_grep','pentcloud_progress','question'}, prepared
    assert prepared['before']['users'] == 1 and prepared['before']['readies'] == 0, prepared
    assert prepared['writeDenied'] and prepared['resultDenied'], prepared
    if case.startswith('preparation-chat'):
        assert prepared['after']['session'] == prepared['before']['session'], prepared
        assert prepared['after']['users'] == 2 and prepared['after']['source'] == prepared['expected'], prepared
        assert prepared['after']['retained'] and prepared['after']['discoveryDelivered'] and prepared['formAnswered'], prepared
        assert prepared['changedReplayDenied'] and 'done' in prepared['after']['tools']['names'], prepared
        assert 'accepted baseline' in prepared['read']['content'], prepared
        if '?failure=' in case:
            assert prepared['firstFailure'] and prepared['pendingAfterFailure'], prepared
    else:
        assert prepared['steerDenied'] and prepared['readiness']['drained'], prepared
    results[case] = {'passed': True}
# Keep the focused passive purge regression part of the complete runtime gate.
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).with_name('check-purge.py')), run_name='__main__')
key, browser_view = probe('browser-live-view')
results[key] = browser_view
assert browser_view['absent'] == {'available': False} and browser_view['absentNoWrites'], browser_view
assert browser_view['created'] and browser_view['activeNoWrites'] and browser_view['cancelled'] and browser_view['cancellationRace'], browser_view
assert browser_view['credentialsNotStored'] and browser_view['lifecycleNotStarted'], browser_view
assert browser_view['browserReads'] == browser_view['providerCalls'] == 2, browser_view
assert browser_view['options'] == {'mode': 'tab', 'targetId': 'existing-page', 'expiresInMs': 60000, 'guardrails': {'mode': 'readonly'}}, browser_view
# OpenCode instances match production's one-active admission. Dispose each
# fixture after capturing the actual provider boundary, before opening another.
key, recovery = probe('platform-recovery')
results[key] = recovery
key, backoff = probe('platform-backoff')
results[key] = backoff
assert backoff['controlsFenced'] and backoff['lifecycleStartupSkipped'] and backoff['after']['canReply'], backoff
assert recovery['before']['recovery']['sealed'] and not recovery['before']['drained'], recovery
assert recovery['before']['unresolvedRemote'] == 1 and recovery['staleRejected'] and recovery['unknownRejected'] and recovery['callFenced'] and recovery['controlsFenced'], recovery
assert recovery['lifecycleStartupSkipped'], recovery
assert recovery['rearmed']['rearmed'] and 'recovery' not in recovery['after'] and recovery['after']['unresolvedRemote'] == 0, recovery
platform_name = 'platform-' + uuid.uuid4().hex
_, held_platform = probe('platform-recovery-held?name=' + platform_name)
assert held_platform['lifecycleStartupSkipped'] and held_platform['controlsFenced'], held_platform
try:
    urllib.request.urlopen(base + '/evict?name=' + platform_name, timeout=15).read()
except (urllib.error.HTTPError, urllib.error.URLError):
    pass
_, recovered_platform = probe('after-platform-eviction?name=' + platform_name)
assert recovered_platform['before']['recovery']['sealed'] and recovered_platform['controlsFenced'] and recovered_platform['lifecycleStartupSkipped'], recovered_platform
assert not recovered_platform['before']['drained'] and recovered_platform['before']['unresolvedRemote'] == 1, recovered_platform
assert recovered_platform['cancelled']['state'] == 'cancelled' and not recovered_platform['cancelled']['drained'] and recovered_platform['cancelled']['unresolvedRemote'] == 1, recovered_platform
results['platform-recovery-eviction'] = {'passed': True}
roles = ['primary','adviser','reporter','coder','maintenance','memorist','pentester','searcher']
toolbox_name = 'toolbox-' + uuid.uuid4().hex
_, paused_toolbox = probe('toolbox-eviction?name=' + toolbox_name)
assert paused_toolbox['users'] == paused_toolbox['models'] == 1 and len(paused_toolbox['pending']) == 1, paused_toolbox
try:
    urllib.request.urlopen(base + '/evict?name=' + toolbox_name, timeout=15).read()
except (urllib.error.HTTPError, urllib.error.URLError):
    pass
_, resumed_toolbox = probe('after-toolbox-eviction?name=' + toolbox_name)
assert resumed_toolbox['queued'] == 1 and resumed_toolbox['afterAlarm']['wakes'] == 0, resumed_toolbox
assert resumed_toolbox['afterAlarm']['models'] == resumed_toolbox['modelsBefore'] == 1, resumed_toolbox
assert resumed_toolbox['afterAlarm']['readies'] == resumed_toolbox['readiesBefore'], resumed_toolbox
assert resumed_toolbox['modelsAfter'] == 2 and resumed_toolbox['users'] == 1 and resumed_toolbox['calls'] == 0, resumed_toolbox
results['toolbox-submitted-eviction'] = {'passed': True}
for case in ['sdk-toolbox-cold', 'toolbox-activity', 'toolbox-generation-loss', 'toolbox-cleanup-lost', 'toolbox-upstream-conflict', 'toolbox-legacy-session']:
    key, value = probe(case)
    results[key] = value
cold = results['sdk-toolbox-cold']
assert cold['before']['readies'] > 0 and cold['before']['initializes'] == cold['before']['modelRequests'] == 0, cold
assert cold['after']['generation'] == cold['after']['session']['generation'] == 'fixture-generation', cold
assert len(cold['after']['catalog']['tools']) == 126 and cold['after']['modelRequests'] == 1, cold
assert cold['after']['initializes'] == 2 and cold['after']['deletes'] == 1, cold
assert cold['after']['modelsAtPartial'] == 0 and not cold['after']['partialCatalogWasPinned'], cold
activity = results['toolbox-activity']
assert activity == {'withoutOwnership': 0, 'active': 1, 'drained': 1, 'held': 2, 'readies': 0}, activity
lost = results['toolbox-generation-loss']
assert lost['blocked'] == 3 and lost['initializes'] == lost['firstInitializes'] == 1, lost
assert lost['execution']['unresolvedRemote'] == 1 and not lost['execution']['drained'], lost
assert lost['receipts'][0]['state'] == 'unknown' and lost['session']['generation'] == 'fixture-generation', lost
assert not lost['cancelled']['drained'] and lost['cancelled']['unresolvedRemote'] == 1, lost
assert lost['reconciled']['drained'] and not lost['sessionAfterReconciled'], lost
cleanup = results['toolbox-cleanup-lost']
assert cleanup['after']['drained'] and not cleanup['sessionHeld'] and cleanup['initializes'] == 1 and cleanup['deletes'] == 0, cleanup
conflict = results['toolbox-upstream-conflict']
assert not conflict['after']['drained'] and conflict['sessionHeld'] and conflict['initializes'] == 1, conflict
assert conflict['recovered']['drained'] and not conflict['sessionAfterRecovery'], conflict
legacy = results['toolbox-legacy-session']
assert not legacy['after']['drained'] and legacy['sessionHeld'] and legacy['initializes'] == legacy['readies'] == 0, legacy
key, managed_specialist = probe('sdk-managed-specialist')
results[key] = managed_specialist
assert managed_specialist['profile']['id'] == 'pentcloud-coder', managed_specialist
assert managed_specialist['skillLoaded'], managed_specialist
assert any(skill['id'] == 'pentcloud-tools' for skill in managed_specialist['skills']), managed_specialist
assert 'skill' in managed_specialist['providerTools']['names'], managed_specialist
assert 'question' not in managed_specialist['providerTools']['names'], managed_specialist
key, managed_primary = probe('sdk-managed-specialist-primary')
results[key] = managed_primary
assert managed_primary['profile']['id'] == 'pentcloud-primary', managed_primary
assert managed_primary['skillLoaded'] and {'skill', 'question'} <= set(managed_primary['providerTools']['names']), managed_primary
for sdk_case in ['sdk-managed-session','sdk-startup','sdk-searcher-tools','sdk-memorist-tools','sdk-pentester-tools', *['sdk-role-'+role for role in roles]]:
    key, value = probe(sdk_case)
    results[key] = value
    if sdk_case != 'sdk-managed-session':
        assert 'event: end\n' in value['terminalEvents'], (sdk_case, value)
    if sdk_case.startswith('sdk-role-'):
        assert bool(value['toolboxReadies']) == (sdk_case[9:] in ['coder','maintenance','pentester']), (sdk_case,value['toolboxReadies'])
        snapshot_frame = value['terminalEvents'].split('\n\n', 1)[0]
        snapshot_value = json.loads(next(line[6:] for line in snapshot_frame.splitlines() if line.startswith('data: ')))
        assert snapshot_value['result']['status'] == 'interrupted', (sdk_case, snapshot_value)
managed = results['sdk-managed-session']
assert managed['wrongSessionRejected'] and managed['invalidAnswerRejected'] and managed['duplicateRejected'] and managed['lateRejected'], managed
assert managed['answered']['state'] == {'status': 'answered', 'answer': {'continue': True}}, managed
assert managed['cancelled']['state'] == {'status': 'cancelled', 'message': 'Operator declined'}, managed
assert managed['fenced']['state']['status'] == 'pending', managed
assert managed['pending']['canReply'] and len(managed['pending']['forms']) == 1, managed
assert managed['pending']['usage']['stats']['steps'] == 0 and managed['pending']['usage']['limits'] is None, managed
assert managed['nativePermissionList'] == [], managed
assert managed['permissionDuplicateRejected'] and managed['permission']['effect'] == 'ask', managed
assert managed['permissionPending']['permissions'][0]['id'] == 'per_managed_probe', managed
native_names = {'pentcloud_read_evidence','cloudflare_browser','computer_read','computer_ls','computer_find','computer_grep','computer_write','computer_edit','computer_delete','computer_exec'}
for role in roles:
    names=set(results['sdk-role-'+role]['providerTools']['names'])
    assert not {'file','terminal','workspace_javascript'} & names, (role, names)
    assert native_names <= names, (role, sorted(native_names-names))
    kali_names={'pentcloud_kali_import','pentcloud_kali_files','pentcloud_kali_export'}
    assert (kali_names <= names) if role in ('coder','maintenance','pentester') else not (kali_names & names), (role, names)
    assert ('execute' in names) == (role in ['coder','maintenance','pentester']), (role,names)
source_computer = results['computer-coder']
assert 'bytesWritten' in source_computer['write']['content'] and 'native marker' in source_computer['read']['content'], source_computer
assert 'editsApplied' in source_computer['edit']['content'] and 'edited marker' in source_computer['exec']['content'] and source_computer['deleted'], source_computer
computer = results['computer']
assert 'accepted baseline' in computer['read']['content'], computer
assert 'computer native marker' in computer['exec']['content'] and '"exitCode":0' in computer['exec']['content'], computer
assert '42' in computer['javascript']['content'], computer
assert 'cannot change source' in computer['source']['content'], computer
assert 'error' in computer['escape']['content'] and 'error' in computer['git']['content'], computer
assert 'error' in computer['symlink']['content'] and 'error' in computer['captured']['content'], computer
assert all('retired' in error for error in computer['retired'].values()), computer
assert not computer['drainedDuring'] and computer['rejectedAfterCancel'] and computer['drainedAfter'], computer
assert computer['cwdBlocked'] and computer['lateBlocked'] and computer['baseline'] == 'accepted baseline\n', computer
shell = results['shell']
assert shell['read']['exitCode'] == 0 and shell['read']['stdout'] == 'accepted baseline\n', shell
assert shell['git']['exitCode'] == 0, shell
assert shell['blockGit']['exitCode'] != 0 and shell['blockSource']['exitCode'] != 0, shell
assert shell['baseline'] == 'accepted baseline\n', shell
assert shell['evidence']['exitCode'] == 0 and 'native-shell' in shell['evidence']['stdout'], shell
assert shell['unsupported']['exitCode'] == 127, shell
assert shell['timeout'] and shell['drainedAfterTimeout'], shell
assert shell['outputWindow']['exitCode'] == 0 and '2500' in shell['outputWindow']['stdout'] and '\n1\n' not in shell['outputWindow']['stdout'], shell
assert shell['curl']['exitCode'] == 0, shell['curl']
assert json.loads(shell['curl']['stdout'].replace('\r\n', '\n').split('\n\n', 1)[1]) == {'method': 'POST', 'header': 'native', 'body': 'curl fixture body'}, shell['curl']
assert shell['curlFile'] == shell['curl']['stdout'], shell
assert '207' in shell['curlFile'] and 'application/json' in shell['curlFile'].lower(), shell
javascript = results['javascript']
assert javascript['scratch']['exitCode'] == 0 and javascript['scratch']['stdout'] == 'isolated scratch\n', javascript
assert javascript['memory']['exitCode'] == 0, javascript
assert javascript['blockEscape']['exitCode'] != 0 and javascript['fileWrite']['exitCode'] != 0, javascript
assert javascript['fileRead']['exitCode'] != 0 and javascript['invalidArguments']['exitCode'] != 0, javascript
for name in ['publish', 'replay']:
    published = results[name]
    assert published['main'] == published['base'] and published['head'] != published['base'], published
    assert published['terminal']['outputCommit'] == published['head'], published
    assert all(push == {'ref': 'attempts/local-attempt', 'remoteRef': 'attempts/local-attempt'} for push in published['published']), published
    assert published['result']['input_commit'] == published['base'] and published['result']['role'] == 'primary', published
    assert published['result']['runtime_provenance'] == {'initialized': {'id': 'probe-initialized', 'tag': 'fixture'}, 'terminal': {'id': 'probe-terminal', 'tag': 'fixture'}}, published
    assert published['terminal']['runtime'] == published['result']['runtime_provenance'], published
assert results['replay']['replayedHead'] == results['replay']['head'], results['replay']
assert results['replay']['replayed']['outputCommit'] == results['replay']['head'], results['replay']
cancelled = results['cancel']
assert cancelled['lateRejected'] and not cancelled['published'], cancelled
assert cancelled['state']['result']['status'] == 'interrupted', cancelled
assert cancelled['state']['result']['runtime']['terminal']['id'] == 'probe-terminal', cancelled
drain = results['drain']
assert not drain['before']['drained'] and drain['lateRejected'] and drain['after']['drained'], drain
assert drain['after']['state'] == 'cancelled' and not drain['published'], drain
known = results['known-running']
assert known['newCallFenced'] and known['starts'] == 1, known
assert not known['before']['drained'] and known['before']['unresolvedRemote'] == 1, known
assert known['after']['drained'] and known['after']['unresolvedRemote'] == 0, known
assert results['mcp-schema']['initialized'] and results['mcp-schema']['result']['structuredContent']['ok'], results['mcp-schema']
memory = results['memory']
assert any(path.startswith('.pentagi/memory/code/') for path in memory['committedFiles']), memory
assert memory['found']['matches'] and any('native-memory-marker' in match['text'] for match in memory['found']['matches']), memory
key, memory_contract = probe('memory-contract')
results[key] = memory_contract
assert any(match['text'] == 'same-attempt-needle' for match in memory_contract['sameAttempt']['matches']), memory_contract
assert memory_contract['wrongLanguage']['matches'] == memory_contract['wrongAnswerType']['matches'] == [], memory_contract
for result_key, stored_key in [('guides', 'install'), ('answers', 'answer'), ('scoped', 'scoped'), ('argumentScoped', 'argumentScoped')]:
    assert {match['path'] for match in memory_contract[result_key]['matches']} == {memory_contract['paths'][stored_key]['path']}, memory_contract
assert memory_contract['mappedButNoMatch']['matches'] == [], memory_contract
assert 'Cannot map' in memory_contract.get('unmapped', '') and 'Cannot map' in memory_contract.get('unmappedSubtask', ''), memory_contract
assert {match['path'] for match in memory_contract['legacy']['matches']} == {'.pentagi/memory/code/legacy.md'}, memory_contract
assert memory_contract['noModel'] == memory_contract['noScanner'] == 0, memory_contract
assert results['research-policy']['scopeRejected'] and results['research-policy']['mutationRejected'], results['research-policy']
assert 'web_search' in results['research-policy']['enabledTools'], results['research-policy']
owned = results['metasploit-owned']
assert owned['newCallFenced'] and owned['unownedRejected'] and owned['launches'] == 1 and owned['stops'] == 2, owned
assert not owned['before']['drained'] and not owned['afterJob']['drained'], owned
assert owned['stop']['verified'] and not owned['stop']['settled'] and owned['stopDuplicate'] == owned['stop'], owned
assert owned['terminate']['verified'] and owned['terminate']['settled'] and owned['after']['drained'], owned
assert all(owned['inspectOrder'][i:i+2] == ['jobs','sessions'] for i in range(0,len(owned['inspectOrder']),2)), owned
unknown_msf = results['metasploit-unknown']
assert unknown_msf['newCallFenced'] and unknown_msf['unownedRejected'] and unknown_msf['unknownControlRejected'], unknown_msf
assert not unknown_msf['after']['drained'] and unknown_msf['launches'] == 1 and unknown_msf['stops'] == 0, unknown_msf
for race_name in ['metasploit-control-race','metasploit-inspect-race']:
    race = results[race_name]
    assert not race['during']['drained'] and race['closesDuring'] == 0, race
    assert race['after']['drained'] and race['closes'] == 1 and race['opensAfterClose'] == 0 and race['stops'] == 0, race
    assert race['retiredControlRejected'] and race['retiredInspectionRejected'], race
    assert (race['requestOutcome'].startswith('403:') if race_name == 'metasploit-control-race' else race['requestOutcome'] == 'fulfilled'), race
stale_inventory = results['metasploit-stale-inventory']
assert stale_inventory['afterStale'][0]['owned']['needsSessionInspection'] and stale_inventory['afterStale'][0]['state'] == 'running', stale_inventory
assert not stale_inventory['after']['drained'] and stale_inventory['terminate']['verified'] and stale_inventory['terminate']['settled'], stale_inventory
startup = results['sdk-startup']
assert not startup['storedModelSecret'], 'Native SDK session storage must not persist the binding value'
assert startup['startup']['stage'] == 'model.request.ready' and startup['startup']['promptCharacters'] > 1000, startup
assert startup['messages'] == 2, startup
assert startup['answer']['status'] == 'unanswered' and startup['answer']['reason'] == 'failed', startup
import pathlib
browser_schema = next(tool['input_schema'] for tool in json.loads((pathlib.Path(__file__).resolve().parents[4]/'contracts/pentagi-tools.json').read_text())['tools'] if tool['name']=='browser')
searcher_tools = results['sdk-searcher-tools']['providerTools']
assert set(searcher_tools['names']) == native_names | {'browser','memorist','search_answer','search_result','store_answer','web_search'}, searcher_tools
assert searcher_tools['browser'] == browser_schema, searcher_tools
memorist_tools = results['sdk-memorist-tools']['providerTools']
assert memorist_tools['browser'] is None and 'browser' not in memorist_tools['names'] and 'web_search' not in memorist_tools['names'], memorist_tools
pentester_tools = results['sdk-pentester-tools']['providerTools']
assert pentester_tools['browser'] == browser_schema and 'execute' in pentester_tools['names'], pentester_tools
assert 'webfetch' not in pentester_tools['names'] and not any(name.startswith(('browser.','browser_')) for name in pentester_tools['names']), pentester_tools
name = 'unknown-' + uuid.uuid4().hex
_, unknown = probe('unknown?name=' + name)
assert unknown['firstLost'] and unknown['newCallFenced'] and unknown['starts'] == 1, unknown
assert not unknown['before']['drained'] and not unknown['cancelled']['drained'], unknown
try:
    urllib.request.urlopen(base + '/evict?name=' + name, timeout=15).read()
except (urllib.error.HTTPError, urllib.error.URLError):
    pass  # ctx.abort intentionally rejects its own RPC.
_, restored = probe('after-eviction?name=' + name)
assert not restored['before']['drained'] and restored['before']['unresolvedRemote'] == 1, restored
assert restored['newCallFenced'] and restored['starts'] == 1 and restored['wrongProofRejected'] and restored['missingAttestationRejected'], restored
assert restored['after']['drained'] and restored['after']['unresolvedRemote'] == 0, restored
results['unknown-eviction-reconciliation'] = {'passed': True}
stateless = results['session-stateless']
assert stateless['initializes'] == 2 and stateless['deletes'] == 0 and not stateless['saved'], stateless
cleanup = results['session-cleanup-failure']
assert cleanup['savedBeforeMutation'] and cleanup['initializes'] == 1 and cleanup['deletesBefore'] == 0, cleanup
assert not cleanup['before']['drained'] and cleanup['before']['sessionCleanupPending'], cleanup
assert all(item['saved'] and not item['execution']['drained'] for item in cleanup['refused']), cleanup
assert cleanup['after']['drained'] and not cleanup['savedAfter'] and cleanup['deletes'] == 1, cleanup
session_name = 'session-' + uuid.uuid4().hex
_, original_session = probe('session?name=' + session_name)
assert original_session['lost'] and original_session['savedBeforeMutation'], original_session
assert original_session['initializes'] == 1 and original_session['deletesBefore'] == 0 and not original_session['before']['drained'], original_session
try:
    urllib.request.urlopen(base + '/evict?name=' + session_name, timeout=15).read()
except (urllib.error.HTTPError, urllib.error.URLError):
    pass
_, resumed = probe('after-session-eviction?name=' + session_name)
assert not resumed['before']['drained'] and resumed['reusedSid'], resumed
assert resumed['wireIdsUnique'] and not resumed['collision'] and resumed['oldPendingRetained'] and resumed['cancelOnlyNew'], resumed
assert resumed['initializes'] == 1 and resumed['deletes'] == 1 and resumed['deleteAfterProof'], resumed
assert resumed['after']['drained'] and not resumed['saved'], resumed
results['session-eviction-retirement'] = {'passed': True}
print(json.dumps({'passed': True, 'runtime': 'workerd', 'checks': list(results), 'externalSubstitutes': ['model abort', 'Artifacts push/read', 'Coordinator authority', 'lost remote mutation/inspection responses']}))
