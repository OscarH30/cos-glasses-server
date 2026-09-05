"""Even G2 platform adapter: SSE stream in, HTTP POST out.

Talks to cos-glasses-server on loopback. Imports stay limited to the same
gateway.platforms surface the ntfy adapter uses (Sep 2026 PLUGIN-COMPAT).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

try:
    import httpx
    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False
    httpx = None  # type: ignore[assignment]

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult

logger = logging.getLogger(__name__)

DEFAULT_SERVER = "http://127.0.0.1:3141"
MAX_MESSAGE_LENGTH = 600
RECONNECT_BACKOFF = [2, 5, 10, 30, 60]


def _setting(extra: Dict[str, Any], key: str, env: str, default: str = "") -> str:
    value = extra.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return (os.environ.get(env) or default).strip()


def check_requirements() -> bool:
    return HTTPX_AVAILABLE and bool(_setting({}, "token", "G2_PLUGIN_TOKEN"))


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    return bool(_setting(extra, "token", "G2_PLUGIN_TOKEN"))


def is_connected(config) -> bool:
    return validate_config(config)


class G2Adapter(BasePlatformAdapter):
    MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform("g2"))
        extra = config.extra or {}
        self._server = _setting(extra, "server", "G2_SERVER_URL", DEFAULT_SERVER).rstrip("/")
        self._token = _setting(extra, "token", "G2_PLUGIN_TOKEN")
        self._profile = _setting(extra, "profile", "G2_PROFILE") or "eve"
        self._home = _setting(extra, "home_channel", "G2_HOME_CHANNEL") or "g2"
        self._stream_task: Optional[asyncio.Task] = None
        self._http_client: Optional["httpx.AsyncClient"] = None
        self._last_event_id = 0

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not HTTPX_AVAILABLE:
            logger.warning("[%s] httpx not installed", self.name)
            return False
        if not self._token:
            logger.warning("[%s] G2_PLUGIN_TOKEN not configured", self.name)
            return False
        try:
            self._http_client = httpx.AsyncClient(timeout=None)
            probe = await self._http_client.get(
                f"{self._server}/hermes/health",
                headers=self._headers(),
                timeout=5.0,
            )
            if probe.status_code >= 300:
                logger.error("[%s] health probe failed HTTP %s", self.name, probe.status_code)
                return False
            self._stream_task = asyncio.create_task(self._run_stream())
            self._mark_connected()
            logger.info("[%s] Connected to %s profile=%s", self.name, self._server, self._profile)
            return True
        except Exception as exc:
            logger.error("[%s] Failed to connect: %s", self.name, exc)
            return False

    async def _run_stream(self) -> None:
        backoff_idx = 0
        while self._running:
            try:
                await self._consume_stream()
                backoff_idx = 0
            except asyncio.CancelledError:
                return
            except Exception as exc:
                if not self._running:
                    return
                delay = RECONNECT_BACKOFF[min(backoff_idx, len(RECONNECT_BACKOFF) - 1)]
                logger.warning("[%s] Stream error: %s — reconnect in %ss", self.name, exc, delay)
                await asyncio.sleep(delay)
                backoff_idx += 1

    async def _consume_stream(self) -> None:
        params = {"profile": self._profile}
        headers = {**self._headers()}
        if self._last_event_id:
            headers["Last-Event-ID"] = str(self._last_event_id)
        url = f"{self._server}/hermes/stream?{urlencode(params)}"
        async with self._http_client.stream(
            "GET",
            url,
            headers=headers,
            timeout=httpx.Timeout(connect=15.0, read=90.0, write=15.0, pool=15.0),
        ) as response:
            response.raise_for_status()
            event_name = "message"
            event_id = None
            data_lines: List[str] = []
            async for line in response.aiter_lines():
                if not self._running:
                    return
                if line.startswith("id:"):
                    event_id = line[3:].strip()
                    continue
                if line.startswith("event:"):
                    event_name = line[6:].strip()
                    continue
                if line.startswith("data:"):
                    data_lines.append(line[5:].strip())
                    continue
                if line.strip():
                    continue
                raw = "\n".join(data_lines)
                data_lines = []
                name, event_name = event_name, "message"
                if not raw:
                    continue
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if event_id and event_id.isdigit():
                    self._last_event_id = int(event_id)
                if name == "message":
                    await self._on_inbound(payload)
                elif name == "stop":
                    logger.info("[%s] stop requested for %s", self.name, payload.get("correlationId"))

    async def _on_inbound(self, payload: Dict[str, Any]) -> None:
        text = str(payload.get("text") or "").strip()
        if not text:
            return
        source = self.build_source(
            chat_id=self._home,
            chat_name="G2",
            chat_type="dm",
            user_id=self._home,
            user_name="Oscar",
        )
        event = MessageEvent(
            text=text,
            message_type=MessageType.TEXT,
            source=source,
            message_id=str(payload.get("id") or payload.get("correlationId") or ""),
            raw_message=payload,
            timestamp=datetime.now(tz=timezone.utc),
        )
        await self.handle_message(event)

    async def disconnect(self) -> None:
        self._running = False
        self._mark_disconnected()
        if self._stream_task:
            self._stream_task.cancel()
            try:
                await self._stream_task
            except asyncio.CancelledError:
                pass
            self._stream_task = None
        if self._http_client:
            await self._http_client.aclose()
            self._http_client = None

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if not self._http_client:
            return SendResult(success=False, error="HTTP client not initialized")
        meta = metadata or {}
        body = {
            "chat_id": chat_id or self._home,
            "text": content[: self.MAX_MESSAGE_LENGTH],
            "kind": meta.get("kind") or "reply",
            "profile": self._profile,
        }
        if reply_to:
            body["reply_to"] = reply_to
        if meta.get("correlation_id"):
            body["correlation_id"] = meta["correlation_id"]
        try:
            resp = await self._http_client.post(
                f"{self._server}/hermes/deliver",
                headers={**self._headers(), "Content-Type": "application/json"},
                json=body,
                timeout=15.0,
            )
            if resp.status_code >= 300:
                return SendResult(success=False, error=f"HTTP {resp.status_code}: {resp.text[:200]}")
            message_id = resp.json().get("message_id")
            return SendResult(success=True, message_id=message_id)
        except Exception as exc:
            return SendResult(success=False, error=str(exc))

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id or self._home, "type": "dm"}


def _env_enablement() -> dict | None:
    token = (os.environ.get("G2_PLUGIN_TOKEN") or "").strip()
    if not token:
        return None
    home = (os.environ.get("G2_HOME_CHANNEL") or "g2").strip()
    return {
        "server": (os.environ.get("G2_SERVER_URL") or DEFAULT_SERVER).rstrip("/"),
        "token": token,
        "profile": (os.environ.get("G2_PROFILE") or "eve").strip(),
        "home_channel": {"chat_id": home, "name": "Even G2"},
    }


async def _standalone_send(
    pconfig,
    chat_id: str,
    message: str,
    *,
    thread_id: Optional[str] = None,
    media_files: Optional[List[str]] = None,
    force_document: bool = False,
) -> Dict[str, Any]:
    if not HTTPX_AVAILABLE:
        return {"error": "g2 standalone send: httpx not installed"}
    extra = getattr(pconfig, "extra", {}) or {}
    server = _setting(extra, "server", "G2_SERVER_URL", DEFAULT_SERVER).rstrip("/")
    token = _setting(extra, "token", "G2_PLUGIN_TOKEN")
    profile = _setting(extra, "profile", "G2_PROFILE") or "eve"
    if not token:
        return {"error": "g2 standalone send: G2_PLUGIN_TOKEN not configured"}
    body = {
        "chat_id": chat_id or "g2",
        "text": message[:MAX_MESSAGE_LENGTH],
        "kind": "cron",
        "profile": profile,
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{server}/hermes/deliver",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json=body,
            )
            if resp.status_code >= 300:
                return {"error": f"g2 HTTP {resp.status_code}: {resp.text[:200]}"}
            return {"success": True, "platform": "g2", "chat_id": chat_id or "g2", "message_id": resp.json().get("message_id")}
    except Exception as exc:
        return {"error": f"g2 standalone send failed: {exc}"}


def register(ctx) -> None:
    ctx.register_platform(
        name="g2",
        label="Even G2",
        adapter_factory=lambda cfg: G2Adapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["G2_PLUGIN_TOKEN"],
        env_enablement_fn=_env_enablement,
        cron_deliver_env_var="G2_HOME_CHANNEL",
        standalone_sender_fn=_standalone_send,
        allowed_users_env="G2_ALLOWED_USERS",
        allow_all_env="G2_ALLOW_ALL_USERS",
        max_message_length=MAX_MESSAGE_LENGTH,
        emoji="👓",
        pii_safe=True,
        allow_update_command=False,
        platform_hint=(
            "You are speaking on Even G2 smart glasses: a 576x288 monochrome "
            "display showing about four short lines at a time, read while "
            "walking. Lead with the answer or the question in one or two "
            "lines. Plain text only: no markdown, tables, code fences or "
            "emoji. Expand only when asked. If a decision is needed, state it "
            "as a yes/no question."
        ),
    )
    from .approval import present_approval
    ctx.register_approval_transport("g2", present_approval)
