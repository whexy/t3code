import { QrCode } from "@t3tools/shared/qrCode";
import Svg, { Path, Rect } from "react-native-svg";

const QUIET_ZONE_MODULES = 4;

function qrPathData(qrCode: QrCode): string {
  const commands: Array<string> = [];
  for (let y = 0; y < qrCode.size; y += 1) {
    let runStart = -1;
    for (let x = 0; x <= qrCode.size; x += 1) {
      if (x < qrCode.size && qrCode.getModule(x, y)) {
        if (runStart === -1) runStart = x;
        continue;
      }
      if (runStart === -1) continue;
      const left = runStart + QUIET_ZONE_MODULES;
      commands.push(`M${left} ${y + QUIET_ZONE_MODULES}h${x - runStart}v1H${left}z`);
      runStart = -1;
    }
  }
  return commands.join("");
}

/** Always dark on white: scanners read inverted codes poorly. */
export function PairingQrCode(props: {
  readonly value: string;
  readonly size: number;
  readonly accessibilityLabel: string;
}) {
  const qrCode = QrCode.encodeText(props.value, QrCode.Ecc.LOW);
  const viewBoxSize = qrCode.size + QUIET_ZONE_MODULES * 2;
  return (
    <Svg
      accessible
      accessibilityRole="image"
      accessibilityLabel={props.accessibilityLabel}
      width={props.size}
      height={props.size}
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
    >
      <Rect width={viewBoxSize} height={viewBoxSize} fill="#fff" />
      <Path d={qrPathData(qrCode)} fill="#000" />
    </Svg>
  );
}
