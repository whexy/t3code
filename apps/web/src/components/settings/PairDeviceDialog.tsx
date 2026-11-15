import type { FleetPairing } from "@t3tools/client-runtime/connection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ChevronLeftIcon, ChevronRightIcon, QrCodeIcon } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";

import { mintFleetPairing as mintFleetPairingCommand } from "~/connection/fleetPairing";
import { type EnvironmentPresentation } from "~/state/environments";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";

type MintState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly pairing: FleetPairing.FleetPairing }
  | { readonly _tag: "Failed"; readonly message: string };

const formatTime = (epochMs: number) =>
  new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function PairDeviceDialog({
  savedEnvironments,
}: {
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const mintFleetPairing = useAtomCommand(mintFleetPairingCommand, { reportFailure: false });
  const [state, setState] = useState<MintState>({ _tag: "Loading" });
  const [codeIndex, setCodeIndex] = useState(0);
  const [expired, setExpired] = useState(false);
  const mintRequestRef = useRef(0);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    target: "pairing link",
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy the pairing link",
          description: error.message,
        }),
      ),
  });

  if (
    !savedEnvironments.some(
      (environment) => environment.entry.target._tag === "BearerConnectionTarget",
    )
  ) {
    return null;
  }

  const stopExpiryTimer = () => {
    clearTimeout(expiryTimerRef.current);
    expiryTimerRef.current = undefined;
  };

  const mint = async () => {
    const request = ++mintRequestRef.current;
    stopExpiryTimer();
    setExpired(false);
    setState({ _tag: "Loading" });
    const result = await mintFleetPairing();
    if (request !== mintRequestRef.current) return;
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setState({
        _tag: "Failed",
        message: error instanceof Error ? error.message : "Could not make pairing links.",
      });
      return;
    }
    setState({ _tag: "Ready", pairing: result.value });
    setCodeIndex(0);
    const expiresAt = result.value.expiresAtEpochMs;
    if (expiresAt !== null) {
      expiryTimerRef.current = setTimeout(
        () => setExpired(true),
        Math.max(0, expiresAt - Date.now()),
      );
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (open) {
      void mint();
      return;
    }
    // Drops a mint still in flight, so its link never shows after the dialog closed.
    mintRequestRef.current += 1;
    stopExpiryTimer();
  };

  const pairing = state._tag === "Ready" ? state.pairing : null;
  const link = expired ? null : (pairing?.link ?? null);
  const expiresAt = pairing?.expiresAtEpochMs ?? null;
  const codes = pairing?.codes ?? [];
  const code = codes[codeIndex] ?? null;
  const showCode = (index: number) => setCodeIndex(Math.min(Math.max(index, 0), codes.length - 1));
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (expired || codes.length < 2) return;
    if (event.key === "ArrowLeft") showCode(codeIndex - 1);
    else if (event.key === "ArrowRight") showCode(codeIndex + 1);
  };
  const included = pairing?.hosts.filter((host) => host._tag === "Minted") ?? [];
  const leftOut =
    pairing?.hosts.flatMap((host) => (host._tag === "Unavailable" ? [host] : [])) ?? [];

  return (
    <Dialog onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button size="xs" variant="ghost-muted">
            <QrCodeIcon className="size-3" />
            <span>Pair a device</span>
          </Button>
        }
      />
      <DialogPopup onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>Pair a device</DialogTitle>
          <DialogDescription>
            Scan this code with the T3 Code app on iPhone or iPad, or paste the link into Add
            environment on another computer.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {state._tag === "Loading" ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Spinner size="sm" tone="muted" />
              Making pairing links…
            </div>
          ) : state._tag === "Failed" ? (
            <Alert variant="error">
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          ) : (
            <>
              {expired ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  This code expired. Make a new one.
                </p>
              ) : code !== null && expiresAt !== null ? (
                <div className="flex flex-col items-center gap-2">
                  {codes.length > 1 ? (
                    <p className="text-sm text-muted-foreground">
                      Scan each code in turn to add every environment.
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2">
                    {codes.length > 1 ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Previous code"
                        disabled={codeIndex === 0}
                        onClick={() => showCode(codeIndex - 1)}
                      >
                        <ChevronLeftIcon />
                      </Button>
                    ) : null}
                    <div className="rounded-xl bg-white p-3">
                      <QRCodeSvg
                        value={code}
                        size={232}
                        level="L"
                        marginSize={1}
                        title={
                          codes.length > 1
                            ? `Pairing code ${codeIndex + 1} of ${codes.length}`
                            : "Pairing code for every environment listed"
                        }
                      />
                    </div>
                    {codes.length > 1 ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Next code"
                        disabled={codeIndex === codes.length - 1}
                        onClick={() => showCode(codeIndex + 1)}
                      >
                        <ChevronRightIcon />
                      </Button>
                    ) : null}
                  </div>
                  {codes.length > 1 ? (
                    <p className="text-sm font-medium" aria-live="polite">
                      Code {codeIndex + 1} of {codes.length}
                    </p>
                  ) : null}
                  <p className="text-center text-xs text-muted-foreground">
                    Single use. Expires at {formatTime(expiresAt)}.
                    <br />
                    Anyone with it can use every environment listed.
                  </p>
                </div>
              ) : (
                <Alert variant="error">
                  <AlertDescription>No environment could make a pairing link.</AlertDescription>
                </Alert>
              )}
              {included.length > 0 ? (
                <section className="space-y-1.5">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    Included ({included.length})
                  </h3>
                  <ul className="space-y-1 text-sm">
                    {included.map((host) => (
                      <li key={host.environmentId}>{host.label}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {leftOut.length > 0 ? (
                <section className="space-y-1.5">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    Left out ({leftOut.length})
                  </h3>
                  <ul className="space-y-1 text-sm">
                    {leftOut.map((host) => (
                      <li key={host.environmentId}>
                        {host.label}
                        <span className="text-muted-foreground"> · {host.detail}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant={expired ? "default" : "outline"}
            disabled={state._tag === "Loading"}
            onClick={() => void mint()}
          >
            New link
          </Button>
          <Button disabled={link === null} onClick={() => link && copyToClipboard(link)}>
            {isCopied ? "Copied" : "Copy link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
