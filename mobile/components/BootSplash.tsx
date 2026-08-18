/**
 * Boot splash rendered while the auth store hydrates from secure storage.
 *
 * The native splash has already been dismissed by this point, so this view
 * carries the brand for the (usually sub-second) keychain read. It is
 * deliberately dark regardless of system theme — TiltGuard's identity is the
 * dark surface plus the §7 risk palette.
 */
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

type BootSplashProps = {
  label?: string;
};

export function BootSplash({ label = 'Securing your session…' }: BootSplashProps) {
  const pulse = useSharedValue(0);

  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1100, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 1100, easing: Easing.in(Easing.quad) })
      ),
      -1,
      false
    );
  }, [pulse]);

  // Animated styles stay on Animated.View; all static styling stays in
  // NativeWind classes on plain children, so the two never fight.
  const haloStyle = useAnimatedStyle(() => ({
    position: 'absolute' as const,
    opacity: 0.2 + pulse.value * 0.5,
    transform: [{ scale: 0.88 + pulse.value * 0.24 }],
  }));

  const markStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.98 + pulse.value * 0.04 }],
  }));

  return (
    <View className="flex-1 items-center justify-center bg-slate-950">
      {/* Ambient glow behind the mark — layered translucent discs stand in for
          a radial gradient without pulling in another native dependency. */}
      <View className="absolute h-80 w-80 rounded-full bg-emerald-500/5" />
      <View className="absolute h-56 w-56 rounded-full bg-emerald-500/5" />

      <View className="items-center">
        <View className="h-28 w-28 items-center justify-center">
          <Animated.View style={haloStyle}>
            <View className="h-28 w-28 rounded-full border border-emerald-400/40" />
          </Animated.View>

          <Animated.View style={markStyle}>
            <View className="h-16 w-16 items-center justify-center rounded-2xl border border-emerald-400/30 bg-emerald-500/10">
              <View className="h-6 w-6 rounded-md bg-emerald-400" />
            </View>
          </Animated.View>
        </View>

        <Text className="mt-8 text-2xl font-semibold tracking-tight text-slate-100">
          TiltGuard
        </Text>
        <Text className="mt-2 text-sm text-slate-500">{label}</Text>
      </View>
    </View>
  );
}

export default BootSplash;
