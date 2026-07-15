import { StyleSheet } from 'react-native';

import { Text, View } from '@/components/Themed';

// Placeholder — wire up to AuthService (§1.3 / §3.1-3.3) and src/stores/auth.store.ts.
export default function LoginScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Login</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
  },
});
