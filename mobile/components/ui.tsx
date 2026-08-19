/**
 * Shared dark-slate primitives (§7).
 *
 * The auth screens and the session screens all draw from this one set so the
 * emerald/red accent language stays consistent instead of being retyped per
 * screen.
 */
import { forwardRef } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import type { RiskFlag } from '@/src/api/sessions';

/** Soft emerald discs bleeding off the top edge — stands in for a gradient. */
export function AmbientGlow() {
  return (
    <>
      <View className="absolute -left-16 -top-24 h-72 w-72 rounded-full bg-emerald-500/10" />
      <View className="absolute -top-10 right-[-70px] h-56 w-56 rounded-full bg-emerald-400/5" />
    </>
  );
}

export function BrandMark({ title = 'TiltGuard' }: { title?: string }) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="h-10 w-10 items-center justify-center rounded-xl border border-emerald-400/30 bg-emerald-500/10">
        <View className="h-4 w-4 rounded bg-emerald-400" />
      </View>
      <Text className="text-lg font-semibold tracking-tight text-slate-100">{title}</Text>
    </View>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }

  return (
    <View className="mb-5 flex-row items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3">
      <View className="mt-1.5 h-2 w-2 rounded-full bg-red-400" />
      <Text className="flex-1 text-sm leading-5 text-red-300">{message}</Text>
    </View>
  );
}

export function FieldLabel({ children }: { children: string }) {
  return (
    <Text className="mb-2 text-xs font-medium uppercase tracking-widest text-slate-500">
      {children}
    </Text>
  );
}

type TextFieldProps = TextInputProps & {
  isFocused?: boolean;
};

/** A dark input whose border lights up emerald while focused. */
export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { isFocused = false, className, ...props },
  ref
) {
  const base = 'rounded-2xl border px-4 py-3.5 text-base text-slate-100';
  const tone = isFocused
    ? 'border-emerald-400/70 bg-slate-900'
    : 'border-white/10 bg-slate-900/60';

  return (
    <TextInput
      ref={ref}
      className={`${base} ${tone} ${className ?? ''}`}
      placeholderTextColor="#475569"
      {...props}
    />
  );
});

type PrimaryButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  /** `danger` is reserved for destructive actions like ending a session. */
  tone?: 'emerald' | 'danger' | 'ghost';
};

export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  busy = false,
  tone = 'emerald',
}: PrimaryButtonProps) {
  const isEnabled = !disabled && !busy;

  const surface = {
    emerald: isEnabled ? 'bg-emerald-500 active:bg-emerald-600' : 'bg-emerald-500/25',
    danger: isEnabled ? 'bg-red-500/15 active:bg-red-500/25' : 'bg-red-500/10',
    ghost: isEnabled ? 'bg-white/5 active:bg-white/10' : 'bg-white/5',
  }[tone];

  const text = {
    emerald: isEnabled ? 'text-emerald-950' : 'text-emerald-100/50',
    danger: isEnabled ? 'text-red-300' : 'text-red-300/40',
    ghost: isEnabled ? 'text-slate-200' : 'text-slate-500',
  }[tone];

  const border = tone === 'danger' ? 'border border-red-500/30' : '';

  return (
    <Pressable
      className={`h-14 flex-row items-center justify-center rounded-2xl ${surface} ${border}`}
      disabled={!isEnabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !isEnabled, busy }}
      onPress={onPress}>
      {busy ? (
        <ActivityIndicator color={tone === 'emerald' ? '#022c22' : '#e2e8f0'} />
      ) : (
        <Text className={`text-base font-semibold tracking-tight ${text}`}>{label}</Text>
      )}
    </Pressable>
  );
}

/** §7 risk palette, applied consistently across gauge, alerts and banners. */
export const RISK_PRESENTATION: Record<
  RiskFlag,
  { label: string; hex: string; text: string; surface: string; border: string }
> = {
  stable: {
    label: 'Stable',
    hex: '#22c55e',
    text: 'text-risk-stable',
    surface: 'bg-risk-stable/10',
    border: 'border-risk-stable/30',
  },
  elevated: {
    label: 'Elevated',
    hex: '#eab308',
    text: 'text-risk-elevated',
    surface: 'bg-risk-elevated/10',
    border: 'border-risk-elevated/30',
  },
  critical: {
    label: 'Critical',
    hex: '#f97316',
    text: 'text-risk-critical',
    surface: 'bg-risk-critical/10',
    border: 'border-risk-critical/30',
  },
  lockRequired: {
    label: 'Lock required',
    hex: '#ef4444',
    text: 'text-risk-lockRequired',
    surface: 'bg-risk-lockRequired/10',
    border: 'border-risk-lockRequired/30',
  },
};

export function RiskBadge({ risk }: { risk: RiskFlag }) {
  const preset = RISK_PRESENTATION[risk];
  return (
    <View
      className={`flex-row items-center gap-2 self-start rounded-full border px-3 py-1.5 ${preset.surface} ${preset.border}`}>
      <View className="h-2 w-2 rounded-full" style={{ backgroundColor: preset.hex }} />
      <Text className={`text-xs font-semibold uppercase tracking-wider ${preset.text}`}>
        {preset.label}
      </Text>
    </View>
  );
}
