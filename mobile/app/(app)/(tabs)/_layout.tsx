import { Tabs } from 'expo-router';

/**
 * Tab bar (§7). Auth protection lives in the root layout's `Stack.Protected`
 * guard, and the full-screen flows (session, paywall) sit in the parent stack,
 * so this layout only owns the three browsable tabs.
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
    </Tabs>
  );
}
