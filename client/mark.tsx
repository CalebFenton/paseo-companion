import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, View } from "react-native";
import { coreParts, frameParts, markSvg, ON_DARK, ON_LIGHT } from "../shared/mark";
import type { Themed } from "./ui";

/**
 * Each palette's two layers for sizes under 24 px: the frame turns, the core holds still. The
 * frame is drawn heavier than the core, so the part that moves is not the faintest.
 */
function layers(palette: typeof ON_DARK) {
  const frame = frameParts({ palette, weight: 2 });
  const core = coreParts({ palette, weight: 1.5 });
  return { frame: { svg: markSvg(frame.body) }, core: { svg: markSvg(core.ring + core.eye) } };
}
const DARK = layers(ON_DARK);
const LIGHT = layers(ON_LIGHT);

/** A surface darker than mid-grey takes the brand's own colours; a lighter one, their ink versions. */
function isDark(color: string): boolean {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return false;
  const v = Number.parseInt(hex, 16);
  return 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255) < 128;
}

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    const read = async () => {
      const enabled = await AccessibilityInfo.isReduceMotionEnabled();
      if (live) setReduce(enabled);
    };
    void read();
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return reduce;
}

/** One 60° step, fast and decisive, then a hold: the mark's motion for thinking. */
const STEP_MS = 380;
const HOLD_MS = 720;
const STEPS = 6;

/**
 * The mark. While `turning`, its frame turns in hard 60° steps, the brand's motion for work under
 * way; otherwise, and under reduced motion, it holds still.
 */
export function Mark({ theme, size, turning }: Themed & { size: number; turning: boolean }) {
  const { frame, core } = isDark(theme.colors.surface0) ? DARK : LIGHT;
  const reduceMotion = useReduceMotion();
  const [turn] = useState(() => new Animated.Value(0));

  useEffect(() => {
    turn.setValue(0);
    if (!turning || reduceMotion) return;
    // Six steps make a whole turn, so each loop's reset lands where it started: the frame's colours
    // differ round the hexagon, and a reset after a single 60° step would show as a jump back.
    const steps = Array.from({ length: STEPS }, (_, k) => [
      Animated.timing(turn, {
        toValue: k + 1,
        duration: STEP_MS,
        easing: Easing.bezier(0.7, 0, 0.2, 1),
        useNativeDriver: Platform.OS !== "web",
      }),
      Animated.delay(HOLD_MS),
    ]).flat();
    const loop = Animated.loop(Animated.sequence(steps));
    loop.start();
    return () => loop.stop();
  }, [turning, reduceMotion, turn]);

  const rotate = turn.interpolate({ inputRange: [0, STEPS], outputRange: ["0deg", "360deg"] });
  const layer = { position: "absolute", top: 0, left: 0 } as const;
  return (
    <View style={{ width: size, height: size }}>
      <Animated.View style={{ ...layer, transform: [{ rotate }] }}>
        <Icon icon={frame} size={size} />
      </Animated.View>
      <View style={layer}>
        <Icon icon={core} size={size} />
      </View>
    </View>
  );
}
