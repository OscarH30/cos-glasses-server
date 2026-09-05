"""G2 approval transport — present Hermes tool-approval prompts on the glasses."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

try:
    import httpx
except ImportError:
    httpx = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

DEFAULT_SERVER = "http://127.0.0.1:3141"


async def present_approval(request: Any):
    if httpx is None:
        return request.respond("deny")
    server = (os.environ.get("G2_SERVER_URL") or DEFAULT_SERVER).rstrip("/")
    token = (os.environ.get("G2_PLUGIN_TOKEN") or "").strip()
    if not token:
        return request.respond("deny")
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = {
        "request_id": getattr(request, "id", None) or getattr(request, "request_id", ""),
        "digest": getattr(request, "digest", ""),
        "command": getattr(request, "command", ""),
        "description": getattr(request, "description", ""),
        "choices": list(getattr(request, "choices", ["once", "deny"])),
        "timeout_s": int(getattr(request, "timeout", 60) or 60),
        "origin": getattr(request, "host", "gateway"),
    }
    timeout_s = max(1, int(payload["timeout_s"]))
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            posted = await client.post(f"{server}/hermes/approval", headers=headers, json=payload, timeout=10.0)
            if posted.status_code >= 300:
                logger.warning("g2 approval present failed HTTP %s", posted.status_code)
                return request.respond("deny")
            request_id = posted.json().get("request_id") or payload["request_id"]
            polled = await client.get(
                f"{server}/hermes/approval/{request_id}",
                headers=headers,
                timeout=timeout_s + 2,
            )
            if polled.status_code != 200:
                return request.respond("deny")
            choice = (polled.json() or {}).get("choice") or "deny"
            return request.respond(choice)
    except Exception as exc:
        logger.warning("g2 approval transport failed: %s", exc)
        return request.respond("deny")
