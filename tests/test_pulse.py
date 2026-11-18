import copy
import base64
from unittest.mock import Mock, patch
import hashlib
import json
import os
import shutil
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

REPO = Path(__file__).resolve().parents[1]
SOURCE = REPO / "src"
sys.path.insert(0, str(SOURCE))
from project_pulse import __version__
from project_pulse.data import CodexReader, Store, desktop_unread_index, display_title, project_for, status_of
from project_pulse.server import Service, start
from project_pulse.ui_resource import URI, MIME, resource


class PulseTest(unittest.TestCase):
    def setUp(self):
        # The Codex adapter is tested alone; never read the developer's other agents.
        self.isolation = __import__('unittest.mock').mock.patch.dict(os.environ, {'PULSE_CLAUDE_DIRS': '', 'PULSE_MAGPIE_BIN': ''})
        self.isolation.start()
        self.addCleanup(self.isolation.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = self.root / 'codex'
        self.home.mkdir()
        self.now = int(time.time())
        state = {'local-projects': {'p1': {'name': 'Parent', 'rootPaths': ['/work/app']}, 'p2': {'name': 'Child', 'rootPaths': ['/work/app/child']}}, 'thread-project-assignments': {'assigned': {'projectId': 'p1'}}}
        state['electron-thread-read-state-v1'] = {
            'version': 1,
            'unreadByIdentity': {'account-a': {'local:machine-a': ['s1']}},
            'legacyMigration': {'identityKey': 'account-a', 'adoptedHostIds': {'local': 'local:machine-a'}, 'unreadThreadIdsByHostId': {'local': ['s1']}, 'cleared': True},
        }
        (self.home / '.codex-global-state.json').write_text(json.dumps(state))
        with sqlite3.connect(self.home / 'state_5.sqlite') as db:
            db.executescript('CREATE TABLE threads(id TEXT, cwd TEXT, title TEXT, updated_at INTEGER, archived INTEGER, agent_path TEXT, project_id TEXT, source TEXT); CREATE TABLE thread_read_receipts(thread_id TEXT,first_unread_turn TEXT,last_published_turn TEXT,revision TEXT);')
            db.executemany('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)', [('s1','/work/app','Completed',self.now,0,None,None,'vscode'), ('s2','/work/app/child','Running',self.now,0,None,None,'vscode'), ('assigned','/work/app/child','Assigned',self.now,0,None,None,'vscode'), ('sub','/work/app','Subagent',self.now,0,'/root/sub',None,'vscode'), ('archived','/work/app','Archive',self.now,1,None,None,'vscode'), ('similar','/work/app2','Another path',self.now,0,None,None,'vscode')])
            db.execute('INSERT INTO thread_read_receipts VALUES(?,?,?,?)',('s1','t1','t1','rev1'))
        with sqlite3.connect(self.home / 'thread_history_1.sqlite') as db:
            db.executescript('CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER); CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_type TEXT,item_json TEXT,rollout_ordinal INTEGER);')
            db.executemany('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)',[('s1','t1','completed',self.now-30,self.now,1),('s2','t2','inProgress',self.now,None,1)])
            db.execute('INSERT INTO thread_items VALUES(?,?,?,?,?)',('s1','t1','agentMessage',json.dumps({'text':'Final answer','phase':'final_answer'}),1))
            db.execute('INSERT INTO thread_items VALUES(?,?,?,?,?)',('s1','t1','reasoning',json.dumps({'text':'Never expose reasoning'}),2))
        self.reader = CodexReader(self.home)
        self.store = Store(self.root / 'personal')
        self.service = Service(self.reader, self.store)

    def tearDown(self):
        self.tmp.cleanup()

    def test_reads_only_imported_main_sessions_and_longest_project_root(self):
        paths = list(self.home.iterdir())
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
        snapshot = self.reader.snapshot()
        self.assertEqual({s['id'] for s in snapshot['sessions']}, {'s1','s2','assigned'})
        self.assertEqual({s['id']:s['projectId'] for s in snapshot['sessions']}, {'s1':'p1','s2':'p2','assigned':'p1'})
        self.assertEqual(before,{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths})
        self.assertEqual(self.reader.result('s1')['text'],'Final answer')

    def test_reads_wal_database_after_app_removed_its_sidecar_files(self):
        path = self.home / 'thread_history_1.sqlite'
        with sqlite3.connect(path) as db:
            db.execute('PRAGMA journal_mode=WAL')
        with sqlite3.connect(path) as db:
            db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        for suffix in ('-wal', '-shm'):
            path.with_name(path.name + suffix).unlink(missing_ok=True)
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        self.assertEqual(self.reader.result('s1')['text'], 'Final answer')
        self.assertEqual({s['id'] for s in self.reader.snapshot()['sessions']}, {'s1', 's2', 'assigned'})
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)
        self.assertFalse(path.with_name(path.name + '-shm').exists())

    def test_complete_and_unknown_are_not_guessed_from_idle(self):
        self.assertEqual(status_of(None,self.now,self.now),'unknown')
        self.assertEqual(status_of({'status':'inProgress'},self.now-8000,self.now),'unknown')
        self.assertEqual(status_of({'status':'interrupted'},self.now,self.now),'interrupted')
        self.assertEqual(status_of({'status':'completed'},self.now,self.now),'completed')
        snapshot=self.service.snapshot()
        self.assertTrue(next(s for s in snapshot['sessions'] if s['id']=='s1')['needsReview'])
        self.assertFalse(next(s for s in snapshot['sessions'] if s['id']=='s2')['needsReview'])

    def test_attachment_wrappers_do_not_replace_user_request_in_titles(self):
        raw='# Files mentioned by the user:\n## image.png: /tmp/image.png\nImage attachment: true\n## My request:\n修复导出报错'
        self.assertEqual(display_title(raw),'修复导出报错')
        self.assertEqual(display_title('普通的会话标题'),'普通的会话标题')
        self.assertEqual(display_title('# Files mentioned by the user:\n## image.png'),'含附件的会话')

    def test_acknowledgement_is_separate_from_desktop_read_and_new_turns(self):
        snap=self.service.snapshot()
        s=next(s for s in snap['sessions'] if s['id']=='s1')
        self.service.action('acknowledge',{'id':'s1','turnId':s['turnId'],'readRevision':s['readRevision']})
        self.assertTrue(self.service.session('s1')['acknowledged'])
        self.assertTrue(self.service.session('s1')['needsReview'])
        with sqlite3.connect(self.home/'thread_history_1.sqlite') as db:
            db.execute('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)',('s1','t-new','completed',self.now,self.now,2))
        with sqlite3.connect(self.home/'state_5.sqlite') as db:
            db.execute('UPDATE thread_read_receipts SET revision=?,last_published_turn=?',('rev-new','t-new'))
        self.service.snapshot(force=True)
        self.assertFalse(self.service.session('s1')['acknowledged'])
        self.assertTrue(self.service.session('s1')['needsReview'])
        with self.assertRaisesRegex(ValueError,'新结果'):
            self.service.action('acknowledge',{'id':'s1','turnId':s['turnId'],'readRevision':s['readRevision']})

    def test_desktop_blue_dot_overrides_stale_sqlite_and_legacy_flags(self):
        path = self.home / '.codex-global-state.json'
        state = json.loads(path.read_text())
        # s1 has an old SQLite receipt and legacy migration entry, but the app
        # has read it. assigned has no SQLite receipt, but the app marks it new.
        state['electron-thread-read-state-v1']['unreadByIdentity']['account-a']['local:machine-a'] = ['assigned']
        path.write_text(json.dumps(state))
        with sqlite3.connect(self.home / 'thread_history_1.sqlite') as db:
            db.execute('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)', ('assigned', 't3', 'completed', self.now - 5, self.now, 1))
        snap = self.service.snapshot(force=True)
        sessions = {s['id']: s for s in snap['sessions']}
        self.assertFalse(sessions['s1']['unread'])
        self.assertFalse(sessions['s1']['needsReview'])
        self.assertTrue(sessions['assigned']['unread'])
        self.assertTrue(sessions['assigned']['needsReview'])
        self.assertEqual(next(p for p in snap['projects'] if p['id'] == 'p1')['unread'], 1)
        # Reading the chat in the app changes the next snapshot without an
        # acknowledgement in this plugin.
        state['electron-thread-read-state-v1']['unreadByIdentity']['account-a']['local:machine-a'] = []
        path.write_text(json.dumps(state))
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.home.iterdir()}
        refreshed = self.service.snapshot(force=True)
        self.assertFalse(any(s['needsReview'] for s in refreshed['sessions']))
        self.assertEqual(before, {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.home.iterdir()})

    def test_desktop_unread_is_scoped_and_unknown_never_falls_back_to_sqlite(self):
        path = self.home / '.codex-global-state.json'
        original = json.loads(path.read_text())
        state = copy.deepcopy(original)
        state['electron-thread-read-state-v1']['unreadByIdentity']['account-a']['remote:other'] = ['s2']
        self.assertEqual(desktop_unread_index(state)['ids'], {'s1'})
        invalid = []
        missing = copy.deepcopy(original)
        missing.pop('electron-thread-read-state-v1')
        invalid.append(missing)
        ambiguous = copy.deepcopy(original)
        ambiguous['electron-thread-read-state-v1']['unreadByIdentity']['account-b'] = {'local:machine-a': ['s2']}
        invalid.append(ambiguous)
        bad_host = copy.deepcopy(original)
        bad_host['electron-thread-read-state-v1']['legacyMigration']['adoptedHostIds']['local'] = 'local:unknown'
        invalid.append(bad_host)
        malformed = copy.deepcopy(original)
        malformed['electron-thread-read-state-v1']['unreadByIdentity']['account-a']['local:machine-a'] = 's1'
        invalid.append(malformed)
        future = copy.deepcopy(original)
        future['electron-thread-read-state-v1']['version'] = 2
        invalid.append(future)
        for value in invalid:
            with self.subTest(value=value):
                path.write_text(json.dumps(value))
                snap = self.service.snapshot(force=True)
                self.assertFalse(snap['source']['readStateAvailable'])
                self.assertFalse(any(s['unreadKnown'] or s['needsReview'] for s in snap['sessions']))

    def test_todo_binding_validation_and_persistence(self):
        with self.assertRaisesRegex(ValueError,'必须属于'):
            self.service.action('todo',{'title':'Wrong binding','projectId':'p1','sessionId':'s2'})
        t=self.service.action('todo',{'title':'Inspect result','projectId':'p1','sessionId':'s1','priority':'high','dueDate':'2026-11-18'})
        restarted=Service(self.reader,Store(self.root/'personal'))
        self.assertEqual(restarted.snapshot()['todos'][0]['sessionId'],'s1')
        done=restarted.action('todo',{'id':t['id'],'status':'done'})
        self.assertEqual(done['dueDate'],'2026-11-18')
        self.assertEqual(done['priority'],'high')
        self.assertEqual(done['status'],'done')
        restarted.action('delete-todo',{'id':t['id']})
        self.assertEqual(restarted.snapshot()['todos'],[])

    def test_todo_start_copies_the_exact_id_before_opening_the_linked_chat(self):
        from project_pulse.mcp_server import call

        values = {"title": "Follow up", "projectId": "p1", "sessionId": "s1", "priority": "high", "dueDate": "2026-11-18"}
        todo = self.service.action("todo", values)
        other = self.service.action("todo", values)
        with (
            patch("project_pulse.server.sys.platform", "darwin"),
            patch.dict(os.environ, {"PULSE_DISABLE_OPEN": "0"}),
            patch("project_pulse.server.subprocess.run", return_value=Mock(returncode=0)) as run,
        ):
            opened = call(self.service, "dashboard_action", {"action": "start-todo", "values": {"id": todo["id"]}})

        self.assertTrue(opened["dispatched"])
        self.assertEqual([c.args[0] for c in run.call_args_list], [["/usr/bin/pbcopy"], ["open", "codex://threads/s1"]])
        prompt = run.call_args_list[0].kwargs["input"].decode("utf-8")
        self.assertTrue(prompt.startswith("$project-pulse "))
        self.assertIn(f"`{todo['id']}` 标为进行中", prompt)
        self.assertNotIn(other["id"], prompt)
        self.assertEqual(call(self.service, "list_todos", {"id": todo["id"]}), {"todos": [todo]})

        # After the user sends the instruction, the skill updates this exact record.
        started = call(self.service, "save_todo", {"id": todo["id"], "status": "doing"})
        self.assertEqual(started, {**todo, "status": "doing", "updatedAt": started["updatedAt"]})
        self.assertEqual(call(self.service, "list_todos", {"id": other["id"]}), {"todos": [other]})

    def test_todo_start_preserves_the_status_if_copy_or_open_fails(self):
        todo = self.service.action("todo", {"title": "Follow up", "projectId": "p1", "sessionId": "s1"})
        with (
            patch("project_pulse.server.sys.platform", "darwin"),
            patch.dict(os.environ, {"PULSE_DISABLE_OPEN": "0"}),
            patch("project_pulse.server.subprocess.run") as run,
        ):
            run.side_effect = subprocess.CalledProcessError(1, "/usr/bin/pbcopy")
            with self.assertRaisesRegex(ValueError, "无法复制开始指令"):
                self.service.action("start-todo", {"id": todo["id"]})
            run.assert_called_once()

            run.reset_mock()
            run.side_effect = [Mock(returncode=0), Mock(returncode=1)]
            with self.assertRaisesRegex(ValueError, "开始指令已复制"):
                self.service.action("start-todo", {"id": todo["id"]})
            self.assertEqual(run.call_count, 2)

        self.assertEqual(self.service.snapshot()["todos"], [todo])

    def test_starting_a_project_only_todo_prefills_a_new_codex_chat(self):
        from project_pulse.mcp_server import call

        root = self.root / "Project & 示例"
        root.mkdir()
        state_file = self.home / ".codex-global-state.json"
        state = json.loads(state_file.read_text())
        state["local-projects"]["p1"]["rootPaths"] = [str(root)]
        state_file.write_text(json.dumps(state))
        todo = self.service.action("todo", {"title": "Plan export", "projectId": "p1"})

        with (
            patch("project_pulse.server.sys.platform", "darwin"),
            patch.dict(os.environ, {"PULSE_DISABLE_OPEN": "0"}),
            patch("project_pulse.server.subprocess.run", return_value=Mock(returncode=0)) as run,
        ):
            opened = call(self.service, "dashboard_action", {"action": "start-todo", "values": {"id": todo["id"]}})

        run.assert_called_once()
        command, url = run.call_args.args[0]
        self.assertEqual(command, "open")
        target = urlsplit(url)
        self.assertEqual((target.scheme, target.netloc), ("codex", "new"))
        query = parse_qs(target.query)
        self.assertEqual(query["path"], [str(root)])
        self.assertIn(f"`{todo['id']}` 标为进行中", query["prompt"][0])
        self.assertTrue(opened["dispatched"])
        self.assertEqual(call(self.service, "list_todos", {"id": todo["id"]}), {"todos": [todo]})

    def test_unread_badge_follows_desktop_reads_independent_of_turn_status(self):
        from project_pulse.branding import has_unread
        path = self.home / '.codex-global-state.json'
        state = json.loads(path.read_text())
        index = state['electron-thread-read-state-v1']['unreadByIdentity']['account-a']
        # A running chat can still have an unread result from its previous turn.
        index['local:machine-a'] = ['s2']
        path.write_text(json.dumps(state))
        snap = self.service.snapshot(force=True)
        self.assertEqual(snap['unreadBadge'], {'known': True, 'count': 1})
        self.assertTrue(has_unread(snap))
        self.assertFalse(any(s['needsReview'] for s in snap['sessions']))
        index['local:machine-a'] = []
        path.write_text(json.dumps(state))
        snap = self.service.snapshot(force=True)
        self.assertEqual(snap['unreadBadge'], {'known': True, 'count': 0})
        self.assertFalse(has_unread(snap))
        state.pop('electron-thread-read-state-v1')
        path.write_text(json.dumps(state))
        snap = self.service.snapshot(force=True)
        self.assertEqual(snap['unreadBadge'], {'known': False, 'count': None})
        self.assertFalse(has_unread(snap))

    def test_entrypoint_icons_notify_only_when_visible_badge_changes(self):
        from project_pulse.branding import icon
        from project_pulse.mcp_server import EntrypointState
        service = Mock()
        service.snapshot.side_effect = [
            {'unreadBadge': {'known': True, 'count': 0}},
            {'unreadBadge': {'known': True, 'count': 2}},
            {'unreadBadge': {'known': True, 'count': 1}},
            {'unreadBadge': {'known': False, 'count': None}},
        ]
        state = EntrypointState(service)
        self.assertEqual(state.read(), (False, False))
        stop, send = Mock(), Mock()
        stop.wait.side_effect = [False, False, False, True]
        state.watch(stop, send)
        self.assertEqual(send.call_count, 2)
        self.assertTrue(all(call.args[0]['method'] == 'notifications/tools/list_changed' for call in send.call_args_list))
        for dark in (False, True):
            images = []
            for unread in (False, True):
                candidate = icon(unread, dark)
                self.assertEqual(candidate['mimeType'], 'image/png')
                self.assertEqual(candidate['theme'], 'dark' if dark else 'light')
                self.assertEqual(candidate['sizes'], ['120x120'])
                png = base64.b64decode(candidate['src'].split(',')[1])
                self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
                self.assertEqual(struct.unpack('>II', png[16:24]), (120, 120))
                images.append(png)
            self.assertNotEqual(*images)

    def test_http_rejects_cross_origin_invalid_host_and_no_csrf(self):
        httpd=start(0,self.service)
        worker=threading.Thread(target=httpd.serve_forever,daemon=True);worker.start()
        url=f'http://127.0.0.1:{httpd.server_port}'
        try:
            with urlopen(url+'/api/bootstrap') as r: boot=json.load(r)
            with urlopen(Request(url+'/',headers={'Sec-Fetch-Site':'cross-site'})) as r:
                self.assertEqual(r.status,200)
            for headers in [{'Origin':'https://evil.example'},{'Host':'evil.example'},{'Sec-Fetch-Site':'cross-site'}]:
                with self.assertRaises(HTTPError) as caught:
                    urlopen(Request(url+'/api/bootstrap',headers=headers))
                self.assertEqual(caught.exception.code,403)
                caught.exception.close()
            with self.assertRaises(HTTPError) as caught:
                urlopen(Request(url+'/api/todo',data=b'{}',headers={'Content-Type':'application/json'}))
            self.assertEqual(caught.exception.code,403)
            caught.exception.close()
            body=json.dumps({'title':'Local todo','projectId':'p1'}).encode()
            with urlopen(Request(url+'/api/todo',data=body,headers={'Content-Type':'application/json','X-Pulse-Token':boot['token']})) as r:
                self.assertEqual(json.load(r)['title'],'Local todo')
            with self.assertRaises(HTTPError) as caught:
                urlopen(url+'/../data.py')
            self.assertEqual(caught.exception.code,404)
            caught.exception.close()
        finally:
            httpd.shutdown();httpd.server_close();worker.join()

    def test_archived_session_does_not_prevent_completing_existing_todo(self):
        t=self.service.action('todo',{'title':'Follow up','projectId':'p1','sessionId':'s1'})
        with sqlite3.connect(self.home/'state_5.sqlite') as db:
            db.execute('UPDATE threads SET archived=1 WHERE id=?',('s1',))
        self.service.snapshot(force=True)
        done=self.service.action('todo',{'id':t['id'],'status':'done'})
        self.assertEqual(done['status'],'done')

    def test_mcp_initialize_discovery_and_real_project_reads(self):
        env={**os.environ,'CODEX_HOME':str(self.home),'PULSE_DATA_DIR':str(self.root/'personal')}
        messages=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18'}},{'jsonrpc':'2.0','method':'notifications/initialized'}, {'jsonrpc':'2.0','id':2,'method':'tools/list'}, {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'list_projects','arguments':{}}}, {'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'list_sessions','arguments':{'status':'unread'}}}]
        # Exercise the actual manifest from a relocated package with spaces in
        # its path. No original source directory or compatibility symlink exists.
        installed = self.root / 'relocated plugin'
        shutil.copytree(SOURCE, installed / 'src', ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copytree(REPO / 'assets', installed / 'assets')
        config = json.loads((REPO / 'mcp.json').read_text())['mcpServers']['project_pulse']
        legacy = json.loads((REPO / '.mcp.json').read_text())['mcpServers']['project_pulse']
        self.assertEqual((config['args'], config['cwd']), (legacy['args'], legacy['cwd']))
        env.pop('PYTHONPATH', None)
        proc=subprocess.run([sys.executable, *config['args']],cwd=config['cwd'].replace('${PLUGIN_ROOT}', str(installed)),input='\n'.join(json.dumps(m) for m in messages)+'\n',text=True,capture_output=True,env=env,timeout=10)
        self.assertEqual(proc.returncode,0,proc.stderr)
        replies=[json.loads(line) for line in proc.stdout.splitlines()]
        self.assertEqual(len(replies),4)
        self.assertEqual(replies[0]['result']['protocolVersion'],'2025-06-18')
        self.assertTrue(replies[0]['result']['capabilities']['tools']['listChanged'])
        self.assertEqual(len(replies[1]['result']['tools']),8)
        dashboard=replies[1]['result']['tools'][0]
        self.assertEqual({icon['theme'] for icon in dashboard['icons']}, {'light', 'dark'})
        self.assertEqual(replies[0]['result']['serverInfo']['icons'], dashboard['icons'])
        self.assertEqual(base64.b64decode(dashboard['icons'][0]['src'].split(',')[1]),
                         (REPO / 'assets/entrypoint-unread.png').read_bytes())
        self.assertEqual(dashboard['_meta']['ui']['resourceUri'],URI)
        self.assertEqual(dashboard['_meta']['openai/ui']['entrypoints'],[{'type':'global'},{'type':'thread'}])
        self.assertEqual(len(json.loads(replies[2]['result']['content'][0]['text'])['projects']),2)
        self.assertEqual(json.loads(replies[3]['result']['content'][0]['text'])['sessions'][0]['id'],'s1')

    def test_native_ui_resource_identity_changes_on_upgrade(self):
        installed = self.root / 'upgrade plugin'
        shutil.copytree(SOURCE, installed / 'src', ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copytree(REPO / 'assets', installed / 'assets')
        env = {**os.environ, 'CODEX_HOME': str(self.home), 'PULSE_DATA_DIR': str(self.root / 'personal'),
               'PYTHONDONTWRITEBYTECODE': '1'}
        env.pop('PYTHONPATH', None)
        previous_uri = 'ui://project-pulse/dashboard.html'
        for version in (__version__, '99.0.0'):
            (installed / 'src/project_pulse/__init__.py').write_text(f'__version__ = "{version}"\n')
            expected_uri = f'ui://project-pulse/dashboard-{version}.html'
            messages = [
                {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-11-25'}},
                {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
                {'jsonrpc': '2.0', 'id': 3, 'method': 'resources/list'},
                {'jsonrpc': '2.0', 'id': 4, 'method': 'resources/read', 'params': {'uri': expected_uri}},
                {'jsonrpc': '2.0', 'id': 5, 'method': 'resources/read', 'params': {'uri': previous_uri}},
            ]
            proc = subprocess.run([sys.executable, '-B', '-m', 'project_pulse.mcp_server'],
                                  cwd=installed / 'src', env=env, text=True, capture_output=True, timeout=10,
                                  input='\n'.join(json.dumps(m) for m in messages) + '\n')
            self.assertEqual(proc.returncode, 0, proc.stderr)
            replies = {r['id']: r for r in map(json.loads, proc.stdout.splitlines())}
            tool = replies[2]['result']['tools'][0]
            self.assertEqual(tool['_meta']['ui']['resourceUri'], expected_uri)
            self.assertEqual(tool['_meta']['openai/outputTemplate'], expected_uri)
            self.assertEqual(replies[3]['result']['resources'][0]['uri'], expected_uri)
            ui = replies[4]['result']['contents'][0]
            self.assertEqual(ui['uri'], expected_uri)
            self.assertIn(f'name="project-pulse-version" content="{version}"', ui['text'])
            self.assertIn('class="top-nav"', ui['text'])
            self.assertNotIn('class="sidebar"', ui['text'])
            self.assertIn('error', replies[5])
            self.assertNotEqual(expected_uri, previous_uri)
            previous_uri = expected_uri

    def test_native_ui_resource_is_self_contained_without_personal_data(self):
        ui=resource()
        self.assertEqual(ui['mimeType'],MIME)
        self.assertIn('ui/initialize',ui['text'])
        self.assertIn('dashboard_snapshot',ui['text'])
        self.assertNotIn('<script src=',ui['text'])
        self.assertNotIn('<link rel="stylesheet"',ui['text'])
        self.assertNotIn('/assets/icon-', ui['text'])
        self.assertIn('data:image/svg+xml;base64,', ui['text'])
        # Both hosts need the same locally bundled form components. Missing
        # vendor code can leave native selects or break form initialization.
        for name in ['vendor/tom-select.complete.min.js', 'vendor/flatpickr.min.js',
                     'vendor/flatpickr-zh.js', 'components.js', 'components.css']:
            content = (SOURCE / 'project_pulse' / 'web' / name).read_text()
            self.assertIn(content.replace('</script', '<\\/script'), ui['text'])
        self.assertNotIn('projectId":"p1',ui['text'])
        self.assertIn('--canvas: #ffffff',ui['text'])

    def test_native_app_tools_use_same_persistent_store(self):
        from project_pulse.mcp_server import call
        t=call(self.service,'dashboard_action',{'action':'todo','values':{'title':'Native todo','projectId':'p1','sessionId':'s1'}})
        snap=call(self.service,'dashboard_snapshot',{})
        self.assertEqual(snap['todos'][0]['id'],t['id'])
        detail=call(self.service,'dashboard_session',{'sessionId':'s1'})
        self.assertEqual(detail['result']['text'],'Final answer')
        call(self.service,'dashboard_action',{'action':'delete-todo','values':{'id':t['id']}})
        self.assertEqual(call(self.service,'dashboard_snapshot',{})['todos'],[])


if __name__=='__main__':
    unittest.main(verbosity=2)
