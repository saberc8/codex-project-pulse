#!/usr/bin/env python3
"""Loopback-only dashboard. Python 3.10+, no third party runtime packages."""
import argparse
import json
import mimetypes
import os
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlencode, urlsplit

from . import __version__
from .agents import MultiReader, terminal_command
from .data import Store, Unavailable

ROOT = Path(__file__).resolve().parent


class Service:
    def __init__(self, reader=None, store=None):
        self.reader, self.store = reader or MultiReader(), store or Store()
        self.cache, self.cache_at = None, 0
        self.lock = threading.Lock()

    def snapshot(self, force=False):
        with self.lock:
            if force or self.cache is None or time.time() - self.cache_at > 3:
                self.cache = self.reader.snapshot()
                self.cache_at = time.time()
            snapshot = self.store.enrich(json.loads(json.dumps(self.cache)))
            snapshot["source"]["canStartTodoInCodex"] = sys.platform == "darwin" and os.environ.get("PULSE_DISABLE_OPEN") != "1"
            return snapshot

    def session(self, ident):
        result = next((s for s in self.snapshot()["sessions"] if s["id"] == ident), None)
        if not result:
            raise ValueError("会话不存在或不属于已导入项目")
        return result

    def action(self, action, values):
        if action == "todo":
            return self.store.save_todo(values, self.snapshot(), values.get("id"))
        if action == "start-todo":
            return self.start_todo_in_codex(values.get("id"))
        if action == "delete-todo":
            self.store.delete_todo(values.get("id"))
        elif action == "acknowledge":
            s = self.session(values.get("id"))
            # Reject stale previews: acknowledging A must not acknowledge a new B.
            if values.get("turnId") != s["turnId"] or values.get("readRevision") != s["readRevision"]:
                raise ValueError("会话已有新结果，请刷新后再确认")
            if s["status"] != "completed":
                raise ValueError("本轮尚未完成")
            self.store.acknowledge(s)
        elif action == "pin":
            if values.get("id") not in {p["id"] for p in self.snapshot()["projects"]}:
                raise ValueError("项目不存在")
            self.store.pin(values["id"], values.get("pinned"))
        elif action == "open":
            return self.open(self.session(values.get("id")))
        else:
            raise ValueError("未知操作")
        return {"ok": True}

    def start_todo_in_codex(self, ident):
        snapshot = self.snapshot()
        if not snapshot["source"]["canStartTodoInCodex"]:
            raise ValueError("当前环境无法从待办打开 Codex")
        todo = next((item for item in snapshot["todos"] if item["id"] == ident), None)
        if todo is None:
            raise ValueError("待办不存在")
        if todo["status"] != "todo":
            raise ValueError("请选择一条待开始的待办")

        prompt = f"$project-pulse 请将待办 ID `{todo['id']}` 标为进行中，然后按下面的说明执行。\n\n"
        if not todo["sessionId"]:
            roots = next((p["roots"] for p in snapshot["projects"] if p["id"] == todo["projectId"]), ())
            root = next((path for path in roots if os.path.isabs(path) and os.path.isdir(path)), None)
            if root is None:
                raise ValueError("项目目录不可用，请在编辑待办时选择可用项目")
            query = urlencode({"path": root, "prompt": prompt}, quote_via=quote)
            return {**self.open({"url": f"codex://new?{query}"}), "prefilled": True}

        session = next((s for s in snapshot["sessions"] if s["id"] == todo["sessionId"]), None)
        if session is None or session.get("agent") != "codex" or not session.get("url"):
            raise ValueError("请先关联可打开的 Codex 对话")

        try:
            subprocess.run(
                ["/usr/bin/pbcopy"], input=prompt.encode("utf-8"),
                env={**os.environ, "LC_ALL": "en_US.UTF-8"},
                capture_output=True, timeout=5, check=True,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise ValueError("无法复制开始指令，请重试") from exc
        try:
            return self.open(session)
        except (ValueError, OSError, subprocess.SubprocessError) as exc:
            raise ValueError("开始指令已复制，请手动打开原对话并粘贴") from exc

    def open(self, s):
        """Codex chats open by URL; Claude Code resumes in Terminal; other agents return a command to copy."""
        if s.get("url"):
            command = ["open", s["url"]] if sys.platform == "darwin" else ["xdg-open", s["url"]]
            if os.environ.get("PULSE_DISABLE_OPEN") == "1":
                raise ValueError("此测试环境不打开原生应用")
            result = subprocess.run(command, capture_output=True, timeout=8, check=False)
            if result.returncode:
                raise ValueError("无法打开 Codex，请复制会话链接后手动打开")
            return {"ok": True, "url": s["url"], "dispatched": True}
        resume = self.reader.resume(s["id"]) if hasattr(self.reader, "resume") else None
        if not resume:
            raise ValueError("这个会话没有可用的打开方式")
        launchable = resume["runnable"] and sys.platform == "darwin" and os.environ.get("PULSE_DISABLE_OPEN") != "1"
        if launchable and subprocess.run(terminal_command(resume["command"]), capture_output=True, timeout=8, check=False).returncode == 0:
            return {"ok": True, "dispatched": True, "command": resume["command"]}
        return {"ok": True, "dispatched": False, "command": resume["command"]}


def make_handler(service, token):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ProjectPulse/0.1"

        def log_message(self, fmt, *args):
            # Request paths can contain private thread IDs. No access log.
            pass

        def allowed(self, mutation=False, sensitive=True):
            allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            if self.headers.get("Host") not in allowed:
                return False
            origin = self.headers.get("Origin")
            if origin and origin not in {f"http://{h}" for h in allowed}:
                return False
            if sensitive and self.headers.get("Sec-Fetch-Site") == "cross-site":
                return False
            if mutation and not secrets.compare_digest(self.headers.get("X-Pulse-Token", ""), token):
                return False
            return True

        def send(self, status, body, content_type="application/json; charset=utf-8"):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = urlsplit(self.path).path
            # A user may follow a localhost link from another app or website.
            # Public static UI can be navigated to; cross-site data reads cannot.
            if not self.allowed(sensitive=path.startswith('/api/')):
                return self.send(403, {"error": "仅允许从本机面板访问"})
            try:
                if path == "/api/health":
                    return self.send(200, {"service": "codex-project-pulse", "version": __version__})
                if path == "/api/bootstrap":
                    return self.send(200, {"token": token, "data": service.snapshot()})
                if path == "/api/snapshot":
                    return self.send(200, service.snapshot())
                if path.startswith("/api/sessions/"):
                    s = service.session(path.rsplit("/", 1)[-1])
                    return self.send(200, {"session": s, "result": service.reader.result(s["id"])})
                if path == "/api/export":
                    data = service.snapshot()
                    return self.send(200, {"version": 1, "exportedAt": time.time(), "todos": data["todos"], "projects": [{"id": p["id"], "name": p["name"], "pinned": p["pinned"]} for p in data["projects"]]})
                if path.startswith("/assets/"):
                    web = (ROOT.parents[1] / "assets").resolve()
                    relative = path.removeprefix("/assets/")
                else:
                    web = (ROOT / "web").resolve()
                    relative = "index.html" if path == "/" else path.lstrip("/")
                target = (web / relative).resolve()
                if not target.is_relative_to(web) or not target.is_file():
                    return self.send(404, {"error": "页面不存在"})
                self.send(200, target.read_bytes(), mimetypes.guess_type(target)[0] or "application/octet-stream")
            except ValueError as exc:
                self.send(404, {"error": str(exc)})
            except Unavailable as exc:
                self.send(503, {"error": str(exc)})

        def do_POST(self):
            if not self.allowed(mutation=True):
                return self.send(403, {"error": "请求来源或会话校验失败，请刷新面板"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 32768:
                    raise ValueError("请求内容大小无效")
                if self.headers.get_content_type() != "application/json":
                    raise ValueError("需要 JSON 请求")
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError("请求格式无效")
                action = urlsplit(self.path).path.removeprefix("/api/")
                self.send(200, service.action(action, data))
            except (ValueError, KeyError) as exc:
                self.send(400, {"error": str(exc)})
            except Unavailable as exc:
                self.send(503, {"error": str(exc)})
            except (OSError, subprocess.TimeoutExpired):
                self.send(500, {"error": "操作失败，请重试"})
    return Handler


def start(port=4318, service=None):
    return ThreadingHTTPServer(("127.0.0.1", port), make_handler(service or Service(), secrets.token_urlsafe(32)))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=4318)
    args = parser.parse_args()
    httpd = start(args.port)
    print(f"Project Pulse: http://127.0.0.1:{httpd.server_port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.server_close()
