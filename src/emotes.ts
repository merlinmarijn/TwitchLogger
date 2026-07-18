import { createElement, type ReactNode } from "react";

export interface ThirdPartyEmote {
  name: string;
  url: string;
  source: "bttv" | "ffz" | "7tv";
}

export interface TwitchMessageFragment {
  type?: string;
  text?: string;
  emote?: {
    id?: string;
    format?: string[];
  } | null;
}

export interface MessagePart {
  type: "text" | "emote";
  text: string;
  url?: string;
  source?: "twitch" | "bttv" | "ffz" | "7tv";
}

export function buildMessageParts(
  messageText: string,
  fragments: unknown,
  thirdPartyEmotes: ReadonlyMap<string, ThirdPartyEmote>,
): MessagePart[] {
  if (!Array.isArray(fragments)) return replaceThirdPartyEmotes(messageText, thirdPartyEmotes);

  const typedFragments = fragments as TwitchMessageFragment[];
  if (typedFragments.some((fragment) => typeof fragment.text !== "string")) {
    return replaceThirdPartyEmotes(messageText, thirdPartyEmotes);
  }

  return typedFragments.flatMap((fragment) => {
    const text = fragment.text ?? "";
    const id = fragment.type === "emote" ? fragment.emote?.id : undefined;
    if (!id) return replaceThirdPartyEmotes(text, thirdPartyEmotes);
    const format = fragment.emote?.format?.includes("animated") ? "animated" : "static";
    return [{
      type: "emote" as const,
      text,
      url: `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/${format}/dark/2.0`,
      source: "twitch" as const,
    }];
  });
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
