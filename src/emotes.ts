import { createElement, type ReactNode } from "react";
import { isNativeEmote, type NativeEmote } from "../shared/nativeEmotes";

export interface ThirdPartyEmote {
  name: string;
  url: string;
  source: "bttv" | "ffz" | "7tv";
}

export interface MessagePart {
  type: "text" | "emote";
  text: string;
  url?: string;
  source?: "twitch" | "bttv" | "ffz" | "7tv";
}

export function buildMessageParts(
  messageText: string,
  nativeEmotes: unknown,
  thirdPartyEmotes: ReadonlyMap<string, ThirdPartyEmote>,
): MessagePart[] {
  if (!Array.isArray(nativeEmotes) || nativeEmotes.length === 0) {
    return replaceThirdPartyEmotes(messageText, thirdPartyEmotes);
  }
  if (!nativeEmotes.every(isNativeEmote)) {
    return replaceThirdPartyEmotes(messageText, thirdPartyEmotes);
  }

  const codePoints = Array.from(messageText);
  const parts: MessagePart[] = [];
  let cursor = 0;
  for (const [start, length, id, animated] of nativeEmotes as NativeEmote[]) {
    if (start < cursor || start + length > codePoints.length) {
      return replaceThirdPartyEmotes(messageText, thirdPartyEmotes);
    }
    if (start > cursor) {
      parts.push(...replaceThirdPartyEmotes(
        codePoints.slice(cursor, start).join(""),
        thirdPartyEmotes,
      ));
    }
    const text = codePoints.slice(start, start + length).join("");
    parts.push({
      type: "emote",
      text,
      url: `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/${animated ? "animated" : "static"}/dark/2.0`,
      source: "twitch",
    });
    cursor = start + length;
  }
  if (cursor < codePoints.length) {
    parts.push(...replaceThirdPartyEmotes(codePoints.slice(cursor).join(""), thirdPartyEmotes));
  }
  return parts;
}

export function replaceThirdPartyEmotes(
  text: string,
  emotes: ReadonlyMap<string, ThirdPartyEmote>,
): MessagePart[] {
  if (emotes.size === 0) return [{ type: "text", text }];
  return text.split(/(\s+)/).map((token) => {
    const emote = emotes.get(token);
    return emote
      ? { type: "emote", text: token, url: emote.url, source: emote.source }
      : { type: "text", text: token };
  });
}

export function renderMessageParts(parts: MessagePart[]): ReactNode[] {
  return parts.map((part, index) =>
    part.type === "emote" && part.url
      ? createElement("img", {
          alt: part.text,
          className: "chat-emote",
          draggable: false,
          key: `${index}-${part.source}-${part.text}`,
          loading: "lazy",
          src: part.url,
          title: `${part.text} (${part.source})`,
        })
      : part.text,
  );
}
