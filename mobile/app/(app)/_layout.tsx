import { Stack } from 'expo-router';

export const unstable_settings = {
  anchor: '(tabs)',
};

/**
 * Authenticated shell (§7).
 *
 * A Stack, not the tab navigator itself: a bottom-tab navigator renders its tab
 * bar over every screen it owns, so hosting `session` there left the mandatory
 * cooldown with a live tab bar the user could tap to escape the lock. Pushing
 * the session and paywall flows onto a parent stack covers the tabs outright,
 * and it is also the only arrangement in which `presentation: 'modal'` means
 * anything — tab screens have no modal presentation.
 */
export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#020617' },
      }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="session" />
      <Stack.Screen
        name="paywall"
        options={{
          presentation: 'modal',
          animation: 'slide_from_bottom',
        }}
      />
    </Stack>
  );
}
