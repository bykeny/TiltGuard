import { useColorScheme as useColorSchemeCore } from 'react-native';

export const useColorScheme = () => {
  const coreScheme = useColorSchemeCore();
  // React Native reports `null` when the OS has no preference.
  return coreScheme ?? 'light';
};
