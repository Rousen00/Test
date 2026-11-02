#!/usr/bin/env python3
"""Send a message to a Telegram group via the Bot API.

Env vars:
  TELEGRAM_BOT_TOKEN  - token from @BotFather (required)
  TELEGRAM_CHAT_ID    - group chat id, e.g. -1001234567890 (optional)
  TELEGRAM_CHAT_TITLE - group title to look up if no chat id (default: "7 негритят")
  TELEGRAM_TEXT       - message text (default: "привет")

If TELEGRAM_CHAT_ID is not set, the script finds the group by title via
getUpdates. For that, add the bot to the group and send any message there first.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

API = "https://api.telegram.org/bot{token}/{method}"


def call(token, method, **params):
    data = urllib.parse.urlencode(params).encode() if params else None
    req = urllib.request.Request(API.format(token=token, method=method), data=data)
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.load(resp)
    if not body.get("ok"):
        raise RuntimeError(f"{method} failed: {body}")
    return body["result"]


def find_chat_id(token, title):
    for upd in call(token, "getUpdates"):
        for key in ("message", "my_chat_member", "channel_post", "edited_message"):
            chat = (upd.get(key) or {}).get("chat")
            if chat and chat.get("title", "").strip().lower() == title.strip().lower():
                return chat["id"]
    return None


def main():
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        sys.exit("TELEGRAM_BOT_TOKEN is not set")
    title = os.environ.get("TELEGRAM_CHAT_TITLE", "7 негритят")
    text = os.environ.get("TELEGRAM_TEXT") or (sys.argv[1] if len(sys.argv) > 1 else "привет")

    chat_id = os.environ.get("TELEGRAM_CHAT_ID") or find_chat_id(token, title)
    if not chat_id:
        sys.exit(
            f'Group "{title}" not found. Add the bot to the group, send any message '
            "there, then run again (or set TELEGRAM_CHAT_ID)."
        )

    msg = call(token, "sendMessage", chat_id=chat_id, text=text)
    print(f'Sent "{text}" to chat {chat_id} (message_id={msg["message_id"]})')


if __name__ == "__main__":
    main()
