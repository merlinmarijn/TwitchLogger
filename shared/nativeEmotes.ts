export type NativeEmote = [
  start: number,
  length: number,
  id: string,
  animated: boolean,
];

interface TwitchMessageFragment {
  type?: string;
  text?: string;
  emote?: {
    id?: string;
    format?: string[];
  } | null;
}

export function compactNativeEmotes(fragments: unknown): NativeEmote[] {
  if (!Array.isArray(fragments)) return [];
  const compact: NativeEmote[] = [];
  let start = 0;
  for (const candidate of fragments) {
    const fragment = candidate as TwitchMessageFragment;
    const text = typeof fragment.text === "string" ? fragment.text : "";
    const length = Array.from(text).length;
    const id = fragment.type === "emote" ? fragment.emote?.id : undefined;
    if (id) {
      compact.push([
        start,
        length,
        id,
        fragment.emote?.format?.includes("animated") === true,
      ]);
    }
    start += length;
  }
  return compact;
}

export function isNativeEmote(value: unknown): value is NativeEmote {
  return Array.isArray(value) && value.length === 4 &&
    Number.isInteger(value[0]) && value[0] >= 0 &&
    Number.isInteger(value[1]) && value[1] > 0 &&
    typeof value[2] === "string" && value[2].length > 0 &&
    typeof value[3] === "boolean";
}
