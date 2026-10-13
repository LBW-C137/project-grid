import base64
import contextlib
import importlib.util
import io
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import uuid
import time
from datetime import datetime, timezone

MODULE_PATH = Path(__file__).resolve().parents[1] / "integration" / "remote-worker.py"
spec = importlib.util.spec_from_file_location("remote_worker", MODULE_PATH)
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


def _git_too_old():
    try: version = remote.Worker(lambda _: None).git_version()
    except Exception: return False
    return bool(version) and version < (2, 11)
GIT_TOO_OLD = _git_too_old()


class RemoteFilesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="agentrix-worker-test-")
        self.root = Path(self.temp.name) / "project"
        self.root.mkdir()
        self.worker = remote.Worker(lambda _: None)
        self.worker.initialize({"path": str(self.root), "token": "test", "projectId": "test"})

    def tearDown(self):
        self.worker.stop()
        self.temp.cleanup()

    def claude_file(self):
        self.worker.claude_home = str(Path(self.temp.name) / "claude")
        folder = Path(self.worker.claude_home) / "projects" / "-srv-project"
        folder.mkdir(parents=True)
        return folder / "session.jsonl"

    def test_claude_hooks_match_local_states_fields_and_ignore_idle_notifications(self):
        def notify(kind, payload):
            client = mock.MagicMock()
            client.__enter__.return_value = client
            with mock.patch("sys.argv", ["notify.py", "claude-hook", kind]), mock.patch("sys.stdin", io.StringIO(json.dumps(payload))), \
                 mock.patch.dict(os.environ, {"AGENTRIX_TOKEN": "test", "AGENTRIX_SOCKET": "test.sock"}), \
                 mock.patch("os.getcwd", return_value="/srv/project"), mock.patch("socket.AF_UNIX", 1, create=True), mock.patch("socket.socket", return_value=client):
                try: exec(remote.NOTIFY_SOURCE, {})
                except SystemExit as error: self.assertEqual(error.code, 0)
            return json.loads(client.sendall.call_args[0][0]) if client.sendall.called else None
        payload = {"session_id": "session", "transcript_path": "/srv/claude/projects/project/session.jsonl", "prompt": "p" * 2100, "message": "m" * 400, "notification_type": "permission_prompt"}
        identities = []
        for kind, state in (("start", "working"), ("stop", "complete"), ("notify", "attention"), ("session", "session")):
            event = notify(kind, payload)
            self.assertEqual((event["type"], event["agent"], event["state"], event["sessionId"]), ("agent-activity", "claude", state, "session"))
            self.assertEqual(event["transcriptPath"], payload["transcript_path"])
            self.assertEqual(event["prompt"], "p" * 2000 if kind == "start" else None)
            self.assertEqual(event["message"], "m" * 300 if kind == "notify" else None)
            self.assertEqual(event["token"], "test"); self.assertTrue(event["eventId"].startswith("session:"))
            identities.append(event["eventId"])
        self.assertEqual(len(set(identities)), 4)
        self.assertIsNotNone(notify("notify", dict(payload, notification_type="elicitation_dialog")))
        for kind, hook in (("notify", dict(payload, notification_type="idle_prompt")), ("start", {}), ("unknown", payload)):
            self.assertIsNone(notify(kind, hook))

    def test_notify_shell_events_name_claude_and_default_to_codex(self):
        for args, expected in ((["codex-started", "--version", "claude"], {"agent": "claude", "command": "--version"}),
                               (["codex-exited", "7", "claude"], {"agent": "claude", "exitCode": 7}),
                               (["codex-started", ""], {"agent": "codex"}), (["codex-exited", "0"], {"agent": "codex", "exitCode": 0}),
                               (["shell-prompt", "0", "1"], {"codexAvailable": False, "claudeAvailable": True})):
            client = mock.MagicMock(); client.__enter__.return_value = client
            with mock.patch("sys.argv", ["notify.py"] + args), mock.patch.dict(os.environ, {"AGENTRIX_TOKEN": "test", "AGENTRIX_SOCKET": "test.sock"}), \
                 mock.patch("os.getcwd", return_value="/srv/project"), mock.patch("socket.AF_UNIX", 1, create=True), mock.patch("socket.socket", return_value=client):
                exec(remote.NOTIFY_SOURCE, {})
            event = json.loads(client.sendall.call_args[0][0])
            for key, value in expected.items(): self.assertEqual(event[key], value)

    def test_claude_wrapper_quotes_hook_commands_for_sh(self):
        python, notify = "/opt/python's tools/python3", "/tmp/agent's path/notify.py"
        source = remote.BASH_SOURCE.split("import json,shlex,sys\n", 1)[1].split("\nPY\n", 1)[0]
        output = io.StringIO()
        with mock.patch("sys.executable", python), mock.patch("sys.argv", ["-", notify]), contextlib.redirect_stdout(output):
            exec("import json,shlex,sys\n" + source, {})
        hooks = json.loads(output.getvalue())["hooks"]
        for name, kind in (("UserPromptSubmit", "start"), ("Stop", "stop"), ("Notification", "notify"), ("SessionStart", "session")):
            self.assertEqual(shlex.split(hooks[name][0]["hooks"][0]["command"]), [python, notify, "claude-hook", kind])

    def test_claude_status_reads_incrementally_and_preserves_tools_settings_and_queued_prompts(self):
        filename = self.claude_file()
        rows = [
            {"type": "user", "uuid": "u1", "message": {"content": "Remote prompt"}},
            {"type": "assistant", "uuid": "a1", "effort": "high", "message": {"model": "claude-test", "usage": {"speed": "fast", "other": 1}, "content": [
                {"type": "thinking", "thinking": "hidden"}, {"type": "text", "text": "Reading"},
                {"type": "tool_use", "id": "read", "name": "Read", "input": {"file_path": "/srv/project/a.py"}},
                {"type": "tool_use", "id": "skill", "name": "Skill", "input": {"skill": "test-skill", "args": "check"}}]}},
            {"type": "assistant", "isSidechain": True, "message": {"content": "child"}},
            {"type": "attachment", "uuid": "queued", "attachment": {"type": "queued_command", "commandMode": "prompt", "prompt": [{"type": "text", "text": "Queued work"}, {"type": "image", "source": {"data": "hidden"}}]}},
        ]
        filename.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        status = self.worker.claude_status(str(filename), 1000)
        self.assertTrue(status["reset"]); self.assertTrue(status["historyDone"])
        self.assertEqual([row["uuid"] for row in status["records"]], ["u1", "a1", "queued"])
        reply = status["records"][1]
        self.assertEqual(reply["message"]["model"], "claude-test"); self.assertEqual(reply["effort"], "high")
        self.assertEqual(reply["message"]["usage"], {"speed": "fast"})
        self.assertEqual([block["type"] for block in reply["message"]["content"]], ["text", "tool_use", "tool_use"])
        result = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "read", "is_error": True, "content": "output" * 10000}]}}
        with filename.open("a", encoding="utf-8") as output: output.write(json.dumps(result))
        self.assertEqual(self.worker.claude_status(str(filename), 1000)["records"], [])
        with filename.open("a", encoding="utf-8") as output: output.write("\n")
        status = self.worker.claude_status(str(filename), 1000)
        self.assertFalse(status["reset"])
        self.assertEqual(status["records"][0]["message"]["content"], [{"type": "tool_result", "tool_use_id": "read", "is_error": True, "content": ""}])
        self.assertEqual(self.worker.claude_status(str(filename), 1000)["records"], [])

    def test_claude_status_resets_on_replacement_truncation_or_new_run(self):
        filename = self.claude_file()
        def row(text): return json.dumps({"type": "user", "message": {"content": text}}) + "\n"
        filename.write_text(row("old"), encoding="utf-8")
        self.worker.claude_status(str(filename), 1000)
        filename.rename(filename.with_suffix(".old"))
        filename.write_text(row("replacement longer than old"), encoding="utf-8")
        status = self.worker.claude_status(str(filename), 1000)
        self.assertTrue(status["reset"]); self.assertEqual(status["records"][0]["message"]["content"], "replacement longer than old")
        filename.write_text(row("short"), encoding="utf-8")
        self.assertTrue(self.worker.claude_status(str(filename), 1000)["reset"])
        self.assertTrue(self.worker.claude_status(str(filename), 2000)["reset"])

    def test_claude_status_refuses_paths_outside_projects_and_invalid_times(self):
        filename = self.claude_file()
        filename.write_text("{}\n", encoding="utf-8")
        for path in (None, "session.jsonl", str(self.root / "outside.jsonl"), str(filename.parent.parent),
                     str(filename.parent / ".." / ".." / "outside.jsonl"), str(Path(self.worker.claude_home) / "projects-other" / "session.jsonl")):
            with self.assertRaises(ValueError): self.worker.claude_status(path, 1000)
        for since in (None, "1000", 0, -1):
            with self.assertRaises(ValueError): self.worker.claude_status(str(filename), since)
        missing = filename.with_name("missing.jsonl")
        status = self.worker.claude_status(str(missing), 1000)
        self.assertEqual(status["records"], []); self.assertFalse(status["historyDone"])

    @unittest.skipUnless(os.name == "posix", "the remote side runs on Linux and macOS")
    def test_claude_status_refuses_symlinks_outside_projects(self):
        filename = self.claude_file()
        outside = self.root / "outside.jsonl"; outside.write_text("{}\n", encoding="utf-8")
        filename.symlink_to(outside)
        with self.assertRaises(ValueError): self.worker.claude_status(str(filename), 1000)

    def test_claude_status_uses_history_window_and_drains_response_budget_before_history_done(self):
        filename = self.claude_file()
        def row(text): return (json.dumps({"type": "user", "message": {"content": text}}) + "\n").encode()
        filename.write_bytes(row("excluded") + (json.dumps({"padding": "x" * (remote.HISTORY_WINDOW + 1000)}) + "\n").encode()
                             + row("recent") + row("a" * remote.RECORD_TEXT_LIMIT) * 20)
        status = self.worker.claude_status(str(filename), 1000)
        self.assertTrue(status["reset"]); self.assertFalse(status["historyDone"])
        self.assertEqual(status["records"][0]["message"]["content"], "recent")
        self.assertLessEqual(len(json.dumps(status)), remote.RECORDS_BUDGET + 100)
        next_status = self.worker.claude_status(str(filename), 1000)
        self.assertFalse(next_status["reset"]); self.assertTrue(next_status["historyDone"])
        self.assertEqual(len(status["records"]) + len(next_status["records"]), 21)
        before = self.worker.claude_reader.offset
        with filename.open("ab") as output:
            output.write((json.dumps({"padding": "x" * (remote.LIVE_READ_LIMIT + 1000)}) + "\n").encode() + row("live"))
        self.assertEqual(self.worker.claude_status(str(filename), 1000)["records"], [])
        self.assertEqual(self.worker.claude_reader.offset - before, remote.LIVE_READ_LIMIT)
        self.assertEqual(self.worker.claude_status(str(filename), 1000)["records"][0]["message"]["content"], "live")

    @unittest.skipIf(GIT_TOO_OLD, "the Git panel needs Git 2.11; older Git is named instead")
    def test_git_reads_status_history_and_commit_paths_without_mutation(self):
        def git(*args):
            return subprocess.run(["git", *args], cwd=str(self.root), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
        self.assertFalse(self.worker.git("status")["repository"])
        git("init"); git("symbolic-ref", "HEAD", "refs/heads/main")
        git("config", "user.name", "测试 User")
        git("config", "user.email", "test@example.invalid")
        git("config", "core.autocrlf", "false")
        self.assertEqual(self.worker.git("history", 0)["output"], "")
        (self.root / "sub").mkdir()
        (self.root / "sub/中文 文件.txt").write_text("base", encoding="utf-8")
        (self.root / "outside.txt").write_text("outside", encoding="utf-8")
        git("add", "."); git("commit", "-m", "第一次提交")
        commit = git("rev-parse", "HEAD").decode().strip()
        (self.root / "sub/中文 文件.txt").write_text("changed", encoding="utf-8")
        (self.root / "新建.txt").write_text("new", encoding="utf-8")
        before = (self.root / ".git/index").read_bytes()
        status = self.worker.git("status")
        self.assertIn("sub/中文 文件.txt\0", status["output"])
        self.assertIn("? 新建.txt\0", status["output"])
        self.assertEqual((self.root / ".git/index").read_bytes(), before)
        self.assertIn(commit + "\0", self.worker.git("history", 0)["output"])
        self.assertIn("第一次提交", self.worker.git("history", 0)["output"])
        self.assertIn("sub/中文 文件.txt\0", self.worker.git("files", commit)["output"])
        self.worker.root = str(self.root / "sub")
        git("config", "diff.relative", "true")
        self.assertEqual(self.worker.git("status")["prefix"], "sub/")
        self.assertNotIn("outside.txt", self.worker.git("files", commit)["output"])
        with self.assertRaises(ValueError): self.worker.git("files", "--output=outside")
        with self.assertRaises(ValueError): self.worker.git("history", -1)

    @unittest.skipIf(GIT_TOO_OLD, "the Git panel needs Git 2.11; older Git is named instead")
    def test_signed_history_ignores_user_signature_display_setting(self):
        def git(*args):
            return subprocess.run(["git", *args], cwd=str(self.root), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode().strip()
        git("init"); git("symbolic-ref", "HEAD", "refs/heads/main")
        (self.root / "signed.txt").write_text("signed change", encoding="utf-8")
        git("add", ".")
        tree = git("write-tree")
        raw = f"tree {tree}\nauthor Test <test@example.invalid> 1700000000 +0000\ncommitter Test <test@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n invalid-test-signature\n -----END PGP SIGNATURE-----\n\nsigned fixture\n"
        obj = Path(self.temp.name) / "signed-commit"
        obj.write_bytes(raw.encode())
        commit = git("hash-object", "-t", "commit", "-w", str(obj))
        git("update-ref", "refs/heads/main", commit)
        git("config", "log.showSignature", "true")
        fields = self.worker.git("history", 0)["output"].split("\0")
        self.assertEqual(fields[0], commit)
        self.assertEqual(fields[5], "signed fixture")
        self.assertEqual(self.worker.git("files", commit)["output"], "A\0signed.txt\0")

    def test_directory_and_media_reads(self):
        (self.root / "src").mkdir()
        (self.root / "中文.txt").write_text("中文文件", encoding="utf-8")
        png = b"\x89PNG\r\n\x1a\n" + b"\0" * 64
        (self.root / "image-without-extension").write_bytes(png)
        (self.root / "page.html").write_text("<h1>Remote page</h1>", encoding="utf-8")
        (self.root / "README.md").write_text("# 远程 Markdown\n\n**正文**", encoding="utf-8")
        (self.root / "clip.mp4").write_bytes(b"video fixture")
        listing = self.worker.directory("", 0)
        self.assertEqual(listing["entries"][0]["name"], "src")
        self.assertEqual(self.worker.preview("中文.txt", 0)["content"], "中文文件")
        self.assertEqual(self.worker.preview("image-without-extension", 0)["kind"], "image")
        self.assertEqual(self.worker.preview("page.html", 0)["kind"], "html")
        self.assertEqual(self.worker.preview("README.md", 0)["kind"], "markdown")
        self.assertEqual(self.worker.preview("clip.mp4", 0)["kind"], "video")
        self.assertEqual(base64.b64decode(self.worker.read("中文.txt", 0, 6)), "中文".encode())

    def test_parent_activity_ignores_child_and_stale_completion(self):
        home = Path(self.temp.name) / "codex"
        sessions = home / "sessions"
        sessions.mkdir(parents=True)
        parent, child = str(uuid.uuid4()), str(uuid.uuid4())
        def event(kind, turn):
            return json.dumps({"type": "event_msg", "timestamp": datetime.now(timezone.utc).isoformat(), "payload": {"type": kind, "turn_id": turn}}) + "\n"
        filename = sessions / ("rollout-" + parent + ".jsonl")
        filename.write_text(json.dumps({"type": "session_meta", "payload": {"id": parent, "cwd": str(self.root), "source": "cli"}}) + "\n" + event("task_started", "parent"), encoding="utf-8")
        (sessions / ("rollout-" + child + ".jsonl")).write_text(json.dumps({"type": "session_meta", "payload": {"id": child, "cwd": str(self.root), "source": {"subagent": "parent"}}}) + "\n" + event("task_complete", "child"), encoding="utf-8")
        reader = remote.CodexActivityReader(str(self.root), str(home), time.time() * 1000)
        self.assertEqual(reader.read()["state"], "working")
        with filename.open("a", encoding="utf-8") as output: output.write(event("task_complete", "old"))
        self.assertEqual(reader.read()["state"], "working")
        completion = event("task_complete", "parent")
        with filename.open("a", encoding="utf-8") as output: output.write(completion[:-1])
        self.assertEqual(reader.read()["state"], "working")
        with filename.open("a", encoding="utf-8") as output: output.write("\n")
        self.assertEqual(reader.read()["state"], "complete")

    def test_conversation_records_go_back_compacted_with_the_status(self):
        # The reading view on the other computer gets the messages, the tools called and which finished; outputs,
        # reasoning and instructions stay here. A new file starts its conversation over; history ends once all is sent.
        home = Path(self.temp.name) / "conversation-home"
        sessions = home / "sessions"
        sessions.mkdir(parents=True)
        identity = str(uuid.uuid4())
        filename = sessions / ("rollout-" + identity + ".jsonl")
        at = datetime.now(timezone.utc).isoformat()
        rows = [
            {"type": "session_meta", "timestamp": at, "payload": {"id": identity, "cwd": str(self.root), "source": "cli", "base_instructions": {"text": "x" * 50000}}},
            {"type": "event_msg", "timestamp": at, "payload": {"type": "task_started", "turn_id": "t1"}},
            {"type": "event_msg", "timestamp": at, "payload": {"type": "item_completed", "item": {"type": "UserMessage", "id": "u1", "content": [{"type": "text", "text": "预处理太慢"}, {"type": "image", "image_url": "data:" + "y" * 90000}]}}},
            {"type": "response_item", "timestamp": at, "payload": {"type": "reasoning", "encrypted_content": "z" * 80000}},
            {"type": "response_item", "timestamp": at, "payload": {"type": "custom_tool_call", "name": "exec", "call_id": "c1", "input": "tools.exec_command({cmd: \"pytest -q\"})"}},
            {"type": "response_item", "timestamp": at, "payload": {"type": "custom_tool_call_output", "call_id": "c1", "output": "o" * 70000}},
            {"type": "event_msg", "timestamp": at, "payload": {"type": "item_completed", "item": {"type": "AgentMessage", "id": "a1", "content": [{"type": "text", "text": "| 节点 | 耗时 |\n| 预处理 | 0.51 |"}]}}},
            {"type": "event_msg", "timestamp": at, "payload": {"type": "token_count", "info": {"total": 1}}},
        ]
        filename.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        reader = remote.CodexActivityReader(str(self.root), str(home), 0, identity[:29])
        snapshot = reader.read()
        answer = reader.take()
        self.assertEqual(snapshot["state"], "working")
        self.assertTrue(answer["reset"]); self.assertTrue(answer["historyDone"])
        kinds = [(record["type"], record["payload"].get("type")) for record in answer["records"]]
        self.assertEqual(kinds, [("session_meta", None), ("event_msg", "task_started"), ("event_msg", "item_completed"), ("response_item", "custom_tool_call"), ("response_item", "custom_tool_call_output"), ("event_msg", "item_completed")])
        self.assertEqual(answer["records"][0]["payload"], {"id": identity, "cwd": str(self.root), "source": "cli"})
        self.assertEqual(answer["records"][2]["payload"]["item"]["content"], [{"type": "text", "text": "预处理太慢"}])
        self.assertEqual(answer["records"][4]["payload"], {"type": "custom_tool_call_output", "call_id": "c1"})
        self.assertLess(len(json.dumps(answer)), 4000)
        # Later growth comes with the next status, without starting over.
        with filename.open("a", encoding="utf-8") as output: output.write(json.dumps({"type": "event_msg", "timestamp": at, "payload": {"type": "agent_message", "message": "完成"}}) + "\n")
        reader.read()
        later = reader.take()
        self.assertFalse(later["reset"])
        self.assertEqual([record["payload"].get("message") for record in later["records"]], ["完成"])

    def test_compacted_records_keep_the_model_effort_and_fast_mode(self):
        turn = remote.compact_record({"type": "turn_context", "timestamp": "t", "payload": {"cwd": "/srv", "model": "gpt-6.1-sol", "effort": "high", "collaboration_mode": {"settings": {"developer_instructions": "long"}}}})
        self.assertEqual(turn["payload"], {"cwd": "/srv", "model": "gpt-6.1-sol", "effort": "high"})
        applied = remote.compact_record({"type": "event_msg", "timestamp": "t", "payload": {"type": "thread_settings_applied", "thread_settings": {
            "model": "gpt-6.1-sol", "service_tier": "priority", "reasoning_effort": "high", "cwd": "/srv", "collaboration_mode": {"settings": {"developer_instructions": "long"}}}}})
        self.assertEqual(applied["payload"], {"type": "thread_settings_applied", "thread_settings": {"model": "gpt-6.1-sol", "reasoning_effort": "high", "service_tier": "priority"}})
        self.assertEqual(remote.compact_record({"type": "turn_context", "payload": {"cwd": "/srv"}})["payload"], {"cwd": "/srv"})

    @unittest.skipUnless(os.name == "posix", "the remote side runs on Linux and macOS")
    def test_document_reads_a_markdown_file_anywhere_and_nothing_else(self):
        note = Path(self.temp.name) / "memory" / "CONTEXT.md"
        note.parent.mkdir()
        note.write_text("# 背景\n" + "x" * 100, encoding="utf-8")
        found = self.worker.document(str(note), 8192)
        self.assertEqual(base64.b64decode(found["data"]).decode("utf-8"), note.read_text(encoding="utf-8"))
        self.assertEqual(found["size"], note.stat().st_size)
        self.assertEqual(len(base64.b64decode(self.worker.document(str(note), 4)["data"])), 4)
        for wrong in (str(note.with_suffix(".txt")), "CONTEXT.md", str(note) + "\0.md"):
            with self.assertRaises(ValueError): self.worker.document(wrong, 10)
        with self.assertRaises(ValueError): self.worker.document(str(note), -1)
        with self.assertRaises(OSError): self.worker.document(str(note.parent / "missing.md"), 10)
        (note.parent / "folder.md").mkdir()
        with self.assertRaises((ValueError, OSError)): self.worker.document(str(note.parent / "folder.md"), 10)

    @unittest.skipUnless(hasattr(os, "getuid"), "the remote side runs on Linux and macOS")
    def test_history_and_handoff_carry_the_folders_earlier_work(self):
        codex_home, claude_home = Path(self.temp.name) / "codex-h", Path(self.temp.name) / "claude-h"
        day = codex_home / "sessions" / "2026" / "10" / "12"
        day.mkdir(parents=True)
        identity = str(uuid.uuid4())
        (day / ("rollout-" + identity + ".jsonl")).write_text("".join(json.dumps(row) + "\n" for row in [
            {"type": "session_meta", "payload": {"id": identity, "cwd": str(self.root), "source": "cli"}},
            {"type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "UserMessage", "id": "u", "content": [{"type": "text", "text": "预处理太慢"}]}}},
            {"type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": "c", "output": "x" * 50000}},
        ]), encoding="utf-8")
        folder = claude_home / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(self.root))
        folder.mkdir(parents=True)
        (folder / "s1.jsonl").write_text("".join(json.dumps(row) + "\n" for row in [
            {"type": "user", "uuid": "u1", "timestamp": "2026-10-12T01:00:00Z", "message": {"role": "user", "content": [{"type": "text", "text": "加上限流"}, {"type": "image", "source": {"data": "y" * 40000}}]}},
            {"type": "assistant", "uuid": "a1", "timestamp": "2026-10-12T01:00:01Z", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t", "name": "Edit", "input": {"file_path": "/srv/a.py", "new_string": "z" * 5000}}]}},
            {"type": "user", "uuid": "r1", "timestamp": "2026-10-12T01:00:02Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "w" * 30000}]}},
        ]), encoding="utf-8")
        found = remote.history_records(str(self.root), str(codex_home), str(claude_home))
        self.assertEqual([session["id"] for session in found["codex"]], [identity])
        self.assertEqual([session["id"] for session in found["claude"]], ["s1"])
        claude = found["claude"][0]["records"]
        self.assertEqual(claude[0]["message"]["content"], [{"type": "text", "text": "加上限流"}])
        self.assertEqual(claude[1]["message"]["content"][0]["input"]["file_path"], "/srv/a.py")
        self.assertLessEqual(len(claude[1]["message"]["content"][0]["input"]["new_string"]), 600)
        self.assertLess(len(json.dumps(found)), 8000, "outputs and pictures stay on this computer")
        # The handoff lies in a private folder, at the path the note names; empty removes it.
        self.worker.project_id = "terminal-1"
        path = self.worker.write_handoff("# Earlier work\n")
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))
        self.assertEqual(path, self.worker.handoff_path())
        self.assertEqual(Path(path).read_text(encoding="utf-8"), "# Earlier work\n")
        self.assertEqual(os.stat(os.path.dirname(path)).st_mode & 0o777, 0o700)
        self.assertIsNone(self.worker.write_handoff(""))
        self.assertFalse(os.path.exists(path))

    def test_transcript_window_history_live_budget_and_rebinding(self):
        home = Path(self.temp.name) / "window-home"
        sessions = home / "sessions"
        sessions.mkdir(parents=True)
        identity = str(uuid.uuid4())
        filename = sessions / ("rollout-" + identity + ".jsonl")
        def line(record): return (json.dumps(record) + "\n").encode()
        def event(kind, turn): return line({"type": "event_msg", "payload": {"type": kind, "turn_id": turn}})
        meta = line({"type": "session_meta", "payload": {"id": identity, "cwd": str(self.root), "source": "cli"}})
        # The first bytes at the seek position look like valid JSON but belong to a cut line.
        cut = line({"cut": True})
        complete = event("task_complete", "excluded")
        padding = line({"padding": "x" * (remote.HISTORY_WINDOW - len(cut) - len(complete) - len(line({"padding": ""})))})
        filename.write_bytes(meta + event("task_started", "excluded") + b"invalid partial line " + cut + padding + complete)
        reader = remote.CodexActivityReader(str(self.root), str(home), 0, identity)
        seen = []
        original = reader.record
        def record(value): seen.append(value); original(value)
        reader.record = record
        self.assertEqual(reader.read()["state"], "unknown")
        self.assertFalse(reader.history_pending)
        self.assertEqual(seen, [{"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "excluded"}}])
        self.assertEqual(remote.recent_session(str(self.root), str(home), identity)["id"], identity)
        before = reader.offset
        with filename.open("ab") as output:
            output.write(event("task_started", "live") + line({"padding": "x" * (remote.LIVE_READ_LIMIT + 1000)}) + event("task_complete", "live"))
        self.assertIsNone(reader.read())
        self.assertEqual(reader.offset - before, remote.LIVE_READ_LIMIT)
        self.assertEqual(reader.read()["state"], "complete")
        # Shrink but remain larger than a window; the old turn must not survive.
        filename.write_bytes(meta + line({"padding": "x" * (remote.HISTORY_WINDOW + 1000)}) + complete)
        self.assertEqual(reader.read()["state"], "unknown")
        filename.rename(filename.with_suffix(".old"))
        filename.write_bytes(meta + line({"padding": "x" * (remote.HISTORY_WINDOW + 2000)}) + event("task_started", "replacement"))
        self.assertEqual(reader.read()["state"], "working")
        self.assertEqual(reader.snapshot["turnId"], "replacement")

    def test_large_unicode_pages_are_lossless(self):
        content = "A" * (remote.PAGE_BYTES - 1) + "中文🙂\ufeff内容\n" * 40000
        for encoding, bom in (("utf-8", b""), ("utf-16le", b"\xff\xfe"), ("utf-16be", b"\xfe\xff")):
            (self.root / "large.txt").write_bytes(bom + content.encode(encoding))
            first = self.worker.preview("large.txt", 0)
            pages = [self.worker.preview("large.txt", index) for index in range(first["page"]["count"])]
            self.assertEqual("".join(page["content"] for page in pages), content)
            for left, right in zip(pages, pages[1:]): self.assertEqual(left["page"]["byteEnd"], right["page"]["byteStart"])

    def test_page_edits_preserve_unicode_encoding_and_reject_conflicts(self):
        for encoding, bom in (("utf-8", b"\xef\xbb\xbf"), ("utf-16le", b"\xff\xfe"), ("utf-16be", b"\xfe\xff")):
            original = bom + ("中文🙂 line\r\n" * 70000).encode(encoding)
            filename = self.root / "editable.txt"
            filename.write_bytes(original)
            preview = self.worker.preview("editable.txt", 1)
            replacement = "edited\n第二行🙂"
            payload = base64.b64encode(replacement.encode("utf-8")).decode("ascii")
            self.worker.save_file("editable.txt", 1, preview["revision"], payload)
            expected = original[:preview["page"]["byteStart"]] + replacement.replace("\n", "\r\n").encode(encoding) + original[preview["page"]["byteEnd"]:]
            self.assertEqual(filename.read_bytes(), expected)
            current = self.worker.preview("editable.txt", 0)
            filename.write_text("external content", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "其他程序修改"):
                self.worker.save_file("editable.txt", 0, current["revision"], payload)
            self.assertEqual(filename.read_text(encoding="utf-8"), "external content")

    def test_traversal_and_non_files_are_rejected(self):
        for filename in ("../outside", "/etc/passwd", "bad\0path", "a\\b"):
            with self.assertRaises(ValueError): self.worker.resolve(filename)
        with self.assertRaises(ValueError): self.worker.preview("", 0)
        with self.assertRaises(ValueError): self.worker.read("file", 0, remote.MAX_READ + 1)
        if os.name == "posix":
            outside = Path(self.temp.name) / "outside"
            outside.write_text("private", encoding="utf-8")
            (self.root / "escape").symlink_to(outside)
            with self.assertRaises(ValueError): self.worker.preview("escape", 0)

    def test_recovery_only_reads_the_matching_interactive_session(self):
        home = Path(self.temp.name) / "codex"
        sessions = home / "sessions"
        sessions.mkdir(parents=True)
        identity = str(uuid.uuid4())
        records = [
            {"type": "session_meta", "payload": {"id": identity, "cwd": str(self.root), "source": "cli"}},
            {"type": "event_msg", "payload": {"type": "task_started"}},
            {"type": "event_msg", "payload": {"type": "turn_aborted"}},
        ]
        filename = sessions / "rollout-test.jsonl"
        filename.write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")
        result = remote.recent_session(os.path.realpath(self.root), str(home))
        self.assertEqual(result["id"], identity)
        self.assertEqual(result["state"], "interrupted")
        with filename.open("a", encoding="utf-8") as output: output.write('\n{"type":"event_msg","payload":{"type":"task_complete"}}\n')
        self.assertEqual(remote.recent_session(os.path.realpath(self.root), str(home))["state"], "complete")

    @unittest.skipUnless(hasattr(os, "getuid"), "the remote side runs on Linux and macOS")
    def test_pasted_picture_lands_in_a_private_temporary_folder_by_absolute_path(self):
        data = b"\x89PNG\r\n\x1a\n" + b"picture" * 60000
        transfer = self.worker.start_image("png", len(data))["id"]
        for offset in range(0, len(data), remote.MAX_READ): self.worker.upload_chunk(transfer, offset, base64.b64encode(data[offset:offset + remote.MAX_READ]).decode())
        saved = Path(self.worker.finish_upload(transfer)["path"])
        self.addCleanup(lambda: saved.exists() and saved.unlink())
        self.assertTrue(saved.is_absolute())
        self.assertEqual(saved.read_bytes(), data)
        self.assertEqual(saved.parent, Path(tempfile.gettempdir()) / f"agentrix-images-{os.getuid()}")
        self.assertEqual(saved.parent.stat().st_mode & 0o777, 0o700)
        self.assertFalse(list(saved.parent.glob(".agentrix-upload-*")))
        # Only pictures, and not too large; the project itself is untouched.
        with self.assertRaises(ValueError): self.worker.start_image("sh", 10)
        with self.assertRaises(ValueError): self.worker.start_image("png", 26 * 1024 * 1024)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_old_git_is_named_instead_of_failing_on_its_options(self):
        self.worker._git_version = (1, 8, 3)
        with self.assertRaisesRegex(ValueError, "1.8.3"): self.worker.git("status")
        self.assertEqual(self.worker.no_relative(), [])
        self.worker._git_version = (2, 43, 0)
        self.assertEqual(self.worker.no_relative(), ["--no-relative"])

    def test_rollout_times_are_read_without_fromisoformat(self):
        self.assertEqual(remote.record_time("1970-01-01T00:00:01.5Z"), 1500)
        self.assertEqual(remote.record_time("1970-01-01T08:00:00+08:00"), 0)
        self.assertEqual(remote.record_time("2026-10-12T05:56:02.121Z"), 1791784562121)
        self.assertEqual(remote.record_time("not a time"), 0)
        self.assertEqual(remote.record_time(None), 0)

    def test_file_mutations_and_upload_do_not_overwrite_existing_data(self):
        self.worker.create("", "新目录", "directory")
        self.worker.create("新目录", "first.txt", "file")
        original = self.root / "新目录" / "first.txt"
        original.write_text("keep", encoding="utf-8")
        with self.assertRaises(FileExistsError): self.worker.create("新目录", "first.txt", "file")
        self.worker.rename("新目录/first.txt", "renamed.txt")
        self.worker.create("新目录", "exists.txt", "file")
        with self.assertRaises(ValueError): self.worker.rename("新目录/renamed.txt", "exists.txt")
        data = b"upload fixture" * 50000
        transfer = self.worker.start_upload("新目录", "renamed.txt", len(data))["id"]
        for offset in range(0, len(data), remote.MAX_READ): self.worker.upload_chunk(transfer, offset, base64.b64encode(data[offset:offset + remote.MAX_READ]).decode())
        result = self.worker.finish_upload(transfer)
        self.assertEqual((self.root / result["path"]).read_bytes(), data)
        self.assertEqual((self.root / "新目录/renamed.txt").read_text(), "keep")
        canceled = self.worker.start_upload("新目录", "cancel.txt", 9)["id"]
        with self.assertRaises(ValueError): self.worker.finish_upload(canceled)
        self.worker.cancel_upload(canceled)
        self.assertFalse((self.root / "新目录/cancel.txt").exists())
        self.assertFalse(list((self.root / "新目录").glob(".agentrix-upload-*")))
        self.worker.remove(result["path"])
        self.assertFalse((self.root / result["path"]).exists())
        for relative in ("", "../outside", "/outside"):
            with self.assertRaises(ValueError): self.worker.remove(relative)

    def test_deleting_remote_link_preserves_external_target(self):
        if os.name != "posix": self.skipTest("POSIX symlink behavior")
        outside = Path(self.temp.name) / "outside"
        outside.mkdir(); (outside / "keep.txt").write_text("keep")
        (self.root / "link").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError): self.worker.create("link", "escape.txt", "file")
        self.worker.remove("link")
        self.assertEqual((outside / "keep.txt").read_text(), "keep")


if __name__ == "__main__": unittest.main()
