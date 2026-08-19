import { Tabs } from 'expo-router';

/**
 * Tabs mapping (§7). Auth protection is handled by the root layout's
 * `Stack.Protected` guard, so this layout only owns presentation.
 */
export default function AppTabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#020617',
          borderTopColor: 'rgba(255,255,255,0.06)',
        },
        tabBarActiveTintColor: '#34d399',
        tabBarInactiveTintColor: '#64748b',
        sceneStyle: { backgroundColor: '#020617' },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Dashboard' }} />
      <Tabs.Screen name="history" options={{ title: 'History' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
      {/* The session flow is pushed full-screen, never surfaced as a tab. */}
      <Tabs.Screen name="session" options={{ href: null }} />
    </Tabs>
  );
}
