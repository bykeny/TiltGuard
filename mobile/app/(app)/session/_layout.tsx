import { Stack } from 'expo-router';

/**
 * Session stack (§7).
 *
 * `cooldown` is deliberately non-dismissable: no header, no swipe-back gesture,
 * and the screen itself swallows the Android hardware back press. The only way
 * out is `CooldownLockReleased` from the hub or the watchdog's expiry.
 */
export default function SessionLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#020617' },
      }}>
      <Stack.Screen name="active" />
      <Stack.Screen
        name="cooldown"
        options={{
          gestureEnabled: false,
          animation: 'fade',
        }}
      />
    </Stack>
  );
}
