import { jsonEqual } from "./json.ts";

/** A file as it was opened, so saving it unchanged gives back the same bytes. */
export interface OpenedText {
  readonly text: string;
  readonly document: unknown;
}

export const NEW_POLICY: unknown = { schemaVersion: 1, organization: "" };

export function parsePolicyText(
  text: string,
):
  | { readonly ok: true; readonly document: unknown }
  | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, document: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      message: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Indentation and final newline of `text`, so an edited file keeps its layout. */
function layoutOf(text: string): { readonly indent: string | number; readonly newline: boolean } {
  const body = text.trimEnd();
  const newline = text.endsWith("\n");
  if (!body.includes("\n")) return { indent: 0, newline };
  const indent = /\n([ \t]+)\S/.exec(body)?.[1];
  return { indent: indent?.startsWith("\t") ? "\t" : (indent?.length ?? 2), newline };
}

/** The text to write: the opened text itself when nothing changed, else the document in its layout. */
export function serializePolicy(document: unknown, opened: OpenedText | undefined): string {
  if (opened !== undefined && jsonEqual(document, opened.document)) return opened.text;
  const { indent, newline } =
    opened === undefined ? { indent: 2, newline: true } : layoutOf(opened.text);
  return `${JSON.stringify(document, null, indent)}${newline ? "\n" : ""}`;
}
