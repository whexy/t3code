/** The File System Access API calls the editor uses; Chromium browsers have them, others do not. */
export interface PolicyFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
  queryPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
}

interface FilePickerOptions {
  readonly suggestedName?: string;
  readonly types?: ReadonlyArray<{
    readonly description: string;
    readonly accept: Record<string, ReadonlyArray<string>>;
  }>;
}

interface FileAccessWindow {
  showOpenFilePicker?: (options?: FilePickerOptions) => Promise<ReadonlyArray<PolicyFileHandle>>;
  showSaveFilePicker?: (options?: FilePickerOptions) => Promise<PolicyFileHandle>;
}

const fileAccess = (): FileAccessWindow => window as unknown as FileAccessWindow;

const JSON_TYPES = [{ description: "Policy JSON", accept: { "application/json": [".json"] } }];

export interface OpenedFile {
  readonly name: string;
  readonly text: string;
  /** Present when the browser can write the file back in place. */
  readonly handle?: PolicyFileHandle;
}

export const canWriteInPlace = () => typeof fileAccess().showOpenFilePicker === "function";

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

async function fromHandle(handle: PolicyFileHandle): Promise<OpenedFile> {
  const file = await handle.getFile();
  return { name: file.name, text: await file.text(), handle };
}

/** Pick a file with the browser's picker; undefined when the user cancels or it is unavailable. */
export async function pickPolicyFile(): Promise<OpenedFile | undefined> {
  const picker = fileAccess().showOpenFilePicker;
  if (picker === undefined) return undefined;
  try {
    const [handle] = await picker({ types: JSON_TYPES });
    return handle === undefined ? undefined : await fromHandle(handle);
  } catch (error) {
    if (isAbort(error)) return undefined;
    throw error;
  }
}

export async function readDroppedFile(transfer: DataTransfer): Promise<OpenedFile | undefined> {
  const item = [...transfer.items].find((candidate) => candidate.kind === "file");
  if (item === undefined) return undefined;
  const withHandle = item as DataTransferItem & {
    getAsFileSystemHandle?: () => Promise<PolicyFileHandle | { readonly kind: "directory" } | null>;
  };
  // Read the handle before the file: the drop's data is only readable during the event.
  const handlePromise = withHandle.getAsFileSystemHandle?.();
  const file = item.getAsFile();
  const handle = await handlePromise;
  if (handle?.kind === "file") return fromHandle(handle);
  return file === null ? undefined : { name: file.name, text: await file.text() };
}

export async function readInputFile(file: File): Promise<OpenedFile> {
  return { name: file.name, text: await file.text() };
}

/** Write `text` back to the opened file. False when the browser refuses permission. */
export async function writeInPlace(handle: PolicyFileHandle, text: string): Promise<boolean> {
  const mode = { mode: "readwrite" } as const;
  if ((await handle.queryPermission?.(mode)) !== "granted") {
    const granted = (await handle.requestPermission?.(mode)) ?? "granted";
    if (granted !== "granted") return false;
  }
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
  return true;
}

export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Save under a name the user picks: a new file handle where the browser has the API, so later
 * saves go to it, else a download. Undefined when the user cancels.
 */
export async function saveAs(
  name: string,
  text: string,
): Promise<{ readonly handle?: PolicyFileHandle; readonly name: string } | undefined> {
  const picker = fileAccess().showSaveFilePicker;
  if (picker === undefined) {
    download(name, text);
    return { name };
  }
  try {
    const handle = await picker({ suggestedName: name, types: JSON_TYPES });
    await writeInPlace(handle, text);
    return { handle, name: handle.name };
  } catch (error) {
    if (isAbort(error)) return undefined;
    throw error;
  }
}
