import { Stack } from 'expo-router';

/**
 * Auth stack (§7). Route protection lives in the root layout, so this layout
 * only owns presentation: a full-bleed dark surface with no chrome.
 */
export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#020617' },
        animation: 'fade',
      }}>
      <Stack.Screen name="login" />
    </Stack>
  );
}
