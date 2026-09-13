"""Small loopback-only OpenAI chat server for a user-owned GGUF model.

The launch document is created by local-gguf.mjs with owner-only permissions.
No prompt, completion, API token, or model contents are written to disk here.
"""

from __future__ import annotations

import argparse
import ctypes
import inspect
import json
import os
import re
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


MAX_BODY_BYTES = 16 * 1024 * 1024


def normalize_reasoning_effort(value: Any) -> str:
    effort = str(value or "xhigh").strip().lower()
    if effort in ("none", "minimal", "low"):
        return "low"
    if effort == "medium":
        return "medium"
    if effort in ("high", "xhigh", "max", "ultra"):
        return "xhigh"
    return "xhigh"


def adapt_qwen38_mtmd_template(chat_template: str) -> str:
    """Let llama.cpp's MTMD handler replace Qwen3.8 image placeholders."""
    if not chat_template or "<|image_pad|>" not in chat_template:
        return chat_template
    pattern = r"\{\{-?\s*(['\"])<\|vision_start\|><\|image_pad\|><\|vision_end\|>\1\s*-?\}\}"
    replacement = (
        "{{- '<|vision_start|>' }}"
        "{%- if item.image_url is string %}"
        "{{- item.image_url }}"
        "{%- else %}"
        "{{- item.image_url.url }}"
        "{%- endif %}"
        "{{- '<|vision_end|>' }}"
    )
    adapted, count = re.subn(pattern, replacement, chat_template)
    if count == 0:
        raise RuntimeError("Qwen3.8 image template could not be adapted for the local MTMD handler.")
    return adapted


def qwen38_vision_handler(mmproj_path: str, chat_template: str, config: dict[str, Any]):
    from llama_cpp.llama_chat_format import Qwen35ChatHandler

    shared = {
        "verbose": os.environ.get("MODEL_ROUTER_LOCAL_GGUF_DEBUG") == "1",
        "extra_template_arguments": {
            "reasoning_effort": normalize_reasoning_effort(config.get("reasoningEffort")),
        },
        "chat_template_override": adapt_qwen38_mtmd_template(chat_template),
    }
    variants = [
        {"add_vision_id": True, "preserve_thinking": False},
        {"preserve_thinking": False},
        {"add_vision_id": True},
        {},
    ]
    last_error: Exception | None = None
    for variant in variants:
        kwargs = {
            "enable_thinking": bool(config.get("thinkingEnabled", True)),
            **variant,
            **shared,
        }
        for path_key in ("mmproj_path", "clip_model_path"):
            try:
                return Qwen35ChatHandler(**{path_key: mmproj_path}, **kwargs)
            except TypeError as error:
                last_error = error
                if "unexpected keyword argument" not in str(error).lower() and "required" not in str(error).lower():
                    break
        fallback = dict(kwargs)
        fallback.pop("extra_template_arguments", None)
        fallback.pop("chat_template_override", None)
        try:
            return Qwen35ChatHandler(clip_model_path=mmproj_path, **fallback)
        except TypeError as error:
            last_error = error
    if last_error is not None:
        raise last_error
    raise RuntimeError("Qwen3.8 vision handler could not be created.")


def load_config(config_path: Path) -> dict[str, Any]:
    payload = json.loads(config_path.read_text(encoding="utf-8"))
    required = ("modelPath", "dependenciesPath", "token", "instanceId", "modelId", "port")
    if any(not payload.get(field) for field in required):
        raise RuntimeError("Local model launch configuration is incomplete.")
    return payload


def prepare_runtime(config: dict[str, Any]) -> list[Any]:
    dependencies = Path(config["dependenciesPath"]).resolve()
    sys.path.insert(0, str(dependencies))
    handles: list[Any] = []
    dll_directories = [dependencies / "llama_cpp" / "lib"]
    python_root = Path(sys.executable).resolve().parent
    dll_directories.append(python_root / "Lib" / "site-packages" / "torch" / "lib")
    if hasattr(os, "add_dll_directory"):
        for directory in dll_directories:
            if directory.is_dir():
                handles.append(os.add_dll_directory(str(directory)))
    torch_lib = dll_directories[-1]
    if os.name == "nt" and torch_lib.is_dir():
        for pattern in ("cudart64*.dll", "cublasLt64*.dll", "cublas64*.dll"):
            for library in torch_lib.glob(pattern):
                try:
                    handles.append(ctypes.WinDLL(str(library)))
                except OSError:
                    pass
    return handles


def create_model(config: dict[str, Any]):
    from llama_cpp import Llama
    from llama_cpp.llama_chat_format import (
        Jinja2ChatFormatter,
        chat_formatter_to_chat_completion_handler,
    )

    llm = Llama(
        model_path=str(Path(config["modelPath"]).resolve()),
        n_gpu_layers=int(config.get("gpuLayers", 0)),
        n_ctx=int(config.get("contextWindow", 4096)),
        n_batch=256,
        verbose=False,
    )
    template = llm.metadata.get("tokenizer.chat_template")
    mmproj_path = config.get("mmprojPath")
    if template and mmproj_path:
        llm.chat_handler = qwen38_vision_handler(
            str(Path(mmproj_path).resolve()),
            template,
            config,
        )
    elif template:
        formatter = Jinja2ChatFormatter(
            template=template,
            eos_token=llm._model.token_get_text(llm.token_eos()),
            bos_token=llm._model.token_get_text(llm.token_bos()),
            stop_token_ids=[llm.token_eos(), llm.token_eot()],
        )

        def format_chat(*, messages, **kwargs):
            kwargs.update(
                enable_thinking=bool(config.get("thinkingEnabled", False)),
                preserve_thinking=False,
                reasoning_effort=normalize_reasoning_effort(config.get("reasoningEffort")),
            )
            return formatter(messages=messages, **kwargs)

        llm.chat_handler = chat_formatter_to_chat_completion_handler(format_chat)
    return llm


class ModelServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler, config):
        super().__init__(address, handler)
        self.config = config
        self.model = None
        self.status = "loading"
        self.inference_lock = threading.Lock()
        self.started_at = time.time()


class Handler(BaseHTTPRequestHandler):
    server: ModelServer
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        expected = f"Bearer {self.server.config['token']}"
        return secrets.compare_digest(self.headers.get("Authorization", ""), expected)

    def _read_json(self) -> dict[str, Any]:
        raw_length = self.headers.get("Content-Length", "")
        try:
            length = int(raw_length)
        except ValueError as error:
            raise ValueError("A valid Content-Length is required.") from error
        if length < 1 or length > MAX_BODY_BYTES:
            raise ValueError("Request body size is invalid.")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object.")
        return payload

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {
                "ok": self.server.status == "ready",
                "status": self.server.status,
                "instanceId": self.server.config["instanceId"],
                "model": self.server.config["modelId"],
                "uptimeSeconds": round(time.time() - self.server.started_at, 1),
                "vision": bool(self.server.config.get("mmprojPath")),
                "thinking": bool(self.server.config.get("thinkingEnabled")),
                "reasoningEffort": self.server.config.get("reasoningEffort", "xhigh"),
            })
            return
        if self.path == "/v1/models":
            if not self._authorized():
                self._json(401, {"error": {"message": "Unauthorized", "type": "authentication_error"}})
                return
            model_id = self.server.config["modelId"]
            self._json(200, {"object": "list", "data": [{
                "id": model_id,
                "object": "model",
                "created": int(self.server.started_at),
                "owned_by": "local-user",
            }]})
            return
        self._json(404, {"error": {"message": "Not found", "type": "invalid_request_error"}})

    def do_POST(self) -> None:
        if not self._authorized():
            self._json(401, {"error": {"message": "Unauthorized", "type": "authentication_error"}})
            return
        if self.path == "/shutdown":
            self._json(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if self.path != "/v1/chat/completions":
            self._json(404, {"error": {"message": "Not found", "type": "invalid_request_error"}})
            return
        if self.server.status != "ready" or self.server.model is None:
            self._json(503, {"error": {"message": "Local model is still loading.", "type": "server_error"}})
            return
        try:
            payload = self._read_json()
            messages = payload.get("messages")
            if not isinstance(messages, list) or not messages:
                raise ValueError("messages must be a non-empty array.")
            stream = payload.get("stream") is True
            kwargs: dict[str, Any] = {
                "messages": messages,
                "stream": stream,
                "max_tokens": min(
                    max(1, int(payload.get("max_tokens", self.server.config.get("maxOutputTokens", 1024)))),
                    int(self.server.config.get("maxOutputTokens", 1024)),
                ),
                "temperature": float(payload.get("temperature", self.server.config.get("temperature", 0.7))),
                "top_p": float(payload.get("top_p", self.server.config.get("topP", 0.8))),
                "top_k": int(payload.get("top_k", self.server.config.get("topK", 20))),
                "min_p": float(payload.get("min_p", self.server.config.get("minP", 0.0))),
                "repeat_penalty": float(payload.get("repeat_penalty", self.server.config.get("repeatPenalty", 1.0))),
                "frequency_penalty": float(payload.get("frequency_penalty", self.server.config.get("frequencyPenalty", 0.0))),
                "presence_penalty": float(payload.get("presence_penalty", self.server.config.get("presencePenalty", 0.0))),
            }
            if "stop" not in payload and self.server.config.get("stopSequences"):
                kwargs["stop"] = self.server.config["stopSequences"]
            for key in ("tools", "tool_choice", "stop", "response_format"):
                if key in payload:
                    kwargs[key] = payload[key]
            parameters = inspect.signature(self.server.model.create_chat_completion).parameters
            if "presence_penalty" not in parameters and "present_penalty" in parameters:
                kwargs["present_penalty"] = kwargs.pop("presence_penalty")
            with self.server.inference_lock:
                handler = getattr(self.server.model, "chat_handler", None)
                extra_arguments = getattr(handler, "extra_template_arguments", None)
                if isinstance(extra_arguments, dict) and self.server.config.get("thinkingEnabled"):
                    extra_arguments["reasoning_effort"] = normalize_reasoning_effort(
                        payload.get("reasoning_effort", self.server.config.get("reasoningEffort"))
                    )
                response = self.server.model.create_chat_completion(**kwargs)
                if stream:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                    self.send_header("Cache-Control", "no-cache, no-store")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    for chunk in response:
                        data = json.dumps(chunk, ensure_ascii=False, separators=(",", ":"))
                        self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
                        self.wfile.flush()
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                else:
                    self._json(200, response)
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            self._json(400, {"error": {"message": str(error), "type": "invalid_request_error"}})
        except Exception:
            self._json(500, {"error": {"message": "Local inference failed.", "type": "server_error"}})


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = load_config(Path(args.config).resolve())
    handles = prepare_runtime(config)
    server = ModelServer(("127.0.0.1", int(config["port"])), Handler, config)

    def load_model() -> None:
        try:
            server.model = create_model(config)
            server.status = "ready"
        except Exception:
            server.status = "error"

    threading.Thread(target=load_model, daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
        if server.model is not None:
            server.model.close()
        handles.clear()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
