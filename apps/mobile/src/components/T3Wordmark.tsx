import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 106 / 41.9446;
  return (
    <Svg
      accessibilityLabel="T3"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="11 44.0277 106 41.9446"
    >
      <ThemedPath
        d="M24.602 85.9723 11 44.0277H23.2239L31.6727 70.8123L40.541 44.0277H51.4466L59.9553 71.1119L68.7038 44.0277H80.0288L66.4268 85.9723H53.7236L45.6942 60.446L37.3053 85.9723ZM77.0328 77.9429V70.2131L95.8479 44.0277H108.1317L91.0543 68.5353H99.563V61.4047H110.7682V68.5353H117V77.9429H110.7682V85.9723H99.2035V77.9429Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
