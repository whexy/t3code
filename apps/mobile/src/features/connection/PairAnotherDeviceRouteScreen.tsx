import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { FleetPairing } from "@t3tools/client-runtime/connection";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { Share, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { IconButton } from "../../components/ui/IconButton";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { environmentCatalog } from "../../connection/catalog";
import { fleetPairingAtom } from "../../connection/fleetPairing";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { PairingQrCode } from "./PairingQrCode";

/** Opens the pairing code screen; shown only when this device holds a bearer pairing to share. */
export function PairAnotherDeviceRow() {
  const navigation = useNavigation();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const hasBearerEnvironment = [...catalog.entries.values()].some(
    (entry) => entry.target._tag === "BearerConnectionTarget",
  );
  if (!hasBearerEnvironment) return null;
  return (
    <View className="mt-5">
      <SettingsSection footer="Show a code that pairs another device with all your environments.">
        <ListRow
          icon="qrcode.viewfinder"
          label="Pair another device"
          onPress={() => navigation.navigate("SettingsPairDevice")}
        />
      </SettingsSection>
    </View>
  );
}

function useHasPassed(epochMs: number | null): boolean {
  const [passed, setPassed] = useState<number | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one timer marks the code expired at its deadline
  useEffect(() => {
    if (epochMs === null) return;
    const timer = setTimeout(() => setPassed(epochMs), Math.max(0, epochMs - Date.now()));
    return () => clearTimeout(timer);
  }, [epochMs]);
  return epochMs !== null && passed === epochMs;
}

export function PairAnotherDeviceRouteScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const result = useAtomValue(fleetPairingAtom);
  const mintAgain = useAtomRefresh(fleetPairingAtom);
  const pairing = AsyncResult.isSuccess(result) ? result.value : null;
  const expired = useHasPassed(pairing?.expiresAtEpochMs ?? null);

  return (
    <SettingsScreen title="Pair another device">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentInset={{ bottom: Math.max(insets.bottom, 18) }}
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4 pb-[18px]"
      >
        {pairing === null ? (
          <View className="items-center gap-3 px-6 py-8">
            {AsyncResult.isFailure(result) ? (
              <Text className="text-center text-sm text-danger-foreground">
                Couldn't create a pairing code.
              </Text>
            ) : (
              <>
                <AppActivityIndicator />
                <Text className="text-center text-sm text-foreground-muted">
                  Creating a pairing code…
                </Text>
              </>
            )}
          </View>
        ) : (
          <PairingCode
            // New codes start from the first one.
            key={pairing.link ?? ""}
            pairing={pairing}
            expired={expired}
            qrSize={Math.min(width - 72, 300)}
          />
        )}

        <SettingsSection>
          {pairing?.link && !expired ? <ShareActions link={pairing.link} /> : null}
          <ListActionRow
            icon="arrow.clockwise"
            label="New code"
            loading={result.waiting}
            onPress={mintAgain}
          />
        </SettingsSection>

        {pairing === null ? null : <HostSections hosts={pairing.hosts} />}
      </ScrollView>
    </SettingsScreen>
  );
}

function PairingCode(props: {
  readonly pairing: FleetPairing.FleetPairing;
  readonly expired: boolean;
  readonly qrSize: number;
}) {
  const { codes, expiresAtEpochMs } = props.pairing;
  const [index, setIndex] = useState(0);
  const code = codes[index];
  if (code === undefined || expiresAtEpochMs === null || props.expired) {
    return (
      <View className="items-center rounded-[24px] bg-grouped-card px-6 py-8">
        <Text className="text-center text-sm text-foreground-muted">
          {props.expired
            ? "This code expired. Make a new one."
            : "No environment could create a pairing code."}
        </Text>
      </View>
    );
  }
  const expiresAt = new Date(expiresAtEpochMs).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <View className="gap-3">
      <View className="items-center">
        <View className="overflow-hidden rounded-[24px] border-continuous bg-white">
          <PairingQrCode
            value={code}
            size={props.qrSize}
            accessibilityLabel={
              codes.length > 1
                ? `Pairing code ${index + 1} of ${codes.length}`
                : "Pairing code for your environments"
            }
          />
        </View>
      </View>
      {codes.length > 1 ? (
        <View className="flex-row items-center justify-center gap-4">
          <IconButton
            icon="chevron.left"
            accessibilityLabel="Previous code"
            disabled={index === 0}
            onPress={() => setIndex(index - 1)}
          />
          <Text textRole="body" className="text-foreground">
            {`Code ${index + 1} of ${codes.length}`}
          </Text>
          <IconButton
            icon="chevron.right"
            accessibilityLabel="Next code"
            disabled={index === codes.length - 1}
            onPress={() => setIndex(index + 1)}
          />
        </View>
      ) : null}
      <Text textRole="footnote" className="px-2 text-center text-foreground">
        {codes.length > 1
          ? "On the other device, open Add environment and scan each code in turn, or paste the link there."
          : "On the other device, scan this from Add environment, or paste the link there."}
      </Text>
      <Text textRole="footnote" className="px-2 text-center text-foreground-muted">
        {`Single use. Expires at ${expiresAt}. It grants access to every environment included below.`}
      </Text>
    </View>
  );
}

function ShareActions(props: { readonly link: string }) {
  return (
    <>
      <ListActionRow
        icon="square.and.arrow.up"
        label="Share link"
        onPress={() => void Share.share({ message: props.link })}
      />
      <View className="ml-4 border-t border-border-subtle" />
      <ListActionRow
        icon="doc.on.doc"
        label="Copy link"
        onPress={() => {
          void Clipboard.setStringAsync(props.link);
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }}
      />
      <View className="ml-4 border-t border-border-subtle" />
    </>
  );
}

function HostSections(props: { readonly hosts: ReadonlyArray<FleetPairing.FleetHostPairing> }) {
  const included = props.hosts.filter((host) => host._tag === "Minted");
  const leftOut = props.hosts.flatMap((host) => (host._tag === "Unavailable" ? [host] : []));
  return (
    <>
      {included.length > 0 ? (
        <SettingsSection title="Included">
          {included.map((host, index) => (
            <HostRow key={host.environmentId} first={index === 0} label={host.label} />
          ))}
        </SettingsSection>
      ) : null}
      {leftOut.length > 0 ? (
        <SettingsSection title="Left out">
          {leftOut.map((host, index) => (
            <HostRow
              key={host.environmentId}
              first={index === 0}
              label={host.label}
              detail={host.detail}
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}

function HostRow(props: {
  readonly first: boolean;
  readonly label: string;
  readonly detail?: string;
}) {
  return (
    <View>
      {props.first ? null : <View className="ml-4 border-t border-border-subtle" />}
      <ListRowLayout
        label={props.label}
        {...(props.detail === undefined ? {} : { description: props.detail })}
      />
    </View>
  );
}
