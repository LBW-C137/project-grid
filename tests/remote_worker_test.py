import base64
import importlib.util
import json
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
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

    def test_codex_sessions_lists_the_folders_other_conversations_by_name(self):
        home = Path(self.temp.name) / "sessions-home"
        folder = home / "sessions" / "2026" / "10" / "12"
        folder.mkdir(parents=True)
        def rollout(identity, cwd, user_text, age):
            path = folder / ("rollout-" + identity + ".jsonl")
            rows = [{"type": "session_meta", "payload": {"id": identity, "cwd": cwd, "source": "cli"}},
                    {"type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "UserMessage", "id": "u", "content": [{"type": "text", "text": user_text}]}}},
                    {"type": "event_msg", "payload": {"type": "item_completed", "item": {"type": "AgentMessage", "id": "a", "content": [{"type": "text", "text": "好"}]}}}]
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            stamp = time.time() - age
            os.utime(str(path), (stamp, stamp))
        current, merge, plain, elsewhere = (str(uuid.uuid4()) for _ in range(4))
        rollout(current, str(self.root), "现在这个", 10)
        rollout(merge, str(self.root), "<send_user_message_question_reply>[]</send_user_message_question_reply>", 100)
        rollout(plain, str(self.root), "删除显示和系统监控功能", 200)
        rollout(elsewhere, str(self.temp.name), "别的文件夹", 50)
        (home / "session_index.jsonl").write_text(json.dumps({"id": merge, "thread_name": "合并远端主分支"}) + "\n", encoding="utf-8")
        listed = remote.codex_sessions(str(self.root), str(home), current[:29])
        self.assertEqual([item["id"] for item in listed], [merge, plain])
        self.assertEqual([item["title"] for item in listed], ["合并远端主分支", "删除显示和系统监控功能"])
        self.assertEqual(listed[1]["messages"], 2)
        self.assertEqual(remote.codex_sessions(str(self.root), str(Path(self.temp.name) / "missing")), [])

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
